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
    // Legacy job types
    case 'artist_full':
      await fetchArtistFull(entity_mbid);
      break;
    
    case 'artist_releases':
      await fetchArtistReleases(entity_mbid, metadata);
      break;
    
    case 'release_tracks':
      await fetchReleaseTracks(entity_mbid);
      break;
    
    // New Lidarr-specific job types
    case 'fetch_artist':
      await fetchArtistBasic(entity_mbid);
      break;
    
    case 'fetch_artist_albums':
      await fetchArtistAlbums(entity_mbid);
      break;
    
    case 'fetch_release':
      await fetchReleaseFull(entity_mbid, metadata);
      break;
    
    case 'fetch_album_full':
      await fetchAlbumFull(entity_mbid);
      break;
    
    case 'download_image':
      // Image download job - metadata contains imageId
      const imageDownloader = require('./imageDownloader');
      await imageDownloader.processDownload(metadata.imageId);
      break;
    
    default:
      throw new Error(`Unknown job type: ${job_type}`);
  }
}

/**
 * Fetch complete artist data including all releases
 */
async function fetchArtistFull(artistMbid) {
  const mbProvider = registry.getProvider('musicbrainz');
  
  // Fetch artist details
  const artistData = await mbProvider.getArtist(artistMbid);
  await metaHandler.storeArtist(artistMbid, artistData, true);
  
  // Now fetch all releases with paging
  await fetchArtistReleases(artistMbid);
}

/**
 * Fetch all releases for an artist, paging through results
 * MB limits responses to ~500 tracks total, so we need to page
 * Now with delta updates - only fetches NEW releases
 */
async function fetchArtistReleases(artistMbid, metadata) {
  const database = require('../sql/database');
  const mbProvider = registry.getProvider('musicbrainz');
  
  // Mark fetch as started
  await database.markArtistFetchStarted(artistMbid);
  
  let offset = (metadata && metadata.offset) ? metadata.offset : 0;
  let totalFetched = 0;
  let hasMore = true;
  let allMBReleaseIds = []; // Track all release IDs from MusicBrainz
  
  while (hasMore) {
    logger.info(`Fetching releases for artist ${artistMbid}, offset ${offset}`);
    
    // Browse releases for this artist
    const releases = await mbProvider.browseReleases(artistMbid, {
      offset,
      limit: 100,
      inc: 'release-groups+artist-credits+labels+media+recordings'
    });
    
    if (!releases || releases.length === 0) {
      hasMore = false;
      break;
    }
    
    // Track all MB release IDs
    allMBReleaseIds.push(...releases.map(r => r.id));
    
    // Store each release
    for (const release of releases) {
      try {
        // First, ensure the release-group exists
        const releaseGroup = release['release-group'];
        if (releaseGroup && releaseGroup.id) {
          // Check if release-group exists, if not create it
          const rgExists = await metaHandler.checkReleaseGroupExists(releaseGroup.id);
          if (!rgExists) {
            // Normalize the date
            let releaseDate = releaseGroup['first-release-date'] || release.date;
            if (releaseDate) {
              if (releaseDate.length === 4) {
                releaseDate = `${releaseDate}-01-01`; // Year only
              } else if (releaseDate.length === 7) {
                releaseDate = `${releaseDate}-01`; // Year-Month
              }
            }
            
            // Store basic release-group info (we'll fetch full details later if needed)
            await metaHandler.storeReleaseGroup(releaseGroup.id, {
              title: releaseGroup.title || release.title,
              primaryType: releaseGroup['primary-type'] || 'Album',
              secondaryTypes: releaseGroup['secondary-types'] || [],
              firstReleaseDate: releaseDate,
              disambiguation: releaseGroup.disambiguation || '',
              artistCredit: releaseGroup['artist-credit'] || release['artist-credit'] || []
            }, artistMbid);
          }
        }
        
        // Now store the release
        await metaHandler.storeRelease(release.id, release);
      } catch (error) {
        logger.error(`Failed to store release ${release.id}:`, error);
        // Continue with next release
      }
    }
    
    totalFetched += releases.length;
    offset += releases.length; // MB docs say to increment by number returned, not limit
    
    logger.info(`Fetched ${releases.length} releases (${totalFetched} total so far) for artist ${artistMbid}`);
  }
  
  // Now fetch full release-group data (tags, genres, rating, aliases, links)
  // Get unique release-groups from what we just stored
  const releaseGroups = await metaHandler.getArtistReleaseGroups(artistMbid);
  
  logger.info(`Fetching full data for ${releaseGroups.length} release-groups`);
  
  const failedReleaseGroups = [];

  // First pass: try all release-groups
  for (const rgMbid of releaseGroups) {
    try {
      const fullRgData = await mbProvider.getAlbum(rgMbid);
      await metaHandler.storeReleaseGroup(rgMbid, fullRgData, artistMbid);
    } catch (error) {
      logger.warn(`Failed to fetch release-group ${rgMbid} (will retry): ${error.message}`);
      failedReleaseGroups.push(rgMbid);
    }
  }

  // Retry failed release-groups
  const stillFailed = failedReleaseGroups.length > 0
    ? await retryFailed(failedReleaseGroups, async (rgMbid) => {
        const fullRgData = await mbProvider.getAlbum(rgMbid);
        await metaHandler.storeReleaseGroup(rgMbid, fullRgData, artistMbid);
      }, 'release-group')
    : [];

  const successCount = releaseGroups.length - stillFailed.length;
  logger.info(`Completed fetching ${totalFetched} releases and ${successCount}/${releaseGroups.length} release-groups for artist ${artistMbid}`);
  
  // Mark fetch as complete
  await database.markArtistFetchComplete(artistMbid, allMBReleaseIds.length);
}

