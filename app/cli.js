"use strict";

const co = require('co');
const logger = require('../app/lib/logger')('cli');
const Q = require('q');
const _ = require('underscore');
const Command = require('commander').Command;
const contacter = require('../app/lib/contacter');
const directory = require('../app/lib/system/directory');
const wizard = require('../app/lib/wizard');
const multicaster = require('../app/lib/streams/multicaster');
const pjson = require('../package.json');
const duniter = require('../index');
const Peer = require('../app/lib/entity/peer');
const Block = require('../app/lib/entity/block');
const constants = require('../app/lib/constants');

module.exports = () => {

  const ERASE_IF_ALREADY_RECORDED = true;
  const NO_LOGS = true;

  const options = [];
  const commands = [];

  return {

    addOption: (optFormat, optDesc, optParser) => options.push({ optFormat, optDesc, optParser }),

    addCommand: (command, executionCallback) => commands.push({ command, executionCallback }),

    // To execute the provided command
    execute: (programArgs, onServiceCallback) => co(function*() {

      const program = new Command();

      let onResolve, onReject = () => Promise.reject(Error("Uninitilized rejection throw")), onService, closeCommand = () => Promise.resolve(true);
      const currentCommand = new Promise((resolve, reject) => {
        onResolve = resolve;
        onReject = reject;
      });

      program
        .version(pjson.version)
        .usage('<command> [options]')

        .option('--home <path>', 'Path to Duniter HOME (defaults to "$HOME/.config/duniter").')
        .option('-d, --mdb <name>', 'Database name (defaults to "duniter_default").')

        .option('--autoconf', 'With `config` and `init` commands, will guess the best network and key options witout asking for confirmation')
        .option('--ipv4 <address>', 'IPv4 interface to listen for requests')
        .option('--ipv6 <address>', 'IPv6 interface to listen for requests')
        .option('--remoteh <host>', 'Remote interface others may use to contact this node')
        .option('--remote4 <host>', 'Remote interface for IPv4 access')
        .option('--remote6 <host>', 'Remote interface for IPv6 access')
        .option('-p, --port <port>', 'Port to listen for requests', parseInt)
        .option('--remotep <port>', 'Remote port others may use to contact this node')
        .option('--upnp', 'Use UPnP to open remote port')
        .option('--noupnp', 'Do not use UPnP to open remote port')
        .option('--addep <endpoint>', 'With `config` command, add given endpoint to the list of endpoints of this node')
        .option('--remep <endpoint>', 'With `config` command, remove given endpoint to the list of endpoints of this node')

        .option('--cpu <percent>', 'Percent of CPU usage for proof-of-work computation', parsePercent)

        .option('-c, --currency <name>', 'Name of the currency managed by this node.')

        .option('--nointeractive', 'Disable interactive sync UI')
        .option('--nocautious', 'Do not check blocks validity during sync')
        .option('--cautious', 'Check blocks validity during sync (overrides --nocautious option)')
        .option('--nopeers', 'Do not retrieve peers during sync')
        .option('--nostdout', 'Disable stdout printing for `export-bc` command')
        .option('--noshuffle', 'Disable peers shuffling for `sync` command')

        .option('--timeout <milliseconds>', 'Timeout to use when contacting peers', parseInt)
        .option('--httplogs', 'Enable HTTP logs')
        .option('--nohttplogs', 'Disable HTTP logs')
        .option('--isolate', 'Avoid the node to send peering or status informations to the network')
        .option('--forksize <size>', 'Maximum size of fork window', parseInt)
        .option('--memory', 'Memory mode')
      ;

      for (const opt of options) {
        program
          .option(opt.optFormat, opt.optDesc, opt.optParser);
      }

      for (const cmd of commands) {
        program
          .command(cmd.command.name)
          .description(cmd.command.desc)
          .action(function() {
            const args = Array.from(arguments);
            return co(function*() {
              try {
                const resOfExecution = yield cmd.executionCallback.apply(null, [program].concat(args));
                onResolve(resOfExecution);
              } catch (e) {
                onReject(e);
              }
            });
          });
      }

      program
        .command('start')
        .description('Start Duniter node daemon.')
        .action(subCommand(service((server, conf) => new Promise((resolve, reject) => {
          co(function*() {
            try {
              const bma = require('./lib/streams/bma');

              logger.info(">> NODE STARTING");

              // Public http interface
              let bmapi = yield bma(server, null, conf.httplogs);

              // Routing documents
              server.routing();

              // Services
              yield server.startServices();
              yield bmapi.openConnections();

              logger.info('>> Server ready!');

            } catch (e) {
              reject(e);
            }
          });
        }))));

      program
        .command('stop')
        .description('Stop Duniter node daemon.')
        .action(subCommand(needsToBeLaunchedByScript));

      program
        .command('restart')
        .description('Restart Duniter node daemon.')
        .action(subCommand(needsToBeLaunchedByScript));

      program
        .command('peer [host] [port]')
        .description('Exchange peerings with another node')
        .action(subCommand(service(function (host, port, server) {
          return co(function *() {
            try {
              logger.info('Fetching peering record at %s:%s...', host, port);
              let peering = yield contacter.statics.fetchPeer(host, port);
              logger.info('Apply peering ...');
              yield server.PeeringService.submitP(peering, ERASE_IF_ALREADY_RECORDED, !program.nocautious);
              logger.info('Applied');
              let selfPeer = yield server.dal.getPeer(server.PeeringService.pubkey);
              if (!selfPeer) {
                yield Q.nfcall(server.PeeringService.generateSelfPeer, server.conf, 0);
                selfPeer = yield server.dal.getPeer(server.PeeringService.pubkey);
              }
              logger.info('Send self peering ...');
              var caster = multicaster();
              yield caster.sendPeering(Peer.statics.peerize(peering), Peer.statics.peerize(selfPeer));
              logger.info('Sent.');
              yield server.disconnect();
            } catch(e) {
              logger.error(e.code || e.message || e);
              throw Error("Exiting");
            }
          });
        })));

      program
        .command('revert [count]')
        .description('Revert (undo + remove) the top [count] blocks from the blockchain. EXPERIMENTAL')
        .action(subCommand(service(function (count, server) {
          return co(function *() {
            try {
              for (let i = 0; i < count; i++) {
                yield server.revert();
              }
            } catch (err) {
              logger.error('Error during revert:', err);
            }
            // Save DB
            yield server.disconnect();
          });
        })));

      program
        .command('revert-to [number]')
        .description('Revert (undo + remove) top blockchain blocks until block #[number] is reached. EXPERIMENTAL')
        .action(subCommand(service(function (number, server) {
          return co(function *() {
            try {
              yield server.revertTo(number);
            } catch (err) {
              logger.error('Error during revert:', err);
            }
            // Save DB
            if (server) {
              yield server.disconnect();
            }
          });
        })));

      program
        .command('reapply-to [number]')
        .description('Reapply reverted blocks until block #[number] is reached. EXPERIMENTAL')
        .action(subCommand(service(function (number, server) {
          return co(function *() {
            try {
              yield server.reapplyTo(number);
            } catch (err) {
              logger.error('Error during reapply:', err);
            }
            // Save DB
            if (server) {
              yield server.disconnect();
            }
          });
        })));

      program
        .command('export-bc [upto]')
        .description('Exports the whole blockchain as JSON array, up to [upto] block number (excluded).')
        .action(subCommand(service(function (upto, server) {
          return co(function *() {
            try {
              let CHUNK_SIZE = 500;
              let jsoned = [];
              let current = yield server.dal.getCurrentBlockOrNull();
              let lastNumber = current ? current.number + 1 : -1;
              if (upto !== undefined && upto.match(/\d+/)) {
                lastNumber = Math.min(parseInt(upto), lastNumber);
              }
              let chunksCount = Math.floor(lastNumber / CHUNK_SIZE);
              let chunks = [];
              // Max-size chunks
              for (let i = 0, len = chunksCount; i < len; i++) {
                chunks.push({start: i * CHUNK_SIZE, to: i * CHUNK_SIZE + CHUNK_SIZE - 1});
              }
              // A last chunk
              if (lastNumber > chunksCount * CHUNK_SIZE) {
                chunks.push({start: chunksCount * CHUNK_SIZE, to: lastNumber});
              }
              for (const chunk of chunks) {
                let blocks = yield server.dal.getBlocksBetween(chunk.start, chunk.to);
                blocks.forEach(function (block) {
                  jsoned.push(_(new Block(block).json()).omit('raw'));
                });
              }
              if (!program.nostdout) {
                console.log(JSON.stringify(jsoned, null, "  "));
              }
              yield server.disconnect();
              return jsoned;
            } catch(err) {
              logger.warn(err.message || err);
              yield server.disconnect();
            }
          });
        }, NO_LOGS)));

      program
        .command('check-config')
        .description('Checks the node\'s configuration')
        .action(subCommand(service(function (server) {
          return server.checkConfig()
            .then(function () {
              logger.warn('Configuration seems correct.');
            })
        })));

      program
        .command('reset [config|data|peers|tx|stats|all]')
        .description('Reset configuration, data, peers, transactions or everything in the database')
        .action(subCommand((type) => {
          let init = ['data', 'all'].indexOf(type) !== -1 ? getServer.bind(getServer, program) : connect;
          return init(function (server) {
            if (!~['config', 'data', 'peers', 'stats', 'all'].indexOf(type)) {
              throw constants.ERRORS.CLI_CALLERR_RESET;
            }
            return co(function*() {
              try {
                if (type == 'data') {
                  yield server.resetData();
                  logger.warn('Data successfully reseted.');
                }
                if (type == 'peers') {
                  yield server.resetPeers();
                  logger.warn('Peers successfully reseted.');
                }
                if (type == 'stats') {
                  yield server.resetStats();
                  logger.warn('Stats successfully reseted.');
                }
                if (type == 'config') {
                  yield server.resetConf();
                  logger.warn('Configuration successfully reseted.');
                }
                if (type == 'all') {
                  yield server.resetAll();
                  logger.warn('Data & Configuration successfully reseted.');
                }
              } catch (e) {
                logger.error(e);
              }
            });
          }, type != 'peers')(type);
        }));

      program
        .on('*', function (cmd) {
          console.log("Unknown command '%s'. Try --help for a listing of commands & options.", cmd);
          onResolve();
        });

      function subCommand(promiseFunc) {
        return function() {
          let args = Array.prototype.slice.call(arguments, 0);
          return co(function*() {
            try {
              let result = yield promiseFunc.apply(null, args);
              onResolve(result);
            } catch (e) {
              if (e && e.uerr) {
                onReject(e.uerr.message);
              } else {
                onReject(e);
              }
            }
          })
        };
      }

      function connect(callback, useDefaultConf) {
        return function () {
          const cbArgs = arguments;
          const dbName = program.mdb || "duniter_default";
          const dbHome = program.home;

          const home = directory.getHome(dbName, dbHome);
          const theServer = duniter(home, program.memory === true, commandLineConf(program));

          // If ever the process gets interrupted
          let isSaving = false;
          closeCommand = () => co(function*() {
            if (!isSaving) {
              isSaving = true;
              // Save DB
              return theServer.disconnect();
            }
          });

          // Initialize server (db connection, ...)
          return theServer.plugFileSystem(useDefaultConf)
            .then(() => theServer.loadConf())
            .then(function () {
              try {
                cbArgs.length--;
                cbArgs[cbArgs.length++] = theServer;
                cbArgs[cbArgs.length++] = theServer.conf;
                return callback.apply(this, cbArgs);
              } catch(e) {
                theServer.disconnect();
                throw e;
              }
            });
        };
      }

      function service(callback, nologs) {

        return function () {

          if (nologs) {
            // Disable logs
            require('../app/lib/logger')().mute();
          }

          const cbArgs = arguments;
          const dbName = program.mdb;
          const dbHome = program.home;

          // Add log files for this instance
          logger.addHomeLogs(directory.getHome(dbName, dbHome));

          const home = directory.getHome(dbName, dbHome);
          const theServer = duniter(home, program.memory === true, commandLineConf(program));

          // If ever the process gets interrupted
          let isSaving = false;
          closeCommand = () => co(function*() {
            if (!isSaving) {
              isSaving = true;
              // Save DB
              return theServer.disconnect();
            }
          });

          const that = this;

          // Initialize server (db connection, ...)
          return co(function*() {
            try {
              yield theServer.initWithDAL();
              yield configure(program, theServer, theServer.conf || {});
              yield theServer.loadConf();
              cbArgs.length--;
              cbArgs[cbArgs.length++] = theServer;
              cbArgs[cbArgs.length++] = theServer.conf;
              cbArgs[cbArgs.length++] = program;
              onService && onService(theServer);
              return callback.apply(that, cbArgs);
            } catch (e) {
              theServer.disconnect();
              throw e;
            }
          });
        };
      }

      onService = onServiceCallback;
      program.parse(programArgs);

      if (programArgs.length <= 2) {
        onReject('No command given.');
      }

      const res = yield currentCommand;
      if (closeCommand) {
        yield closeCommand();
      }
      return res;
    })
  };
};

