const database = require('../sql/database');
const { logger } = require('./logger');
const { registry } = require('./providerRegistry');
const config = require('./config');
const { getLastInboundAt } = require('./request');
const BaseProvider = require('../providers/base');
const blocklist = require('./blocklist');

/**
 * BackgroundJobQueue - Single unified job queue with three independent worker pools
 *
 * Worker pools (all share metadata_jobs table, each polls for its own job types):
 *   mbWorkers    (3) - MB requests + DB writes: artist_full, fetch_album_full, etc.
 *   wikiWorkers  (3)  - Wikipedia overview fetches: fetch_artist_wiki, fetch_album_wiki (album jobs run in batches)
 *   imageWorkers (8)  - Provider image fetches: fetch_artist_images, fetch_album_images
 *   backfillWorker (1) - Fills gaps in rows that came from a non-MusicBrainz source. Runs only
 *                        while nuLMD is idle, and only ever talks to MusicBrainz sources.
 *
 * imageDownloadQueue remains separate — it downloads URLs already stored in the images table.
 */

const MB_JOB_TYPES = [
  'fetch_artist_albums',
  'fetch_album_full'
];

// Upper bound on parallel MB workers regardless of how many sources are configured
const MAX_MB_WORKERS = 4;

const WIKI_JOB_TYPES = ['fetch_artist_wiki', 'fetch_album_wiki'];

const IMAGE_JOB_TYPES = ['fetch_artist_images', 'fetch_album_images'];

const BACKFILL_JOB_TYPES = ['backfill_artist', 'backfill_album'];
// Finishing the browse lists /ws/2 keeps: idle-time work like the backfill, but not tied to its on/off switch
const LIST_JOB_TYPES = ['complete_rg_list', 'complete_release_list'];
const BACKFILL_SWEEP_BATCH = 20;
// nuLMD counts as idle once Lidarr has been quiet this long (and nothing is queued or running)
const IDLE_AFTER_MS = 30 * 1000;
// How long a failed job waits before its next attempt (seconds, by attempts made so far; the last step repeats)
const COOL_OFF_SECONDS = [15, 30, 60, 120, 240, 300];
// Waiting album overview jobs are taken together, this many at a time, so their Wikipedia lookups go out batched
const WIKI_ALBUM_BATCH = 20;

class BackgroundJobQueue {
  constructor() {
    // MB worker pool
    this.mbWorkers = 0;
    this.maxMbWorkers = 1;
    this.mbInterval = null;
    this.mbPaused = false;

    // Wiki worker pool
    this.wikiWorkers = 0;
    this.maxWikiWorkers = 3;    // each worker runs one artist job, or one batch of up to WIKI_ALBUM_BATCH album jobs
    this.wikiInterval = null;

    // Provider image worker pool
    this.imageWorkers = 0;
    this.maxImageWorkers = 8;
    this.imageInterval = null;

    // Backfill worker (idle-time MusicBrainz gap filling)
    this.backfillWorkers = 0;
    this.maxBackfillWorkers = 1;
    this.backfillInterval = null;
    this.backfillSweepInterval = null;

    // processJob fn injected at startup
    this._processJobFn = null;
  }

  // More MB sources = more MB jobs can usefully run in parallel (capped)
  refreshMbCapacity() {
    const mb = registry.getProvider('musicbrainz');
    if (mb && typeof mb.getCapacity === 'function') {
      this.maxMbWorkers = Math.min(Math.max(1, mb.getCapacity()), MAX_MB_WORKERS);
    }
    return this.maxMbWorkers;
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
    if (blocklist.blocksJob(entityType, entityMbid, rootArtistMbid)) { logger.info(`Not queuing ${jobType} for blocked ${entityType} ${entityMbid}`); return null; }
    try {
      // ON CONFLICT target differs based on whether this is a tree job or standalone job
      // due to two partial unique indexes (see schema).
      const conflictClause = rootArtistMbid
        ? `ON CONFLICT (job_type, entity_mbid, root_artist_mbid) WHERE root_artist_mbid IS NOT NULL`
        : `ON CONFLICT (job_type, entity_mbid) WHERE root_artist_mbid IS NULL`;

      const result = await database.query(`
        INSERT INTO metadata_jobs (job_type, entity_type, entity_mbid, priority, metadata, parent_job_id, root_artist_mbid)
        -- parent_job_id is a soft tree link (ON DELETE SET NULL). If the parent was
        -- killed/pruned while this subtree is still queuing children, degrade to an
        -- orphan (NULL parent) in-statement instead of a hard FK violation.
        VALUES ($1, $2, $3, $4, $5, (SELECT id FROM metadata_jobs WHERE id = $6), $7)
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
              END,
              run_after = CASE
                WHEN metadata_jobs.status IN ('processing', 'completed') THEN metadata_jobs.run_after
                ELSE NULL
              END
        RETURNING id, status
      `, [jobType, entityType, entityMbid, priority, metadata ? JSON.stringify(metadata) : null, parentJobId, rootArtistMbid]);

      const { id: jobId, status } = result.rows[0];
      if (status !== 'completed') {
        logger.info(`Queued job ${jobId}: ${jobType} for ${entityType} ${entityMbid}`);
      }
      this._maybePrune().catch(err => logger.warn(`Job prune error: ${err.message}`));
      return jobId;
    } catch (error) {
      logger.error('Failed to queue job:', error);
      throw error;
    }
  }

