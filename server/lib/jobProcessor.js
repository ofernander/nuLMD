const { registry } = require('./providerRegistry');
const metaHandler = require('./metaHandler');
const { logger } = require('./logger');

const MAX_ITEM_RETRIES = 10;

/**
 * Retry a list of failed items with backoff between attempts.
 * @param {Array} failedItems - items to retry
 * @param {Function} processFn - async fn(item) that processes one item
 * @param {string} label - label for logging (e.g. "release-group")
 * @returns {Array} items that still failed after all retries
 */
async function retryFailed(failedItems, processFn, label) {
  let remaining = [...failedItems];

  logger.info(`Scheduling retries for ${remaining.length} failed ${label}(s) - will attempt up to ${MAX_ITEM_RETRIES} times each`);

  for (let attempt = 1; attempt <= MAX_ITEM_RETRIES && remaining.length > 0; attempt++) {
    logger.info(`Retry round ${attempt}/${MAX_ITEM_RETRIES}: ${remaining.length} ${label}(s) to process - hang tight, we'll get them!`);
    const stillFailing = [];

    for (const item of remaining) {
      const itemId = typeof item === 'string' ? item : item.id;
      try {
        await processFn(item);
        logger.info(`Retry succeeded for ${label} ${itemId} (round ${attempt}/${MAX_ITEM_RETRIES})`);
      } catch (error) {
        const attemptsLeft = MAX_ITEM_RETRIES - attempt;
        if (attemptsLeft > 0) {
          logger.warn(`Retry round ${attempt} failed for ${label} ${itemId}: ${error.message} - ${attemptsLeft} round(s) remaining`);
        } else {
          logger.error(`Final retry failed for ${label} ${itemId}: ${error.message} - no more retries`);
        }
        stillFailing.push(item);
      }
    }

    if (stillFailing.length === 0) {
      logger.info(`All ${label}(s) recovered successfully after ${attempt} retry round(s)!`);
    } else if (attempt < MAX_ITEM_RETRIES) {
      logger.info(`${remaining.length - stillFailing.length} ${label}(s) recovered, ${stillFailing.length} still pending - continuing retries...`);
    }

    remaining = stillFailing;
  }

  if (remaining.length > 0) {
    const ids = remaining.map(i => typeof i === 'string' ? i : i.id).join(', ');
    logger.error(`${remaining.length} ${label}(s) could not be fetched after ${MAX_ITEM_RETRIES} retry rounds: ${ids}`);
  }

  return remaining;
}

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

    default:
      throw new Error(`Unknown job type: ${job_type}`);
  }
}

/**
 * Fetch all albums for an artist
 */
