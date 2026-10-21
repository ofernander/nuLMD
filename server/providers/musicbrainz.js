const BaseProvider = require('./base');
const { logger } = require('../lib/logger');
const { INC } = require('../lib/mbRequests');

// Retry budgets per operation. Search rides out MB's intermittent 503s: up to 10 tries,
// backoff capped at 3s + jitter (rate limiter already spaces requests 2s).
const SEARCH_RETRY = { maxRetries: 10, backoffMs: 1000, maxBackoffMs: 3000, jitterMs: 1000 };
const DEFAULT_RETRY = { maxRetries: 10, backoffMs: 3000 };
// A page of a bulk browse is heavy (up to 100 releases with their tracklists). It gets its own timeout, and when a
// page fails (timeout, 5xx) the next try asks for half as many items instead of repeating the request that just
// failed. Paging follows what comes back, so a smaller page only costs more calls.
const PAGE_TIMEOUT_MS = 30000;
const PAGE_SIZE = 100;
const MIN_PAGE_SIZE = 10;
const PAGE_RETRY = { maxRetries: 2, backoffMs: 3000 };
// A search from a client of /ws/2: ride out a busy spell briefly (4 real tries, a few seconds of backoff), but don't
// leave the client waiting minutes. Two places apply it, because the pool counts differently from the provider:
//  - WS2_SEARCH_TRY: the provider's own retry, used when there is a single source (the pool steps aside then)
//  - WS2_SEARCH_RETRY: the pool's profile. It counts every failed try AND every "all sources tried, wait and go
//    again" step, so it is twice the tries to mean the same thing. (With one MusicBrainz source the pool's circuit
//    breaker, which rests a source after 3 failures in a row, ends the tries sooner: a search gets 3 there.)
const WS2_SEARCH_TRIES = 4;
const WS2_SEARCH_TRY = { maxRetries: WS2_SEARCH_TRIES, backoffMs: 1000, maxBackoffMs: 3000, jitterMs: 500 };
const WS2_SEARCH_RETRY = { ...WS2_SEARCH_TRY, maxRetries: WS2_SEARCH_TRIES * 2 };

class MusicBrainzProvider extends BaseProvider {
  // Retry profile for an operation; the source pool reuses this to retry across sources.
  static retryProfile(method) {
    if (method === 'getSearch') return WS2_SEARCH_RETRY;
    return (method === 'searchArtist' || method === 'searchAlbum') ? SEARCH_RETRY : DEFAULT_RETRY;
  }

  /**
   * @param {object} config
   *   baseUrl        MB ws/2 URL (default: official)
   *   rateLimitMs    per-source limit in ms between requests (0 = none). When omitted, falls
   *                  back to the legacy env behaviour (official 2000ms, custom MUSICBRAINZ_RATE_LIMIT).
   *   label          short tag for log/error names when running several sources
   *   singleAttempt  one try per call; the source pool handles retry/failover
   */
  constructor(config) {
    const baseUrl = config.baseUrl || process.env.MUSICBRAINZ_URL || 'https://musicbrainz.org/ws/2';
    
    // Detect if using official MusicBrainz server
    const isOfficialServer = baseUrl === 'https://musicbrainz.org/ws/2';
    
    // Determine rate limiting
    let rateLimit = null;
    
    if (isOfficialServer) {
      // Official MB always uses 2000ms rate limit (cannot be overridden)
      rateLimit = { requests: 1, period: 2000 };
      logger.info(`MusicBrainz: Using official server - rate limit: 2000ms`);
    } else if (config.rateLimitMs !== undefined) {
      if (config.rateLimitMs > 0) {
        rateLimit = { requests: 1, period: config.rateLimitMs };
      }
      logger.info(`MusicBrainz: ${baseUrl} rate limit: ${config.rateLimitMs > 0 ? config.rateLimitMs + 'ms' : 'none'}`);
    } else {
      // Custom servers: check env variable override
      if (process.env.MUSICBRAINZ_RATE_LIMIT !== undefined) {
        const rateLimitMs = parseInt(process.env.MUSICBRAINZ_RATE_LIMIT);
        if (rateLimitMs > 0) {
          rateLimit = { requests: 1, period: rateLimitMs };
          logger.info(`MusicBrainz: Using custom rate limit from env: ${rateLimitMs}ms`);
        } else {
          logger.info(`MusicBrainz: Rate limiting disabled via env variable`);
        }
      } else {
        // Default: no rate limit for custom servers
        logger.info(`MusicBrainz: Using custom server - rate limiting disabled`);
      }
    }
    
    const providerConfig = {
      ...config,
      baseUrl: baseUrl,
      rateLimit: rateLimit
    };
    
    super(config.label ? `MusicBrainz(${config.label})` : 'MusicBrainz', providerConfig);
    this.customBaseUrl = config.baseUrl;
    this.useLocalServer = !isOfficialServer;
    this.singleAttempt = !!config.singleAttempt;
  }

