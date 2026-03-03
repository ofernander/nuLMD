/**
 * Lidarr API Client
 * 
 * Communicates with a Lidarr instance to trigger metadata refreshes
 * and map MusicBrainz IDs to Lidarr's internal integer IDs.
 * 
 * API: Lidarr v1 (/api/v1)
 * Auth: X-Api-Key header
 */

const axios = require('axios');
const { logger } = require('./logger');
const config = require('./config');

class LidarrClient {
  constructor() {
    this.client = null;
    this.enabled = false;
    this.url = null;
    this.apiKey = null;
    
    // MBID → Lidarr integer ID cache
    this.artistMap = new Map();
    this.lastMapRefresh = null;
    this.mapRefreshInterval = 30 * 60 * 1000; // 30 minutes
  }

  /**
   * Initialize client from config. 
   * Call after config.load() completes.
   * Silently disables if URL or API key missing.
   */
  initialize() {
    const cfg = config.get('lidarrIntegration', {});
    this.url = cfg.url || process.env.LIDARR_URL || '';
    this.apiKey = cfg.apiKey || process.env.LIDARR_API_KEY || '';
    this.enabled = cfg.enabled !== false;

    // Guard: need both URL and API key
    if (!this.url || !this.apiKey) {
      if (this.enabled) {
        logger.warn('Lidarr-Client: enabled but URL or API key missing — disabled');
      }
      this.enabled = false;
      this.client = null;
      return;
    }

    // Strip trailing slash from URL
    this.url = this.url.replace(/\/+$/, '');

    this.client = axios.create({
      baseURL: `${this.url}/api/v1`,
      headers: { 'X-Api-Key': this.apiKey },
      timeout: 15000
    });

    logger.info(`Lidarr-Client: initialized: ${this.url}`);
  }

  /**
   * Test connection to Lidarr.
   * @returns {Promise<{success: boolean, version?: string, error?: string}>}
   */
  async testConnection() {
    if (!this.client) {
      return { success: false, error: 'Client not initialized' };
    }

    try {
      const response = await this.client.get('/system/status');
      const version = response.data?.version || 'unknown';
      logger.info(`Lidarr-Client: connection OK — version ${version}`);
      return { success: true, version };
    } catch (error) {
      const msg = this._formatError(error);
      logger.error(`Lidarr-Client: connection test failed: ${msg}`);
      return { success: false, error: msg };
    }
  }

  /**
   * Fetch all artists from Lidarr and build MBID → ID map.
   * @returns {Promise<number>} Number of artists mapped
   */
  async refreshArtistMap() {
    if (!this.client) return 0;

    try {
      const response = await this.client.get('/artist');
      const artists = response.data || [];

      this.artistMap.clear();
      for (const artist of artists) {
        if (artist.foreignArtistId) {
          this.artistMap.set(artist.foreignArtistId, {
            id: artist.id,
            name: artist.artistName || artist.name || ''
          });
        }
      }

      this.lastMapRefresh = Date.now();
      logger.info(`Lidarr-Client: artist map refreshed: ${this.artistMap.size} artists`);
      return this.artistMap.size;
    } catch (error) {
      const msg = this._formatError(error);
      logger.error(`Lidarr-Client: failed to refresh artist map: ${msg}`);
      return 0;
    }
  }

  /**
   * Get Lidarr integer ID for an artist by MBID.
   * Refreshes the map if stale.
   * @param {string} mbid - MusicBrainz artist ID
   * @returns {Promise<number|null>} Lidarr artist ID or null if not found
   */
  async getLidarrId(mbid) {
    if (!this.client) return null;

    // Refresh map if stale or empty
    if (this.artistMap.size === 0 || this._isMapStale()) {
      await this.refreshArtistMap();
    }

    const entry = this.artistMap.get(mbid);
    return entry ? entry.id : null;
  }

  /**
   * Trigger RefreshArtist command in Lidarr.
   * @param {number} lidarrArtistId - Lidarr internal artist ID
   * @returns {Promise<{success: boolean, commandId?: number, error?: string}>}
   */
  async refreshArtist(lidarrArtistId) {
    if (!this.client) {
      return { success: false, error: 'Client not initialized' };
    }

    try {
      const response = await this.client.post('/command', {
        name: 'RefreshArtist',
        artistIds: [lidarrArtistId]
      });

      const commandId = response.data?.id;
      logger.info(`Lidarr-Client: RefreshArtist command sent for artist ID ${lidarrArtistId} — command ID ${commandId}`);
      return { success: true, commandId };
    } catch (error) {
      const msg = this._formatError(error);
      logger.error(`Lidarr-Client: RefreshArtist failed for artist ID ${lidarrArtistId}: ${msg}`);
      return { success: false, error: msg };
    }
  }

  /**
   * Trigger RefreshArtist by MBID. Handles the MBID→ID lookup.
   * @param {string} mbid - MusicBrainz artist ID
   * @returns {Promise<{success: boolean, commandId?: number, skipped?: boolean, error?: string}>}
   */
  async refreshArtistByMbid(mbid) {
    if (!this.enabled || !this.client) {
      return { success: false, skipped: true, error: 'Lidarr integration disabled' };
    }

    const lidarrId = await this.getLidarrId(mbid);
    if (!lidarrId) {
      logger.debug(`Lidarr-Client: artist ${mbid} not found in Lidarr — skipping refresh`);
      return { success: false, skipped: true, error: 'Artist not in Lidarr' };
    }

    return this.refreshArtist(lidarrId);
  }

  /**
   * Get command status from Lidarr.
   * @param {number} commandId
   * @returns {Promise<{status: string, error?: string}>}
   */
  async getCommandStatus(commandId) {
    if (!this.client) {
      return { status: 'unknown', error: 'Client not initialized' };
    }

    try {
      const response = await this.client.get(`/command/${commandId}`);
      return { status: response.data?.status || 'unknown' };
    } catch (error) {
      return { status: 'unknown', error: this._formatError(error) };
    }
  }

  /**
   * Get map stats for debugging/UI.
   */
  getStats() {
    return {
      enabled: this.enabled,
      url: this.url || null,
      connected: !!this.client,
      artistCount: this.artistMap.size,
      lastMapRefresh: this.lastMapRefresh ? new Date(this.lastMapRefresh).toISOString() : null
    };
  }

  // ─── Private ─────────────────────────────────────────────

  _isMapStale() {
    if (!this.lastMapRefresh) return true;
    return (Date.now() - this.lastMapRefresh) > this.mapRefreshInterval;
  }

  _formatError(error) {
    if (error.response) {
      const status = error.response.status;
      if (status === 401) return 'Unauthorized — check API key';
      if (status === 403) return 'Forbidden — check API key permissions';
      if (status === 404) return 'Not found — check Lidarr URL';
      return `HTTP ${status}: ${error.response.statusText || ''}`;
    }
    if (error.code === 'ECONNREFUSED') return `Connection refused — is Lidarr running at ${this.url}?`;
    if (error.code === 'ECONNRESET') return 'Connection reset';
    if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') return 'Connection timed out';
    return error.message || 'Unknown error';
  }
}

module.exports = new LidarrClient();