/****************
 *
 *   UTILITIES
 *
 ****************/

function commandLineConf(program, conf) {

  conf = conf || {};
  conf.sync = conf.sync || {};
  const cli = {
    currency: program.currency,
    cpu: program.cpu,
    server: {
      port: program.port,
      ipv4address: program.ipv4,
      ipv6address: program.ipv6,
      remote: {
        host: program.remoteh,
        ipv4: program.remote4,
        ipv6: program.remote6,
        port: program.remotep
      }
    },
    db: {
      mport: program.mport,
      mdb: program.mdb,
      home: program.home
    },
    net: {
      upnp: program.upnp,
      noupnp: program.noupnp
    },
    logs: {
      http: program.httplogs,
      nohttp: program.nohttplogs
    },
    endpoints: [],
    rmEndpoints: [],
    isolate: program.isolate,
    forksize: program.forksize,
    nofork: program.nofork,
    timeout: program.timeout
  };

  // Update conf
  if (cli.currency)                         conf.currency = cli.currency;
  if (cli.server.ipv4address)               conf.ipv4 = cli.server.ipv4address;
  if (cli.server.ipv6address)               conf.ipv6 = cli.server.ipv6address;
  if (cli.server.port)                      conf.port = cli.server.port;
  if (cli.server.remote.host != undefined)  conf.remotehost = cli.server.remote.host;
  if (cli.server.remote.ipv4 != undefined)  conf.remoteipv4 = cli.server.remote.ipv4;
  if (cli.server.remote.ipv6 != undefined)  conf.remoteipv6 = cli.server.remote.ipv6;
  if (cli.server.remote.port != undefined)  conf.remoteport = cli.server.remote.port;
  if (cli.net.upnp)                         conf.upnp = true;
  if (cli.net.noupnp)                       conf.upnp = false;
  if (cli.cpu)                              conf.cpu = Math.max(0.01, Math.min(1.0, cli.cpu));
  if (cli.logs.http)                        conf.httplogs = true;
  if (cli.logs.nohttp)                      conf.httplogs = false;
  if (cli.db.mport)                         conf.mport = cli.db.mport;
  if (cli.db.home)                          conf.home = cli.db.home;
  if (cli.db.mdb)                           conf.mdb = cli.db.mdb;
  if (cli.isolate)                          conf.isolate = cli.isolate;
  if (cli.timeout)                          conf.timeout = cli.timeout;
  if (cli.forksize != null)                 conf.forksize = cli.forksize;

  // Specific internal settings
  conf.createNext = true;
  return _(conf).extend({routing: true});
}

