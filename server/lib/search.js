const { registry } = require('./providerRegistry');
const { logger } = require('./logger');
const lidarr = require('./lidarr');
const services = require('./mbWs/services');
const blocklist = require('./blocklist');

// The same search typed again within a few hours is answered from the database, not asked of MusicBrainz again
// (`ws2.searchTtlHours`, the lifetime /ws/2 searches have). Only the search hits are kept; they are turned into results
// from the tables as before.
function searchHits(mbProvider, op, ...args) {
  const [query, ...rest] = args;
  const key = `lidarr-search:${op}:${JSON.stringify([String(query).trim().toLowerCase(), ...rest])}`;
  return services.proxy().remember(key, () => mbProvider[op](...args));
}

/**
 * Lidarr search — replicates oldLMD's /search endpoint exactly.
 * Routes based on 'type' query param:
 *   type=artist → flat array of artist objects
 *   type=album  → flat array of full album objects
 *   type=all    → array of { album, artist, score } wrappers
 */
async function lidarrSearch(query, type, { limit = 5, artist: artistFilter, includeTracks } = {}) {
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

// Build result items from MB search hits WITHOUT a per-result full MB fetch.
// Candidates already in the DB are formatted richly from DB (no MB call); the rest
// return a lightweight item. Full ingestion happens when Lidarr looks up the picked
// entity via /artist/:mbid or /album/:mbid. This is the whole speedup — search now
// makes just the one MB search call instead of N rate-limited detail fetches.
async function buildArtistResults(searchResults) {
  searchResults = searchResults.filter(r => !blocklist.isBlocked('artist', r.id));
  const cached = await lidarr.getArtistsBatch(searchResults.map(r => r.id));
  const results = [];
  for (const result of searchResults) {
    try {
      let data;
      if (cached.has(result.id)) {
        const { Albums, ...rest } = await lidarr.formatArtist(result.id);
        data = rest;
      } else {
        data = lidarr.formatArtistLight(result);
      }
      results.push({ data, score: result.score || 100 });
    } catch (err) {
      logger.error(`Search: failed to format artist ${result.id}: ${err.message}`);
    }
  }
  return results;
}

async function buildAlbumResults(searchResults, includeTracks) {
  searchResults = searchResults.filter(r => !blocklist.isBlocked('release_group', r.id));
  const present = await lidarr.getReleaseGroupsPresent(searchResults.map(r => r.id));
  const results = [];
  for (const result of searchResults) {
    try {
      let data;
      if (present.has(result.id)) {
        data = await lidarr.formatAlbum(result.id);
        if (!includeTracks) data.releases = [];
      } else {
        data = lidarr.formatAlbumLight(result);
      }
      results.push({ data, score: result.score || 100 });
    } catch (err) {
      logger.error(`Search: failed to format album ${result.id}: ${err.message}`);
    }
  }
  return results;
}

async function searchArtists(query, limit) {
  const mbProvider = registry.getProvider('musicbrainz');
  if (!mbProvider) return [];

  const searchResults = await searchHits(mbProvider, 'searchArtist', query, limit);
  const results = (await buildArtistResults(searchResults)).map(r => r.data);
  logger.info(`Search: found ${results.length} artists for "${query}"`);
  return results;
}

async function searchAlbums(query, limit, artistFilter, includeTracks) {
  const mbProvider = registry.getProvider('musicbrainz');
  if (!mbProvider) return [];

  const searchResults = await searchHits(mbProvider, 'searchAlbum', query, artistFilter || null, limit);
  const results = (await buildAlbumResults(searchResults, includeTracks)).map(r => r.data);
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

  const searchResults = await searchHits(mbProvider, 'searchArtist', query, limit);
  return buildArtistResults(searchResults);
}

async function searchAlbumsWithScores(query, limit, includeTracks) {
  const mbProvider = registry.getProvider('musicbrainz');
  if (!mbProvider) return [];

  const searchResults = await searchHits(mbProvider, 'searchAlbum', query, null, limit);
  return buildAlbumResults(searchResults, includeTracks);
}

module.exports = { lidarrSearch };