  async forceQueueJob(jobType, entityType, entityMbid, priority = 0, metadata = null, parentJobId = null, rootArtistMbid = null) {
    if (blocklist.blocksJob(entityType, entityMbid, rootArtistMbid)) { logger.info(`Not queuing ${jobType} for blocked ${entityType} ${entityMbid}`); return null; }
    try {
      const conflictClause = rootArtistMbid
        ? `ON CONFLICT (job_type, entity_mbid, root_artist_mbid) WHERE root_artist_mbid IS NOT NULL`
        : `ON CONFLICT (job_type, entity_mbid) WHERE root_artist_mbid IS NULL`;

      const result = await database.query(`
        INSERT INTO metadata_jobs (job_type, entity_type, entity_mbid, priority, metadata, parent_job_id, root_artist_mbid)
        -- parent_job_id is a soft tree link (ON DELETE SET NULL). If the parent was
        -- killed/pruned while this subtree is still queuing children, degrade to an
        -- orphan (NULL parent) in-statement instead of a hard FK violation.
        VALUES ($1, $2, $3, $4, $5, (SELECT id FROM metadata_jobs WHERE id = $6), $7)
        ${conflictClause} DO UPDATE
          SET priority = GREATEST(metadata_jobs.priority, EXCLUDED.priority),
              status = CASE
                WHEN metadata_jobs.status = 'processing' THEN metadata_jobs.status
                ELSE 'pending'
              END,
              attempts = 0,
              run_after = NULL,
              metadata = CASE
                WHEN EXCLUDED.metadata IS NOT NULL THEN EXCLUDED.metadata
                ELSE (COALESCE(metadata_jobs.metadata, '{}'::jsonb) - 'lidarr_refresh_triggered' - 'lidarr_refresh_delivered' - 'lidarr_stage1_triggered' - 'lidarr_stage1_delivered')
              END
        RETURNING id
      `, [jobType, entityType, entityMbid, priority, metadata ? JSON.stringify(metadata) : null, parentJobId, rootArtistMbid]);

      const jobId = result.rows[0].id;
      logger.info(`Force-queued job ${jobId}: ${jobType} for ${entityType} ${entityMbid}`);
      this._maybePrune().catch(err => logger.warn(`Job prune error: ${err.message}`));
      return jobId;
    } catch (error) {
      logger.error('Failed to force-queue job:', error);
      throw error;
    }
  }

  // ─── Job fetching ────────────────────────────────────────────────────────────

  async _getNextJob(jobTypes) {
    return (await this._claimJobs(jobTypes, 1))[0] || null;
  }

  // Takes up to `limit` waiting jobs of these types (highest priority, then oldest) and marks them as running
  async _claimJobs(jobTypes, limit) {
    try {
      const result = await database.query(`
        UPDATE metadata_jobs
        SET status = 'processing',
            started_at = NOW(),
            attempts = attempts + 1
        WHERE id IN (
          SELECT id FROM metadata_jobs
          WHERE status = 'pending'
            AND job_type = ANY($1)
            AND (run_after IS NULL OR run_after <= NOW())
          ORDER BY priority DESC, created_at ASC
          LIMIT $2
          FOR UPDATE SKIP LOCKED
        )
        RETURNING *
      `, [jobTypes, limit]);
      return result.rows;
    } catch (error) {
      logger.error('Failed to get next job:', error);
      return [];
    }
  }

  // ─── Job completion ──────────────────────────────────────────────────────────

  async completeJob(jobId) {
    // Only complete a job still in 'processing'. If it was killed (kill-active sets
    // 'failed') or pruned while its loop ran, don't resurrect it to 'completed'.
    const result = await database.query(
      `UPDATE metadata_jobs SET status = 'completed', completed_at = NOW() WHERE id = $1 AND status = 'processing' RETURNING root_artist_mbid`,
      [jobId]
    );
    if (result.rows.length === 0) {
      logger.info(`Job ${jobId} not marked completed (killed or removed while running)`);
      return;
    }
    logger.info(`Job ${jobId} completed`);

    const rootArtistMbid = result.rows[0]?.root_artist_mbid;
    if (rootArtistMbid) {
      await this._checkAndTriggerRefresh(rootArtistMbid);
    }
  }

  /** Is a catalog job for this artist running, or queued and ready to run? (One waiting out a pause is not.) */
  async isCatalogJobActive(artistMbid) {
    const result = await database.query(`
      SELECT 1 FROM metadata_jobs
      WHERE job_type = 'fetch_artist_albums' AND entity_mbid = $1
        AND (status = 'processing' OR (status = 'pending' AND (run_after IS NULL OR run_after <= NOW())))
      LIMIT 1
    `, [artistMbid]);
    return result.rows.length > 0;
  }

  // ─── Work that is already done ───────────────────────────────────────────────

  /**
   * An answer of "no overview" holds as long as the metadata itself does (metadata.ttlDays); after that the lookup is
   * made again. (Images are not on this clock: see albumsNeedingImages.)
   */
  _checkedCutoff() {
    return new Date(Date.now() - Number(config.get('metadata.ttlDays', 30)) * 24 * 60 * 60 * 1000);
  }

  /**
   * Of these release groups, the ones whose overview still needs looking up: none stored, not recently looked for, and a
   * Wikidata link on MusicBrainz to look it up by (an album with no link is not searched for by name).
   */
  async albumsNeedingWiki(mbids) {
    if (mbids.length === 0) return [];
    const result = await database.query(`
      SELECT mbid FROM release_groups
      WHERE mbid = ANY($1)
        AND COALESCE(overview, '') = ''
        AND (wiki_checked_at IS NULL OR wiki_checked_at < $2)
        AND EXISTS (SELECT 1 FROM relations r
                    WHERE r.entity_type = 'release_group' AND r.entity_mbid = release_groups.mbid
                      AND r.type = 'wikidata' AND r.url IS NOT NULL)
    `, [mbids, this._checkedCutoff()]);
    return result.rows.map(r => r.mbid);
  }

