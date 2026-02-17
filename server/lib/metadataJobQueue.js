const database = require('../sql/database');
const { logger } = require('./logger');

class MetadataJobQueue {
  constructor() {
    this.processing = false;
    this.processInterval = null;
  }

  /**
   * Queue a new metadata fetch job
   */
  async queueJob(jobType, entityType, entityMbid, priority = 0, metadata = null) {
    try {
      // Use INSERT ... ON CONFLICT to avoid duplicate jobs
      const result = await database.query(`
        INSERT INTO metadata_jobs (job_type, entity_type, entity_mbid, priority, metadata)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (job_type, entity_mbid) DO UPDATE
        SET priority = GREATEST(metadata_jobs.priority, EXCLUDED.priority),
            status = CASE 
              WHEN metadata_jobs.status = 'failed' THEN 'pending'
              ELSE metadata_jobs.status
            END
        RETURNING id
      `, [jobType, entityType, entityMbid, priority, metadata ? JSON.stringify(metadata) : null]);

      const jobId = result.rows[0].id;
      logger.info(`Queued job ${jobId}: ${jobType} for ${entityType} ${entityMbid}`);
      return jobId;
    } catch (error) {
      logger.error('Failed to queue job:', error);
      throw error;
    }
  }

  /**
   * Get next pending job
   */
  async getNextJob() {
    try {
      const result = await database.query(`
        UPDATE metadata_jobs
        SET status = 'processing',
            started_at = NOW(),
            attempts = attempts + 1
        WHERE id = (
          SELECT id FROM metadata_jobs
          WHERE status = 'pending'
          ORDER BY priority DESC, created_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING *
      `);

      return result.rows[0] || null;
    } catch (error) {
      logger.error('Failed to get next job:', error);
      return null;
    }
  }

  /**
   * Mark job as completed
   */
  async completeJob(jobId) {
    await database.query(`
      UPDATE metadata_jobs
      SET status = 'completed',
          completed_at = NOW()
      WHERE id = $1
    `, [jobId]);
    logger.info(`Job ${jobId} completed`);
  }

  /**
   * Mark job as failed
   */
  async failJob(jobId, errorMessage) {
    const result = await database.query(`
      UPDATE metadata_jobs
      SET status = CASE 
            WHEN attempts >= max_attempts THEN 'failed'
            ELSE 'pending'
          END,
          error_message = $2
      WHERE id = $1
      RETURNING status, attempts, max_attempts
    `, [jobId, errorMessage]);

    const job = result.rows[0];
    if (job.status === 'failed') {
      logger.error(`Job ${jobId} failed permanently after ${job.attempts}/${job.max_attempts} attempts: ${errorMessage}`);
    } else {
      const attemptsLeft = job.max_attempts - job.attempts;
      logger.warn(`Job ${jobId} failed (attempt ${job.attempts}/${job.max_attempts}), ${attemptsLeft} attempt(s) remaining - will retry automatically: ${errorMessage}`);
    }
  }

  /**
   * Get job statistics
   */
  async getStats() {
    const result = await database.query(`
      SELECT 
        status,
        COUNT(*) as count
      FROM metadata_jobs
      GROUP BY status
    `);

    const stats = {
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0
    };

    result.rows.forEach(row => {
      stats[row.status] = parseInt(row.count);
    });

    return stats;
  }

  /**
   * Clean up old completed jobs (older than 7 days)
   */
  async cleanupOldJobs() {
    const result = await database.query(`
      DELETE FROM metadata_jobs
      WHERE status = 'completed'
      AND completed_at < NOW() - INTERVAL '7 days'
      RETURNING id
    `);

    if (result.rows.length > 0) {
      logger.info(`Cleaned up ${result.rows.length} old completed jobs`);
    }
  }

  /**
   * Reset stuck jobs on startup
   */
  async resetStuckJobs() {
    // Bump max_attempts for any jobs still under the old default
    await database.query(`
      UPDATE metadata_jobs
      SET max_attempts = 5
      WHERE max_attempts < 5
      AND status IN ('pending', 'processing', 'failed')
    `);

    // Re-enable failed jobs that now have room for more attempts
    await database.query(`
      UPDATE metadata_jobs
      SET status = 'pending'
      WHERE status = 'failed'
      AND attempts < max_attempts
    `);

    const result = await database.query(`
      UPDATE metadata_jobs
      SET status = 'pending',
          started_at = NULL
      WHERE status = 'processing'
      RETURNING id, job_type, entity_mbid
    `);

    if (result.rows.length > 0) {
      logger.info(`Reset ${result.rows.length} stuck jobs to pending`);
      result.rows.forEach(job => {
        logger.info(`  - Job ${job.id}: ${job.job_type} for ${job.entity_mbid}`);
      });
    }
  }

  /**
   * Start the background job processor
   */
  async startProcessor(processJobFn, intervalMs = 5000) {
    // Reset any jobs that were stuck as 'processing' from previous run
    await this.resetStuckJobs();
    if (this.processInterval) {
      logger.warn('Metadata job processor already running');
      return;
    }

    logger.info('Starting metadata job queue processor');

    this.processInterval = setInterval(async () => {
      if (this.processing) {
        return; // Already processing a job
      }

      try {
        this.processing = true;
        const job = await this.getNextJob();

        if (job) {
          if (job.attempts > 1) {
            logger.info(`Retrying job ${job.id}: ${job.job_type} for ${job.entity_mbid} (attempt ${job.attempts}/${job.max_attempts})`);
          } else {
            logger.info(`Processing job ${job.id}: ${job.job_type} for ${job.entity_mbid}`);
          }

          try {
            await processJobFn(job);
            if (job.attempts > 1) {
              logger.info(`Job ${job.id} succeeded on attempt ${job.attempts} - recovered!`);
            }
            await this.completeJob(job.id);
          } catch (error) {
            logger.error(`Job ${job.id} processing error: ${error.message}`);
            await this.failJob(job.id, error.message);
          }
        }
      } catch (error) {
        logger.error('Metadata job processor error:', error);
      } finally {
        this.processing = false;
      }
    }, intervalMs);

    // Also run cleanup periodically
    setInterval(() => {
      this.cleanupOldJobs().catch(err => logger.error('Cleanup error:', err));
    }, 3600000); // Every hour
  }

  /**
   * Stop the background job processor
   */
  stopProcessor() {
    if (this.processInterval) {
      clearInterval(this.processInterval);
      this.processInterval = null;
      logger.info('Metadata job queue processor stopped');
    }
  }
}

module.exports = new MetadataJobQueue();
