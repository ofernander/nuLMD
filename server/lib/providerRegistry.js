const { logger } = require('./logger');
const config = require('./config');
const MusicBrainzProvider = require('../providers/musicbrainz');
const WikipediaProvider = require('../providers/wikipedia');
const CoverArtArchiveProvider = require('../providers/coverartarchive');
const FanartTVProvider = require('../providers/fanart');

class ProviderRegistry {
  constructor() {
    this.providers = new Map();
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) {
      logger.warn('Provider registry already initialized');
      return;
    }

    const providerConfigs = config.get('providers', {});

    // Mandatory providers that are always enabled
    const mandatoryProviders = ['musicbrainz', 'wikipedia'];

    // Initialize each provider based on configuration
    const providerClasses = {
      musicbrainz: MusicBrainzProvider,
      wikipedia: WikipediaProvider,
      coverartarchive: CoverArtArchiveProvider,
      fanart: FanartTVProvider
    };

    for (const [name, ProviderClass] of Object.entries(providerClasses)) {
      let providerConfig = providerConfigs[name] || {};
      
      // Special handling for Fanart: prioritize environment variable
      if (name === 'fanart' && process.env.FANART_API_KEY) {
        providerConfig = {
          ...providerConfig,
          enabled: true,
          apiKey: process.env.FANART_API_KEY
        };
      }
      
      // Always initialize mandatory providers, check enabled flag for optional ones
      const shouldInitialize = mandatoryProviders.includes(name) || providerConfig.enabled;
      
      if (shouldInitialize) {
        try {
          const provider = new ProviderClass(providerConfig);
          await provider.initialize();
          this.providers.set(name, provider);
          logger.info(`Provider initialized: ${name}`);
          
          // Log MusicBrainz server URL
          if (name === 'musicbrainz') {
            const mbUrl = providerConfig.baseUrl || process.env.MUSICBRAINZ_URL || 'https://musicbrainz.org/ws/2';
            logger.info(`MusicBrainz server: ${mbUrl}`);
          }
        } catch (error) {
          logger.error(`Failed to initialize provider ${name}:`, error);
        }
      } else {
        logger.info(`Provider disabled: ${name}`);
      }
    }

    this.initialized = true;
    logger.info(`Provider registry initialized with ${this.providers.size} active providers`);
  }

  getProvider(name) {
    return this.providers.get(name);
  }

  getAllProviders() {
    return Array.from(this.providers.values());
  }

  getActiveProviderNames() {
    return Array.from(this.providers.keys());
  }

  hasProvider(name) {
    return this.providers.has(name);
  }

  async queryAll(method, ...args) {
    const results = {};
    const promises = [];

    for (const [name, provider] of this.providers) {
      if (typeof provider[method] === 'function') {
        promises.push(
          provider[method](...args)
            .then(result => {
              results[name] = { success: true, data: result };
            })
            .catch(error => {
              logger.error(`Provider ${name} query failed:`, error);
              results[name] = { success: false, error: error.message };
            })
        );
      }
    }

    await Promise.all(promises);
    return results;
  }
}

const registry = new ProviderRegistry();

async function initializeProviders() {
  await registry.initialize();
}

module.exports = {
  registry,
  initializeProviders
};
