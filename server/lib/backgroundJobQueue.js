const database = require('../sql/database');
const { logger } = require('./logger');
const { registry } = require('./providerRegistry');

/**
 * BackgroundJobQueue - Single unified job queue with three independent worker pools
 *
 * Worker pools (all share metadata_jobs table, each polls for its own job types):
 *   mbWorkers    (3) - MB requests + DB writes: artist_full, fetch_album_full, etc.
 *   wikiWorkers  (2) - Wikipedia overview fetches: fetch_artist_wiki, fetch_album_wiki
 *   imageWorkers (2) - Provider image fetches: fetch_artist_images, fetch_album_images
 *
 * imageDownloadQueue remains separate — it downloads URLs already stored in the images table.
 */

const MB_JOB_TYPES = [
  'artist_full', 'artist_releases', 'release_tracks',
  'fetch_artist', 'fetch_artist_albums', 'fetch_release',
  'fetch_album_full', 'download_image'
];

const WIKI_JOB_TYPES = ['fetch_artist_wiki', 'fetch_album_wiki'];

const IMAGE_JOB_TYPES = ['fetch_artist_images', 'fetch_album_images'];

class BackgroundJobQueue {
  constructor() {
    // MB worker pool
    this.mbWorkers = 0;
    this.maxMbWorkers = 1;
    this.mbInterval = null;

    // Wiki worker pool
    this.wikiWorkers = 0;
    this.maxWikiWorkers = 2;
    this.wikiInterval = null;

    // Provider image worker pool
    this.imageWorkers = 0;
    this.maxImageWorkers = 2;
    this.imageInterval = null;

    // processJob fn injected at startup
    this._processJobFn = null;
  }

  // ─── Provider availability helpers ──────────────────────────────────────────

  hasArtistImageProvider() {
    for (const [, provider] of registry.providers) {
      if (provider.constructor.capabilities?.artistImages) return true;
    }
    return false;
  }

  hasAlbumImageProvider() {
    for (const [, provider] of registry.providers) {
      if (provider.constructor.capabilities?.albumImages) return true;
    }
    return false;
  }

  // ─── Job queuing ────────────────────────────────────────────────────────────

  async queueJob(jobType, entityType, entityMbid, priority = 0, metadata = null) {
    try {
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

  // ─── Job fetching ────────────────────────────────────────────────────────────

  async _getNextJob(jobTypes) {
    try {
      const result = await database.query(`
        UPDATE metadata_jobs
        SET status = 'processing',
            started_at = NOW(),
            attempts = attempts + 1
        WHERE id = (
          SELECT id FROM metadata_jobs
          WHERE status = 'pending'
            AND job_type = ANY($1)
          ORDER BY priority DESC, created_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING *
      `, [jobTypes]);
      return result.rows[0] || null;
    } catch (error) {
      logger.error('Failed to get next job:', error);
      return null;
    }
  }

  // ─── Job completion ──────────────────────────────────────────────────────────

  async completeJob(jobId) {
    await database.query(
      `UPDATE metadata_jobs SET status = 'completed', completed_at = NOW() WHERE id = $1`,
      [jobId]
    );
    logger.info(`Job ${jobId} completed`);
  }

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
      logger.warn(`Job ${jobId} failed (attempt ${job.attempts}/${job.max_attempts}), will retry: ${errorMessage}`);
    }
  }

  // ─── MB worker pool ──────────────────────────────────────────────────────────

  _startMbPool(intervalMs) {
    this.mbInterval = setInterval(async () => {
      if (this.mbWorkers >= this.maxMbWorkers) return;
      try {
        const job = await this._getNextJob(MB_JOB_TYPES);
        if (job) {
          this.mbWorkers++;
          this._runMbJob(job).finally(() => { this.mbWorkers--; });
        }
      } catch (error) {
        logger.error('MB job processor error:', error);
      }
    }, intervalMs);
  }

  async _runMbJob(job) {
    if (job.attempts > 1) {
      logger.info(`Retrying job ${job.id}: ${job.job_type} for ${job.entity_mbid} (attempt ${job.attempts}/${job.max_attempts})`);
    } else {
      logger.info(`Processing job ${job.id}: ${job.job_type} for ${job.entity_mbid} [mb worker ${this.mbWorkers}/${this.maxMbWorkers}]`);
    }
    try {
      await this._processJobFn(job);
      await this.completeJob(job.id);
    } catch (error) {
      logger.error(`Job ${job.id} error: ${error.message}`);
      await this.failJob(job.id, error.message);
    }
  }

  // ─── Wiki worker pool ────────────────────────────────────────────────────────

  _startWikiPool(intervalMs) {
    this.wikiInterval = setInterval(async () => {
      if (this.wikiWorkers >= this.maxWikiWorkers) return;
      try {
        const job = await this._getNextJob(WIKI_JOB_TYPES);
        if (job) {
          this.wikiWorkers++;
          this._runWikiJob(job).finally(() => { this.wikiWorkers--; });
        }
      } catch (error) {
        logger.error('Wiki job processor error:', error);
      }
    }, intervalMs);
  }

