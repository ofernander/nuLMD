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
const { USER_AGENT } = require('./userAgent');

const MISS_REFRESH_MS = 15 * 1000;   // an artist missing from the map is looked for again at most this often

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

    // Live reachability, updated by every probe (testConnection). null = never probed.
    this.lastCheckOk = null;
    this.lastCheckAt = null;
    this.lastError = null;
  }

  /**
   * Initialize client from config and environment (the environment wins; see config.lidarrSettings).
   * Call after config.load() completes.
   * There is no switch: it is on exactly when there is both a URL and an API key.
   */
  initialize() {
    const settings = config.lidarrSettings();
    this.url = settings.url;
    this.apiKey = settings.apiKey;
    this.enabled = settings.enabled;

    if (!this.enabled) {
      if (this.url || this.apiKey) {
        logger.warn('Lidarr-Client: needs both a URL and an API key — off');
      }
      this.client = null;
      return;
    }

    // Strip trailing slash from URL
    this.url = this.url.replace(/\/+$/, '');

    this.client = axios.create({
      baseURL: `${this.url}/api/v1`,
      headers: { 'X-Api-Key': this.apiKey, 'User-Agent': USER_AGENT },
      timeout: 15000
    });

    logger.info(`Lidarr-Client: initialized: ${this.url}`);
  }

  /**
   * Test connection to Lidarr.
   * @returns {Promise<{success: boolean, version?: string, error?: string}>}
   */
  async testConnection(opts = {}) {
    if (!this.client) {
      this.lastCheckOk = false;
      this.lastCheckAt = Date.now();
      this.lastError = 'Client not initialized';
      return { success: false, error: this.lastError };
    }

    try {
      const response = await this.client.get('/system/status');
      const version = response.data?.version || 'unknown';
      this.lastCheckOk = true;
      this.lastCheckAt = Date.now();
      this.lastError = null;
      if (!opts.silent) logger.info(`Lidarr-Client: connection OK — version ${version}`);
      return { success: true, version };
    } catch (error) {
      const msg = this._formatError(error);
      this.lastCheckOk = false;
      this.lastCheckAt = Date.now();
      this.lastError = msg;
      if (!opts.silent) logger.error(`Lidarr-Client: connection test failed: ${msg}`);
      return { success: false, error: msg };
    }
  }

  /**
   * Silent probe with UP/DOWN state-change logging. Safe to call frequently.
   * @returns {Promise<boolean>} whether Lidarr is currently reachable
   */
  async _probe() {
    const was = this.lastCheckOk;
    const r = await this.testConnection({ silent: true });
    if (was !== r.success) {
      if (r.success) logger.info('Lidarr-Client: connection recovered — UP');
      else logger.warn(`Lidarr-Client: connection lost — DOWN (${r.error})`);
    }
    return r.success;
  }

  /**
   * Ensure we have a working connection: re-init if the client was lost, probe,
   * and retry once after a short delay to ride out a transient first-request blip.
   * @returns {Promise<boolean>}
   */
  async ensureConnected() {
    if (!this.client) this.initialize();
    if (!this.client) return false; // not configured
    if (await this._probe()) return true;
    await new Promise(r => setTimeout(r, 1000));
    return this._probe();
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
   * Set of artist foreign IDs (MusicBrainz artist MBIDs) currently in Lidarr.
   * Reflects the last refreshArtistMap() call — refresh first for accuracy.
   * @returns {Set<string>}
   */
  getArtistForeignIds() {
    return new Set(this.artistMap.keys());
  }

  /**
   * Fetch all album foreign IDs (release-group MBIDs) from Lidarr.
   * @returns {Promise<{ids: Set<string>, reachable: boolean}>}
   */
  async getAlbumForeignIds() {
    if (!this.client) return { ids: new Set(), reachable: false };
    try {
      const response = await this.client.get('/album');
      const albums = response.data || [];
      const ids = new Set();
      for (const album of albums) {
        if (album.foreignAlbumId) ids.add(album.foreignAlbumId);
      }
      logger.info(`Lidarr-Client: fetched ${ids.size} album foreign IDs`);
      return { ids, reachable: true };
    } catch (error) {
      const msg = this._formatError(error);
      logger.error(`Lidarr-Client: failed to fetch albums: ${msg}`);
      return { ids: new Set(), reachable: false };
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
   * Whether an artist is in Lidarr's library: true or false once that is known, null when it cannot be told (Lidarr not
   * connected, or unreachable). An artist missing from the map gets one map refresh, because it may have been added a
   * moment ago; refreshes are shared between concurrent callers and at most one is made per MISS_REFRESH_MS, and a miss
   * inside that window is "unknown" (null), never a recorded "no", so the next request asks again.
   * @param {string} mbid - MusicBrainz artist ID
   * @returns {Promise<boolean|null>}
   */
  async isInLidarr(mbid) {
    if (!this.enabled || !this.client) return null;
    if (this.artistMap.has(mbid)) return true;
    if (!this._mapRefreshing) {
      if (this.lastMapRefresh && Date.now() - this.lastMapRefresh < MISS_REFRESH_MS) return null;
      this._mapRefreshing = this.refreshArtistMap().finally(() => { this._mapRefreshing = null; });
    }
    const { reachable } = await this._mapRefreshing;
    return reachable ? this.artistMap.has(mbid) : null;
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
   * Periodic health check. Two decoupled cadences:
   *  - probeMs (fast, cheap): GET /system/status to track live reachability, plus a
   *    reconciliation sweep that re-delivers any Lidarr refreshes missed during a
   *    stale window or restart.
   *  - mapMs (slow): full artist-map refresh (GET /artist can be large — don't do it
   *    every probe). On-demand refresh via getLidarrId still covers staleness between.
   */
  startHealthCheck(probeMs = 15 * 1000, mapMs = 30 * 60 * 1000) {
    setInterval(async () => {
      if (!this.url || !this.apiKey) return; // not configured, nothing to check
      if (!this.client) {
        this.initialize();
        if (!this.client) return;
      }
      const up = await this._probe();
      if (up) {
        if (!this.enabled) {
          logger.info('Lidarr-Client: health check recovered connection — re-enabling');
          this.enabled = true;
        }
        // Re-deliver any refreshes that never landed. Kept out of lidarrClient (no DB
        // here) — the job queue owns the jobs table.
        try {
          const backgroundJobQueue = require('./backgroundJobQueue');
          if (backgroundJobQueue.reconcilePendingRefreshes) {
            await backgroundJobQueue.reconcilePendingRefreshes();
          }
        } catch (err) {
          logger.warn(`Lidarr-Client: refresh reconciliation error: ${err.message}`);
        }
      }
    }, probeMs);

    setInterval(async () => {
      if (this.client && this.enabled && this.lastCheckOk) {
        await this.refreshArtistMap();
      }
    }, mapMs);
  }

  /**
   * Get map stats for debugging/UI. `connected` reflects the last real probe, not
   * merely whether a client object exists.
   */
  getStats() {
    return {
      enabled: this.enabled,
      url: this.url || null,
      connected: this.lastCheckOk === true,
      clientReady: !!this.client,
      artistCount: this.artistMap.size,
      lastMapRefresh: this.lastMapRefresh ? new Date(this.lastMapRefresh).toISOString() : null,
      lastCheckAt: this.lastCheckAt ? new Date(this.lastCheckAt).toISOString() : null,
      lastError: this.lastError
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
