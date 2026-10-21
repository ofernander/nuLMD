const fs = require('fs').promises;
const path = require('path');
const yaml = require('js-yaml');
const { logger } = require('./logger');

class Config {
  constructor() {
    this.configPath = process.env.CONFIG_PATH || path.join(__dirname, '../../config/config.yml');
    this.config = null;
  }

  async load() {
    try {
      const configFile = await fs.readFile(this.configPath, 'utf8');
      this.config = yaml.load(configFile);
      logger.info(`Configuration loaded from: ${this.configPath}`);
      return this.config;
    } catch (error) {
      if (error.code === 'ENOENT') {
        logger.warn('Config file not found, creating default configuration');
        await this.createDefault();
        return this.config;
      }
      throw error;
    }
  }

  async createDefault() {
    const defaultConfig = {
      server: {
        port: 5001,
        host: '0.0.0.0',
        logLevel: 'info'
      },
      postgres: {
        host: process.env.POSTGRES_HOST || 'nulmd-db',
        port: process.env.POSTGRES_PORT || 5432,
        database: process.env.POSTGRES_DB || 'nulmd',
        user: process.env.POSTGRES_USER || 'nulmd',
        password: process.env.POSTGRES_PASSWORD || 'changeme'
      },
      providers: {
        musicbrainz: {
          enabled: true,
          baseUrl: '', // Empty = use default, or set custom MusicBrainz server URL
          sources: []  // Extra MusicBrainz sources: [{ url, priority, rateLimitMs, maxConcurrent, enabled }]
        },
        wikipedia: {
          enabled: true  // No API key needed!
        },
        coverartarchive: {
          enabled: true  // Album covers from MusicBrainz/Internet Archive
        },
        fanart: {
          apiKey: ''  // On when there is a key (FANART_API_KEY in the environment wins). Get a free key from https://fanart.tv/get-an-api-key/
        },
        deezer: {
          enabled: true  // Free, no API key needed
        }
        // lastfm: {
        //   enabled: false,
        //   apiKey: ''
        // },
        // discogs: {
        //   enabled: false,
        //   token: ''
        // }
      },
      lidarr: {
        compatibilityMode: 'plugin', // or 'legacy'
        metadataProfile: 'default'
      },
      lidarrIntegration: {   // On when there is a URL and a key (LIDARR_URL and LIDARR_API_KEY in the environment win)
        url: '',
        apiKey: ''
      },
      ws2: {
        enabled: process.env.WS2_ENABLED !== 'false', // MusicBrainz-compatible API at /ws/2
        apiKey: process.env.WS2_API_KEY || '',          // Empty = open. Set to require it (X-API-Key, Bearer token or ?apikey=)
        proxyTtlHours: 24,                              // How long a passed-through MusicBrainz reply is reused
        searchTtlHours: 24,                             // How long a search result is reused (also Lidarr's own search hits)
        emptySearchTtlMinutes: 15,                      // How long a search that found nothing is reused (never longer than the above)
        negativeTtlMinutes: 10                          // How long a "not found" / "needs an account" from MusicBrainz is remembered (0 = off)
      },
      logs: {
        requestLogDays: 30     // The request log (the dashboard's Requests and Responses history) keeps this many days; 0 = keep everything
      },
      metadata: {
        ttlDays: 30,           // Days before cached artist/album metadata is stale and re-fetched from MusicBrainz
        fullRefreshDays: 180,  // At the TTL an artist whose release and release group counts are unchanged only has its TTL renewed (2 requests); its whole catalog is fetched again this often regardless
      }
    };

    this.config = defaultConfig;
    
    // Ensure config directory exists
    const configDir = path.dirname(this.configPath);
    await fs.mkdir(configDir, { recursive: true });
    
    // Write default config
    await fs.writeFile(
      this.configPath,
      yaml.dump(defaultConfig),
      'utf8'
    );
    
    logger.info(`Default configuration created at: ${this.configPath}`);
  }

  async save() {
    try {
      await fs.writeFile(
        this.configPath,
        yaml.dump(this.config),
        'utf8'
      );
      logger.info('Configuration saved');
      return true;
    } catch (error) {
      logger.error('Failed to save configuration:', error);
      throw error;
    }
  }

  get(key, defaultValue = null) {
    const keys = key.split('.');
    let value = this.config;
    
    for (const k of keys) {
      if (value && typeof value === 'object' && k in value) {
        value = value[k];
      } else {
        return defaultValue;
      }
    }
    
    return value;
  }

  // Fanart and the Lidarr integration have no switch: each is on exactly when it has what it needs, and a value from the
  // environment (compose) beats the one saved in config.yml, field by field. To turn one off, remove its key.
  fanartSettings() {
    const fromEnv = String(process.env.FANART_API_KEY || '').trim();
    const apiKey = fromEnv || String(this.get('providers.fanart.apiKey', '') || '').trim();
    return { apiKey, enabled: !!apiKey, apiKeyFromEnv: !!fromEnv };
  }

  lidarrSettings() {
    const envUrl = String(process.env.LIDARR_URL || '').trim();
    const envKey = String(process.env.LIDARR_API_KEY || '').trim();
    const url = envUrl || String(this.get('lidarrIntegration.url', '') || '').trim();
    const apiKey = envKey || String(this.get('lidarrIntegration.apiKey', '') || '').trim();
    return { url, apiKey, enabled: !!(url && apiKey), urlFromEnv: !!envUrl, apiKeyFromEnv: !!envKey };
  }

  set(key, value) {
    const keys = key.split('.');
    let target = this.config;
    
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i];
      if (!(k in target) || typeof target[k] !== 'object') {
        target[k] = {};
      }
      target = target[k];
    }
    
    target[keys[keys.length - 1]] = value;
  }

  getAll() {
    return { ...this.config };
  }
}

module.exports = new Config();