  /**
   * Of these release groups, the ones whose images still need their first lookup. Images are not part of the TTL cycle:
   * once an album has been looked up, or holds its cover (cached, uploaded, or waiting in the download queue), that is
   * done for good. Asking again is the image explorer's job (a forced refresh), and a failed download is retried by the
   * download queue.
   */
  async albumsNeedingImages(mbids) {
    if (mbids.length === 0) return [];
    const result = await database.query(`
      SELECT rg.mbid FROM release_groups rg
      WHERE rg.mbid = ANY($1)
        AND rg.images_checked_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM images i
                        WHERE i.entity_type = 'release_group' AND i.entity_mbid = rg.mbid AND i.cover_type = 'Cover'
                          AND (i.cached = true OR i.user_uploaded = true OR i.cache_failed = false))
    `, [mbids]);
    return result.rows.map(r => r.mbid);
  }

  async artistNeedsWiki(mbid) {
    const result = await database.query(`
      SELECT 1 FROM artists
      WHERE mbid = $1 AND COALESCE(overview, '') = '' AND (wiki_checked_at IS NULL OR wiki_checked_at < $2)
    `, [mbid, this._checkedCutoff()]);
    return result.rows.length > 0;
  }

  // Same for an artist: its first lookup, unless its poster is already held
  async artistNeedsImages(mbid) {
    const result = await database.query(`
      SELECT 1 FROM artists a
      WHERE a.mbid = $1
        AND a.images_checked_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM images i
                        WHERE i.entity_type = 'artist' AND i.entity_mbid = a.mbid AND i.cover_type = 'Poster'
                          AND (i.cached = true OR i.user_uploaded = true OR i.cache_failed = false))
    `, [mbid]);
    return result.rows.length > 0;
  }

  // ─── Tree completion check ────────────────────────────────────────────────────

  async _checkAndTriggerRefresh(rootArtistMbid) {
    // Check if any jobs in this tree are still pending or processing
    const pending = await database.query(`
      SELECT COUNT(*) as n FROM metadata_jobs
      WHERE root_artist_mbid = $1
        AND status IN ('pending', 'processing')
    `, [rootArtistMbid]);

    if (parseInt(pending.rows[0].n) > 0) {
      logger.info(`Refresh check ${rootArtistMbid}: waiting — ${pending.rows[0].n} job(s) still pending/processing`);
      return;
    }

    // Also wait for image downloads to complete for this artist's albums
    const pendingDownloads = await database.query(`
      SELECT COUNT(*) as n FROM images i
      WHERE (
        i.entity_mbid = $1
        OR i.entity_mbid IN (
          SELECT release_group_mbid FROM artist_release_groups WHERE artist_mbid = $1
        )
      )
      AND i.cached = false
      AND i.cache_failed = false
    `, [rootArtistMbid]);

    if (parseInt(pendingDownloads.rows[0].n) > 0) {
      logger.info(`Refresh check ${rootArtistMbid}: waiting — ${pendingDownloads.rows[0].n} image download(s) still pending`);
      return;
    }

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

    if (claimed.rows.length === 0) {
      logger.info(`Refresh check ${rootArtistMbid}: refresh already triggered or no root job found, skipping`);
      return;
    }

    logger.info(`Job tree complete for artist ${rootArtistMbid} — triggering Lidarr refresh`);
    // The claim above burns the one-shot trigger; delivery is confirmed separately via
    // lidarr_refresh_delivered. If delivery never lands (stale connection, restart, or
    // Lidarr still importing), reconcilePendingRefreshes() retries it later.
    const lidarrClient = require('./lidarrClient');
    if (lidarrClient.enabled) {
      lidarrClient.waitForArtistAndRefresh(rootArtistMbid)
        .then(res => { if (res && res.success) return this._markRefreshDelivered(rootArtistMbid); })
        .catch(err => logger.warn(`Lidarr refresh failed for artist ${rootArtistMbid}: ${err.message}`));
    } else {
      logger.warn(`Lidarr refresh for ${rootArtistMbid} deferred — integration not ready; reconciliation will retry`);
    }
  }

  /**
   * Stage 1 of the Lidarr refresh. The artist's catalog is complete (every release group and release stored), which is all
   * Lidarr needs to list, monitor and search its albums, so it is told now. Overviews and cover images follow, and
   * stage 2 (_checkAndTriggerRefresh, when the whole tree is done) refreshes Lidarr again to pick them up.
   * One claim per run, like stage 2; reconcilePendingRefreshes() retries a delivery that never landed.
   */
  async triggerCatalogRefresh(rootJobId, artistMbid) {
    const claimed = await database.query(`
      UPDATE metadata_jobs
      SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"lidarr_stage1_triggered": true}'::jsonb
      WHERE id = $1
        AND job_type = 'fetch_artist_albums'
        AND (metadata IS NULL OR (metadata->>'lidarr_stage1_triggered') IS NULL)
      RETURNING id
    `, [rootJobId]);
    if (claimed.rows.length === 0) return;

    const lidarrClient = require('./lidarrClient');
    if (!lidarrClient.enabled) {
      logger.warn(`Lidarr refresh (catalog) for ${artistMbid} deferred — integration not ready; reconciliation will retry`);
      return;
    }
    logger.info(`Catalog complete for artist ${artistMbid} — refreshing Lidarr now (stage 1); images and overviews follow`);
    lidarrClient.waitForArtistAndRefresh(artistMbid)
      .then(res => { if (res && res.success) return this._markStage1Delivered(rootJobId); })
      .catch(err => logger.warn(`Lidarr refresh (catalog) failed for artist ${artistMbid}: ${err.message}`));
  }

  async _markStage1Delivered(rootJobId) {
    await database.query(`
      UPDATE metadata_jobs
      SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"lidarr_stage1_delivered": true}'::jsonb
      WHERE id = $1
    `, [rootJobId]);
  }

  /**
   * Mark an artist's completed refresh as delivered so reconciliation stops retrying it.
   */
  async _markRefreshDelivered(rootArtistMbid) {
    await database.query(`
      UPDATE metadata_jobs
      SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"lidarr_refresh_delivered": true}'::jsonb
      WHERE root_artist_mbid = $1 AND job_type = 'fetch_artist_albums' AND status = 'completed'
    `, [rootArtistMbid]);
  }

