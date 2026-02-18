const axios = require('axios');
const { logger } = require('../lib/logger');
const cache = require('../lib/cache');

class BaseProvider {
  constructor(name, config) {
    this.name = name;
    this.config = config;
    this.client = null;
    this.rateLimiter = null;
  }

  async initialize() {
    const pkg = require('../../package.json');
    
    // Create axios instance with base configuration
    this.client = axios.create({
      baseURL: this.config.baseUrl,
      timeout: 30000,
      headers: {
        'User-Agent': `${pkg.name}/${pkg.version} ( ${pkg.repository?.url || pkg.homepage || 'https://github.com/yourusername/nuLMD'} )`
      }
    });

    // Add request interceptor for rate limiting
    if (this.config.rateLimit) {
      this.setupRateLimiter();
    }

    // Add response interceptor for error handling
    this.client.interceptors.response.use(
      response => response,
      error => this.handleError(error)
    );
  }

  setupRateLimiter() {
    const { requests, period } = this.config.rateLimit;
    const delay = period / requests;
    let queue = Promise.resolve();

    this.client.interceptors.request.use(config => {
      // Chain all requests through a single queue to prevent concurrent firing
      queue = queue.then(async () => {
        const now = Date.now();
        if (!this._lastRequestTime) this._lastRequestTime = 0;
        const timeSinceLastRequest = now - this._lastRequestTime;

        if (timeSinceLastRequest < delay) {
          const waitTime = delay - timeSinceLastRequest;
          logger.debug(`${this.name}: Rate limiting, waiting ${waitTime}ms`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }

        this._lastRequestTime = Date.now();
      });
      return queue.then(() => config);
    });
  }

  async handleError(error) {
    if (error.response) {
      // Server responded with error status
      // 404 is normal for CoverArtArchive - not all albums have cover art
      const logLevel = error.response.status === 404 ? 'warn' : 'error';
      logger[logLevel](`${this.name} API error:`, {
        status: error.response.status,
        data: error.response.data
      });
      
      if (error.response.status === 404) {
        throw new Error(`${this.name}: Resource not found`);
      }
      
      if (error.response.status === 429) {
        throw new Error(`${this.name}: Rate limit exceeded`);
      }
      
      if (error.response.status === 401 || error.response.status === 403) {
        throw new Error(`${this.name}: Authentication failed. Check your API credentials.`);
      }
      
      throw new Error(`${this.name}: API error (${error.response.status})`);
    } else if (error.request) {
      // Request made but no response (connection error, timeout, etc)
      const errorCode = error.code || 'UNKNOWN';
      logger.error(`${this.name}: No response received`, { code: errorCode, message: error.message });
      
      // ECONNRESET means connection was dropped - could be rate limiting or server issue
      if (errorCode === 'ECONNRESET') {
        throw new Error(`${this.name}: Connection reset by server (possible rate limit or timeout)`);
      }
      
      throw new Error(`${this.name}: Service unavailable (${errorCode})`);
    } else {
      logger.error(`${this.name}: Request setup error`, error.message);
      throw new Error(`${this.name}: ${error.message}`);
    }
  }

  async cachedRequest(cacheKey, requestFn, ttl = null) {
    // Check cache first
    const cached = cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    // Make request with retry on transient errors (5 attempts with exponential backoff)
    const maxRetries = 10;
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 1) {
          logger.info(`${this.name}: Attempt ${attempt}/${maxRetries} for ${cacheKey} - retrying now...`);
        }
        const result = await requestFn();
        if (attempt > 1) {
          logger.info(`${this.name}: Request succeeded on attempt ${attempt}/${maxRetries} for ${cacheKey}`);
        }
        cache.set(cacheKey, result, ttl);
        return result;
      } catch (error) {
        lastError = error;
        const isRetryable = error.message && (
          error.message.includes('Connection reset') ||
          error.message.includes('Service unavailable') ||
          error.message.includes('Rate limit exceeded') ||
          error.message.includes('ETIMEDOUT') ||
          error.message.includes('ECONNREFUSED') ||
          error.message.includes('socket hang up')
        );
        if (isRetryable && attempt < maxRetries) {
          const backoff = attempt * 3000; // 3s, 6s, 9s, 12s
          logger.warn(`${this.name}: Request failed (attempt ${attempt}/${maxRetries}): ${error.message} - will retry in ${backoff / 1000}s`);
          await new Promise(resolve => setTimeout(resolve, backoff));
        } else if (!isRetryable) {
          logger.warn(`${this.name}: Non-retryable error for ${cacheKey}: ${error.message}`);
          throw error;
        } else {
          logger.warn(`${this.name}: Request failed after all ${maxRetries} attempts for ${cacheKey}: ${error.message}`);
          throw error;
        }
      }
    }
    throw lastError;
  }

  // Methods to be implemented by specific providers
  async searchArtist(query) {
    throw new Error('searchArtist not implemented');
  }

  async getArtist(id) {
    throw new Error('getArtist not implemented');
  }

  async searchAlbum(query) {
    throw new Error('searchAlbum not implemented');
  }

  async getAlbum(id) {
    throw new Error('getAlbum not implemented');
  }

  async getAlbumTracks(albumId) {
    throw new Error('getAlbumTracks not implemented');
  }
}

module.exports = BaseProvider;