/**
 * Fetch complete track data for a release
 */
async function fetchReleaseTracks(releaseMbid) {
  const mbProvider = registry.getProvider('musicbrainz');
  
  const releaseData = await mbProvider.getRelease(releaseMbid);
  await metaHandler.storeRelease(releaseMbid, releaseData);
}

/**
 * Fetch basic artist data (for track artists)
 */
async function fetchArtistBasic(artistMbid) {
  const mbProvider = registry.getProvider('musicbrainz');
  
  logger.info(`Fetching basic artist data for ${artistMbid}`);
  const artistData = await mbProvider.getArtist(artistMbid);
  await metaHandler.storeArtist(artistMbid, artistData, false);
}

/**
 * Fetch all albums for an artist
 */
async function fetchArtistAlbums(artistMbid) {
  const mbProvider = registry.getProvider('musicbrainz');
  const database = require('../sql/database');

  logger.info(`Fetching all albums for artist ${artistMbid}`);

  // Get all albums from MB
  const albums = await mbProvider.getArtistAlbums(artistMbid);
  logger.info(`Found ${albums.length} albums for artist ${artistMbid}`);

  // First pass: store each album
  const failedAlbums = [];
  for (const album of albums) {
    try {
      const fullAlbum = await mbProvider.getReleaseGroup(album.id);
      await metaHandler.storeReleaseGroup(album.id, fullAlbum, artistMbid);
    } catch (error) {
      logger.warn(`Failed to fetch/store album ${album.id} (will retry): ${error.message}`);
      failedAlbums.push(album);
    }
  }

  // Retry failures
  if (failedAlbums.length > 0) {
    await retryFailed(failedAlbums, async (album) => {
      const fullAlbum = await mbProvider.getReleaseGroup(album.id);
      await metaHandler.storeReleaseGroup(album.id, fullAlbum, artistMbid);
    }, 'album');
  }

  logger.info(`Completed fetching albums for artist ${artistMbid}: ${albums.length} total, ${failedAlbums.length} initially failed`);
}

/**
 * Fetch full release data with tracks
 */
async function fetchReleaseFull(releaseMbid, metadata) {
  const mbProvider = registry.getProvider('musicbrainz');
  
  logger.info(`Fetching full release data for ${releaseMbid}`);
  const releaseData = await mbProvider.getRelease(releaseMbid);
  await metaHandler.storeRelease(releaseMbid, releaseData);
}