  async initialize() {
    await super.initialize();
  }

  async searchArtist(query, limit = 10) {
    const cacheKey = `mb:artist:search:${query}:${limit}`;
    
    return this.cachedRequest(cacheKey, async () => {
      logger.info(`MusicBrainz: Searching for artist "${query}"`);
      
      const response = await this.client.get('/artist', {
        params: {
          query: query,
          limit: limit,
          fmt: 'json'
        }
      });

      return this.normalizeArtistSearchResults(response.data);
    }, null, SEARCH_RETRY);
  }

  async getArtist(mbid) {
    const cacheKey = `mb:artist:${mbid}`;
    
    return this.cachedRequest(cacheKey, async () => {
      logger.info(`MusicBrainz: Fetching artist ${mbid}`);
      
      const response = await this.client.get(`/artist/${mbid}`, {
        params: {
          inc: INC.artist,
          fmt: 'json'
        }
      });

      // MusicBrainz's own JSON; metaHandler maps it to rows through lib/mbMap.js
      return { ...response.data, provider: 'musicbrainz' };
    });
  }

  async getArtistAlbums(artistMbid) {
    const cacheKey = `mb:artist:${artistMbid}:albums`;
    
    return this.cachedRequest(cacheKey, async () => {
      logger.info(`MusicBrainz: Fetching all albums for artist ${artistMbid} (paginated)`);
      
      const allAlbums = [];
      let offset = 0;
      const limit = 100;
      let total = null;

      do {
        const response = await this.client.get('/release-group', {
          params: {
            artist: artistMbid,
            limit,
            offset,
            fmt: 'json'
          }
        });

        const data = response.data;
        if (total === null) total = data['release-group-count'] || 0;

        // MusicBrainz's own browse items (title, types, first-release-date...); stored as release-group stubs
        allAlbums.push(...(data['release-groups'] || []).map(rg => ({ ...rg, provider: 'musicbrainz' })));
        offset += limit;

        logger.info(`MusicBrainz: Fetched ${allAlbums.length}/${total} release groups for artist ${artistMbid}`);
      } while (offset < total);

      return allAlbums;
    });
  }

  async getReleaseGroup(mbid) {
    const cacheKey = `mb:release-group:${mbid}`;
    
    return this.cachedRequest(cacheKey, async () => {
      logger.info(`MusicBrainz: Fetching release group ${mbid}`);
      
      const response = await this.client.get(`/release-group/${mbid}`, {
        params: {
          inc: INC.release_group,
          fmt: 'json'
        }
      });

      // MusicBrainz's own JSON; metaHandler maps it to rows through lib/mbMap.js
      return { ...response.data, provider: 'musicbrainz' };
    });
  }

  async getRelease(mbid) {
    const cacheKey = `mb:release:${mbid}`;
    
    return this.cachedRequest(cacheKey, async () => {
      logger.info(`MusicBrainz: Fetching release ${mbid}`);
      
      const response = await this.client.get(`/release/${mbid}`, {
        params: {
          inc: INC.release,
          fmt: 'json'
        }
      });

      return { ...response.data, provider: 'musicbrainz' };
    });
  }