  async _runWikiJob(job) {
    logger.info(`Wiki job ${job.id}: ${job.job_type} for ${job.entity_mbid} [wiki worker ${this.wikiWorkers}/${this.maxWikiWorkers}]`);
    try {
      if (job.job_type === 'fetch_artist_wiki') {
        await this._fetchArtistWiki(job.entity_mbid);
      } else if (job.job_type === 'fetch_album_wiki') {
        await this._fetchAlbumWiki(job.entity_mbid);
      }
      await this.completeJob(job.id);
    } catch (error) {
      logger.error(`Wiki job ${job.id} error: ${error.message}`);
      await this.failJob(job.id, error.message);
    }
  }

  async _fetchArtistWiki(mbid) {
    const existing = await database.query(
      'SELECT overview, name, type FROM artists WHERE mbid = $1', [mbid]
    );
    if (!existing.rows[0] || existing.rows[0].overview) return;

    const artist = existing.rows[0];
    const wikiProvider = registry.getProvider('wikipedia');
    if (!wikiProvider) return;

    let wikidataId = null;
    const mbProvider = registry.getProvider('musicbrainz');
    if (mbProvider) {
      try {
        const WikipediaProvider = require('../providers/wikipedia');
        const mbData = await mbProvider.getArtist(mbid);
        wikidataId = WikipediaProvider.extractWikidataId(mbData.relations || []);
      } catch (err) {
        logger.warn(`Wiki: Could not get MB relations for artist ${mbid}: ${err.message}`);
      }
    }

    const overview = await wikiProvider.getArtistOverview(wikidataId, artist.name, artist.type);
    if (overview) {
      await database.query('UPDATE artists SET overview = $1 WHERE mbid = $2', [overview, mbid]);
      logger.info(`Wiki: Stored artist overview for ${mbid} (${overview.length} chars)`);
    }
  }

  async _fetchAlbumWiki(mbid) {
    const existing = await database.query(
      'SELECT overview, title FROM release_groups WHERE mbid = $1', [mbid]
    );
    if (!existing.rows[0] || existing.rows[0].overview) return;

    const rg = existing.rows[0];
    const wikiProvider = registry.getProvider('wikipedia');
    if (!wikiProvider) return;

    const artistResult = await database.query(
      `SELECT a.name FROM artists a
       JOIN artist_release_groups arg ON arg.artist_mbid = a.mbid
       WHERE arg.release_group_mbid = $1 LIMIT 1`, [mbid]
    );
    const artistName = artistResult.rows[0]?.name || null;

    let wikidataId = null;
    const mbProvider = registry.getProvider('musicbrainz');
    if (mbProvider) {
      try {
        const WikipediaProvider = require('../providers/wikipedia');
        const mbData = await mbProvider.getReleaseGroup(mbid);
        wikidataId = WikipediaProvider.extractWikidataId(mbData.relations || []);
      } catch (err) {
        logger.warn(`Wiki: Could not get MB relations for album ${mbid}: ${err.message}`);
      }
    }

    const overview = await wikiProvider.getAlbumOverview(wikidataId, rg.title, artistName);
    if (overview) {
      await database.query('UPDATE release_groups SET overview = $1 WHERE mbid = $2', [overview, mbid]);
      logger.info(`Wiki: Stored album overview for "${rg.title}" (${overview.length} chars)`);
    }
  }

  // ─── Provider image worker pool ──────────────────────────────────────────────

  _startImagePool(intervalMs) {
    this.imageInterval = setInterval(async () => {
      if (this.imageWorkers >= this.maxImageWorkers) return;
      try {
        const job = await this._getNextJob(IMAGE_JOB_TYPES);
        if (job) {
          this.imageWorkers++;
          this._runImageJob(job).finally(() => { this.imageWorkers--; });
        }
      } catch (error) {
        logger.error('Provider image job processor error:', error);
      }
    }, intervalMs);
  }

  async _runImageJob(job) {
    logger.info(`Image job ${job.id}: ${job.job_type} for ${job.entity_mbid} [image worker ${this.imageWorkers}/${this.maxImageWorkers}]`);
    try {
      if (job.job_type === 'fetch_artist_images') {
        await this._fetchArtistImages(job.entity_mbid);
      } else if (job.job_type === 'fetch_album_images') {
        await this._fetchAlbumImages(job.entity_mbid);
      }
      await this.completeJob(job.id);
    } catch (error) {
      logger.error(`Image job ${job.id} error: ${error.message}`);
      await this.failJob(job.id, error.message);
    }
  }

  async _storeImageUrls(entityType, entityMbid, images, provider) {
    for (const image of images) {
      await database.query(`
        INSERT INTO images (entity_type, entity_mbid, url, cover_type, provider, last_verified_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (entity_mbid, cover_type, provider) DO UPDATE
          SET url = EXCLUDED.url, last_verified_at = NOW(), cached = false, cache_failed = false
      `, [entityType, entityMbid, image.Url, image.CoverType, image.Provider || provider]);
    }
    logger.info(`Image: Stored ${images.length} URLs for ${entityType} ${entityMbid} from ${provider}`);
  }

