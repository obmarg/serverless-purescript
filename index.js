'use strict';

const _        = require('lodash'),
      bluebird = require('bluebird'),
      mkdirp   = bluebird.promisify(require('mkdirp')),
      exec     = bluebird.promisify(require('child_process').exec,
                                    {multiArgs: true}),
      fs = require('fs'),
      writeFile = bluebird.promisify(fs.writeFile),
      unlink = bluebird.promisify(fs.unlink);

class Purescript {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;

    _.bindAll(this, ['compile', 'cleanup', 'offlineCompile', 'doCompile']);
    this.doCompile = bluebird.coroutine(this.doCompile);
    this.cleanup = bluebird.coroutine(this.cleanup);

    this.hooks = {
      // Build as part of a normal deploy
      'before:deploy:createDeploymentArtifacts': this.compile,
      'after:deploy:createDeploymentArtifacts': this.cleanup,

      // Build as part of a function only deploy
      'before:deploy:function:packageFunction': this.compile,
      'after:deploy:function:packageFunction': this.cleanup,

      // Add some hooks to let us work with serverless-offline.
      'before:offline:start': this.offlineCompile,
      'before:offline:start:init': this.offlineCompile,
      'before:offline:start:end': this.cleanup
    };

  }

  offlineCompile() {
    process.on('SIGINT', () => {
      this.cleanup();
    });
    return this.compile();
  }

  compile() {
    const debugMode =
          this.serverless.service.custom ?
          this.serverless.service.custom.purescriptDebug : false;

    const functions = _.filter(_.map(
      this.serverless.service.functions,
      (fn, key) => {
        if (fn.purescript) {
          const qualifiedName = fn.purescript,
                pathComponents = _.split(qualifiedName, '.'),
                moduleComponents = _.dropRight(pathComponents, 1),
                modulePath = _.join(moduleComponents, '.');

          return {
            name: key,
            qualifiedName: qualifiedName,
            module: modulePath
          };
        } else {
          return null;
        }
      }
    ));

    const modules = _.uniq(_.map(functions, 'module'));

    if (functions.length == 0) {
      return null;
    }

    // Now lets replace the serverless handlers w/ the correct data.
    _.map(functions, ({name}) => {
      // Ugh mutation :(
      this.serverless.service.functions[name].handler = `purescript.${name}`;
    });

    return this.doCompile(modules, functions, debugMode);
  }

  *doCompile(modules, functions, debugMode) {
    const workDir = `${this.serverless.config.servicePath}/.serverless/purescript`,
          srcGenDir = `${workDir}/gen`;

    yield mkdirp(srcGenDir);

    this.serverless.cli.log('Building entrypoints.');

    yield writeFile(
      `${srcGenDir}/handlers.purs`,
      purescriptEntrypointTemplate({
        modules: modules,
        functions: functions,
        debugMode: debugMode
      })
    );

    this.serverless.cli.log('Compiling Purescript.');

    yield exec(`pulp build -I ${srcGenDir}`);

    this.serverless.cli.log('Writing purescript entrypoints file.');

    yield writeFile(
      'purescript.js',
      javascriptEntrypointTemplate({
        functions: functions,
        debugMode: debugMode
      })
    );

    this.serverless.cli.log('PureScript built.');
  }

  *cleanup() {
    this.serverless.cli.log("Cleaning up purescript.");
    yield unlink('purescript.js');
  }
}

const purescriptEntrypointTemplate = _.template(`
module ServerlessPurescriptHandlers where
-- AUTOGENERATED FILE.  DO NOT MODIFY

import Prelude
import AWS.Lambda (Lambda, exposeLambda, runLambda)
import Main (Effects)
<% _.forEach(modules, function (module) { %>
import <%= module %> as <%= module %>
<% }); %>

<% _.forEach(functions, function (func) { %>
-- AUTOGENERATED FILE.  DO NOT MODIFY
--<%= func.name %> :: Lambda Effects
<%= func.name %> = exposeLambda $ runLambda <%= func.qualifiedName %>

<% }); %>
`);

const javascriptEntrypointTemplate = _.template(`
// AUTOGENERATED FILE.  DO NOT MODIFY.

const handlers = require('./output/ServerlessPurescriptHandlers');

<% _.forEach(functions, function (func) { %>
// AUTOGENERATED FILE.  DO NOT MODIFY.
exports.<%= func.name %> = function(data, context, callback) {
  <% if (debugMode) { %>
  console.log("Incoming Data: ");
  console.log(data);
  <% } %>
  handlers.<%= func.name %>(context, callback, data)();
}

<% }) %>
`);

module.exports = Purescript;
