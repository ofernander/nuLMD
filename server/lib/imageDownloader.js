const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const database = require('../sql/database');
const { logger } = require('./logger');

/**
 * ImageDownloader - Downloads and caches images from external providers
 * 
 * Downloads images from TheAudioDB, CoverArtArchive, etc. and stores them locally
 * to avoid 403 hotlinking errors and provide faster access to Lidarr.
 */
class ImageDownloader {
  constructor() {
    // Base path relative to project root
    this.basePath = path.join(__dirname, '../../data/images');
    this.maxRetries = 3;
    this.timeout = 10000; // 10 seconds
    
    logger.info(`ImageDownloader initialized with base path: ${this.basePath}`);
  }

  /**
   * Download image from external URL
   * @param {Object} imageRecord - Database image record
   * @returns {Promise<Buffer>} - Image data as buffer
   */
  async downloadImage(imageRecord) {
    const { url, entity_type, entity_mbid, cover_type } = imageRecord;
    
    logger.debug(`Downloading image: ${url}`);
    
    // Extract domain from URL for dynamic Referer
    const urlObj = new URL(url);
    const referer = `${urlObj.protocol}//${urlObj.hostname}/`;
    
    const requestConfig = {
      responseType: 'arraybuffer',
      timeout: this.timeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': referer,
        'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'Sec-Fetch-Dest': 'image',
        'Sec-Fetch-Mode': 'no-cors',
        'Sec-Fetch-Site': 'cross-site'
      },
      maxRedirects: 5,
      validateStatus: (status) => status === 200
    };
    
    // Log full request details
    logger.debug(`Request URL: ${url}`);
    logger.debug(`Request headers: ${JSON.stringify(requestConfig.headers)}`);
    logger.debug(`Request config: ${JSON.stringify({...requestConfig, headers: requestConfig.headers})}`);
    