  /**
   * Re-deliver Lidarr refreshes that were triggered but never confirmed delivered —
   * recovers refreshes missed during a stale connection or a restart. Bounded to trees
   * completed in the last 24h so a genuinely-absent artist isn't retried forever.
   * Called by the Lidarr health check when the connection is up.
   */
  async reconcilePendingRefreshes() {
    await this._reconcileCatalogRefreshes();
    const res = await database.query(`
      SELECT DISTINCT root_artist_mbid FROM metadata_jobs
      WHERE job_type = 'fetch_artist_albums'
        AND status = 'completed'
        AND (metadata->>'lidarr_refresh_triggered') = 'true'
        AND (metadata->>'lidarr_refresh_delivered') IS DISTINCT FROM 'true'
        AND root_artist_mbid IS NOT NULL
        AND completed_at > NOW() - INTERVAL '24 hours'
      LIMIT 50
    `);
    if (res.rows.length === 0) return;

    const lidarrClient = require('./lidarrClient');
    if (!lidarrClient.enabled) return;

    logger.info(`Reconcile: ${res.rows.length} artist(s) with undelivered Lidarr refresh — retrying`);
    for (const row of res.rows) {
      try {
        const r = await lidarrClient.refreshArtistByMbid(row.root_artist_mbid);
        if (r && r.success) {
          await this._markRefreshDelivered(row.root_artist_mbid);
          logger.info(`Reconcile: delivered refresh for ${row.root_artist_mbid}`);
        }
        // skipped (artist not in Lidarr yet / unreachable) → leave undelivered; retried
        // next sweep until the 24h window closes.
      } catch (err) {
        logger.warn(`Reconcile: failed for ${row.root_artist_mbid}: ${err.message}`);
      }
    }
  }

  // Stage 1 refreshes that were triggered but never confirmed delivered (same 24 hour window)
  async _reconcileCatalogRefreshes() {
    const res = await database.query(`
      SELECT id, root_artist_mbid FROM metadata_jobs
      WHERE job_type = 'fetch_artist_albums'
        AND (metadata->>'lidarr_stage1_triggered') = 'true'
        AND (metadata->>'lidarr_stage1_delivered') IS DISTINCT FROM 'true'
        AND root_artist_mbid IS NOT NULL
        AND COALESCE(completed_at, started_at, created_at) > NOW() - INTERVAL '24 hours'
      LIMIT 50
    `);
    if (res.rows.length === 0) return;

    const lidarrClient = require('./lidarrClient');
    if (!lidarrClient.enabled) return;

    logger.info(`Reconcile: ${res.rows.length} artist(s) with undelivered Lidarr catalog refresh — retrying`);
    for (const row of res.rows) {
      try {
        const r = await lidarrClient.refreshArtistByMbid(row.root_artist_mbid);
        if (r && r.success) {
          await this._markStage1Delivered(row.id);
          logger.info(`Reconcile: delivered catalog refresh for ${row.root_artist_mbid}`);
        }
      } catch (err) {
        logger.warn(`Reconcile: catalog refresh failed for ${row.root_artist_mbid}: ${err.message}`);
      }
    }
  }

  async failJob(jobId, errorMessage) {
    // A job that failed is not tried again at once (a source that is down would burn every attempt in seconds):
    // it waits COOL_OFF_SECONDS[attempts - 1] first, the last step repeating
    const result = await database.query(`
      UPDATE metadata_jobs
      SET status = CASE
            WHEN attempts >= max_attempts THEN 'failed'
            ELSE 'pending'
          END,
          run_after = CASE
            WHEN attempts >= max_attempts THEN NULL
            ELSE NOW() + ($3::int[])[LEAST(GREATEST(attempts, 1), array_length($3::int[], 1))] * INTERVAL '1 second'
          END,
          error_message = $2
      WHERE id = $1
      RETURNING status, attempts, max_attempts
    `, [jobId, errorMessage, COOL_OFF_SECONDS]);

    const job = result.rows[0];
    if (job.status === 'failed') {
      logger.error(`Job ${jobId} failed permanently after ${job.attempts}/${job.max_attempts} attempts: ${errorMessage}`);
    } else {
      logger.warn(`Job ${jobId} failed (attempt ${job.attempts}/${job.max_attempts}), will retry: ${errorMessage}`);
    }
  }

