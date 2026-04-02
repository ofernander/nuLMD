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
  'fetch_artist_albums',
  'fetch_album_full'
];

const WIKI_JOB_TYPES = ['fetch_artist_wiki', 'fetch_album_wiki'];

const IMAGE_JOB_TYPES = ['fetch_artist_images', 'fetch_album_images'];

class BackgroundJobQueue {
  constructor() {
    // MB worker pool
    this.mbWorkers = 0;
    this.maxMbWorkers = 1;
    this.mbInterval = null;
    this.mbPaused = false;

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

  async queueJob(jobType, entityType, entityMbid, priority = 0, metadata = null, parentJobId = null, rootArtistMbid = null) {
    try {
      // ON CONFLICT target differs based on whether this is a tree job or standalone job
      // due to two partial unique indexes (see schema).
      const conflictClause = rootArtistMbid
        ? `ON CONFLICT (job_type, entity_mbid, root_artist_mbid) WHERE root_artist_mbid IS NOT NULL`
        : `ON CONFLICT (job_type, entity_mbid) WHERE root_artist_mbid IS NULL`;

      const result = await database.query(`
        INSERT INTO metadata_jobs (job_type, entity_type, entity_mbid, priority, metadata, parent_job_id, root_artist_mbid)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ${conflictClause} DO UPDATE
          SET priority = GREATEST(metadata_jobs.priority, EXCLUDED.priority),
              status = CASE
                WHEN metadata_jobs.status = 'processing' THEN metadata_jobs.status
                WHEN metadata_jobs.status = 'completed' THEN metadata_jobs.status
                ELSE 'pending'
              END,
              attempts = CASE
                WHEN metadata_jobs.status = 'processing' THEN metadata_jobs.attempts
                WHEN metadata_jobs.status = 'completed' THEN metadata_jobs.attempts
                ELSE 0
              END
        RETURNING id, status
      `, [jobType, entityType, entityMbid, priority, metadata ? JSON.stringify(metadata) : null, parentJobId, rootArtistMbid]);

      const { id: jobId, status } = result.rows[0];
      if (status !== 'completed') {
        logger.info(`Queued job ${jobId}: ${jobType} for ${entityType} ${entityMbid}`);
      }
      return jobId;
    } catch (error) {
      logger.error('Failed to queue job:', error);
      throw error;
    }
  }

  async forceQueueJob(jobType, entityType, entityMbid, priority = 0, metadata = null, parentJobId = null, rootArtistMbid = null) {
    try {
      const conflictClause = rootArtistMbid
        ? `ON CONFLICT (job_type, entity_mbid, root_artist_mbid) WHERE root_artist_mbid IS NOT NULL`
        : `ON CONFLICT (job_type, entity_mbid) WHERE root_artist_mbid IS NULL`;

      const result = await database.query(`
        INSERT INTO metadata_jobs (job_type, entity_type, entity_mbid, priority, metadata, parent_job_id, root_artist_mbid)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ${conflictClause} DO UPDATE
          SET priority = GREATEST(metadata_jobs.priority, EXCLUDED.priority),
              status = CASE
                WHEN metadata_jobs.status = 'processing' THEN metadata_jobs.status
                ELSE 'pending'
              END,
              attempts = 0,
              metadata = CASE
                WHEN EXCLUDED.metadata IS NOT NULL THEN EXCLUDED.metadata
                ELSE (COALESCE(metadata_jobs.metadata, '{}'::jsonb) - 'lidarr_refresh_triggered')
              END
        RETURNING id
      `, [jobType, entityType, entityMbid, priority, metadata ? JSON.stringify(metadata) : null, parentJobId, rootArtistMbid]);

      const jobId = result.rows[0].id;
      logger.info(`Force-queued job ${jobId}: ${jobType} for ${entityType} ${entityMbid}`);
      return jobId;
    } catch (error) {
      logger.error('Failed to force-queue job:', error);
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
    const result = await database.query(
      `UPDATE metadata_jobs SET status = 'completed', completed_at = NOW() WHERE id = $1 RETURNING root_artist_mbid`,
      [jobId]
    );
    logger.info(`Job ${jobId} completed`);

    const rootArtistMbid = result.rows[0]?.root_artist_mbid;
    if (rootArtistMbid) {
      await this._checkAndTriggerRefresh(rootArtistMbid);
    }
  }

  // ─── Tree completion check ────────────────────────────────────────────────────

  async _checkAndTriggerRefresh(rootArtistMbid) {
    // Check if any jobs in this tree are still pending or processing
    const pending = await database.query(`
      SELECT 1 FROM metadata_jobs
      WHERE root_artist_mbid = $1
        AND status IN ('pending', 'processing')
      LIMIT 1
    `, [rootArtistMbid]);

    if (pending.rows.length > 0) return; // tree still running

    // Also wait for image downloads to complete for this artist's albums
    const pendingDownloads = await database.query(`
      SELECT 1 FROM images i
      WHERE (
        i.entity_mbid = $1
        OR i.entity_mbid IN (
          SELECT release_group_mbid FROM artist_release_groups WHERE artist_mbid = $1
        )
      )
      AND i.cached = false
      AND i.cache_failed = false
      LIMIT 1
    `, [rootArtistMbid]);

    if (pendingDownloads.rows.length > 0) return; // image downloads still pending

    // All jobs terminal — claim the refresh atomically so only one worker fires it
    // even if multiple jobs complete simultaneously.
    const claimed = await database.query(`
      UPDATE metadata_jobs
      SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"lidarr_refresh_triggered": true}'::jsonb
      WHERE root_artist_mbid = $1
        AND job_type = 'fetch_artist_albums'
        AND status = 'completed'
        AND (metadata IS NULL OR (metadata->>'lidarr_refresh_triggered') IS NULL)
      RETURNING id
    `, [rootArtistMbid]);

    if (claimed.rows.length === 0) return; // already triggered or no root job found

    logger.info(`Job tree complete for artist ${rootArtistMbid} — triggering Lidarr refresh`);
    const lidarrClient = require('./lidarrClient');
    if (lidarrClient.enabled) {
      lidarrClient.waitForArtistAndRefresh(rootArtistMbid).catch(err =>
        logger.warn(`Lidarr refresh failed for artist ${rootArtistMbid}: ${err.message}`)
      );
    }
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
      if (this.mbPaused || this.mbWorkers >= this.maxMbWorkers) return;
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
        await this._fetchArtistWiki(job.entity_mbid, job.metadata?.forceRefresh);
      } else if (job.job_type === 'fetch_album_wiki') {
        await this._fetchAlbumWiki(job.entity_mbid, job.metadata?.forceRefresh);
      }
      await this.completeJob(job.id);
    } catch (error) {
      logger.error(`Wiki job ${job.id} error: ${error.message}`);
      await this.failJob(job.id, error.message);
    }
  }

