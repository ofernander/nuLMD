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
   * @returns {Promise<{count: number, reachable: boolean}>}
   */
  async refreshArtistMap() {
    if (!this.client) return { count: 0, reachable: false };

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
      return { count: this.artistMap.size, reachable: true };
    } catch (error) {
      const msg = this._formatError(error);
      logger.error(`Lidarr-Client: failed to refresh artist map: ${msg}`);
      return { count: 0, reachable: false };
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
      const { reachable } = await this.refreshArtistMap();
      if (!reachable) return null;
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

    let lidarrId = await this.getLidarrId(mbid);
    if (!lidarrId) {
      // Force a fresh map refresh and retry once — artist may have just been added
      const { reachable } = await this.refreshArtistMap();
      if (!reachable) {
        return { success: false, skipped: true, error: 'Lidarr unreachable' };
      }
      lidarrId = this.artistMap.get(mbid)?.id;
      if (!lidarrId) {
        logger.warn(`Lidarr-Client: artist ${mbid} not found in Lidarr after map refresh — skipping refresh`);
        return { success: false, skipped: true, error: 'Artist not in Lidarr' };
      }
    }

    return this.refreshArtist(lidarrId);
  }

  /**
   * Poll Lidarr until the artist appears, then trigger refresh.
   * Polls every 15s. Distinguishes Lidarr being unreachable from artist genuinely
   * absent — only counts attempts where Lidarr was reachable against the give-up budget.
   * Fire-and-forget — does not block the caller.
   */
  async waitForArtistAndRefresh(mbid) {
    if (!this.enabled || !this.client) {
      logger.warn(`Lidarr-Client: waitForArtistAndRefresh called but client not ready for ${mbid}`);
      return;
    }

    const MAX_NOT_FOUND_ATTEMPTS = 40; // 40 x 15s = 10 minutes of Lidarr being up but artist absent
    const INTERVAL_MS = 15000;
    let notFoundAttempts = 0;

    while (true) {
      try {
        const { reachable } = await this.refreshArtistMap();
        if (!reachable) {
          logger.warn(`Lidarr-Client: Lidarr unreachable while waiting for artist ${mbid} — will retry in ${INTERVAL_MS / 1000}s`);
          await new Promise(r => setTimeout(r, INTERVAL_MS));
          continue;
        }
        const lidarrId = this.artistMap.get(mbid)?.id;
        if (lidarrId) {
          logger.info(`Lidarr-Client: artist ${mbid} found in Lidarr — triggering refresh`);
          return this.refreshArtist(lidarrId);
        }
      } catch (err) {
        logger.warn(`Lidarr-Client: poll failed for ${mbid}: ${err.message}`);
        await new Promise(r => setTimeout(r, INTERVAL_MS));
        continue;
      }
      notFoundAttempts++;
      if (notFoundAttempts >= MAX_NOT_FOUND_ATTEMPTS) {
        logger.warn(`Lidarr-Client: artist ${mbid} not found in Lidarr after ${MAX_NOT_FOUND_ATTEMPTS} reachable attempts — giving up`);
        return;
      }
      logger.info(`Lidarr-Client: artist ${mbid} not in Lidarr yet (attempt ${notFoundAttempts}/${MAX_NOT_FOUND_ATTEMPTS}), retrying in ${INTERVAL_MS / 1000}s`);
      await new Promise(r => setTimeout(r, INTERVAL_MS));
    }
  }

  /**
   * Periodic health check — every 10 minutes.
   * Re-initializes if client was lost and Lidarr is back up.
   * Also keeps the artist map fresh.
   */
  startHealthCheck(intervalMs = 10 * 60 * 1000) {
    setInterval(async () => {
      if (!this.url || !this.apiKey) return; // not configured, nothing to check
      // If client was never created or dropped, attempt re-init first
      if (!this.client) {
        this.initialize();
        if (!this.client) return; // still no config
      }
      const result = await this.testConnection();
      if (result.success) {
        if (!this.enabled) {
          logger.info('Lidarr-Client: health check recovered connection — re-enabling');
          this.enabled = true;
        }
        await this.refreshArtistMap();
      } else {
        logger.warn(`Lidarr-Client: health check failed: ${result.error}`);
      }
    }, intervalMs);
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
