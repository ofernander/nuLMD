const axios = require('axios');
const { logger } = require('../lib/logger');

class FanartProvider {
  constructor(config) {
    this.baseURL = 'https://webservice.fanart.tv/v3';
    this.name = 'fanart';
    this.apiKey = config?.apiKey || process.env.FANART_API_KEY;
  }

  async initialize() {
    if (!this.apiKey) {
      return false;
    }
    
    return true;
  }

  /**
   * Get artist images from Fanart.tv
   * @param {string} mbid - MusicBrainz artist ID
   * @returns {Promise<Array>} Array of image objects
   */
  async getArtistImages(mbid) {
    if (!this.apiKey) {
      throw new Error('Fanart.tv API key not configured');
    }

    try {
      const response = await axios.get(`${this.baseURL}/music/${mbid}`, {
        params: {
          api_key: this.apiKey
        },
        timeout: 10000
      });

      const data = response.data;
      const images = [];

      // Map Fanart.tv image types to our CoverType enum
      // Priority order: Logo > Banner > Background > Thumb
      
      // Logos (HD preferred)
      if (data.hdmusiclogo && data.hdmusiclogo.length > 0) {
        images.push({
          Url: data.hdmusiclogo[0].url,
          CoverType: 'Logo',
          Provider: 'fanart'
        });
      } else if (data.musiclogo && data.musiclogo.length > 0) {
        images.push({
          Url: data.musiclogo[0].url,
          CoverType: 'Logo',
          Provider: 'fanart'
        });
      }

      // Banner
      if (data.musicbanner && data.musicbanner.length > 0) {
        images.push({
          Url: data.musicbanner[0].url,
          CoverType: 'Banner',
          Provider: 'fanart'
        });
      }

      // Backgrounds (4K preferred)
      if (data.artist4kbackground && data.artist4kbackground.length > 0) {
        images.push({
          Url: data.artist4kbackground[0].url,
          CoverType: 'Fanart',
          Provider: 'fanart'
        });
      } else if (data.artistbackground && data.artistbackground.length > 0) {
        images.push({
          Url: data.artistbackground[0].url,
          CoverType: 'Fanart',
          Provider: 'fanart'
        });
      }

      // Thumbnail
      if (data.artistthumb && data.artistthumb.length > 0) {
        images.push({
          Url: data.artistthumb[0].url,
          CoverType: 'Poster',
          Provider: 'fanart'
        });
      }

      return images;
    } catch (error) {
      if (error.response?.status === 404) {
        logger.debug(`No Fanart.tv images found for artist ${mbid}`);
        return [];
      }
      
      logger.error(`Fanart.tv API error for artist ${mbid}:`, error.message);
      throw error;
    }
  }

  /**
   * Get album images from Fanart.tv
   * @param {string} mbid - MusicBrainz release group ID
   * @returns {Promise<Array>} Array of image objects
   */
  async getAlbumImages(mbid) {
    if (!this.apiKey) {
      throw new Error('Fanart.tv API key not configured');
    }

    try {
      const response = await axios.get(`${this.baseURL}/music/albums/${mbid}`, {
        params: {
          api_key: this.apiKey
        },
        timeout: 10000
      });

      const data = response.data;
      const images = [];

      // The albums endpoint returns the parent artist with only the requested album
      if (data.albums && data.albums.length > 0) {
        const album = data.albums[0];

        // Album cover
        if (album.albumcover && album.albumcover.length > 0) {
          images.push({
            Url: album.albumcover[0].url,
            CoverType: 'Cover',
            Provider: 'fanart'
          });
        }

        // CD Art (disc)
        if (album.cdart && album.cdart.length > 0) {
          images.push({
            Url: album.cdart[0].url,
            CoverType: 'Disc',
            Provider: 'fanart'
          });
        }
      }

      return images;
    } catch (error) {
      if (error.response?.status === 404) {
        logger.debug(`No Fanart.tv images found for album ${mbid}`);
        return [];
      }
      
      logger.error(`Fanart.tv API error for album ${mbid}:`, error.message);
      throw error;
    }
  }
}

module.exports = FanartProvider;