  /**
   * A GET passed through as-is (browse and search requests the app doesn't build itself).
   * By default MusicBrainz's JSON, parsed. With `text: true` the reply exactly as MusicBrainz sent it (a string),
   * in the `format` asked for ('json' or 'xml'), so a client can be handed MusicBrainz's own bytes.
   */
  async getRaw(path, params = {}, { format = 'json', text = false, retry } = {}) {
    return this.cachedRequest(`mb:raw:${format}:${text}:${path}?${JSON.stringify(params)}`, async () => {
      logger.info(`MusicBrainz: ${path} ${JSON.stringify(params)}${format === 'xml' ? ' (xml)' : ''}`);
      const response = await this.client.get(path, {
        params: { ...params, fmt: format },
        ...(text ? { responseType: 'text', transformResponse: [data => data] } : {})
      });
      return response.data;
    }, null, retry);
  }

  // Same request, for a search: its own name so the source pool uses the shorter search retry profile,
  // and the short retry for the single-source case
  async getSearch(path, params = {}, opts = {}) {
    return this.getRaw(path, params, { ...opts, retry: WS2_SEARCH_TRY });
  }

  async getRecording(mbid) {
    const cacheKey = `mb:recording:${mbid}`;

    return this.cachedRequest(cacheKey, async () => {
      logger.info(`MusicBrainz: Fetching recording ${mbid}`);

      const response = await this.client.get(`/recording/${mbid}`, {
        params: {
          inc: INC.recording,
          fmt: 'json'
        }
      });

      return { ...response.data, provider: 'musicbrainz' };
    });
  }

  async getReleasesByReleaseGroup(releaseGroupMbid) {
    logger.info(`MusicBrainz: Fetching all releases for release group ${releaseGroupMbid} (paginated)`);

    const allReleases = [];
    let offset = 0;
    const limit = 100;
    let total = null;

    do {
      const response = await this.client.get('/release', {
        params: {
          'release-group': releaseGroupMbid,
          limit,
          offset,
          fmt: 'json'
        }
      });

      const data = response.data;
      if (total === null) total = data['release-count'] || 0;

      const releases = data.releases || [];
      allReleases.push(...releases.map(r => ({
        id: r.id,
        title: r.title,
        date: r.date,
        country: r.country,
        status: r.status
      })));
      offset += limit;

      logger.info(`MusicBrainz: Fetched ${allReleases.length}/${total} releases for release group ${releaseGroupMbid}`);
    } while (offset < total);

    return allReleases;
  }

  /**
   * Every page of a browse. Advances by what came back (a page that carries tracklists holds anywhere from 5 to 73
   * releases, whatever limit was asked) and is finished only when it holds the total MusicBrainz reported: a list that
   * comes up short is an error, never a smaller copy. `onPage(items)` receives each page's new items as it arrives,
   * so a caller can store them without holding the whole list; `maxTotal` refuses a list that is too large.
   */
  async _browseAll(path, params, itemsKey, { onPage, maxTotal } = {}) {
    const countKey = itemsKey === 'releases' ? 'release-count' : 'release-group-count';
    const seen = new Set();
    let offset = 0;
    let total = null;
    let limit = PAGE_SIZE;

    while (total === null || seen.size < total) {
      let reply;
      try {
        reply = await this.cachedRequest(`mb:browse:${path}:${JSON.stringify(params)}:${offset}:${limit}`, async () => {
          logger.info(`MusicBrainz: Browsing ${path} ${JSON.stringify(params)} offset ${offset} limit ${limit}`);
          const response = await this.client.get(path, { params: { ...params, limit, offset, fmt: 'json' }, timeout: PAGE_TIMEOUT_MS });
          return response.data;
        }, null, PAGE_RETRY);
      } catch (error) {
        if (!BaseProvider.isRetryableError(error) || limit <= MIN_PAGE_SIZE) throw error;
        limit = Math.max(MIN_PAGE_SIZE, Math.floor(limit / 2));
        logger.warn(`MusicBrainz: ${path} page at offset ${offset} failed (${error.message}); trying ${limit} items per page`);
        continue;
      }

      total = reply[countKey] || 0;
      if (maxTotal && total > maxTotal) {
        throw Object.assign(new Error(`MusicBrainz: ${path} has ${total} items, over the limit of ${maxTotal}`), { overLimit: true });
      }
      const page = reply[itemsKey] || [];
      if (!page.length) break;                       // nothing more, whatever the count says
      offset += page.length;

      const fresh = page.filter(item => !seen.has(item.id));
      fresh.forEach(item => seen.add(item.id));
      if (onPage && fresh.length) await onPage(fresh);
    }

    if (seen.size < total) throw new Error(`MusicBrainz: ${path} came back incomplete (${seen.size}/${total})`);
    return { count: seen.size, total };
  }