/**
 * Super basic server with only its home path set
 * @param program
 * @param callback
 * @returns {Function}
 */
function getServer(program, callback) {
  return function () {
    var cbArgs = arguments;
    var dbName = program.mdb || "duniter_default";
    var dbHome = program.home;

    const home = directory.getHome(dbName, dbHome);
    var server = duniter(home, program.memory === true, commandLineConf(program));

    cbArgs.length--;
    cbArgs[cbArgs.length++] = server;
    cbArgs[cbArgs.length++] = server.conf;
    return callback.apply(this, cbArgs);
  };
}

function parsePercent(s) {
  var f = parseFloat(s);
  return isNaN(f) ? 0 : f;
}

function needsToBeLaunchedByScript() {
  logger.error('This command must not be launched directly, using duniter.sh script');
  return Promise.resolve();
}

function configure(program, server, conf) {
  return co(function *() {
    if (typeof server == "string" || typeof conf == "string") {
      throw constants.ERRORS.CLI_CALLERR_CONFIG;
    }
    let wiz = wizard();
    // UPnP override
    if (program.noupnp === true) {
      conf.upnp = false;
    }
    if (program.upnp === true) {
      conf.upnp = true;
    }
    // Network autoconf
    const autoconfNet = program.autoconf
      || !(conf.ipv4 || conf.ipv6)
      || !(conf.remoteipv4 || conf.remoteipv6 || conf.remotehost)
      || !(conf.port && conf.remoteport);
    if (autoconfNet) {
      yield Q.nbind(wiz.networkReconfiguration, wiz)(conf, autoconfNet, program.noupnp);
    }
    // Try to add an endpoint if provided
    if (program.addep) {
      if (conf.endpoints.indexOf(program.addep) === -1) {
        conf.endpoints.push(program.addep);
      }
      // Remove it from "to be removed" list
      const indexInRemove = conf.rmEndpoints.indexOf(program.addep);
      if (indexInRemove !== -1) {
        conf.rmEndpoints.splice(indexInRemove, 1);
      }
    }
    // Try to remove an endpoint if provided
    if (program.remep) {
      if (conf.rmEndpoints.indexOf(program.remep) === -1) {
        conf.rmEndpoints.push(program.remep);
      }
      // Remove it from "to be added" list
      const indexInToAdd = conf.endpoints.indexOf(program.remep);
      if (indexInToAdd !== -1) {
        conf.endpoints.splice(indexInToAdd, 1);
      }
    }
    return server.dal.saveConf(conf)
      .then(function () {
        try {
          logger.debug("Configuration saved.");
          return conf;
        } catch (e) {
          logger.error("Configuration could not be saved: " + e);
          throw Error(e);
        }
      });
  });
}