  async _fetchArtistWiki(mbid, force = false) {
    const existing = await database.query(
      'SELECT overview, name, type FROM artists WHERE mbid = $1', [mbid]
    );
    if (!existing.rows[0] || (!force && existing.rows[0].overview)) return;

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
      return;
    }

    // Fallback: try Deezer bio
    const deezerProvider = registry.getProvider('deezer');
    if (deezerProvider) {
      const bio = await deezerProvider.getArtistBio(artist.name);
      if (bio) {
        await database.query('UPDATE artists SET overview = $1 WHERE mbid = $2', [bio, mbid]);
        logger.info(`Deezer: Stored artist bio for ${mbid} (${bio.length} chars)`);
      }
    }
  }

  async _fetchAlbumWiki(mbid, force = false) {
    const existing = await database.query(
      'SELECT overview, title FROM release_groups WHERE mbid = $1', [mbid]
    );
    if (!existing.rows[0] || (!force && existing.rows[0].overview)) return;

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
        await this._fetchArtistImages(job.entity_mbid, job.metadata?.force);
      } else if (job.job_type === 'fetch_album_images') {
        await this._fetchAlbumImages(job.entity_mbid, job.metadata?.force);
      }
      await this.completeJob(job.id);
    } catch (error) {
      logger.error(`Image job ${job.id} error: ${error.message}`);
      await this.failJob(job.id, error.message);
    }
  }

  async _storeImageUrls(entityType, entityMbid, images, provider, force = false) {
    // Get all user-uploaded cover types for this entity so we don't overwrite them
    const userUploaded = await database.query(`
      SELECT cover_type FROM images
      WHERE entity_type = $1 AND entity_mbid = $2 AND user_uploaded = true
    `, [entityType, entityMbid]);
    const protectedTypes = new Set(userUploaded.rows.map(r => r.cover_type));

    let stored = 0;
    for (const image of images) {
      if (protectedTypes.has(image.CoverType)) {
        logger.info(`Image: Skipping ${image.CoverType} for ${entityType} ${entityMbid} — user upload takes precedence`);
        continue;
      }
      await database.query(`
        INSERT INTO images (entity_type, entity_mbid, url, cover_type, provider, last_verified_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (entity_mbid, cover_type, provider) DO UPDATE
          SET url = EXCLUDED.url,
              last_verified_at = NOW(),
              cached = CASE WHEN $6 THEN false WHEN images.url = EXCLUDED.url THEN images.cached ELSE false END,
              cache_failed = CASE WHEN $6 THEN false WHEN images.url = EXCLUDED.url THEN images.cache_failed ELSE false END
      `, [entityType, entityMbid, image.Url, image.CoverType, image.Provider || provider, force]);
      stored++;
    }
    logger.info(`Image: Stored ${stored}/${images.length} URLs for ${entityType} ${entityMbid} from ${provider}`);
  }

  async _fetchArtistImages(mbid, force = false) {
    const BLOCKED = new Set(['89ad4ac3-39f7-470e-963a-56509c546377', 'fe5b7087-438f-4e6e-bf3d-4a5b65e8d8b6']);
    if (BLOCKED.has(mbid)) return;

    const result = await database.query('SELECT name FROM artists WHERE mbid = $1', [mbid]);
    if (!result.rows[0]) return;

    // Skip image types we already have cached or user-uploaded
    const existing = await database.query(
      `SELECT DISTINCT cover_type FROM images
       WHERE entity_type = 'artist' AND entity_mbid = $1 AND (cached = true OR user_uploaded = true)`,
      [mbid]
    );
    const existingTypes = new Set(existing.rows.map(r => r.cover_type));

    const ARTIST_IMAGE_TYPES = ['Poster', 'Banner', 'Fanart', 'Logo'];

    // Provider fallback order: Fanart > Deezer
    // For each missing type, try providers in order, stop at first hit
    const providers = [
      registry.getProvider('fanart'),
      registry.getProvider('deezer')
    ].filter(Boolean);

    // Cache each provider's API response to avoid repeat calls
    const cache = new Map();
    const getImages = async (provider) => {
      if (!cache.has(provider.name)) {
        try {
          cache.set(provider.name, await provider.getArtistImages(mbid));
        } catch (err) {
          logger.warn(`Image: ${provider.name} artist images failed for ${mbid}: ${err.message}`);
          cache.set(provider.name, []);
        }
      }
      return cache.get(provider.name);
    };

    for (const type of ARTIST_IMAGE_TYPES) {
      for (const provider of providers) {
        const images = await getImages(provider);
        const match = images.find(img => img.CoverType === type);
        if (match) {
          await this._storeImageUrls('artist', mbid, [match], match.Provider || provider.name, force);
          break;
        }
      }
    }
  }

  async _fetchAlbumImages(mbid, force = false) {
    const result = await database.query(
      `SELECT rg.title, a.name as artist_name
       FROM release_groups rg
       LEFT JOIN artist_release_groups arg ON arg.release_group_mbid = rg.mbid
       LEFT JOIN artists a ON a.mbid = arg.artist_mbid
       WHERE rg.mbid = $1 LIMIT 1`, [mbid]
    );
    if (!result.rows[0]) return;

    // Skip image types we already have cached or user-uploaded
    const existing = await database.query(
      `SELECT DISTINCT cover_type FROM images
       WHERE entity_type = 'release_group' AND entity_mbid = $1 AND (cached = true OR user_uploaded = true)`,
      [mbid]
    );
    const existingTypes = new Set(existing.rows.map(r => r.cover_type));

    const ALBUM_IMAGE_TYPES = ['Cover', 'Disc'];
    // Provider fallback order: Fanart > CAA > Deezer
    // For each type, try providers in order, stop at first hit
    const providers = [
      registry.getProvider('fanart'),
      registry.getProvider('coverartarchive'),
      registry.getProvider('deezer')
    ].filter(Boolean);

    // Cache each provider's API response to avoid repeat calls
    const cache = new Map();
    const getImages = async (provider) => {
      if (!cache.has(provider.name)) {
        try {
          const fn = provider.getAlbumImages?.bind(provider);
          cache.set(provider.name, fn ? await fn(mbid) : []);
        } catch (err) {
          logger.warn(`Image: ${provider.name} album images failed for ${mbid}: ${err.message}`);
          cache.set(provider.name, []);
        }
      }
      return cache.get(provider.name);
    };

    for (const type of ALBUM_IMAGE_TYPES) {
      for (const provider of providers) {
        const images = await getImages(provider);
        const match = images.find(img => img.CoverType === type);
        if (match) {
          await this._storeImageUrls('release_group', mbid, [match], match.Provider || provider.name, force);
          break;
        }
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
