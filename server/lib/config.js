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
      logger.info('Configuration loaded from:', this.configPath);
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
      cache: {
        enabled: process.env.CACHE_ENABLED !== 'false', // Default true unless explicitly disabled
        ttl: parseInt(process.env.CACHE_TTL) || 3600, // 1 hour in seconds
        maxSize: parseInt(process.env.CACHE_MAX_SIZE) || 1000
      },
      providers: {
        musicbrainz: {
          enabled: true,
          baseUrl: '' // Empty = use default, or set custom MusicBrainz server URL
        },
        wikipedia: {
          enabled: true  // No API key needed!
        },
        coverartarchive: {
          enabled: false  // Album cover downloads - default OFF (Lidarr handles this)
        },
        theaudiodb: {
          enabled: false  // Secondary image source - default OFF
        },
        fanart: {
          enabled: !!process.env.FANART_API_KEY,  // Auto-enable if API key in environment
          apiKey: process.env.FANART_API_KEY || ''  // Get free key from https://fanart.tv/get-an-api-key/
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
      refresh: {
        artistTTL: parseInt(process.env.ARTIST_TTL_DAYS) || 7, // Days before artist data expires
        bulkRefreshInterval: parseInt(process.env.BULK_REFRESH_DAYS) || 180 // Days between bulk refreshes
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
    
    logger.info('Default configuration created at:', this.configPath);
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