async function fetchArtistAlbums(job) {
  const artistMbid = job.entity_mbid;
  const rootJobId = job.id;
  const skipArtistImages = job.metadata?.skipArtistImages || false;
  const skipAlbumImages  = job.metadata?.skipAlbumImages  || false;
  const forceRefresh     = job.metadata?.forceRefresh     || false;

  const BLOCKED = new Set(['89ad4ac3-39f7-470e-963a-56509c546377', 'fe5b7087-438f-4e6e-bf3d-4a5b65e8d8b6']);
  if (BLOCKED.has(artistMbid)) {
    logger.info(`fetchArtistAlbums: skipping blocked entity ${artistMbid}`);
    return;
  }

  const database = require('../sql/database');
  const backgroundJobQueue = require('./backgroundJobQueue');

  // Get all release groups already stored for this artist
  const releaseGroups = await metaHandler.getArtistReleaseGroups(artistMbid);

  // Safety: refuse to process artists with absurd album counts
  if (releaseGroups.length > 2000) {
    logger.warn(`fetchArtistAlbums: artist ${artistMbid} has ${releaseGroups.length} release groups, exceeds safety limit of 2000, skipping`);
    return;
  }

  logger.info(`Background: artist ${artistMbid} has ${releaseGroups.length} release groups, checking for missing releases`);

  let fetched = 0;
  const failedAlbums = [];

  for (const rgMbid of releaseGroups) {
    try {
      const { needsFullFetch } = await metaHandler.ensureAlbum(rgMbid, forceRefresh);
      fetched++;
      logger.info(`Background: ensureAlbum complete for ${rgMbid} (${fetched} albums processed)`);

      // Queue fetch_album_full as tree child if album has remaining releases
      if (needsFullFetch) {
        const fullFetchQueueFn = forceRefresh
          ? backgroundJobQueue.forceQueueJob.bind(backgroundJobQueue)
          : backgroundJobQueue.queueJob.bind(backgroundJobQueue);
        await fullFetchQueueFn('fetch_album_full', 'release_group', rgMbid, 1, null, rootJobId, artistMbid);
        logger.info(`Queued tree fetch_album_full for album ${rgMbid}`);
      }

      // Queue wiki and image jobs for this album as tree children
      const albumWikiQueueFn = forceRefresh ? backgroundJobQueue.forceQueueJob.bind(backgroundJobQueue) : backgroundJobQueue.queueJob.bind(backgroundJobQueue);
      await albumWikiQueueFn('fetch_album_wiki', 'release_group', rgMbid, 1, forceRefresh ? { forceRefresh: true } : null, rootJobId, artistMbid);
      if (!skipAlbumImages && backgroundJobQueue.hasAlbumImageProvider()) {
        await backgroundJobQueue.queueJob('fetch_album_images', 'release_group', rgMbid, 1, null, rootJobId, artistMbid);
      }
    } catch (error) {
      logger.warn(`Background: failed to ensure album ${rgMbid}: ${error.message}`);
      failedAlbums.push(rgMbid);
    }
  }

  // Retry failures
  if (failedAlbums.length > 0) {
    await retryFailed(failedAlbums, async (rgMbid) => {
      const { needsFullFetch } = await metaHandler.ensureAlbum(rgMbid, forceRefresh);
      if (needsFullFetch) {
        const retryFullFetchQueueFn = forceRefresh
          ? backgroundJobQueue.forceQueueJob.bind(backgroundJobQueue)
          : backgroundJobQueue.queueJob.bind(backgroundJobQueue);
        await retryFullFetchQueueFn('fetch_album_full', 'release_group', rgMbid, 1, null, rootJobId, artistMbid);
      }
      const retryAlbumWikiQueueFn = forceRefresh ? backgroundJobQueue.forceQueueJob.bind(backgroundJobQueue) : backgroundJobQueue.queueJob.bind(backgroundJobQueue);
      await retryAlbumWikiQueueFn('fetch_album_wiki', 'release_group', rgMbid, 1, forceRefresh ? { forceRefresh: true } : null, rootJobId, artistMbid);
      if (!skipAlbumImages && backgroundJobQueue.hasAlbumImageProvider()) {
        await backgroundJobQueue.queueJob('fetch_album_images', 'release_group', rgMbid, 1, null, rootJobId, artistMbid);
      }
    }, 'album-releases');
  }

  logger.info(`Background: completed fetching releases for artist ${artistMbid}: ${fetched} albums processed, ${failedAlbums.length} failed`);

  // Queue artist wiki and image jobs as tree children
  const artistWikiQueueFn = forceRefresh ? backgroundJobQueue.forceQueueJob.bind(backgroundJobQueue) : backgroundJobQueue.queueJob.bind(backgroundJobQueue);
  await artistWikiQueueFn('fetch_artist_wiki', 'artist', artistMbid, 1, forceRefresh ? { forceRefresh: true } : null, rootJobId, artistMbid);
  if (!skipArtistImages && backgroundJobQueue.hasArtistImageProvider()) {
    await backgroundJobQueue.queueJob('fetch_artist_images', 'artist', artistMbid, 1, null, rootJobId, artistMbid);
  }
}

/**
 * Fetch complete album data: release group + remaining releases
 * Does NOT store track artists or the primary album artist — those are handled elsewhere
 */
async function fetchAlbumFull(releaseGroupMbid) {
  const mbProvider = registry.getProvider('musicbrainz');
  const config = require('./config');

  logger.info(`Fetching complete album data for ${releaseGroupMbid}`);

  // Fetch release group
  const releaseGroupData = await mbProvider.getReleaseGroup(releaseGroupMbid);

  // Store release group (artist already in DB from synchronous path)
  await metaHandler.storeReleaseGroup(releaseGroupMbid, releaseGroupData, null, { force: true });

  // Fetch remaining releases — skip only what's already stored in DB, apply status filter
  const allReleases = releaseGroupData.releases || [];
  const statusFilter = config.get('metadata.fetchTypes.releaseStatuses', ['Official']);
  const database = require('../sql/database');
  const storedResult = await database.query(
    'SELECT mbid FROM releases WHERE release_group_mbid = $1',
    [releaseGroupMbid]
  );
  const storedMbids = new Set(storedResult.rows.map(r => r.mbid));

  const remainingReleases = allReleases.filter(r => {
    const alreadyFetched = storedMbids.has(r.id);
    const matchesFilter = statusFilter.length === 0 || statusFilter.includes(r.status || 'Pseudo-Release');
    return !alreadyFetched && matchesFilter;
  });

  logger.info(`Fetching ${remainingReleases.length} remaining releases for album ${releaseGroupMbid}`);

  const failedReleases = [];

  for (const release of remainingReleases) {
    try {
      const fullRelease = await mbProvider.getRelease(release.id);
      await metaHandler.storeRelease(release.id, fullRelease);
      logger.info(`Stored ${release.status || 'Other'} release ${release.id}`);
    } catch (error) {
      logger.warn(`Failed to fetch ${release.status || 'Other'} release ${release.id} (will retry): ${error.message}`);
      failedReleases.push(release);
    }
  }

  if (failedReleases.length > 0) {
    await retryFailed(failedReleases, async (release) => {
      const fullRelease = await mbProvider.getRelease(release.id);
      await metaHandler.storeRelease(release.id, fullRelease);
    }, 'release');
  }

  logger.info(`Completed fetching remaining releases for album ${releaseGroupMbid}`);
}

module.exports = { processJob };