    try {
      const response = await axios.get(url, requestConfig);
      
      // Log response details
      logger.debug(`Response status: ${response.status}`);
      logger.debug(`Response headers: ${JSON.stringify(response.headers)}`);
      
      // Validate content type
      const contentType = response.headers['content-type'];
      if (!contentType || !contentType.startsWith('image/')) {
        throw new Error(`Invalid content-type: ${contentType}`);
      }
      
      logger.debug(`Downloaded ${response.data.length} bytes for ${entity_type} ${entity_mbid} ${cover_type}`);
      
      return {
        buffer: Buffer.from(response.data),
        contentType: contentType
      };
      
    } catch (error) {
      // Log detailed error for debugging
      if (error.response) {
        logger.debug(`Error response status: ${error.response.status}`);
        logger.debug(`Error response headers: ${JSON.stringify(error.response.headers)}`);
        logger.debug(`Error response data: ${error.response.data}`);
        // 404 is normal - not all albums have cover art
        if (error.response.status === 404) {
          logger.warn(`Download failed with status ${error.response.status}: ${url}`);
        } else {
          logger.error(`Download failed with status ${error.response.status}: ${url}`);
        }
      } else if (error.code === 'ECONNABORTED') {
        logger.error(`Download timeout after ${this.timeout}ms: ${url}`);
      } else {
        logger.debug(`Error code: ${error.code}`);
        logger.debug(`Error message: ${error.message}`);
        logger.error(`Download error: ${error.message} - ${url}`);
      }
      throw error;
    }
  }

  /**
   * Determine file extension from content-type or URL
   * @param {string} contentType - MIME type from response
   * @param {string} url - Original URL
   * @returns {string} - File extension without dot (e.g., 'jpg')
   */
  determineExtension(contentType, url) {
    const mimeMap = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
      'image/gif': 'gif'
    };
    
    // Try content-type first
    if (mimeMap[contentType]) {
      return mimeMap[contentType];
    }
    
    // Fallback to URL extension
    const urlMatch = url.match(/\.(jpg|jpeg|png|webp|gif)(\?.*)?$/i);
    if (urlMatch) {
      return urlMatch[1].toLowerCase() === 'jpeg' ? 'jpg' : urlMatch[1].toLowerCase();
    }
    
    // Default fallback
    return 'jpg';
  }

  /**
   * Save image buffer to disk
   * @param {Object} imageRecord - Database image record
   * @param {Buffer} imageBuffer - Image data
   * @param {string} contentType - MIME type
   * @returns {Promise<string>} - Local file path
   */
  async saveImageToDisk(imageRecord, imageBuffer, contentType) {
    const { entity_type, entity_mbid, cover_type, url } = imageRecord;
    
    // Determine file extension
    const ext = this.determineExtension(contentType, url);
    
    // Generate path: {basePath}/{entity_type}/{mbid}/{cover_type}.{ext}
    const dirPath = path.join(this.basePath, entity_type, entity_mbid);
    const filename = `${cover_type.toLowerCase()}.${ext}`;
    const filePath = path.join(dirPath, filename);
    
    try {
      // Create directories recursively if they don't exist
      await fs.mkdir(dirPath, { recursive: true });
      
      // Write image to disk
      await fs.writeFile(filePath, imageBuffer);
      
      logger.debug(`Saved image to: ${filePath}`);
      
      return filePath;
      
    } catch (error) {
      logger.error(`Failed to save image to ${filePath}:`, error.message);
      throw error;
    }
  }

  /**
   * Main download workflow - called by job queue
   * @param {number} imageId - Database image record ID
   */
  async processDownload(imageId) {
    let attempt = 0;
    let lastError = null;
    
    // Fetch image record from database
    const result = await database.query(
      'SELECT * FROM images WHERE id = $1',
      [imageId]
    );
    
    if (result.rows.length === 0) {
      logger.error(`Image record ${imageId} not found in database`);
      return;
    }
    
    const imageRecord = result.rows[0];
    const { entity_type, entity_mbid, cover_type, url, provider } = imageRecord;
    
    logger.info(`Processing download for ${entity_type} ${entity_mbid} ${cover_type} from ${provider}`);
    
    // Retry logic with exponential backoff
    while (attempt < this.maxRetries) {
      try {
        // Download image
        const { buffer, contentType } = await this.downloadImage(imageRecord);
        
        // Save to disk
        const localPath = await this.saveImageToDisk(imageRecord, buffer, contentType);
        
        // Update database - mark as cached
        await database.query(`
          UPDATE images
          SET cached = true,
              cached_at = NOW(),
              local_path = $1,
              cache_failed = false,
              cache_failed_reason = null
          WHERE id = $2
        `, [localPath, imageId]);
        
        logger.info(`Successfully downloaded and cached image ${imageId}: ${localPath}`);
        return;
        
      } catch (error) {
        attempt++;
        lastError = error;
        
        // Check if we should retry
        const shouldRetry = this.shouldRetry(error, attempt);
        
        if (!shouldRetry) {
          logger.warn(`Not retrying image ${imageId} after error: ${error.message}`);
          break;
        }
        
        if (attempt < this.maxRetries) {
          // Exponential backoff: 2^attempt seconds
          const delay = Math.pow(2, attempt) * 1000;
          logger.warn(`Download attempt ${attempt} failed for image ${imageId}, retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    
    // All retries exhausted - mark as failed
    await database.query(`
      UPDATE images
      SET cache_failed = true,
          cache_failed_reason = $1
      WHERE id = $2
    `, [lastError.message, imageId]);
    
    // 404 is normal - not all albums have cover art
    if (lastError.response && lastError.response.status === 404) {
      logger.warn(`Failed to download image ${imageId} after ${attempt} attempts: ${lastError.message}`);
    } else {
      logger.error(`Failed to download image ${imageId} after ${attempt} attempts: ${lastError.message}`);
    }
  }

  /**
   * Determine if download should be retried based on error
   * @param {Error} error - Error from download attempt
   * @param {number} attempt - Current attempt number
   * @returns {boolean} - True if should retry
   */
  shouldRetry(error, attempt) {
    // Don't retry if max attempts reached
    if (attempt >= this.maxRetries) {
      return false;
    }
    
    // Don't retry 404 Not Found
    if (error.response && error.response.status === 404) {
      return false;
    }
    
    // Don't retry 403 Forbidden (shouldn't happen, but just in case)
    if (error.response && error.response.status === 403) {
      return false;
    }
    
    // Don't retry invalid content-type
    if (error.message.includes('Invalid content-type')) {
      return false;
    }
    
    // Retry network timeouts
    if (error.code === 'ECONNABORTED') {
      return true;
    }
    
    // Retry 5xx server errors
    if (error.response && error.response.status >= 500) {
      return true;
    }
    
    // Retry network errors
    if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
      return true;
    }
    
    // Default: don't retry
    return false;
  }

  /**
   * Queue image download job
   * @param {number} imageId - Database image record ID
   */
  async queueDownload(imageId) {
    // Import here to avoid circular dependency
    const jobQueue = require('./jobQueue');
    
    // Use a dummy UUID format for entity_mbid since it's required by schema
    // We use '00000000-0000-0000-0000-' + imageId padded to 12 chars
    const dummyMbid = `00000000-0000-0000-0000-${String(imageId).padStart(12, '0')}`;
    
    await jobQueue.queueJob(
      'download_image',        // jobType
      'image',                 // entityType
      dummyMbid,              // entityMbid (dummy UUID format required by schema)
      0,                       // priority (low - don't block metadata)
      { imageId: imageId }     // metadata
    );
    
    logger.debug(`Queued download job for image ID ${imageId}`);
  }
}

// Export singleton instance
module.exports = new ImageDownloader();
