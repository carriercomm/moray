// Copyright (c) 2012 Joyent, Inc.  All rights reserved.

var http = require('http');
var fs = require('fs');

var Logger = require('bunyan');
var restify = require('restify');

var buckets = require('./buckets');
var db = require('./db');
var objects = require('./objects');
var search = require('./search');


///--- Globals

var VERSION = false;
var ServerResponse = http.ServerResponse;



///--- Override restify response handling

ServerResponse.prototype.defaultResponseHeaders = function (data) {
    this.setHeader('Connection', this.keepAlive ? 'Keep-Alive' : 'close');
    this.setHeader('X-Request-Id', this.id);
    if (this.etag)
        this.setHeader('Etag', this.etag);

    var now = new Date().getTime();
    this.setHeader('X-Response-Time', now - this.req.time.getTime());
};




///--- Internal functions

/**
 * Returns the current semver version stored in CloudAPI's package.json.
 * This is used to set in the API versioning and in the Server header.
 *
 * @return {String} version.
 */
function version() {
    if (!VERSION) {
        var pkg = fs.readFileSync(__dirname + '/../package.json', 'utf8');
        VERSION = JSON.parse(pkg).version;
    }

    return VERSION;
}


/**
 * Reads and processes a configuration file.
 *
 * Overrides should be command line options (i.e., what you got from nopt).
 *
 * @arg {string} file      - config file to read.
 * @arg {object} overrides - command-line options.
 * @return {object} fully parsed configuration.
 * @throws {TypeError} on bad input.
 */
function configure(file, options) {
    assertString('file', file);
    assertObject('options', options);

    var config;
    var overrides = options.overrides || {};

    try {
        config = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (overrides.port) {
            config.port = overrides.port;
        } else if (!config.port) {
            config.port = (config.certificate && config.key) ? 443 : 80;
        }
    } catch (e) {
        console.error('Unable to parse %s: %s', file, e.message);
        process.exit(1);
    }

    try {
        if (config.certificate)
            config.certificate = fs.readFileSync(config.certificate, 'utf8');
    } catch (e) {
        console.error('Unable to load %s: %s', config.certificate, e.message);
        process.exit(1);
    }

    try {
        if (config.key)
            config.key = fs.readFileSync(config.key, 'utf8');
    } catch (e) {
        console.error('Unable to load %s: %s', config.certificate, e.message);
        process.exit(1);
    }

    if (!config.postgres) {
        console.error('Missing Postgres configuration from %s', file);
        process.exit(1);
    }

    if (!config.marker) {
        console.error('Missing AES configuration for markers in %s', file);
        process.exit(1);
    }

    config.dtrace = options.dtrace;
    config.log = options.log;
    config.log.level(config.logLevel);
    config.marker.iv = new Buffer(config.marker.iv, 'hex').toString('ascii');
    config.marker.key = new Buffer(config.marker.key, 'hex').toString('ascii');
    config.name = 'Moray ' + version();
    config.version = version();
    config.postgres.log = options.log;
    if (config.logLevel)
        config.log.level(config.logLevel);

    return config;
}



///--- API

module.exports = {

    /**
     * Wrapper over restify's createServer to make testing and
     * configuration handling easier.
     *
     * The returned server object will have a '.start()' method on it, which
     * wraps up the port/host settings for you.
     *
     * @arg {object} options      - options object.
     * @arg {string} options.file - configuration file to read from.
     * @arg {object} options.log  - bunyan logger.
     * @arg {function} callback   - of the form f(err, server).
     * @throws {TypeError} on bad input.
     */
    createServer: function createServer(options, callback) {
        assertObject('options', options);
        assertObject('options.log', options.log);
        assertFunction('callback', callback);

        var config = configure(options.file, options);
        db.createBucketManager(config.postgres, function (err, bucketMgr) {
            if (err)
                return callback(err);

            config.postgres.bucketManager = bucketMgr;
            var pgCfg = config.postgres;
            return db.createObjectManager(pgCfg, function (err2, objectMgr) {
                if (err2)
                    return callback(err2);

                var server = restify.createServer(config);
                server.objectManager = objectMgr;
                server.bucketManager = bucketMgr;

                server.use(restify.acceptParser(server.acceptable));
                server.use(restify.dateParser(config.maxRequestAge || 10));
                server.use(restify.queryParser());

                server.use(function addProxies(req, res, next) {
                    req.config = config;
                    req.bucketManager = bucketMgr;
                    req.objectManager = objectMgr;
                    return next();
                });

                search.mount(server);
                buckets.mount(server);
                objects.mount(server);

                server.on('after', restify.auditLogger({
                    body: true,
                    log: new Logger({
                        name: 'audit',
                        streams: [
                            {
                                level: process.env.LOG_LEVEL || 'info',
                                stream: process.stdout
                            }
                        ]
                    })
                }));

                server.start = function start(cb) {
                    return server.listen(config.port, cb);
                };

                server.stop = function stop(cb) {
                    server.on('close', function () {
                        objectMgr.pgClient.shutdown(function () {
                            bucketMgr.pgClient.shutdown(function () {
                                if (typeof (cb) === 'function')
                                    return cb();
                                return false;
                            });
                        });
                    });
                    server.close();
                };

                return callback(null, server);
            });
        });
    }

};