  async isJobActive(jobId) {
    // True only while the job row still exists and is being processed.
    // Lets long-running tree loops bail when a job is killed (kill-active) or
    // pruned out from under them, instead of queuing orphaned children.
    const result = await database.query(
      `SELECT 1 FROM metadata_jobs WHERE id = $1 AND status = 'processing'`,
      [jobId]
    );
    return result.rows.length > 0;
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

  // ─── Backfill (idle-time MusicBrainz gap filling) ────────────────────────────

  /**
   * True when it's polite to spend MusicBrainz requests on housekeeping: Lidarr hasn't asked us
   * for anything lately, no MB-bound or wiki jobs are running or waiting, and no source is busy.
   */
  async isIdle() {
    if (Date.now() - getLastInboundAt() < IDLE_AFTER_MS) return false;
    if (this.mbPaused || this.mbWorkers > 0 || this.wikiWorkers > 0) return false;

    const mb = registry.getProvider('musicbrainz');
    if (mb && typeof mb.isIdle === 'function' && !mb.isIdle()) return false;

    const waiting = await database.query(
      `SELECT 1 FROM metadata_jobs WHERE status = 'pending' AND job_type = ANY($1) AND (run_after IS NULL OR run_after <= NOW()) LIMIT 1`,
      [[...MB_JOB_TYPES, ...WIKI_JOB_TYPES]]
    );
    return waiting.rows.length === 0;
  }

  _startBackfill(workerIntervalMs, sweepIntervalMs) {
    this.backfillInterval = setInterval(async () => {
      if (this.backfillWorkers >= this.maxBackfillWorkers) return;
      try {
        if (!(await this.isIdle())) return;
        const job = await this._getNextJob([...BACKFILL_JOB_TYPES, ...LIST_JOB_TYPES]);
        if (job) {
          this.backfillWorkers++;
          this._runBackfillJob(job).finally(() => { this.backfillWorkers--; });
        }
      } catch (error) {
        logger.error('Backfill worker error:', error);
      }
    }, workerIntervalMs);

    this.backfillSweepInterval = setInterval(async () => {
      try {
        if (await this.isIdle()) await this.sweepBackfill();
      } catch (error) {
        logger.error('Backfill sweep error:', error);
      }
    }, sweepIntervalMs);
  }

  async _runBackfillJob(job) {
    logger.info(`Backfill job ${job.id}: ${job.job_type} for ${job.entity_mbid}${job.attempts > 1 ? ` (attempt ${job.attempts}/${job.max_attempts})` : ''}`);
    try {
      await this._processJobFn(job);
      await this.completeJob(job.id);
    } catch (error) {
      logger.error(`Backfill job ${job.id} error: ${error.message}`);
      await this.failJob(job.id, error.message);
    }
  }

  /**
   * Queue backfill jobs for rows flagged needs_mb_backfill (most recently used first).
   * Skips entities with a job already waiting/running, one that failed in the last 24h, or one
   * that completed in the last hour (guards against a hot loop if a row can't be un-flagged).
   */
  async sweepBackfill(limit = BACKFILL_SWEEP_BATCH) {
    // The rows of an artist whose catalog came from an upstream (provisional) are left to that artist's catalog fetch
    // below, which replaces them all in a few calls; filling them one by one would repeat that work
    const targets = [
      { table: 'artists', jobType: 'backfill_artist', entityType: 'artist', unless: 'NOT catalog_provisional' },
      { table: 'release_groups', jobType: 'backfill_album', entityType: 'release_group', unless: `NOT EXISTS (
          SELECT 1 FROM artist_release_groups arg JOIN artists a ON a.mbid = arg.artist_mbid
          WHERE arg.release_group_mbid = release_groups.mbid AND a.catalog_provisional)` }
    ];
    let queued = 0;
    const provisional = await database.query(`
      SELECT a.mbid FROM artists a
      WHERE a.catalog_provisional
        AND NOT EXISTS (SELECT 1 FROM metadata_jobs j
                        WHERE j.job_type = 'fetch_artist_albums' AND j.entity_mbid = a.mbid
                          AND (j.status IN ('pending', 'processing')
                               OR (j.status = 'failed' AND j.started_at > NOW() - INTERVAL '24 hours')
                               OR (j.status = 'completed' AND j.completed_at > NOW() - INTERVAL '1 hour')))
      ORDER BY a.last_accessed_at DESC NULLS LAST
      LIMIT $1
    `, [Math.min(limit, 5)]);
    for (const row of provisional.rows) {
      await this.forceQueueJob('fetch_artist_albums', 'artist', row.mbid, 0, { via: 'provisional-sweep' }, null, row.mbid);
      queued++;
    }
    for (const t of targets) {
      const blockedRes = await database.query(`
        SELECT entity_mbid FROM metadata_jobs
        WHERE job_type = $1 AND root_artist_mbid IS NULL
          AND (status IN ('pending', 'processing')
               OR (status = 'failed' AND started_at > NOW() - INTERVAL '24 hours')
               OR (status = 'completed' AND completed_at > NOW() - INTERVAL '1 hour'))
      `, [t.jobType]);
      const blocked = new Set(blockedRes.rows.map(r => r.entity_mbid));

      const flagged = await database.query(`
        SELECT mbid FROM ${t.table}
        WHERE needs_mb_backfill AND ${t.unless}
        ORDER BY last_accessed_at DESC NULLS LAST
        LIMIT $1
      `, [limit + blocked.size]);
      const res = { rows: flagged.rows.filter(r => !blocked.has(r.mbid)).slice(0, limit) };
      for (const row of res.rows) {
        await this.forceQueueJob(t.jobType, t.entityType, row.mbid, 0);
        queued++;
      }
    }
    if (queued > 0) logger.info(`Backfill sweep: queued ${queued} job(s)`);
    return queued;
  }

  // ─── Wiki worker pool ────────────────────────────────────────────────────────

  _startWikiPool(intervalMs) {
    this.wikiInterval = setInterval(() => this._fillWikiWorkers(), intervalMs);
  }

  // Start a job on every free worker, not one per tick, and again as each job ends (so the pool never waits out a tick)
  async _fillWikiWorkers() {
    if (this._fillingWiki) return;
    this._fillingWiki = true;
    try {
      while (this.wikiWorkers < this.maxWikiWorkers) {
        const job = await this._getNextJob(WIKI_JOB_TYPES);
        if (!job) break;
        // Album overviews are looked up together: the other waiting ones come along
        const jobs = [job];
        if (job.job_type === 'fetch_album_wiki') jobs.push(...await this._claimJobs(['fetch_album_wiki'], WIKI_ALBUM_BATCH - 1));
        this.wikiWorkers++;
        this._runWikiJobs(jobs).finally(() => { this.wikiWorkers--; if (this.wikiInterval) this._fillWikiWorkers(); });
      }
    } catch (error) {
      logger.error('Wiki job processor error:', error);
    } finally {
      this._fillingWiki = false;
    }
  }

  async _runWikiJobs(jobs) {
    logger.info(`Wiki job${jobs.length > 1 ? 's' : ''} ${jobs.map(j => j.id).join(', ')}: ${jobs[0].job_type}${jobs.length > 1 ? ` x${jobs.length}` : ` for ${jobs[0].entity_mbid}`} [wiki worker ${this.wikiWorkers}/${this.maxWikiWorkers}]`);
    if (jobs[0].job_type === 'fetch_album_wiki') return this._runAlbumWikiBatch(jobs);
    for (const job of jobs) {
      try {
        await this._fetchArtistWiki(job.entity_mbid, job.metadata?.forceRefresh);
        await this.completeJob(job.id);
      } catch (error) {
        logger.error(`Wiki job ${job.id} error: ${error.message}`);
        await this.failJob(job.id, error.message);
      }
    }
  }

  // The album overviews of these jobs, looked up together; each job then completes or fails on its own
  async _runAlbumWikiBatch(jobs) {
    let outcomes;
    try {
      outcomes = await this._lookupAlbumWikis(jobs.map(job => ({ mbid: job.entity_mbid, force: job.metadata?.forceRefresh })));
    } catch (error) {
      outcomes = jobs.map(() => ({ error }));
    }
    for (let i = 0; i < jobs.length; i++) {
      if (outcomes[i].error) {
        logger.error(`Wiki job ${jobs[i].id} error: ${outcomes[i].error.message}`);
        await this.failJob(jobs[i].id, outcomes[i].error.message);
      } else {
        await this.completeJob(jobs[i].id);
      }
    }
  }

  /**
   * The Wikidata id of an entity, from the URL relations stored with it (no MusicBrainz call: the catalog fetch already
   * stored them). A row we hold only as a stub (not full MusicBrainz data) may be missing them, so for that case alone
   * the entity is looked up on MusicBrainz, as before. null = no Wikidata link.
   */
  async _wikidataIdOf(entityType, mbid, hasFullData, lookup) {
    const WikipediaProvider = require('../providers/wikipedia');
    const stored = await database.query(
      `SELECT url FROM relations WHERE entity_type = $1 AND entity_mbid = $2 AND type = 'wikidata' AND url IS NOT NULL LIMIT 1`,
      [entityType, mbid]
    );
    if (stored.rows.length > 0) {
      return WikipediaProvider.extractWikidataId([{ type: 'wikidata', url: { resource: stored.rows[0].url } }]);
    }
    if (hasFullData) return null;
    try {
      const data = await lookup();
      return WikipediaProvider.extractWikidataId(data.relations || []);
    } catch (err) {
      logger.warn(`Wiki: Could not get MB relations for ${entityType} ${mbid}: ${err.message}`);
      return null;
    }
  }

  async _fetchArtistWiki(mbid, force = false) {
    const existing = await database.query(
      'SELECT overview, name, type, mb_version FROM artists WHERE mbid = $1', [mbid]
    );
    if (!existing.rows[0] || (!force && existing.rows[0].overview)) return;

    const artist = existing.rows[0];
    const wikiProvider = registry.getProvider('wikipedia');
    if (!wikiProvider) return;

    const wikidataId = await this._wikidataIdOf('artist', mbid, artist.mb_version === 1, () => registry.getProvider('musicbrainz').getArtist(mbid));

    const wiki = await this._lookup(`Wiki: artist overview for ${mbid}`, () => wikiProvider.getArtistOverview(wikidataId, artist.name, artist.type));
    const overview = wiki.value;
    if (overview) {
      await database.query('UPDATE artists SET overview = $1, wiki_checked_at = NOW() WHERE mbid = $2', [overview, mbid]);
      logger.info(`Wiki: Stored artist overview for ${mbid} (${overview.length} chars)`);
      return;
    }

    // Fallback: try Deezer bio
    const deezerProvider = registry.getProvider('deezer');
    if (deezerProvider) {
      const bio = await deezerProvider.getArtistBio(artist.name);
      if (bio) {
        await database.query('UPDATE artists SET overview = $1, wiki_checked_at = NOW() WHERE mbid = $2', [bio, mbid]);
        logger.info(`Deezer: Stored artist bio for ${mbid} (${bio.length} chars)`);
        return;
      }
    }

    // Wikipedia answered and so did the fallback: there is no overview to be had. Remember it, so the next refresh
    // does not ask again. (A lookup that failed is not an answer and is not remembered.)
    if (wiki.answered) {
      await database.query('UPDATE artists SET wiki_checked_at = NOW() WHERE mbid = $1', [mbid]);
      logger.info(`Wiki: no overview found for artist ${mbid} (recorded)`);
    }
  }

  /**
   * Ask a provider something whose failure must not be mistaken for "nothing found". Trouble worth retrying (network,
   * 429, 5xx) fails the job, which the queue retries after a pause; any other failure is logged and the job ends
   * without recording anything, so the next refresh asks again.
   */
  async _lookup(label, fn) {
    try {
      return { value: await fn(), answered: true };
    } catch (err) {
      if (BaseProvider.isRetryableError(err)) throw err;
      logger.warn(`${label} failed: ${err.message}`);
      return { value: null, answered: false };
    }
  }

  async _fetchAlbumWiki(mbid, force = false) {
    const [outcome] = await this._lookupAlbumWikis([{ mbid, force }]);
    if (outcome.error) throw outcome.error;
  }

  /**
   * Looks up the overviews of albums together (Wikipedia answers many at a time) and stores what it finds.
   * Returns one { error } per album, in order: a failure worth retrying (the job then fails and is retried after a
   * pause), else null. An album Wikipedia has nothing for is recorded as checked; a lookup that failed in a way
   * retrying won't fix is logged and left unrecorded, so the next refresh asks again. An album with no Wikidata link is
   * skipped (no call, nothing recorded).
   */
  async _lookupAlbumWikis(entries) {
    const outcomes = entries.map(() => ({ error: null }));
    const wikiProvider = registry.getProvider('wikipedia');
    if (!wikiProvider) return outcomes;

    const mbids = entries.map(e => e.mbid);
    const rows = new Map((await database.query(
      'SELECT mbid, overview, title, mb_version FROM release_groups WHERE mbid = ANY($1)', [mbids]
    )).rows.map(r => [r.mbid, r]));

    // Only the albums still without an overview are looked up (a forced run looks up all)
    const pending = [];
    for (let i = 0; i < entries.length; i++) {
      const row = rows.get(entries[i].mbid);
      if (!row || (!entries[i].force && row.overview)) continue;
      const wikidataId = await this._wikidataIdOf('release_group', row.mbid, row.mb_version === 1, () => registry.getProvider('musicbrainz').getReleaseGroup(row.mbid));
      if (!wikidataId) continue;   // no link, nothing to look up (albums are not searched for by name)
      pending.push({ index: i, row, item: { wikidataId } });
    }
    if (pending.length === 0) return outcomes;

    const results = await wikiProvider.getAlbumOverviews(pending.map(p => p.item));
    for (let n = 0; n < pending.length; n++) {
      const { index, row } = pending[n];
      const result = results[n];
      if (result.error) {
        outcomes[index].error = result.error;
      } else if (result.overview) {
        await database.query('UPDATE release_groups SET overview = $1, wiki_checked_at = NOW() WHERE mbid = $2', [result.overview, row.mbid]);
        logger.info(`Wiki: Stored album overview for "${row.title}" (${result.overview.length} chars)`);
      } else if (result.answered) {
        await database.query('UPDATE release_groups SET wiki_checked_at = NOW() WHERE mbid = $1', [row.mbid]);
        logger.info(`Wiki: no overview found for album "${row.title}" (recorded)`);
      }
    }
    return outcomes;
  }

  // ─── Provider image worker pool ──────────────────────────────────────────────

  _startImagePool(intervalMs) {
    this.imageInterval = setInterval(() => this._fillImageWorkers(), intervalMs);
  }

  async _fillImageWorkers() {
    if (this._fillingImages) return;
    this._fillingImages = true;
    try {
      while (this.imageWorkers < this.maxImageWorkers) {
        const job = await this._getNextJob(IMAGE_JOB_TYPES);
        if (!job) break;
        this.imageWorkers++;
        this._runImageJob(job).finally(() => { this.imageWorkers--; if (this.imageInterval) this._fillImageWorkers(); });
      }
    } catch (error) {
      logger.error('Provider image job processor error:', error);
    } finally {
      this._fillingImages = false;
    }
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
      // Never cache an image with no URL — it would later be served to Lidarr
      // as an empty cover and rejected. Skip so the fetch can retry cleanly.
      if (!image.Url || String(image.Url).trim() === '') {
        logger.warn(`Image: Skipping ${image.CoverType} for ${entityType} ${entityMbid} — empty URL from ${image.Provider || provider}`);
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
    if (blocklist.isBlocked('artist', mbid)) return;

    const result = await database.query('SELECT name FROM artists WHERE mbid = $1', [mbid]);
    if (!result.rows[0]) return;

    // Skip image types we already have: cached, user-uploaded, or found and waiting in the download queue
    const existing = await database.query(
      `SELECT DISTINCT cover_type FROM images
       WHERE entity_type = 'artist' AND entity_mbid = $1 AND (cached = true OR user_uploaded = true OR cache_failed = false)`,
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
    const errors = [];
    const getImages = async (provider) => {
      if (!cache.has(provider.name)) {
        try {
          cache.set(provider.name, await provider.getArtistImages(mbid));
        } catch (err) {
          logger.warn(`Image: ${provider.name} artist images failed for ${mbid}: ${err.message}`);
          errors.push(err);
          cache.set(provider.name, []);
        }
      }
      return cache.get(provider.name);
    };

    const needTypes = ARTIST_IMAGE_TYPES.filter(t => !existingTypes.has(t));
    // Skip types already cached locally (DB + on disk) unless force refresh.
    // A Lidarr TTL refresh updates MB metadata but must not redownload existing images.
    const typesToFetch = force ? ARTIST_IMAGE_TYPES : needTypes;
    logger.info(`Image: artist ${mbid} — fetching ${typesToFetch.length}/${ARTIST_IMAGE_TYPES.length} types: [${typesToFetch.join(', ')}] (${existingTypes.size} already cached, force=${!!force})`);

    let missing = 0;
    for (const type of typesToFetch) {
      let found = false;
      for (const provider of providers) {
        const images = await getImages(provider);
        const match = images.find(img => img.CoverType === type);
        if (match) {
          logger.info(`Image: artist ${mbid} ${type} — found at ${match.Provider || provider.name}`);
          await this._storeImageUrls('artist', mbid, [match], match.Provider || provider.name, force);
          found = true;
          break;
        } else {
          logger.info(`Image: artist ${mbid} ${type} — not found at ${provider.name}, trying next`);
        }
      }
      if (!found) { missing++; logger.warn(`Image: artist ${mbid} ${type} — not found at any provider`); }
    }
    await this._recordImageCheck('artists', mbid, errors, missing);
  }

  /**
   * End of an image lookup. When every provider answered, that is recorded on the row, so the next refresh does not ask
   * again for what they do not have. If a provider failed in a way worth retrying (network, 429, 5xx) while types are
   * still missing, the job fails and is retried after a pause; any other failure just leaves the lookup unrecorded.
   */
  async _recordImageCheck(table, mbid, errors, missing) {
    if (errors.length === 0) {
      await database.query(`UPDATE ${table === 'artists' ? 'artists' : 'release_groups'} SET images_checked_at = NOW() WHERE mbid = $1`, [mbid]);
      return;
    }
    if (missing > 0 && errors.some(err => BaseProvider.isRetryableError(err))) {
      throw new Error(`image provider failed: ${errors.map(err => err.message).join('; ')}`);
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

    // Skip image types we already have: cached, user-uploaded, or found and waiting in the download queue
    const existing = await database.query(
      `SELECT DISTINCT cover_type FROM images
       WHERE entity_type = 'release_group' AND entity_mbid = $1 AND (cached = true OR user_uploaded = true OR cache_failed = false)`,
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
    const errors = [];
    const caa = registry.getProvider('coverartarchive');
    const getImages = async (provider) => {
      if (!cache.has(provider.name)) {
        try {
          const fn = provider.getAlbumImages?.bind(provider);
          const art = provider === caa ? await this._coverArtFlags(mbid) : null;
          if (art && art.known) {
            // MusicBrainz already told us (with every release we stored) what art the archive holds. The front cover has
            // an address of its own, so it costs no lookup; the archive is asked only for a disc image, and only when a
            // back cover (or art of an unknown kind) is listed
            const images = art.front ? provider.directCover(mbid) : [];
            if (typesToFetch.includes('Disc') && (art.back || (art.artwork && !art.front))) {
              images.push(...(await fn(mbid)).filter(image => image.CoverType === 'Disc'));
            }
            logger.debug(`Image: album ${mbid} — CoverArtArchive from MusicBrainz's art flags (front=${art.front}, back=${art.back}): ${images.length} image(s)`);
            cache.set(provider.name, images);
          } else {
            cache.set(provider.name, fn ? await fn(mbid) : []);
          }
        } catch (err) {
          logger.warn(`Image: ${provider.name} album images failed for ${mbid}: ${err.message}`);
          errors.push(err);
          cache.set(provider.name, []);
        }
      }
      return cache.get(provider.name);
    };

    const { title } = result.rows[0];
    const needTypes = ALBUM_IMAGE_TYPES.filter(t => !existingTypes.has(t));
    // Skip types already cached locally (DB + on disk) unless force refresh.
    const typesToFetch = force ? ALBUM_IMAGE_TYPES : needTypes;
    logger.info(`Image: album "${title}" (${mbid}) — fetching ${typesToFetch.length}/${ALBUM_IMAGE_TYPES.length} types: [${typesToFetch.join(', ')}] (${existingTypes.size} already cached, force=${!!force})`);

    let missing = 0;
    for (const type of typesToFetch) {
      let found = false;
      for (const provider of providers) {
        const images = await getImages(provider);
        const match = images.find(img => img.CoverType === type);
        if (match) {
          logger.info(`Image: album "${title}" ${type} — found at ${match.Provider || provider.name}`);
          await this._storeImageUrls('release_group', mbid, [match], match.Provider || provider.name, force);
          found = true;
          break;
        } else {
          logger.info(`Image: album "${title}" ${type} — not found at ${provider.name}, trying next`);
        }
      }
      if (!found) { missing++; logger.warn(`Image: album "${title}" ${type} — not found at any provider`); }
    }
    await this._recordImageCheck('release_groups', mbid, errors, missing);
  }

  /**
   * What MusicBrainz says the Cover Art Archive holds for this group, from the summary stored with each release
   * (cover-art-archive: artwork / front / back). `known` only when every release of the group is stored and each has
   * that summary; otherwise the archive has to be asked.
   */
  async _coverArtFlags(rgMbid) {
    const result = await database.query(`
      SELECT rg.releases_complete_at IS NOT NULL AS complete,
             COUNT(r.mbid) FILTER (WHERE r.cover_art_archive IS NULL) AS unknown,
             COALESCE(BOOL_OR(r.cover_art_archive->>'artwork' = 'true'), false) AS artwork,
             COALESCE(BOOL_OR(r.cover_art_archive->>'front' = 'true'), false) AS front,
             COALESCE(BOOL_OR(r.cover_art_archive->>'back' = 'true'), false) AS back
      FROM release_groups rg LEFT JOIN releases r ON r.release_group_mbid = rg.mbid
      WHERE rg.mbid = $1
      GROUP BY rg.mbid, rg.releases_complete_at
    `, [rgMbid]);
    const row = result.rows[0];
    if (!row || !row.complete || Number(row.unknown) > 0) return { known: false };
    return { known: true, artwork: row.artwork, front: row.front, back: row.back };
  }

  // ─── Startup / shutdown ──────────────────────────────────────────────────────

  async startProcessor(processJobFn, intervalMs = 1000) {
    this._processJobFn = processJobFn;

    await this._resetStuckJobs();

    this.refreshMbCapacity();

    this._startMbPool(intervalMs);
    this._startBackfill(5000, 60000);
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
    if (this.backfillInterval) { clearInterval(this.backfillInterval); this.backfillInterval = null; }
    if (this.backfillSweepInterval) { clearInterval(this.backfillSweepInterval); this.backfillSweepInterval = null; }
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
    // Keep the most recent 500 terminal-state jobs; delete the rest.
    // Active jobs (pending/processing) are never touched.
    const result = await database.query(`
      DELETE FROM metadata_jobs
      WHERE status IN ('completed', 'failed')
        AND id NOT IN (
          SELECT id FROM metadata_jobs
          WHERE status IN ('completed', 'failed')
          ORDER BY created_at DESC
          LIMIT 500
        )
      RETURNING id
    `);
    if (result.rows.length > 0) {
      logger.info(`Pruned ${result.rows.length} old terminal-state jobs (retention: 500)`);
    }
  }

  async _maybePrune() {
    // Cheap check: only invoke cleanup when terminal-state row count exceeds threshold.
    // Avoids running DELETE on every insert during quiet periods.
    const PRUNE_THRESHOLD = 600;
    const result = await database.query(`
      SELECT COUNT(*)::int as n FROM metadata_jobs
      WHERE status IN ('completed', 'failed')
    `);
    if (result.rows[0].n >= PRUNE_THRESHOLD) {
      await this._cleanupOldJobs();
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
      backfill_workers: this.backfillWorkers, max_backfill_workers: this.maxBackfillWorkers,
      image_workers: this.imageWorkers, max_image_workers: this.maxImageWorkers,
      // keep legacy keys so dashboard doesn't break
      active_workers: this.mbWorkers, max_workers: this.maxMbWorkers
    };
    result.rows.forEach(row => { stats[row.status] = parseInt(row.count); });
    return stats;
  }
}

module.exports = new BackgroundJobQueue();