/**
 * Fetch complete album data: release group + ALL releases + track artists
 */
async function fetchAlbumFull(releaseGroupMbid) {
  const mbProvider = registry.getProvider('musicbrainz');
  const database = require('../sql/database');
  
  logger.info(`Fetching complete album data for ${releaseGroupMbid}`);
  
  // Fetch release group
  const releaseGroupData = await mbProvider.getReleaseGroup(releaseGroupMbid);
  
  // Extract and store artist if needed
  let artistId = null;
  if (releaseGroupData['artist-credit'] && releaseGroupData['artist-credit'].length > 0) {
    artistId = releaseGroupData['artist-credit'][0].artist.id;
    const artistExists = await database.getArtist(artistId);
    if (!artistExists) {
      logger.info(`Fetching missing artist ${artistId}`);
      const artistData = await mbProvider.getArtist(artistId);
      await metaHandler.storeArtist(artistId, artistData, false);
    }
  }
  
  // Store release group
  await metaHandler.storeReleaseGroup(releaseGroupMbid, releaseGroupData, artistId);
  
  // Fetch only non-Official releases (Official already fetched synchronously)
  const allReleases = releaseGroupData.releases || [];
  const nonOfficialReleases = allReleases.filter(r => r.status !== 'Official');
  
  logger.info(`Fetching ${nonOfficialReleases.length} non-Official releases for album ${releaseGroupMbid}`);

  const trackArtistIds = new Set();
  const failedReleases = [];

  // Helper to collect track artists from a fetched release
  function collectTrackArtists(fullRelease) {
    const media = fullRelease.media || [];
    media.forEach(medium => {
      const tracks = medium.tracks || [];
      tracks.forEach(track => {
        const artistCredit = track['artist-credit'] || [];
        if (artistCredit.length > 0) {
          trackArtistIds.add(artistCredit[0].artist.id);
        }
      });
    });
  }

  // First pass: fetch non-Official releases
  for (const release of nonOfficialReleases) {
    try {
      const fullRelease = await mbProvider.getRelease(release.id);
      await metaHandler.storeRelease(release.id, fullRelease);
      collectTrackArtists(fullRelease);
      logger.info(`Stored ${release.status || 'Other'} release ${release.id}`);
    } catch (error) {
      logger.warn(`Failed to fetch ${release.status || 'Other'} release ${release.id} (will retry): ${error.message}`);
      failedReleases.push(release);
    }
  }

  // Retry failed releases
  if (failedReleases.length > 0) {
    await retryFailed(failedReleases, async (release) => {
      const fullRelease = await mbProvider.getRelease(release.id);
      await metaHandler.storeRelease(release.id, fullRelease);
      collectTrackArtists(fullRelease);
    }, 'release');
  }

  // Fetch any missing track artists
  const missingArtistIds = [];
  for (const trackArtistId of trackArtistIds) {
    const exists = await database.getArtist(trackArtistId);
    if (!exists) {
      missingArtistIds.push(trackArtistId);
    }
  }

  logger.info(`Found ${trackArtistIds.size} unique track artists, ${missingArtistIds.length} missing from DB`);

  const failedArtists = [];
  for (const trackArtistId of missingArtistIds) {
    try {
      const artistData = await mbProvider.getArtist(trackArtistId);
      await metaHandler.storeArtist(trackArtistId, artistData, false);
    } catch (error) {
      logger.warn(`Failed to fetch track artist ${trackArtistId} (will retry): ${error.message}`);
      failedArtists.push(trackArtistId);
    }
  }

  // Retry failed track artists
  if (failedArtists.length > 0) {
    await retryFailed(failedArtists, async (trackArtistId) => {
      const artistData = await mbProvider.getArtist(trackArtistId);
      await metaHandler.storeArtist(trackArtistId, artistData, false);
    }, 'track-artist');
  }

  logger.info(`Completed fetching album ${releaseGroupMbid} with ${nonOfficialReleases.length} releases and ${trackArtistIds.size} track artists`);
}

module.exports = { processJob };