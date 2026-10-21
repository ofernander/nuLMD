/**
 * The /ws/2 services built once from the real database, registry and config, so the routes and the
 * background job runner share the same instances.
 */
const config = require('../config');
const database = require('../../sql/database');
const metaHandler = require('../metaHandler');
const { registry } = require('../providerRegistry');
const { WsLookup } = require('./lookup');
const { ProxyCache } = require('./proxy');
const { Browse } = require('./browse');
const { ApiKeys } = require('./keys');

let built;
function build() {
  if (!built) {
    const proxy = new ProxyCache({ database, registry, config });
    built = {
      lookup: new WsLookup({ database, metaHandler, registry, config }),
      proxy,
      browse: new Browse({ database, proxy, registry, config }),
      keys: new ApiKeys({ database, config })
    };
    // Old passed-through replies are cleared out a few times a day (it never keeps the process alive)
    const timer = setInterval(() => built.proxy.prune(), 6 * 3600 * 1000);
    if (timer.unref) timer.unref();
  }
  return built;
}

module.exports = { lookup: () => build().lookup, proxy: () => build().proxy, browse: () => build().browse, keys: () => build().keys };
