const database = require('../sql/database');
const { logger } = require('./logger');
const imageDownloader = require('./imageDownloader');

/**
 * Dedicated image download queue processor
 * Runs independently of metadata job queue to ensure images download quickly
 * Uses provider-specific rate limits
 */
class ImageDownloadQueue {
  constructor() {
    this.processing = false;
    this.processInterval = null;
    this.lastDownloadTime = {}; // Track last download time per provider
    
    // Provider-specific rate limits (milliseconds between requests)
    this.providerRateLimits = {
      'coverartarchive': 2500,  // 2.5s - conservative for 30 req/min limit
      'theaudiodb': 1000,       // 1s - conservative
      'fanart': 500,            // 0.5s - they allow 2 req/s
      'default': 1000           // 1s default for unknown providers
    };
  }

  /**
   * Get next pending download from images table
   * Returns full image record including provider for rate limiting
   */
  async getNextDownload() {
    try {
      // Find images that need downloading (not cached, not failed)
      // Prioritize artist images first (Lidarr requests these first)
      const result = await database.query(`
        SELECT id, provider
        FROM images
        WHERE cached = false 
        AND cache_failed = false
        ORDER BY 
          CASE WHEN entity_type = 'artist' THEN 0 ELSE 1 END,
          last_verified_at ASC
        LIMIT 1
      `);

      return result.rows[0] || null;
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
   * @param {number} intervalMs - How often to check for downloads (default 2000ms)
   */
  async startProcessor(intervalMs = 2000) {
    if (this.processInterval) {
      logger.warn('Image download processor already running');
      return;
    }

    logger.info('Starting image download queue processor');

    this.processInterval = setInterval(async () => {
      if (this.processing) {
        return; // Already processing a download
      }

      try {
        this.processing = true;
        const download = await this.getNextDownload();

        if (download) {
          const provider = download.provider || 'default';
          
          // Check if we can download from this provider (rate limiting)
          if (!this.canDownloadFromProvider(provider)) {
            const rateLimit = this.providerRateLimits[provider] || this.providerRateLimits.default;
            logger.debug(`Rate limit active for ${provider}, waiting ${rateLimit}ms between requests`);
            return; // Skip this iteration, will retry next interval
          }
          
          logger.debug(`Processing download for image ${download.id} from ${provider}`);
          
          try {
            await imageDownloader.processDownload(download.id);
            // Record successful download time for this provider
            this.recordDownload(provider);
          } catch (error) {
            logger.error(`Download ${download.id} processing error: ${error.message}`);
            // Still record download attempt to maintain rate limiting
            this.recordDownload(provider);
          }
        }
      } catch (error) {
        logger.error('Image download processor error:', error);
      } finally {
        this.processing = false;
      }
    }, intervalMs);
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
