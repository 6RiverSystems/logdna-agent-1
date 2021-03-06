// External Modules
const async = require('async');
const debug = require('debug')('logdna:lib:file-utilities');
const fs = require('fs');
const glob = require('glob');
const os = require('os');
const properties = require('properties');
const spawn = require('child_process').spawn;

// Internal Modules
const log = require('./log');
const linebuffer = require('./linebuffer');
const TailReadStream = require('./tailreadstream/tailreadstream');
const Splitter = require('./tailreadstream/line-splitter');
const k8s = require('./k8s');

// RegExp
const GLOB_CHARS_REGEX = /[*?[\]()]/;

// Constants
const globalExclude = [
    // '**/*+(-|_)20[0-9][0-9]*', // date stamped files: cronlog-20150928
    '**/testexclude'
    , '/var/log/wtmp'
    , '/var/log/btmp'
    , '/var/log/utmp'
    , '/var/log/wtmpx'
    , '/var/log/btmpx'
    , '/var/log/utmpx'
    , '/var/log/asl/**'
    , '/var/log/sa/**'
    , '/var/log/sar*'
    , '/tmp/cur'
    , '/tmp/new'
    , '/tmp/tmp'
];

// Variables
var firstrun = true;
var files = [];
var tails = [];

const getFiles = (config, dir, callback) => {
    // glob patterns always use / (even on windows)
    var globdir = dir.replace('\\', '/');

    // default glob pattern for simple dir input (ie: /var/log)
    var globpattern = '{' +
        globdir + '/**/*.log,' + // *.log files
        globdir + '/**/!(*.*)' + // extensionless files
    '}';

    fs.stat(dir, (err, stats) => {
        if (err) {
            // see if dir matches any glob control chars
            if (!GLOB_CHARS_REGEX.test(dir)) {
                if (firstrun) {
                    log('Error accessing ' + dir + ': ' + err);
                }
                return callback && callback(err);
            }

            // set as globpattern
            globpattern = globdir;

        } else if (!stats.isDirectory()) {
            if (stats.isFile()) {
                // single file? just return as an single item array (this also avoids globalExclude intentionally)
                return callback && callback(null, [dir]);
            }

            // something else? block devices, socket files, etc
            if (firstrun) {
                log('Error opening ' + dir + ': Not a file or directory');
            }
            return callback && callback(new Error('Not a file or directory'));
        }

        debug(globpattern);
        glob(globpattern, {
            nocase: (os.platform() !== 'win32')
            , nodir: true
            , ignore: globalExclude.concat(config.exclude || [])
        }, (err, logfiles) => {
            if (err) {
                if (firstrun) {
                    log('Error opening ' + dir + ': ' + err);
                }
                return callback && callback(err);
            }

            return callback && callback(null, logfiles);
        });
    });
};

function parseLine(line) {
    t = Date.now();
    try {
        lineObj = JSON.parse(line);
        // get time from JSON, if available
        if (lineObj.time) {
            t = new Date(lineObj.time);
        }
        // replace msg property with message so logdna knows about it
        if (lineObj.msg) {
            lineObj.message = lineObj.msg;
            delete lineObj.msg;
        }

        // translte numeric level to string that logdna knows about
        if (lineObj.level) {
            switch(lineObj.level) {
                case 10:
                    lineObj.level = 'TRACE';
                    break;
                case 20:
                    lineObj.level = 'DEBUG';
                    break;
                case 30:
                    lineObj.level = 'INFO';
                    break;
                case 40:
                    lineObj.level = 'WARN';
                    break;
                case 50:
                    lineObj.level = 'ERROR';
                    break;
                case 60:
                    lineObj.level = 'FATAL';
                    break;
                default:
                    // leave lineObj.level with its current value
            }
        }
        // store new line
        line = JSON.stringify(lineObj);
    } catch (e) {
        // ignore any errors, don't modify the log line (e.g. not valid JSON)
        debug('got error parsing log line as JSON: ' + e);
    }
    return {t, l: line};
}

const streamFiles = (config, logfiles, callback) => {
    logfiles.forEach((file) => {
        var tail, i, labels;

        if (config.platform && config.platform.indexOf('k8s') === 0) {
            labels = k8s.getLabelsFromFile(file);
        }

        if (os.platform() !== 'win32' && config.TAIL_MODE === 'unix') {
            debug('tailing: ' + file);
            tail = spawn('tail', ['-n0', '-F', file]);
            tail.stdout.on('data', (data) => {
                data = data.toString().trim().split('\n');
                for (i = 0; i < data.length; i++) {
                    req = parseLine(data[i]);
                    linebuffer.addMessage({t: req.t, l: req.l, f: file, label: labels});
                }
            });

            tail.stderr.on('data', (err) => {
                log('Tail error: ' + file + ': ' + err.toString().trim());
            });

            tails.push(tail);

        } else {
            debug('tailing: ' + file);
            tail = TailReadStream.tail(file, config);
            tail.pipe(new Splitter())
                .on('data', (line) => {
                    req = parseLine(line);
                    msg = {t: req.t, l: req.l, f: file, label: labels};
                    linebuffer.addMessage(msg);
                });

            tail.on('error', (err) => {
                log('Tail error: ' + file + ': ' + err);
            });

            tail.on('end', (err) => {
                if (err) {
                    log('File does not exist, stopped tailing: ' + file + ' after ' + tail.timeout + 'ms');
                    files = files.filter(element => element !== file);
                }
            });

            tail.on('rename', () => {
                log('Log rotated: ' + file + ' by rename');
            });

            tail.on('truncate', () => {
                log('Log rotated: ' + file + ' by truncation');
            });
        }
    });

    return callback && callback();
};

