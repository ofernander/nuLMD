const NodeCache = require('node-cache');
const { logger } = require('./logger');
const config = require('./config');

class CacheManager {
  constructor() {
    this.cache = null;
  }

  initialize() {
    const cacheConfig = config.get('cache', {});
    const ttl = cacheConfig.ttl || 3600;
    const maxSize = cacheConfig.maxSize || 1000;

    this.cache = new NodeCache({
      stdTTL: ttl,
      checkperiod: ttl * 0.2,
      useClones: false,
      maxKeys: maxSize
    });

    this.cache.on('expired', (key, value) => {
      logger.debug(`Cache key expired: ${key}`);
    });

    logger.info(`Cache initialized with TTL: ${ttl}s, Max size: ${maxSize}`);
  }

  get(key) {
    if (!this.cache) return null;
    
    const value = this.cache.get(key);
    if (value) {
      logger.debug(`Cache hit: ${key}`);
      return value;
    }
    
    logger.debug(`Cache miss: ${key}`);
    return null;
  }

  set(key, value, ttl = null) {
    if (!this.cache) return false;
    
    const success = ttl ? this.cache.set(key, value, ttl) : this.cache.set(key, value);
    if (success) {
      logger.debug(`Cache set: ${key}`);
    }
    return success;
  }

  del(key) {
    if (!this.cache) return 0;
    
    const count = this.cache.del(key);
    if (count > 0) {
      logger.debug(`Cache deleted: ${key}`);
    }
    return count;
  }

  flush() {
    if (!this.cache) return;
    
    this.cache.flushAll();
    logger.info('Cache flushed');
  }

  getStats() {
    if (!this.cache) return null;
    
    return this.cache.getStats();
  }

  has(key) {
    return this.cache ? this.cache.has(key) : false;
  }

  // Generate cache key from request parameters
  generateKey(prefix, params) {
    const sortedParams = Object.keys(params)
      .sort()
      .map(key => `${key}:${params[key]}`)
      .join('|');
    
    return `${prefix}:${sortedParams}`;
  }
}

module.exports = new CacheManager();
