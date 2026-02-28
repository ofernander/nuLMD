const { logger } = require('./logger');
const config = require('./config');
const database = require('../sql/database');
const metaHandler = require('./metaHandler');
const cron = require('node-cron');

class BulkRefresher {
  constructor() {
    this.cronJob = null;
    this.isRunning = false;
  }

  /**
   * Start the bulk refresh cron job
   * Runs daily at 3am, checks if bulk refresh is due
   */
  start() {
    // Run daily at 3am
    this.cronJob = cron.schedule('0 3 * * *', async () => {
      await this.checkAndRefresh();
    });

    logger.info('Bulk refresh scheduler started (runs daily at 3am)');
  }

  /**
   * Stop the bulk refresh cron job
   */
  stop() {
    if (this.cronJob) {
      this.cronJob.stop();
      logger.info('Bulk refresh scheduler stopped');
    }
  }

  /**
   * Check if bulk refresh is due and run it
   */
  async checkAndRefresh() {
    if (this.isRunning) {
      logger.info('Bulk refresh already running, skipping scheduled check');
      return;
    }

    try {
      const bulkRefreshInterval = config.get('refresh.bulkRefreshInterval', 180);
      const lastRefresh = await database.getLastBulkRefresh();

      if (!lastRefresh) {
        // Fresh database — don't immediately re-fetch everything.
        // Record a synthetic bulk refresh so it waits the full interval.
        logger.info('No previous bulk refresh found — recording baseline, will refresh after configured interval');
        const baselineId = await database.startBulkRefresh();
        await database.completeBulkRefresh(baselineId, 0);
        return;
      }

      // Check if enough days have passed
      const lastRefreshDate = new Date(lastRefresh.completed_at);
      const daysSinceRefresh = (Date.now() - lastRefreshDate.getTime()) / (1000 * 60 * 60 * 24);

      if (daysSinceRefresh >= bulkRefreshInterval) {
        logger.info(`Bulk refresh due (${Math.floor(daysSinceRefresh)} days since last refresh, interval: ${bulkRefreshInterval} days)`);
        await this.runBulkRefresh();
      } else {
        logger.info(`Bulk refresh not due yet (${Math.floor(daysSinceRefresh)} days since last refresh, interval: ${bulkRefreshInterval} days)`);
      }
    } catch (error) {
      logger.error('Error checking bulk refresh status:', error);
    }
  }

  /**
   * Manually trigger a bulk refresh (called from API)
   */
  async triggerManualRefresh() {
    if (this.isRunning) {
      throw new Error('Bulk refresh already running');
    }

    logger.info('Manual bulk refresh triggered');
    await this.runBulkRefresh();
  }

  /**
   * Run the bulk refresh process
   */
  async runBulkRefresh() {
    this.isRunning = true;
    let refreshId = null;

    try {
      // Start tracking
      refreshId = await database.startBulkRefresh();
      logger.info(`Starting bulk refresh (ID: ${refreshId})`);

      // Get all artists
      const artistMbids = await database.getAllArtistMbids();
      logger.info(`Found ${artistMbids.length} artists to refresh`);

      let successCount = 0;
      let failCount = 0;

      // Refresh each artist
      for (let i = 0; i < artistMbids.length; i++) {
        const mbid = artistMbids[i];
        
        try {
          await metaHandler.refreshArtist(mbid);
          successCount++;
          
          if ((i + 1) % 10 === 0) {
            logger.info(`Bulk refresh progress: ${i + 1}/${artistMbids.length} artists (${successCount} successful, ${failCount} failed)`);
          }
        } catch (error) {
          failCount++;
          logger.error(`Failed to refresh artist ${mbid} during bulk refresh:`, error);
        }

        // Small delay to avoid overwhelming MusicBrainz
        // MusicBrainz provider handles rate limiting, but this adds extra safety
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // Mark complete
      await database.completeBulkRefresh(refreshId, successCount);
      logger.info(`Bulk refresh complete: ${successCount} artists refreshed successfully, ${failCount} failed`);

    } catch (error) {
      logger.error('Bulk refresh failed:', error);
      if (refreshId) {
        await database.failBulkRefresh(refreshId);
      }
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Get current bulk refresh status
   */
  async getStatus() {
    const lastRefresh = await database.getLastBulkRefresh();
    const bulkRefreshInterval = config.get('refresh.bulkRefreshInterval', 180);

    if (!lastRefresh) {
      return {
        lastRefresh: null,
        daysSinceRefresh: null,
        nextRefreshDue: null,
        isRunning: this.isRunning
      };
    }

    const lastRefreshDate = new Date(lastRefresh.completed_at);
    const daysSinceRefresh = Math.floor((Date.now() - lastRefreshDate.getTime()) / (1000 * 60 * 60 * 24));
    const nextRefreshDue = Math.max(0, bulkRefreshInterval - daysSinceRefresh);

    return {
      lastRefresh: lastRefreshDate,
      daysSinceRefresh,
      nextRefreshDue,
      artistsRefreshed: lastRefresh.artists_refreshed,
      isRunning: this.isRunning
    };
  }
}

module.exports = new BulkRefresher();
