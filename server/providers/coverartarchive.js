const BaseProvider = require('./base');
const { logger } = require('../lib/logger');

class CoverArtArchiveProvider extends BaseProvider {
  static capabilities = { artistImages: false, albumImages: true };

  constructor(config) {
    const providerConfig = {
      ...config,
      baseUrl: 'https://coverartarchive.org',
      rateLimit: {
        requests: 1,
        period: Number(config && config.rateLimitMs) || 1000  // ms between requests; the archive documents no limit, so one a second
      }
    };
    
    super('CoverArtArchive', providerConfig);
  }

  async initialize() {
    await super.initialize();
  }

  /**
   * Get release group (album) images from Cover Art Archive
   * @param {string} mbid - MusicBrainz release group ID
   * @returns {Promise<Array>} - Array of image objects with {CoverType, Url}
   */
  async getAlbumImages(mbid) {
    const cacheKey = `caa:album:${mbid}`;
    
    return this.cachedRequest(cacheKey, async () => {
      try {
        logger.debug(`CoverArtArchive: Fetching album images for ${mbid}`);
        
        // Endpoint: /release-group/{mbid}
        const response = await this.client.get(`/release-group/${mbid}`);
        
        if (!response.data || !response.data.images) {
          logger.debug(`CoverArtArchive: No images found for album ${mbid}`);
          return [];
        }
        
        return this.extractImages(response.data.images);
        
      } catch (error) {
        // 404 is normal - not all albums have cover art
        if (error.response && error.response.status === 404) {
          logger.debug(`CoverArtArchive: No cover art found for album ${mbid}`);
          return [];
        }
        
        // Re-throw to let BaseProvider's cachedRequest handle retries
        throw error;
      }
    }, 7 * 24 * 60 * 60); // Cache for 7 days
  }

  /**
   * The front cover of a release group, without asking the archive anything: its own address for the group's front image
   * (it redirects to the file). Only for a group MusicBrainz says has a front image; a group without one answers 404.
   * @param {string} mbid - MusicBrainz release group ID
   * @returns {Array} - one image object with {CoverType, Url, Provider}
   */
  directCover(mbid) {
    return [{ CoverType: 'Cover', Url: `https://coverartarchive.org/release-group/${mbid}/front`, Provider: 'coverartarchive' }];
  }

  extractImages(images) {
    const extracted = [];
    
    // Cover Art Archive returns images array with types and URLs
    // We need to map their types to Lidarr's CoverType values
    for (const image of images) {
      const types = image.types || [];
      const url = image.image; // Full resolution image URL

      // Cover Art Archive occasionally returns an entry with no usable image
      // URL — skip it rather than emitting a blank-URL cover.
      if (!url) continue;

      // Map Cover Art Archive types to Lidarr CoverType
      if (types.includes('Front')) {
        extracted.push({
          CoverType: 'Cover',
          Url: url,
          Provider: 'coverartarchive'
        });
      }
      
      if (types.includes('Back')) {
        extracted.push({
          CoverType: 'Disc',  // Use Disc for back cover
          Url: url,
          Provider: 'coverartarchive'
        });
      }
      
      // Medium type is the disc/CD art
      if (types.includes('Medium')) {
        extracted.push({
          CoverType: 'Disc',
          Url: url,
          Provider: 'coverartarchive'
        });
      }
    }
    
    logger.info(`CoverArtArchive: Found ${extracted.length} images`);
    return extracted;
  }
}

module.exports = CoverArtArchiveProvider;