const streamAllLogs = (config, callback) => {
    linebuffer.setConfig(config);
    var newfiles = [];
    debug('scanning all folders: ' + config.logdir);
    async.each(config.logdir, (dir, done) => {
        getFiles(config, dir, (err, logfiles) => {
            if (!err && logfiles.length > 0) {
                debug('all ' + dir + ' files');
                debug(logfiles);

                // figure out new files that we're not already tailing
                var diff = logfiles.filter(element => files.indexOf(element) < 0);

                // unique filenames between logdir(s)
                newfiles = newfiles.concat(diff);
                newfiles = newfiles.filter((element, index) => newfiles.indexOf(element) === index);
                debug('newfiles after processing ' + dir);
                debug(newfiles);

                if (diff.length > 0) {
                    log('Streaming ' + dir + ': ' + diff.length + (!firstrun ? ' new file(s), ' + logfiles.length + ' total' : '') + ' file(s)');
                }
            }
            done();
        });
    }, () => {
        firstrun = false;

        // add to master files array
        files = files.concat(newfiles);
        debug('files after processing');
        debug(files);

        streamFiles(config, newfiles, () => {
            return callback && callback();
        });
    });

    if (config.usejournald && firstrun) {
        log('Streaming from journalctl: ' + config.usejournald);
        var journalctl, lastchunk, i;

        if (config.usejournald === 'files') {
            journalctl = spawn('journalctl', ['-n0', '-D', '/var/log/journal', '-o', 'json', '-f']);
        } else {
            journalctl = spawn('journalctl', ['-n0', '-o', 'json', '-f']);
        }

        const processChunk = (data) => {
            try {
                data = JSON.parse(data);
            } catch (e) {
                return { t: Date.now(), l: data, f: 'systemd' };
            }
            if (data.__REALTIME_TIMESTAMP && parseInt(data.__REALTIME_TIMESTAMP) > 10000000000000) {
                // convert to ms
                data.__REALTIME_TIMESTAMP = parseInt(data.__REALTIME_TIMESTAMP / 1000);
            }
            return { t: data.__REALTIME_TIMESTAMP, l: data.MESSAGE, f: data.CONTAINER_NAME || data.SYSLOG_IDENTIFIER || 'UNKNOWN_SYSTEMD_APP', pid: data._PID && parseInt(data._PID), prival: data.PRIORITY && parseInt(data.PRIORITY), containerid: data.CONTAINER_ID_FULL };
        };

        journalctl.stdout.on('data', (data) => {
            data = data.toString().trim().split('\n');
            for (i = 0; i < data.length; i++) {
                if (data[i].substring(0, 1) === '{' && data[i].substring(data[i].length - 1) === '}') {
                    // full chunk
                    linebuffer.addMessage(processChunk(data[i]));
                    if (lastchunk) { lastchunk = null; } // clear

                } else if (data[i].substring(0, 1) === '{') {
                    // starting chunk
                    lastchunk = (lastchunk ? lastchunk : '') + data[i];

                } else if (lastchunk && data[i].substring(data[i].length - 1) === '}') {
                    // ending chunk
                    lastchunk += data[i];
                    linebuffer.addMessage(processChunk(lastchunk));
                    lastchunk = null; // clear

                } else if (lastchunk && lastchunk.length < 32768) {
                    // append chunk
                    lastchunk += data[i];

                } else {
                    linebuffer.addMessage({
                        t: Date.now()
                        , l: data[i]
                        , f: 'systemd'
                    });
                }
            }
        });

        journalctl.stderr.on('data', (err) => {
            log('Error reading from journalctl: ' + err.toString().trim());
        });
    }

    if (config.RESCAN_INTERVAL) {
        setTimeout(() => {
            streamAllLogs(config);
        }, config.RESCAN_INTERVAL); // rescan for files every once in awhile
    }
};

const saveConfig = (config, configPath, callback) => {
    return properties.stringify(config, {
        path: configPath
    }, callback);
};

// Custom Appender:
const appender = (xs) => {
    xs = xs || [];
    return (x) => {
        xs.push(x);
        return xs;
    };
};

const gracefulShutdown = (signal) => {
    log('Got ' + signal + ' signal, shutting down...');
    setTimeout(() => {
        process.exit();
    }, 5000);
    tails.forEach((tail) => {
        tail.kill('SIGTERM');
        debug('tail pid ' + tail.pid + ' killed');
    });
    process.exit();
};

// Graceful Shutdown Scenarios
process.once('SIGTERM', () => { gracefulShutdown('SIGTERM'); }); // kill
process.once('SIGINT', () => { gracefulShutdown('SIGINT'); }); // ctrl+c

// Module Exports
module.exports.files = files;
module.exports.gracefulShutdown = gracefulShutdown;
module.exports.appender = appender;
module.exports.saveConfig = saveConfig;
module.exports.getFiles = getFiles;
module.exports.streamFiles = streamFiles;
module.exports.streamAllLogs = streamAllLogs;
