const database = require('../sql/database');
const { logger } = require('./logger');
const imageDownloader = require('./imageDownloader');
const config = require('./config');

/**
 * Dedicated image download queue processor
 * Runs independently of metadata job queue to ensure images download quickly
 * Uses provider-specific rate limits
 */
class ImageDownloadQueue {
  constructor() {
    this.activeWorkers = 0;
    this.maxWorkers = 6;
    this.processInterval = null;
    this.lastDownloadTime = {}; // Track last download time per provider
    this.inFlight = new Set();  // ids being downloaded right now
    this.retryAfterMs = 60 * 60 * 1000;   // a failed download is tried again an hour after it failed

    // Provider-specific rate limits (milliseconds between requests)
    this.providerRateLimits = {
      'coverartarchive': Number(config.get('providers.coverartarchive.rateLimitMs', 1000)),  // same pace as its API calls
      'theaudiodb': 1000,       // 1s - conservative
      'fanart': 500,            // 0.5s - they allow 2 req/s
      'deezer': 1000,           // 1s - conservative for free tier
      'default': 1000           // 1s default for unknown providers
    };
  }

  /**
   * Get the next download that can start now: the head of each provider's queue is considered (waiting downloads before
   * retries, artist images first, then oldest), and the first whose provider is outside its rate-limit window and which is
   * not already being downloaded wins. A provider that has to wait therefore never holds up the others.
   * A retry is a download that failed (transiently) at least `retryAfterMs` ago and has failed fewer than
   * `maxAutoRetries` times; failures from before the count existed are not retried (refresh them in the image explorer).
   * Returns the image record's id and provider for rate limiting.
   */
  async getNextDownload() {
    try {
      const result = await database.query(`
        SELECT DISTINCT ON (provider) id, provider, entity_type, last_verified_at, cache_failed
        FROM images
        WHERE cached = false
        AND (cache_failed = false
             OR (download_failures < $2 AND last_failed_at IS NOT NULL AND last_failed_at <= $3))
        AND id <> ALL($1::bigint[])
        ORDER BY provider,
          cache_failed ASC,
          CASE WHEN entity_type = 'artist' THEN 0 ELSE 1 END,
          last_verified_at ASC
      `, [[...this.inFlight], imageDownloader.maxAutoRetries, new Date(Date.now() - this.retryAfterMs)]);

      const heads = result.rows.sort((a, b) =>
        (a.cache_failed ? 1 : 0) - (b.cache_failed ? 1 : 0) ||
        (a.entity_type === 'artist' ? 0 : 1) - (b.entity_type === 'artist' ? 0 : 1) ||
        new Date(a.last_verified_at) - new Date(b.last_verified_at));
      return heads.find(row => this.canDownloadFromProvider(row.provider || 'default')) || null;
    } catch (error) {
      logger.error('Failed to get next download:', error);
      return null;
    }
  }

  /**
   * Check if enough time has passed since last download for this provider
   * @param {string} provider - Provider name
   * @returns {boolean} - True if we can proceed with download
   */
  canDownloadFromProvider(provider) {
    const rateLimit = this.providerRateLimits[provider] || this.providerRateLimits.default;
    const lastTime = this.lastDownloadTime[provider] || 0;
    const now = Date.now();
    const timeSinceLastDownload = now - lastTime;
    
    return timeSinceLastDownload >= rateLimit;
  }

  /**
   * Record download time for provider rate limiting
   * @param {string} provider - Provider name
   */
  recordDownload(provider) {
    this.lastDownloadTime[provider] = Date.now();
  }

  /**
   * Start the download processor
   * @param {number} intervalMs - How often to check for downloads (default 500ms)
   */
  async startProcessor(intervalMs = 500) {
    if (this.processInterval) {
      logger.warn('Image download processor already running');
      return;
    }

    logger.info('Starting image download queue processor');

    this.processInterval = setInterval(() => this._fillWorkers(), intervalMs);
  }

  // Start a download on every free worker whose provider is ready, not one per tick, and again as each download ends
  async _fillWorkers() {
    if (this._filling) return;
    this._filling = true;
    try {
      while (this.activeWorkers < this.maxWorkers) {
        const download = await this.getNextDownload();
        if (!download) break;

        const provider = download.provider || 'default';
        logger.debug(`Processing download for image ${download.id} from ${provider} [worker ${this.activeWorkers + 1}/${this.maxWorkers}]`);
        this.activeWorkers++;
        this.inFlight.add(String(download.id));
        this.recordDownload(provider);
        this._runDownload(download.id).finally(() => {
          this.activeWorkers--;
          this.inFlight.delete(String(download.id));
          if (this.processInterval) this._fillWorkers();
        });
      }
    } catch (error) {
      logger.error('Image download processor error:', error);
    } finally {
      this._filling = false;
    }
  }

  async _runDownload(imageId) {
    try {
      await imageDownloader.processDownload(imageId);

      // Fire refresh check in background — don't let it stall the download loop
      this._checkRefreshAsync(imageId).catch(err =>
        logger.error(`Refresh check failed for image ${imageId}: ${err.message}`)
      );
    } catch (error) {
      logger.error(`Download ${imageId} processing error: ${error.message}`);
    }
  }

  async _checkRefreshAsync(imageId) {
    const backgroundJobQueue = require('./backgroundJobQueue');
    const imgResult = await database.query(
      `SELECT entity_type, entity_mbid FROM images WHERE id = $1`,
      [imageId]
    );
    if (imgResult.rows.length === 0) return;
    const { entity_type, entity_mbid } = imgResult.rows[0];
    let artistMbid = entity_type === 'artist' ? entity_mbid : null;
    if (!artistMbid) {
      const argResult = await database.query(
        `SELECT artist_mbid FROM artist_release_groups WHERE release_group_mbid = $1 LIMIT 1`,
        [entity_mbid]
      );
      artistMbid = argResult.rows[0]?.artist_mbid || null;
    }
    if (artistMbid) {
      await backgroundJobQueue._checkAndTriggerRefresh(artistMbid);
    }
  }

  /**
   * Stop the download processor
   */
  stopProcessor() {
    if (this.processInterval) {
      clearInterval(this.processInterval);
      this.processInterval = null;
      logger.info('Image download queue processor stopped');
    }
  }

  /**
   * Get download statistics
   */
  async getStats() {
    const result = await database.query(`
      SELECT 
        cached,
        cache_failed,
        COUNT(*) as count
      FROM images
      GROUP BY cached, cache_failed
    `);

    const stats = {
      pending: 0,
      cached: 0,
      failed: 0
    };

    result.rows.forEach(row => {
      if (row.cached) {
        stats.cached = parseInt(row.count);
      } else if (row.cache_failed) {
        stats.failed = parseInt(row.count);
      } else {
        stats.pending = parseInt(row.count);
      }
    });

    return stats;
  }
}

module.exports = new ImageDownloadQueue();
