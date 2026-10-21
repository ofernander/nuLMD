const { registry } = require('./providerRegistry');
const metaHandler = require('./metaHandler');
const { logger } = require('./logger');
const lidarrClient = require('./lidarrClient');
const blocklist = require('./blocklist');

/**
 * Process a metadata fetch job
 */
async function processJob(job) {
  const { job_type, entity_mbid, metadata } = job;

  logger.info(`Processing ${job_type} job for ${entity_mbid}`);

  switch (job_type) {
    case 'fetch_artist_albums':
      await fetchArtistAlbums(job);
      break;

    case 'fetch_album_full':
      await fetchAlbumFull(entity_mbid);
      break;

    case 'backfill_artist':
      await backfillArtist(entity_mbid);
      break;

    case 'backfill_album':
      await backfillAlbum(entity_mbid);
      break;

    case 'complete_rg_list':
    case 'complete_release_list': {
      const { browse } = require('./mbWs/services');
      const queue = require('./backgroundJobQueue');
      // Be a polite background task: between pages, wait for nuLMD to be idle (up to ~10 minutes)
      const waitIdle = async () => {
        for (let i = 0; i < 200; i++) {
          if (await queue.isIdle()) return;
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
        throw new Error('nuLMD stayed busy, list will be finished later');
      };
      await browse().runJob(job, { waitIdle });
      break;
    }

    default:
      throw new Error(`Unknown job type: ${job_type}`);
  }
}

function isNotFound(error) {
  return !!(error && error.message && error.message.includes('Resource not found'));
}

/**
 * Backfill: re-fetch a row that was filled from a non-MusicBrainz source (e.g. an LMD upstream)
 * from MusicBrainz itself, so the fields upstream can't provide get filled. MusicBrainz is the
 * authority, so its data replaces the row's; the one exception is the overview, which MB doesn't
 * supply and which an upstream (or Wikipedia) already gave us.
 *
 * These calls are pinned to MusicBrainz sources, never an LMD upstream.
 * Releases are deliberately not re-fetched: what an upstream lacks there (barcodes) isn't served
 * to Lidarr, and each release is an extra MB request.
 */
async function backfillArtist(mbid) {
  const database = require('../sql/database');
  if (blocklist.isBlocked('artist', mbid)) return;
  const mb = registry.getProvider('musicbrainz');
  const mbOnly = typeof mb.onlyMusicBrainz === 'function' ? mb.onlyMusicBrainz() : mb;

  const existing = await database.query('SELECT overview FROM artists WHERE mbid = $1', [mbid]);
  if (existing.rows.length === 0) return;

  let data;
  try {
    data = await mbOnly.getArtist(mbid);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    // MBID merged/removed on MusicBrainz: nothing to fill, stop retrying it
    logger.warn(`Backfill: artist ${mbid} not found on MusicBrainz, clearing flag`);
    await database.query('UPDATE artists SET needs_mb_backfill = FALSE WHERE mbid = $1', [mbid]);
    return;
  }
  await metaHandler.storeArtist(mbid, { ...data, overview: existing.rows[0].overview || '' }, true);
  logger.info(`Backfill: artist ${mbid} filled from MusicBrainz`);
}

async function backfillAlbum(mbid) {
  const database = require('../sql/database');
  if (blocklist.isBlocked('release_group', mbid)) return;
  const mb = registry.getProvider('musicbrainz');
  const mbOnly = typeof mb.onlyMusicBrainz === 'function' ? mb.onlyMusicBrainz() : mb;

  const existing = await database.query('SELECT overview FROM release_groups WHERE mbid = $1', [mbid]);
  if (existing.rows.length === 0) return;

  let data;
  try {
    data = await mbOnly.getReleaseGroup(mbid);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    logger.warn(`Backfill: release group ${mbid} not found on MusicBrainz, clearing flag`);
    await database.query('UPDATE release_groups SET needs_mb_backfill = FALSE WHERE mbid = $1', [mbid]);
    return;
  }
  await metaHandler.storeReleaseGroup(mbid, { ...data, overview: existing.rows[0].overview || '' }, null, { force: true });
  logger.info(`Backfill: release group ${mbid} filled from MusicBrainz`);
}

/**
 * Fetch an artist's whole catalog: every release group and every release of every status, in a few bulk calls
 * (metaHandler.ingestCatalog), then queue the wiki and image jobs for each album and the artist.
 * Any failure fails the job, which is retried as a whole: a half-filled artist is never presented as finished.
 */
async function fetchArtistAlbums(job) {
  const artistMbid = job.entity_mbid;
  const rootJobId = job.id;
  const skipArtistImages = job.metadata?.skipArtistImages || false;
  const skipAlbumImages  = job.metadata?.skipAlbumImages  || false;
  const forceRefresh     = job.metadata?.forceRefresh     || false;
  const imagesOnly       = job.metadata?.imagesOnly       || false;   // the catalog is held: only the image lookups are owed

  if (blocklist.isBlocked('artist', artistMbid)) {
    logger.info(`fetchArtistAlbums: skipping blocked entity ${artistMbid}`);
    return;
  }

  const backgroundJobQueue = require('./backgroundJobQueue');

  if (!imagesOnly) {
    try {
      let result;
      try {
        result = await metaHandler.ingestCatalog(artistMbid, { force: forceRefresh });
      } catch (error) {
        // MusicBrainz could not answer (again) and we hold nothing for this artist: the upstreams stand in, provisionally
        if (error.overLimit || !(await metaHandler.upstreamFallbackAllowed(artistMbid, error, job.attempts))) throw error;
        logger.warn(`fetchArtistAlbums: MusicBrainz failed for ${artistMbid} (${error.message}); using the upstream fallback`);
        result = { ...(await metaHandler.ingestCatalogFromUpstream(artistMbid)), firstTime: true };
      }
      const { groups, releases, firstTime } = result;
      logger.info(`Background: artist ${artistMbid} catalog complete: ${groups} release groups, ${releases} releases`);
      // Lidarr has all it needs to list the albums: tell it now, before the wiki and image work (stage 1 of the refresh)
      if (firstTime) await backgroundJobQueue.triggerCatalogRefresh(rootJobId, artistMbid);
    } catch (error) {
      // Safety: refuse to process artists with absurd album counts
      if (error.overLimit) {
        logger.warn(`fetchArtistAlbums: artist ${artistMbid} skipped: ${error.message}`);
        return;
      }
      throw error;
    }
  }

  const releaseGroups = await metaHandler.getArtistReleaseGroups(artistMbid);

  // Only the albums that still have something to look up get a job: one with an overview and images (or a recorded
  // "nothing found") needs no wiki or image work, and a forced refresh looks everything up again
  const wikiNeeded = new Set(forceRefresh ? releaseGroups : await backgroundJobQueue.albumsNeedingWiki(releaseGroups));
  // Images are fetched only for an artist that is in Lidarr (unknown, e.g. Lidarr unreachable, counts as not yet: a later
  // /artist request that finds it in Lidarr queues an images-only catch-up). With the integration off there is no gate.
  const inLidarr = !lidarrClient.enabled || (await lidarrClient.isInLidarr(artistMbid)) === true;
  if (!inLidarr) logger.info(`fetchArtistAlbums: artist ${artistMbid} is not in Lidarr, no images fetched`);
  const imagesWanted = inLidarr && !skipAlbumImages && backgroundJobQueue.hasAlbumImageProvider();
  const imagesNeeded = new Set(!imagesWanted ? [] : forceRefresh ? releaseGroups : await backgroundJobQueue.albumsNeedingImages(releaseGroups));

  for (const rgMbid of releaseGroups) {
    if (!wikiNeeded.has(rgMbid) && !imagesNeeded.has(rgMbid)) continue;

    // Bail if the root job was killed (kill-active) or pruned while we ran —
    // no point queuing children under a parent that no longer exists.
    if (!(await backgroundJobQueue.isJobActive(rootJobId))) {
      logger.warn(`fetchArtistAlbums: root job ${rootJobId} no longer active (killed/removed) — stopped queuing children for artist ${artistMbid}`);
      return;
    }

    // Queue wiki and image jobs for this album as tree children
    if (wikiNeeded.has(rgMbid)) {
      const albumWikiQueueFn = forceRefresh ? backgroundJobQueue.forceQueueJob.bind(backgroundJobQueue) : backgroundJobQueue.queueJob.bind(backgroundJobQueue);
      await albumWikiQueueFn('fetch_album_wiki', 'release_group', rgMbid, 1, forceRefresh ? { forceRefresh: true } : null, rootJobId, artistMbid);
    }
    if (imagesNeeded.has(rgMbid)) {
      await backgroundJobQueue.queueJob('fetch_album_images', 'release_group', rgMbid, 1, null, rootJobId, artistMbid);
    }
  }

  // Stop if the tree was killed while we queued
  if (!(await backgroundJobQueue.isJobActive(rootJobId))) {
    logger.warn(`fetchArtistAlbums: root job ${rootJobId} no longer active after album loop — skipping artist-level children for ${artistMbid}`);
    return;
  }

  // Queue artist wiki and image jobs as tree children
  if (forceRefresh || await backgroundJobQueue.artistNeedsWiki(artistMbid)) {
    const artistWikiQueueFn = forceRefresh ? backgroundJobQueue.forceQueueJob.bind(backgroundJobQueue) : backgroundJobQueue.queueJob.bind(backgroundJobQueue);
    await artistWikiQueueFn('fetch_artist_wiki', 'artist', artistMbid, 1, forceRefresh ? { forceRefresh: true } : null, rootJobId, artistMbid);
  }
  if (inLidarr && !skipArtistImages && backgroundJobQueue.hasArtistImageProvider() && (forceRefresh || await backgroundJobQueue.artistNeedsImages(artistMbid))) {
    await backgroundJobQueue.queueJob('fetch_artist_images', 'artist', artistMbid, 1, null, rootJobId, artistMbid);
  }
}

/**
 * Fetch complete album data: the release group and every release MusicBrainz lists for it (the UI's "fetch album"
 * action). The same routine a Lidarr album request uses, forced.
 */
async function fetchAlbumFull(releaseGroupMbid) {
  if (blocklist.isBlocked('release_group', releaseGroupMbid)) return;
  logger.info(`Fetching complete album data for ${releaseGroupMbid}`);
  await metaHandler.ensureAlbum(releaseGroupMbid, true);
  logger.info(`Completed fetching releases for album ${releaseGroupMbid}`);
}

module.exports = { processJob };