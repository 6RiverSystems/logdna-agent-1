'use strict';
/*
 * The base code for this is taken from the 'node-growing-file' module (https://github.com/felixge/node-growing-file) by felixge
 * Due to the inactivity of the repo and our desire to switch to ES6 syntax, the code has been ported over with a few minor tweaks to the calling params
 */

var fs = require('fs');
var debug = require('debug')('logdna:tailreadstream');
var Readable = require('stream').Readable;
var util = require('util');

var DEFAULT_WATCH_INTERVAL = 1000;
var DEFAULT_READ_INTERVAL = 1000;
var DEFAULT_READ_TIMEOUT = 3600000; // 1hr timeout
var DEFAULT_TAILHEAD_SIZE = 8192; // 8kb
var DEFAULT_TAILHEAD_AGE = 60000; // 1min
var DOES_NOT_EXIST_ERROR = 'ENOENT';

util.inherits(TailReadStream, Readable);

function TailReadStream(filepath, options) {
    Readable.call(this);

    options = options || {};

    this.readable = true;

    this._filepath = filepath;
    this._stream = null;
    this._offset = 0;

    this._interval = process.env.TRS_READ_INTERVAL || options.interval || DEFAULT_READ_INTERVAL;
    this._timeout = process.env.TRS_READ_TIMEOUT || options.timeout || DEFAULT_READ_TIMEOUT;
    this._watchinterval = process.env.TRS_WATCH_INTERVAL || options.watchinterval || DEFAULT_WATCH_INTERVAL;
    this._tailheadsize = process.env.TRS_TAILHEAD_SIZE || options.tailheadsize || DEFAULT_TAILHEAD_SIZE;
    this._tailheadage = process.env.TRS_TAILHEAD_AGE || options.tailheadage || DEFAULT_TAILHEAD_AGE;
    this._idle = 0;

    this._reading = false;
    this._paused = false;
    this._ended = false;
    this._watching = false;
};

TailReadStream.tail = function(filepath, fromstart, options) {
    if (typeof fromstart === 'object') { // shift args
        options = fromstart;
        fromstart = false;
    }
    var file = new this(filepath, options);
    if (fromstart) {
        if (typeof fromstart === 'boolean') {
            // read from start
            debug(filepath + ': reading from beginning of file');
            file._readFromOffsetUntilEof();
        } else {
            // read from offset
            debug(filepath + ': reading from offset ' + fromstart);
            file._readFromOffsetUntilEof(+fromstart);
        }
    } else {
        // tail from end
        file._getFileSizeAndReadUntilEof();
    }
    return file;
};

TailReadStream.prototype = Object.create(Readable.prototype);
TailReadStream.prototype.constructor = TailReadStream;

var TailReadStreamProto = {
    get offset() { return this._offset; }
    , get timeout() { return this._timeout; }
    , set timeout(timeout) { this._timeout = timeout; }

    , destroy: function() {
        this.readable = false;
        this._stream = null;
    }

    , pause: function() {
        this._paused = true;
        this._stream.pause();
    }

    , resume: function() {
        if (!this._stream) return;
        this._paused = false;
        this._stream.resume();
        this._readFromOffsetUntilEof();
    }

    , _readFromOffsetUntilEof: function(offset) {
        if (!isNaN(offset)) {
            this._offset = offset;
        }

        if (this._paused || this._reading) {
            return;
        }

        this._reading = true;

        this._stream = fs.createReadStream(this._filepath, {
            start: this._offset
        });

        this._stream.on('error', this._handleError.bind(this));
        this._stream.on('data', this._handleData.bind(this));
        this._stream.on('end', this._handleEnd.bind(this));
    }

    , _getFileSizeAndReadUntilEof: function() {
        var that = this;

        fs.stat(this._filepath, function(err, stats) {
            if (err) {
                that.readable = false;

                if (that._hasTimedOut()) {
                    debug(that._filepath + ': file does not exist, timed out after ' + that._timeout + 'ms');
                    that.emit('nofile', err);
                    return;
                }

                if (err.code === DOES_NOT_EXIST_ERROR) {
                    debug(that._filepath + ': file does not exist, waiting for it to appear...');
                    setTimeout(that._getFileSizeAndReadUntilEof.bind(that), that._interval);
                    that._idle += that._interval;
                    return;
                }

                that.emit('error', err);
                return;
            }

            if (stats.size < that._tailheadsize && Date.now() - stats.birthtime.getTime() < that._tailheadage) {
                debug(that._filepath + ': file is smaller than ' + that._tailheadsize + ' bytes and is ' + (Date.now() - stats.birthtime.getTime()) + 'ms old, reading from beginning');
                that._readFromOffsetUntilEof(0); // tail from beginning of file if small enough (e.g. newly created files)
            } else {
                that._readFromOffsetUntilEof(stats.size);
            }
        });
    }

    , _retryInInterval: function() {
        setTimeout(this._readFromOffsetUntilEof.bind(this), this._interval);
    }

    , _handleError: function(error) {
        this._reading = false;

        if (this._hasTimedOut()) {
            debug(this._filepath + ': file no longer exists, timed out after ' + this._timeout + 'ms');
            this.emit('nofile', error);
            return;
        }

        if (error.code === DOES_NOT_EXIST_ERROR) {
            debug(this._filepath + ': file renamed, waiting for it to reappear...');
            if (this.readable) {
                this.readable = false;
                this.emit('rename');
                this._offset = 0; // reset on rename
            }
            this._idle += this._interval;
            this._retryInInterval();
            return;
        }

        this.readable = false;

        this.emit('error', error);
    }

    , _handleData: function(data) {
        this.readable = true;

        this._offset += data.length;
        this._idle = 0;

        debug(this._filepath + ': reading ' + data.length + ' bytes');
        this.emit('data', data);
    }

    , _handleEnd: function() {
        this._reading = false;

        if (!this._watching) {
            this._watching = true;
            this._watchFile();
        }

        if (!this._hasTimedOut()) {
            this._retryInInterval();
            return;
        }

        this.destroy();
        this.emit('end');
    }

    , _hasTimedOut: function() {
        return this._idle >= this._timeout;
    }

    , _watchFile: function() {
        var that = this;

        if (!this.readable) {
            this._watching = false;
            return;
        }

        fs.stat(this._filepath, function(err, stats) {
            if (err) {
                return setTimeout(that._watchFile.bind(that), that._watchinterval);
            }

            if (stats.size < that._offset) {
                that.emit('truncate', stats.size);
                if (stats.size < that._tailheadsize) {
                    debug(that._filepath + ': file truncated but smaller than ' + that._tailheadsize + ' bytes, reading from beginning');
                    that._offset = 0;
                } else {
                    debug(that._filepath + ': file truncated but larger than ' + that._tailheadsize + ' bytes, reading from ' + stats.size);
                    that._offset = stats.size;
                }
            }

            setTimeout(that._watchFile.bind(that), that._watchinterval);
        });
    }
};

Object.keys(TailReadStreamProto).forEach(function(protoKey) {
    TailReadStream.prototype[protoKey] = TailReadStreamProto[protoKey];
});

module.exports = TailReadStream;