  // How many release groups / releases MusicBrainz lists for an artist: one request for a single item, whose reply
  // carries the total. Used to see whether anything was added or removed before fetching a whole catalog again.
  countReleaseGroups(artistMbid) { return this._count('/release-group', artistMbid, 'release-group-count'); }
  countReleases(artistMbid) { return this._count('/release', artistMbid, 'release-count'); }

  async _count(path, artistMbid, countKey) {
    const reply = await this.cachedRequest(`mb:count:${path}:${artistMbid}`, async () => {
      const response = await this.client.get(path, { params: { artist: artistMbid, limit: 1, fmt: 'json' } });
      return response.data;
    }, null, DEFAULT_RETRY);
    if (!Number.isInteger(reply[countKey])) throw new Error(`MusicBrainz: ${path} count missing from the reply`);
    return reply[countKey];
  }

  // All of an artist's release groups, with credit, tags, genres, rating and links
  browseReleaseGroups(artistMbid, opts) {
    return this._browseAll('/release-group', { artist: artistMbid, inc: INC.release_group_browse }, 'release-groups', opts);
  }

  // All releases of an artist (or of one release group), any status, each with its tracklist
  browseReleases({ artist, releaseGroup }, opts) {
    return this._browseAll('/release', { ...(artist ? { artist } : { 'release-group': releaseGroup }), inc: INC.release }, 'releases', opts);
  }

  async searchAlbum(query, artist = null, limit = 10) {
    let searchQuery = query;
    if (artist) {
      searchQuery = `${query} AND artist:"${artist}"`;
    }

    const cacheKey = `mb:album:search:${searchQuery}:${limit}`;
    
    return this.cachedRequest(cacheKey, async () => {
      logger.info(`MusicBrainz: Searching for album "${query}"`);
      
      const response = await this.client.get('/release-group', {
        params: {
          query: searchQuery,
          limit: limit,
          fmt: 'json'
        }
      });

      return this.normalizeAlbumSearchResults(response.data);
    }, null, SEARCH_RETRY);
  }

  // Normalization methods to convert MusicBrainz format to Lidarr-compatible format
  normalizeArtistSearchResults(data) {
    if (!data.artists) return [];
    
    return data.artists.map(artist => ({
      id: artist.id,
      name: artist.name,
      sortName: artist['sort-name'],
      disambiguation: artist.disambiguation || '',
      type: artist.type || 'Unknown',
      country: artist.country || null,
      score: artist.score || 0,
      provider: 'musicbrainz'
    }));
  }

  normalizeAlbumSearchResults(data) {
    if (!data['release-groups']) return [];
    
    return data['release-groups'].map(rg => ({
      id: rg.id,
      title: rg.title,
      disambiguation: rg.disambiguation || '',
      primaryType: rg['primary-type'] || null,
      secondaryTypes: rg['secondary-types'] || [],
      firstReleaseDate: rg['first-release-date'] || null,
      artistCredit: this.formatArtistCredit(rg['artist-credit'] || []),
      score: rg.score || 0,
      provider: 'musicbrainz'
    }));
  }

  formatArtistCredit(artistCredit) {
    if (!Array.isArray(artistCredit)) return [];
    
    return artistCredit.map(ac => ({
      artist: {
        id: ac.artist ? ac.artist.id : null,
        name: ac.artist ? ac.artist.name : ac.name || '',
        disambiguation: ac.artist ? ac.artist.disambiguation || '' : ''
      },
      name: ac.name || (ac.artist ? ac.artist.name : ''),
      joinPhrase: ac.joinphrase || ''
    }));
  }
}

module.exports = MusicBrainzProvider;
