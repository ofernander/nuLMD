const { registry } = require('./providerRegistry');
const { logger } = require('./logger');
const metaHandler = require('./metaHandler');
const lidarr = require('./lidarr');

/**
 * Lidarr search — replicates oldLMD's /search endpoint exactly.
 * Routes based on 'type' query param:
 *   type=artist → flat array of artist objects
 *   type=album  → flat array of full album objects
 *   type=all    → array of { album, artist, score } wrappers
 */
async function lidarrSearch(query, type, { limit = 10, artist: artistFilter, includeTracks } = {}) {
  if (!type) {
    return { error: 'Type not provided', status: 400 };
  }

  if (type === 'artist') {
    return await searchArtists(query, limit);
  } else if (type === 'album') {
    return await searchAlbums(query, limit, artistFilter, includeTracks);
  } else if (type === 'all') {
    return await searchAll(query, limit, includeTracks);
  } else {
    return { error: `Unsupported search type ${type}`, status: 400 };
  }
}

async function searchArtists(query, limit) {
  const mbProvider = registry.getProvider('musicbrainz');
  if (!mbProvider) return [];

  const searchResults = await mbProvider.searchArtist(query, limit);
  const results = [];

  for (const result of searchResults) {
    try {
      await metaHandler.storeArtist(result.id, await mbProvider.getArtist(result.id), true);
      const formatted = await lidarr.formatArtist(result.id);
      const { Albums, ...artistWithoutAlbums } = formatted;
      results.push(artistWithoutAlbums);
    } catch (err) {
      logger.error(`Search: failed to format artist ${result.id}: ${err.message}`);
    }
  }

  logger.info(`Search: found ${results.length} artists for "${query}"`);
  return results;
}

async function searchAlbums(query, limit, artistFilter, includeTracks) {
  const mbProvider = registry.getProvider('musicbrainz');
  if (!mbProvider) return [];

  const searchResults = await mbProvider.searchAlbum(query, artistFilter || null, limit);
  const results = [];

  for (const result of searchResults) {
    try {
      // Store album and its releases in DB (same as ensureAlbum path)
      await metaHandler.ensureAlbum(result.id);
      const formatted = await lidarr.formatAlbum(result.id);

      // oldLMD strips releases unless includeTracks is requested
      if (!includeTracks) {
        formatted.releases = [];
      }

      results.push(formatted);
    } catch (err) {
      logger.error(`Search: failed to format album ${result.id}: ${err.message}`);
    }
  }

  logger.info(`Search: found ${results.length} albums for "${query}"`);
  return results;
}

async function searchAll(query, limit, includeTracks) {
  const [artists, albums] = await Promise.all([
    searchArtistsWithScores(query, limit),
    searchAlbumsWithScores(query, limit, includeTracks)
  ]);

  const results = [
    ...artists.map(a => ({ score: a.score, artist: a.data, album: null })),
    ...albums.map(a => ({ score: a.score, artist: null, album: a.data }))
  ];

  // Sort by score descending (matching oldLMD)
  results.sort((a, b) => b.score - a.score);

  logger.info(`Search: found ${artists.length} artists and ${albums.length} albums for "${query}"`);
  return results;
}

async function searchArtistsWithScores(query, limit) {
  const mbProvider = registry.getProvider('musicbrainz');
  if (!mbProvider) return [];

  const searchResults = await mbProvider.searchArtist(query, limit);
  const results = [];

  for (const result of searchResults) {
    try {
      await metaHandler.storeArtist(result.id, await mbProvider.getArtist(result.id), true);
      const formatted = await lidarr.formatArtist(result.id);
      const { Albums, ...artistWithoutAlbums } = formatted;
      results.push({ data: artistWithoutAlbums, score: result.score || 100 });
    } catch (err) {
      logger.error(`Search: failed to format artist ${result.id}: ${err.message}`);
    }
  }

  return results;
}

async function searchAlbumsWithScores(query, limit, includeTracks) {
  const mbProvider = registry.getProvider('musicbrainz');
  if (!mbProvider) return [];

  const searchResults = await mbProvider.searchAlbum(query, null, limit);
  const results = [];

  for (const result of searchResults) {
    try {
      await metaHandler.ensureAlbum(result.id);
      const formatted = await lidarr.formatAlbum(result.id);

      if (!includeTracks) {
        formatted.releases = [];
      }

      results.push({ data: formatted, score: result.score || 100 });
    } catch (err) {
      logger.error(`Search: failed to format album ${result.id}: ${err.message}`);
    }
  }

  return results;
}

module.exports = { lidarrSearch };
