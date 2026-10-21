const { logger } = require('./logger');
const config = require('./config');
const MusicBrainzProvider = require('../providers/musicbrainz');
const WikipediaProvider = require('../providers/wikipedia');
const CoverArtArchiveProvider = require('../providers/coverartarchive');
const FanartTVProvider = require('../providers/fanart');
const DeezerProvider = require('../providers/deezer');
const { resolveMusicBrainzSources } = require('./mbSources');
const LmdUpstreamProvider = require('../providers/lmdupstream');
const { SourcePool, PoolSource, PooledMusicBrainz } = require('./sourcePool');

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
      fanart: FanartTVProvider,
      deezer: DeezerProvider
    };

    // Providers that are enabled by default (no API key needed)
    const enabledByDefault = ['coverartarchive', 'deezer'];

    for (const [name, ProviderClass] of Object.entries(providerClasses)) {
      let providerConfig = providerConfigs[name] || {};

      // Enable by default if no config exists and provider doesn't need a key
      if (!providerConfigs[name] && enabledByDefault.includes(name)) {
        providerConfig = { enabled: true };
      }

      // Fanart has no switch: it is on exactly when it has a key (the environment's key wins over the saved one)
      if (name === 'fanart') {
        const fanart = config.fanartSettings();
        providerConfig = { ...providerConfig, enabled: fanart.enabled, apiKey: fanart.apiKey };
      }
      
      // Always initialize mandatory providers, check enabled flag for optional ones
      const shouldInitialize = mandatoryProviders.includes(name) || providerConfig.enabled;
      
      if (shouldInitialize) {
        try {
          const provider = name === 'musicbrainz'
            ? await this.buildMusicBrainzPool(providerConfig)
            : new ProviderClass(providerConfig);
          if (name !== 'musicbrainz') await provider.initialize();
          this.providers.set(name, provider);
          logger.info(`Provider initialized: ${name}`);
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

  // MusicBrainz is a pool of one or more equivalent sources (MB servers and, optionally,
  // Lidarr metadata upstreams) behind a single provider facade
  async buildMusicBrainzPool(providerConfig) {
    const resolved = resolveMusicBrainzSources(providerConfig).filter(s => s.enabled);
    if (!resolved.some(s => s.type === 'musicbrainz')) throw new Error('No enabled MusicBrainz sources');
    const multi = resolved.length > 1;

    const sources = [];
    for (const r of resolved) {
      const host = r.url.replace(/^https?:\/\//, '').split('/')[0];
      const base = { baseUrl: r.url, rateLimitMs: r.rateLimitMs, label: multi ? host : undefined, singleAttempt: multi };
      const provider = r.type === 'lmd'
        ? new LmdUpstreamProvider({ ...base, enabledOps: r.enabledOps })
        : new MusicBrainzProvider(base);
      await provider.initialize();
      sources.push(new PoolSource({ ...r, id: host }, provider));
      logger.info(`${r.type === 'lmd' ? 'LMD upstream' : 'MusicBrainz source'}: ${r.url} (priority ${r.priority}, rate limit ${r.rateLimitMs ? r.rateLimitMs + 'ms' : 'none'}${r.fromEnv ? ', from env' : ''})`);
    }

    const pool = new SourcePool(sources, { retryProfile: m => MusicBrainzProvider.retryProfile(m) });
    return new PooledMusicBrainz(pool);
  }

  // Rebuild the MusicBrainz pool from current config and swap it in. Callers look the provider
  // up per call, so new calls use the new pool while in-flight ones finish on the old one.
  // On failure the old pool stays in place.
  async reloadMusicBrainz() {
    const pooled = await this.buildMusicBrainzPool(config.get('providers.musicbrainz', {}) || {});
    this.providers.set('musicbrainz', pooled);
    logger.info(`MusicBrainz pool reloaded: ${pooled.getStatus().length} source(s)`);
    return pooled;
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
