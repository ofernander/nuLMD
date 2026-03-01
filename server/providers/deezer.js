const axios = require('axios');
const { logger } = require('../lib/logger');
const database = require('../sql/database');

/**
 * Deezer Provider — free, no API key required
 * Provides artist images (picture_big → Poster) and album covers (cover_big → Cover)
 * Used as fallback behind Fanart.tv (artist) and CoverArtArchive (album)
 */
class DeezerProvider {
  static capabilities = { artistImages: true, albumImages: true };

  constructor(config) {
    this.name = 'deezer';
    this.baseURL = 'https://api.deezer.com';
    this.timeout = 5000;
    // Cache: artistName → Map<normalizedTitle, { coverUrl, deezerAlbumId, fans }>
    this._albumMapCache = new Map();
    this._albumMapCacheTime = new Map();
    this._albumMapTTL = 3600000; // 1 hour
  }

  async initialize() {
    return true;
  }

  // ─── Title normalization (from Aurral) ────────────────────────────────────

  _normalizeTitle(title) {
    return String(title || '')
      .toLowerCase()
      .replace(
        /\s*[\(\[](deluxe|remaster|remastered|anniversary|expanded|bonus|edition|live|mono|stereo|special|super|complete|\d{4}).*[\)\]]/gi,
        ''
      )
      .replace(/\s+/g, ' ')
      .trim();
  }

  // ─── Artist search ────────────────────────────────────────────────────────

  /**
   * Search Deezer for an artist by name, return best match
   * @param {string} artistName
   * @returns {Promise<Object|null>} { id, name, imageUrl }
   */
  async _searchArtist(artistName) {
    if (!artistName) return null;

    try {
      const response = await axios.get(`${this.baseURL}/search/artist`, {
        params: { q: artistName, limit: 5 },
        timeout: this.timeout
      });

      const artists = response.data?.data;
      if (!artists?.length) return null;

      const searchLower = artistName.toLowerCase().replace(/^the\s+/i, '');
      let bestMatch = null;

      for (const a of artists) {
        if (!a?.id) continue;
        const aName = (a.name || '').toLowerCase().replace(/^the\s+/i, '');

        // Exact match
        if (aName === searchLower || aName === artistName.toLowerCase()) {
          bestMatch = a;
          break;
        }
        // Partial match fallback
        if (!bestMatch && aName.includes(searchLower)) {
          bestMatch = a;
        }
      }

      if (!bestMatch) bestMatch = artists[0];
      if (!bestMatch?.id) return null;

      return {
        id: bestMatch.id,
        name: bestMatch.name,
        imageUrl: bestMatch.picture_big || bestMatch.picture_medium || bestMatch.picture || null
      };
    } catch (err) {
      logger.warn(`Deezer: Artist search failed for "${artistName}": ${err.message}`);
      return null;
    }
  }

  // ─── Bulk album catalog fetch ─────────────────────────────────────────────