  async _fetchArtistImages(mbid) {
    const result = await database.query('SELECT name FROM artists WHERE mbid = $1', [mbid]);
    if (!result.rows[0]) return;
    const artistName = result.rows[0].name;

    const fanartProvider = registry.getProvider('fanart');
    if (fanartProvider) {
      try {
        const images = await fanartProvider.getArtistImages(mbid);
        if (images.length > 0) {
          await this._storeImageUrls('artist', mbid, images, 'fanart');
        }
      } catch (err) {
        logger.error(`Image: Fanart artist images failed for ${mbid}: ${err.message}`);
      }
    }
  }

  async _fetchAlbumImages(mbid) {
    const result = await database.query(
      `SELECT rg.title, a.name as artist_name
       FROM release_groups rg
       LEFT JOIN artist_release_groups arg ON arg.release_group_mbid = rg.mbid
       LEFT JOIN artists a ON a.mbid = arg.artist_mbid
       WHERE rg.mbid = $1 LIMIT 1`, [mbid]
    );
    if (!result.rows[0]) return;
    const { title, artist_name } = result.rows[0];

    const caaProvider = registry.getProvider('coverartarchive');
    if (caaProvider) {
      try {
        const images = await caaProvider.getAlbumImages(mbid);
        if (images.length > 0) {
          await this._storeImageUrls('release_group', mbid, images, 'coverartarchive');
          return;
        }
      } catch (err) {
        logger.warn(`Image: CAA album images failed for ${mbid}: ${err.message}`);
      }
    }

    const fanartProvider = registry.getProvider('fanart');
    if (fanartProvider?.getAlbumImages) {
      try {
        const images = await fanartProvider.getAlbumImages(mbid);
        if (images.length > 0) {
          await this._storeImageUrls('release_group', mbid, images, 'fanart');
        }
      } catch (err) {
        logger.error(`Image: Fanart album images failed for ${mbid}: ${err.message}`);
      }
    }
  }

  // ─── Startup / shutdown ──────────────────────────────────────────────────────

  async startProcessor(processJobFn, intervalMs = 1000) {
    this._processJobFn = processJobFn;

    await this._resetStuckJobs();

    this._startMbPool(intervalMs);
    this._startWikiPool(1000);
    this._startImagePool(500);

    // Cleanup old completed jobs hourly
    setInterval(() => {
      this._cleanupOldJobs().catch(err => logger.error('Cleanup error:', err));
    }, 3600000);

    logger.info(`Background job queue started — MB workers: ${this.maxMbWorkers}, Wiki workers: ${this.maxWikiWorkers}, Image workers: ${this.maxImageWorkers}`);
  }

  stopProcessor() {
    if (this.mbInterval) { clearInterval(this.mbInterval); this.mbInterval = null; }
    if (this.wikiInterval) { clearInterval(this.wikiInterval); this.wikiInterval = null; }
    if (this.imageInterval) { clearInterval(this.imageInterval); this.imageInterval = null; }
    logger.info('Background job queue stopped');
  }

  // ─── Maintenance ─────────────────────────────────────────────────────────────

  async _resetStuckJobs() {
    await database.query(`
      UPDATE metadata_jobs SET max_attempts = 5
      WHERE max_attempts < 5 AND status IN ('pending', 'processing', 'failed')
    `);
    await database.query(`
      UPDATE metadata_jobs SET status = 'pending'
      WHERE status = 'failed' AND attempts < max_attempts
    `);
    const result = await database.query(`
      UPDATE metadata_jobs SET status = 'pending', started_at = NULL
      WHERE status = 'processing'
      RETURNING id, job_type, entity_mbid
    `);
    if (result.rows.length > 0) {
      logger.info(`Reset ${result.rows.length} stuck jobs to pending`);
    }
  }

  async _cleanupOldJobs() {
    const result = await database.query(`
      DELETE FROM metadata_jobs
      WHERE status = 'completed' AND completed_at < NOW() - INTERVAL '7 days'
      RETURNING id
    `);
    if (result.rows.length > 0) {
      logger.info(`Cleaned up ${result.rows.length} old completed jobs`);
    }
  }

  // ─── Stats ───────────────────────────────────────────────────────────────────

  async getStats() {
    const result = await database.query(`
      SELECT status, COUNT(*) as count FROM metadata_jobs GROUP BY status
    `);
    const stats = {
      pending: 0, processing: 0, completed: 0, failed: 0,
      mb_workers: this.mbWorkers, max_mb_workers: this.maxMbWorkers,
      wiki_workers: this.wikiWorkers, max_wiki_workers: this.maxWikiWorkers,
      image_workers: this.imageWorkers, max_image_workers: this.maxImageWorkers,
      // keep legacy keys so dashboard doesn't break
      active_workers: this.mbWorkers, max_workers: this.maxMbWorkers
    };
    result.rows.forEach(row => { stats[row.status] = parseInt(row.count); });
    return stats;
  }
}

module.exports = new BackgroundJobQueue();
