const BaseProvider = require('./base');
const { logger } = require('../lib/logger');

class TheAudioDBProvider extends BaseProvider {
  constructor(config) {
    // Free API key is 123, users can provide their own premium key
    const apiKey = config.apiKey || '123';
    
    const providerConfig = {
      ...config,
      // Base URL includes the API key in the path: /api/v1/json/{key}/
      baseUrl: `https://www.theaudiodb.com/api/v1/json/${apiKey}`,
      rateLimit: {
        requests: 1,
        period: 2000  // 30 requests per minute = 1 request every 2 seconds
      }
    };
    
    super('TheAudioDB', providerConfig);
    this.apiKey = apiKey;
  }

  async initialize() {
    await super.initialize();
  }

  /**
   * Get artist images from TheAudioDB
   * @param {string} artistName - Artist name
   * @param {string} mbid - MusicBrainz ID (optional)
   * @returns {Promise<Array>} - Array of image objects with {CoverType, Url}
   */
  async getArtistImages(artistName, mbid = null) {
    const cacheKey = `tadb:artist:images:${mbid || artistName}`;
    
    return this.cachedRequest(cacheKey, async () => {
      let artistData = null;
      
      // Try MBID first (more accurate) - endpoint: artist-mb.php?i={mbid}
      if (mbid) {
        artistData = await this.searchByMBID(mbid);
      }
      
      // Fallback to name search - endpoint: search.php?s={name}
      if (!artistData && artistName) {
        artistData = await this.searchByName(artistName);
      }
      
      if (!artistData) {
        logger.debug(`TheAudioDB: No data found for ${artistName || mbid}`);
        return [];
      }
      
      // Extract images
      return this.extractImages(artistData);
    }, 7 * 24 * 60 * 60); // Cache for 7 days
  }

  async searchByMBID(mbid) {
    try {
      logger.debug(`TheAudioDB: Searching by MBID ${mbid}`);
      
      // Endpoint: /artist-mb.php?i={musicbrainz_id}
      const response = await this.client.get('/artist-mb.php', {
        params: { i: mbid }
      });
      
      if (response.data && response.data.artists && response.data.artists.length > 0) {
        return response.data.artists[0];
      }
      
      return null;
    } catch (error) {
      logger.error(`TheAudioDB: Failed to search by MBID ${mbid}:`, error.message);
      return null;
    }
  }

  async searchByName(artistName) {
    try {
      logger.debug(`TheAudioDB: Searching by name "${artistName}"`);
      
      // Endpoint: /search.php?s={artist_name}
      const response = await this.client.get('/search.php', {
        params: { s: artistName }
      });
      
      if (response.data && response.data.artists && response.data.artists.length > 0) {
        return response.data.artists[0];
      }
      
      return null;
    } catch (error) {
      logger.error(`TheAudioDB: Failed to search by name "${artistName}":`, error.message);
      return null;
    }
  }

  /**
   * Get album images from TheAudioDB
   * @param {string} albumTitle - Album title
   * @param {string} artistName - Artist name (for search)
   * @param {string} mbid - MusicBrainz release group ID (optional)
   * @returns {Promise<Array>} - Array of image objects with {CoverType, Url}
   */
  async getAlbumImages(albumTitle, artistName, mbid = null) {
    const cacheKey = `tadb:album:images:${mbid || `${artistName}-${albumTitle}`}`;
    
    return this.cachedRequest(cacheKey, async () => {
      let albumData = null;
      
      // Try MBID first - endpoint: album-mb.php?i={mbid}
      if (mbid) {
        albumData = await this.searchAlbumByMBID(mbid);
      }
      
      // Fallback to artist+album search - endpoint: searchalbum.php?s={artist}&a={album}
      if (!albumData && artistName && albumTitle) {
        albumData = await this.searchAlbumByName(artistName, albumTitle);
      }
      
      if (!albumData) {
        logger.debug(`TheAudioDB: No album data found for ${albumTitle}`);
        return [];
      }
      
      // Extract album images
      return this.extractAlbumImages(albumData);
    }, 7 * 24 * 60 * 60); // Cache for 7 days
  }

  async searchAlbumByMBID(mbid) {
    try {
      logger.debug(`TheAudioDB: Searching album by MBID ${mbid}`);
      
      // Endpoint: /album-mb.php?i={musicbrainz_id}
      const response = await this.client.get('/album-mb.php', {
        params: { i: mbid }
      });
      
      if (response.data && response.data.album && response.data.album.length > 0) {
        return response.data.album[0];
      }
      
      return null;
    } catch (error) {
      logger.error(`TheAudioDB: Failed to search album by MBID ${mbid}:`, error.message);
      return null;
    }
  }

  async searchAlbumByName(artistName, albumTitle) {
    try {
      logger.debug(`TheAudioDB: Searching album "${albumTitle}" by ${artistName}`);
      
      // Endpoint: /searchalbum.php?s={artist}&a={album}
      const response = await this.client.get('/searchalbum.php', {
        params: { 
          s: artistName,
          a: albumTitle
        }
      });
      
      if (response.data && response.data.album && response.data.album.length > 0) {
        return response.data.album[0];
      }
      
      return null;
    } catch (error) {
      logger.error(`TheAudioDB: Failed to search album "${albumTitle}":`, error.message);
      return null;
    }
  }

  extractImages(artistData) {
    const images = [];
    
    // TheAudioDB field mapping to Lidarr CoverType
    // Field names from API response (all start with strArtist)
    const imageMap = {
      strArtistThumb: 'Poster',      // Artist thumbnail
      strArtistLogo: 'Logo',         // Artist logo (PNG)
      strArtistFanart: 'Fanart',     // Artist fanart background
      strArtistBanner: 'Banner'      // Artist banner
    };
    
    for (const [field, coverType] of Object.entries(imageMap)) {
      if (artistData[field]) {
        images.push({
          CoverType: coverType,
          Url: artistData[field],
          Provider: 'theaudiodb'
        });
      }
    }
    
    logger.info(`TheAudioDB: Found ${images.length} images for artist`);
    return images;
  }

  extractAlbumImages(albumData) {
    const images = [];
    
    // TheAudioDB album field mapping to Lidarr CoverType
    const imageMap = {
      strAlbumThumb: 'Cover',        // Album cover art
      strAlbumThumbBack: 'Disc',     // Album back cover
      strAlbumCDart: 'Disc'          // CD art (disc image)
    };
    
    for (const [field, coverType] of Object.entries(imageMap)) {
      if (albumData[field]) {
        images.push({
          CoverType: coverType,
          Url: albumData[field],
          Provider: 'theaudiodb'
        });
      }
    }
    
    logger.info(`TheAudioDB: Found ${images.length} images for album`);
    return images;
  }
}

module.exports = TheAudioDBProvider;