  /**
   * Fetch all albums for an artist from Deezer in one call, build lookup map.
   * Cached per artist name for 1 hour.
   * @param {string} artistName
   * @returns {Promise<Map<string, { coverUrl, deezerAlbumId, fans }>>}
   */
  async _getArtistAlbumMap(artistName) {
    const cacheKey = artistName.toLowerCase().trim();
    const cachedTime = this._albumMapCacheTime.get(cacheKey);
    if (cachedTime && Date.now() - cachedTime < this._albumMapTTL) {
      return this._albumMapCache.get(cacheKey);
    }

    const artist = await this._searchArtist(artistName);
    if (!artist?.id) {
      const empty = new Map();
      this._albumMapCache.set(cacheKey, empty);
      this._albumMapCacheTime.set(cacheKey, Date.now());
      return empty;
    }

    try {
      const response = await axios.get(`${this.baseURL}/artist/${artist.id}/albums`, {
        params: { limit: 100 },
        timeout: this.timeout
      });

      const albums = response.data?.data || [];
      const map = new Map();

      for (const a of albums) {
        if (!a?.id) continue;
        const coverUrl = a.cover_big || a.cover_medium || a.cover || null;
        if (!coverUrl) continue;

        const normTitle = this._normalizeTitle(a.title);
        const existing = map.get(normTitle);
        const fans = typeof a.fans === 'number' ? a.fans : 0;

        // Keep the entry with more fans (more popular = more likely correct)
        if (!existing || fans > existing.fans) {
          map.set(normTitle, { coverUrl, deezerAlbumId: a.id, fans });
        }
      }

      logger.info(`Deezer: Cached ${map.size} album covers for "${artistName}" (artist id: ${artist.id})`);
      this._albumMapCache.set(cacheKey, map);
      this._albumMapCacheTime.set(cacheKey, Date.now());
      return map;
    } catch (err) {
      logger.warn(`Deezer: Failed to fetch album catalog for "${artistName}": ${err.message}`);
      const empty = new Map();
      this._albumMapCache.set(cacheKey, empty);
      this._albumMapCacheTime.set(cacheKey, Date.now());
      return empty;
    }
  }

  // ─── Artist images ────────────────────────────────────────────────────────

  /**
   * Get artist images from Deezer
   * @param {string} mbid - MusicBrainz artist ID
   * @returns {Promise<Array>} Array of { Url, CoverType, Provider }
   */
  async getArtistImages(mbid) {
    // Look up artist name from DB
    const result = await database.query('SELECT name FROM artists WHERE mbid = $1', [mbid]);
    if (!result.rows[0]) return [];

    const artist = await this._searchArtist(result.rows[0].name);
    if (!artist?.imageUrl) return [];

    logger.info(`Deezer: Found artist image for "${artist.name}" (id: ${artist.id})`);

    return [{
      Url: artist.imageUrl,
      CoverType: 'Poster',
      Provider: 'deezer'
    }];
  }

  // ─── Album images ─────────────────────────────────────────────────────────

  /**
   * Get album cover from Deezer by matching release group title
   * @param {string} mbid - MusicBrainz release group ID
   * @returns {Promise<Array>} Array of { Url, CoverType, Provider }
   */
  async getAlbumImages(mbid) {
    const result = await database.query(
      `SELECT rg.title, a.name as artist_name
       FROM release_groups rg
       LEFT JOIN artist_release_groups arg ON arg.release_group_mbid = rg.mbid
       LEFT JOIN artists a ON a.mbid = arg.artist_mbid
       WHERE rg.mbid = $1 LIMIT 1`, [mbid]
    );
    if (!result.rows[0]) return [];

    const { title, artist_name } = result.rows[0];
    if (!artist_name || !title) return [];

    const albumMap = await this._getArtistAlbumMap(artist_name);
    const match = albumMap.get(this._normalizeTitle(title));
    if (!match) return [];

    logger.info(`Deezer: Matched album cover for "${title}" by ${artist_name} (deezer id: ${match.deezerAlbumId})`);

    return [{
      Url: match.coverUrl,
      CoverType: 'Cover',
      Provider: 'deezer'
    }];
  }
  // ─── Artist bio ──────────────────────────────────────────────────────────

  /**
   * Get artist biography from Deezer
   * @param {string} artistName
   * @returns {Promise<string|null>}
   */
  async getArtistBio(artistName) {
    const artist = await this._searchArtist(artistName);
    if (!artist?.id) return null;

    try {
      const response = await axios.get(`${this.baseURL}/artist/${artist.id}`, {
        timeout: this.timeout
      });
      const data = response.data;
      const bio = data?.biography || data?.bio || data?.description || null;
      if (typeof bio === 'string' && bio.trim()) {
        logger.info(`Deezer: Found bio for "${artistName}" (${bio.trim().length} chars)`);
        return bio.trim();
      }
      return null;
    } catch (err) {
      logger.warn(`Deezer: Artist bio failed for "${artistName}": ${err.message}`);
      return null;
    }
  }
}

module.exports = DeezerProvider;
