const axios = require('axios');
const { logger } = require('../lib/logger');
const { logConnection, finishCall, callOutcomeOf } = require('../lib/request');
const { USER_AGENT } = require('../lib/userAgent');

// Transient failures worth retrying (here, or on another source in the pool)
function isRetryableError(error) {
  return !!(error && error.message && (
    error.message.includes('Connection reset') ||
    error.message.includes('Service unavailable') ||
    error.message.includes('Rate limit exceeded') ||
    error.message.includes('ETIMEDOUT') ||
    error.message.includes('ECONNREFUSED') ||
    error.message.includes('socket hang up')
  ));
}

// MusicBrainz's own explanation of a failed request, from a parsed reply or from the raw text (JSON or XML)
function upstreamMessageOf(data) {
  if (data && typeof data === 'object') return data.error;
  if (typeof data !== 'string') return undefined;
  const xml = data.match(/<error>\s*<text>([^<]*)<\/text>/);
  if (xml) return xml[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  try { const parsed = JSON.parse(data); return parsed && parsed.error; } catch (_) { return undefined; }
}

class BaseProvider {
  constructor(name, config) {
    this.name = name;
    this.config = config;
    this.client = null;
    this.rateLimiter = null;
  }

  async initialize() {
    // Create axios instance with base configuration
    this.client = axios.create({
      baseURL: this.config.baseUrl,
      timeout: 30000,
      headers: {
        'User-Agent': USER_AGENT
      }
    });

    // How each call went and how long it took, for the request it was made for. This is registered before the error
    // handler below, which replaces the error with one that no longer carries the request.
    this.client.interceptors.response.use(
      response => {
        finishCall(response.config && response.config.nuCall, { status: 'ok', outcome: String(response.status) });
        return response;
      },
      error => {
        finishCall(error.config && error.config.nuCall, callOutcomeOf(error));
        return Promise.reject(error);
      }
    );

    // Add request interceptor for rate limiting
    if (this.config.rateLimit) {
      this.setupRateLimiter();
    }

    // Add response interceptor for error handling
    this.client.interceptors.response.use(
      response => response,
      error => this.handleError(error)
    );

    // Log every real outbound HTTP request to the connections feed
    const providerName = this.name;
    this.client.interceptors.request.use(config => {
      try {
        const base = (config.baseURL || '').replace(/\/$/, '');
        const path = (config.url || '');
        const params = config.params
          ? '?' + Object.entries(config.params)
              .filter(([k]) => k !== 'fmt' && k !== 'inc')
              .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
              .join('&')
          : '';
        config.nuCall = logConnection({
          direction: 'outbound',
          label: providerName,
          detail: base + path + params,
          status: 'ok'
        });
      } catch (_) {}
      return config;
    });
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
      
      // The status and MusicBrainz's own message travel with the error, so a caller relaying the request
      // (the /ws/2 proxy) can answer with the same status instead of guessing
      const failed = message => {
        const err = new Error(message);
        err.status = error.response.status;
        err.upstreamMessage = upstreamMessageOf(error.response.data);
        return err;
      };

      if (error.response.status === 404) {
        throw failed(`${this.name}: Resource not found`);
      }
      
      if (error.response.status === 429) {
        throw failed(`${this.name}: Rate limit exceeded`);
      }
      
      if (error.response.status === 401 || error.response.status === 403) {
        throw failed(`${this.name}: Authentication failed. Check your API credentials.`);
      }

      // 5xx (incl. 503 "busy, try again later") is transient — route through the
      // "Service unavailable" message so cachedRequest's backoff retries it.
      if (error.response.status >= 500) {
        throw failed(`${this.name}: Service unavailable (${error.response.status})`);
      }

      throw failed(`${this.name}: API error (${error.response.status})`);
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

  // Runs a request with retries on transient errors. (Despite the name nothing is cached here: stored copies live in the
  // database. `cacheKey` only names the request in the logs, and `ttl` is unused.)
  async cachedRequest(cacheKey, requestFn, ttl = null, retryOpts = {}) {
    // Make request with retry on transient errors. Defaults suit background fetches;
    // callers can tune the budget (e.g. search: more attempts, capped + jittered backoff
    // so a busy-MB spell recovers invisibly without one huge wait).
    // singleAttempt: the source pool owns retry/failover across sources, so don't retry here.
    const maxRetries = this.singleAttempt ? 1 : (retryOpts.maxRetries || 10);
    const backoffMs = retryOpts.backoffMs || 3000;
    const maxBackoffMs = retryOpts.maxBackoffMs || Infinity;
    const jitterMs = retryOpts.jitterMs || 0;
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
        return result;
      } catch (error) {
        lastError = error;
        const isRetryable = isRetryableError(error);
        if (isRetryable && attempt < maxRetries) {
          const capped = Math.min(attempt * backoffMs, maxBackoffMs);
          const backoff = capped + Math.floor(Math.random() * jitterMs);
          logger.warn(`${this.name}: Request failed (attempt ${attempt}/${maxRetries}): ${error.message} - will retry in ${(backoff / 1000).toFixed(1)}s`);
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

BaseProvider.isRetryableError = isRetryableError;
BaseProvider.upstreamMessageOf = upstreamMessageOf;

module.exports = BaseProvider;