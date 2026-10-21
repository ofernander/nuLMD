/**
 * Passes a request through to MusicBrainz and remembers the reply, for what /ws/2 can't build from its own
 * tables (unusual filters or includes on a browse, lists not yet fetched, searches).
 *
 * The reply is kept exactly as MusicBrainz sent it, in the format the client asked for, so what a client gets is
 * MusicBrainz's own bytes. XML and JSON are separate entries. A reply is reused for `ws2.proxyTtlHours`
 * (searches: `ws2.searchTtlHours`, they go stale faster). Errors are not stored, except that a final "no" (not found,
 * needs an account) is remembered for a few minutes in memory (see negativeCache.js).
 */
const { logger } = require('../logger');
const { NegativeCache } = require('./negativeCache');

// Everything that makes one request different from another, in a fixed order, so the same request
// asked two ways ("limit=5&offset=0" / "offset=0&limit=5") is one cache entry
function cacheKey(resource, params, format = 'json') {
  const pairs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => [k, String(v)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `${resource}?${pairs.map(([k, v]) => `${k}=${v}`).join('&')}#${format}`;
}

// The key of a search ignores differences MusicBrainz ignores: runs of spaces, and the case of what is searched for
// (checked against musicbrainz.org: artist, alias, tag, type, country, status, primarytype, titles and ids give the same
// results in any case). The words AND, OR, NOT and TO are operators only in capitals, so they keep their case. The query
// sent to MusicBrainz is the client's own; only the key is normalized.
const QUERY_OPERATORS = new Set(['AND', 'OR', 'NOT', 'TO']);
function normalizeQuery(query) {
  return String(query).trim().split(/\s+/).map(word => (QUERY_OPERATORS.has(word) ? word : word.toLowerCase())).join(' ');
}

// Did a stored search find nothing? Read from the start of the reply: MusicBrainz's JSON opens with its count, its XML
// with the list element's count; Lidarr's own search hits are stored as a JSON array.
function isEmptySearch(body) {
  const head = String(body).slice(0, 300);
  return /^\s*\[\s*\]\s*$/.test(head) ||
    /^\s*\{[^[]{0,200}?"count"\s*:\s*0\s*[,}]/.test(head) ||
    /<[\w-]+-list\b[^>]*\bcount="0"/.test(head);
}

const MAX_ENTRIES = 20000;   // oldest replies go first once the cache is this large
const hours = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback);
const minutes = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback);

class ProxyCache {
  constructor({ database, registry, config }) {
    this.database = database;
    this.registry = registry;
    this.config = config;
    this.inflight = new Map();
    this.negatives = new NegativeCache(config);
  }

  mb() {
    const provider = this.registry.getProvider('musicbrainz');
    if (!provider) throw new Error('MusicBrainz provider not available');
    return typeof provider.onlyMusicBrainz === 'function' ? provider.onlyMusicBrainz() : provider;
  }

  ttlMs(kind = 'proxy') {
    return kind === 'search'
      ? hours(this.config.get('ws2.searchTtlHours', 24), 24) * 3600 * 1000
      : hours(this.config.get('ws2.proxyTtlHours', 24), 24) * 3600 * 1000;
  }

  // A search that found nothing is reused for a short time only, whatever the search lifetime: an empty answer kept for
  // a day would hide an entry that MusicBrainz (or its search) had only just not got yet
  emptyTtlMs() {
    return Math.min(minutes(this.config.get('ws2.emptySearchTtlMinutes', 15), 15) * 60 * 1000, this.ttlMs('search'));
  }

  searchLifetime(body) {
    return isEmptySearch(body) ? this.emptyTtlMs() : this.ttlMs('search');
  }

  /**
   * MusicBrainz's reply to `GET /<resource>?<params>` as text, from the cache when fresh.
   * Returns { body, cached }. `search` selects the search retry profile and cache lifetime.
   */
  async get(resource, params, { format = 'json', search = false } = {}) {
    const key = cacheKey(resource, search && typeof params.query === 'string' ? { ...params, query: normalizeQuery(params.query) } : params, format);
    const hit = await this.database.query('SELECT body, fetched_at FROM mb_proxy_cache WHERE cache_key = $1', [key]);
    if (hit.rows.length && Date.now() - new Date(hit.rows[0].fetched_at).getTime() < (search ? this.searchLifetime(hit.rows[0].body) : this.ttlMs('proxy'))) {
      return { body: hit.rows[0].body, cached: true };
    }
    const refused = this.negatives.recall(key);
    if (refused) throw refused;
    if (!this.inflight.has(key)) {
      this.inflight.set(key, this.fetch(resource, params, key, { format, search }).finally(() => this.inflight.delete(key)));
    }
    return { body: await this.inflight.get(key), cached: false };
  }

  /**
   * A computed answer that is plain data (not a MusicBrainz reply as sent), such as the hits of a Lidarr search, kept for
   * the same time as a search (`ws2.searchTtlHours`). `fn` runs only when there is no fresh copy; its failure is never kept.
   */
  async remember(key, fn) {
    const hit = await this.database.query('SELECT body, fetched_at FROM mb_proxy_cache WHERE cache_key = $1', [key]);
    if (hit.rows.length && Date.now() - new Date(hit.rows[0].fetched_at).getTime() < this.searchLifetime(hit.rows[0].body)) {
      return JSON.parse(hit.rows[0].body);
    }
    const flight = `remember:${key}`;
    if (!this.inflight.has(flight)) {
      this.inflight.set(flight, (async () => {
        const value = await fn();
        await this.database.query(
          `INSERT INTO mb_proxy_cache (cache_key, body, fetched_at) VALUES ($1, $2, NOW())
           ON CONFLICT (cache_key) DO UPDATE SET body = EXCLUDED.body, fetched_at = NOW()`,
          [key, JSON.stringify(value)]
        );
        return value;
      })().finally(() => this.inflight.delete(flight)));
    }
    return this.inflight.get(flight);
  }

  async fetch(resource, params, key, { format, search }) {
    const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
    let body;
    try {
      body = await this.mb()[search ? 'getSearch' : 'getRaw'](`/${resource}`, clean, { format, text: true });
    } catch (err) {
      this.negatives.remember(key, err);
      throw err;
    }
    await this.database.query(
      `INSERT INTO mb_proxy_cache (cache_key, body, fetched_at) VALUES ($1, $2, NOW())
       ON CONFLICT (cache_key) DO UPDATE SET body = EXCLUDED.body, fetched_at = NOW()`,
      [key, body]
    );
    return body;
  }

  /** Drop expired replies, then the oldest beyond the size cap. Safe to call any time. */
  async prune() {
    try {
      const keep = Math.max(this.ttlMs('proxy'), this.ttlMs('search'));
      const expired = await this.database.query(
        `DELETE FROM mb_proxy_cache WHERE fetched_at < NOW() - ($1 * INTERVAL '1 millisecond')`, [keep]);
      const extra = await this.database.query(
        `DELETE FROM mb_proxy_cache WHERE cache_key IN (
           SELECT cache_key FROM mb_proxy_cache ORDER BY fetched_at DESC OFFSET $1)`, [MAX_ENTRIES]);
      const n = (expired.rowCount || 0) + (extra.rowCount || 0);
      if (n) logger.info(`ws/2 proxy cache: dropped ${n} old repl${n === 1 ? 'y' : 'ies'}`);
    } catch (err) {
      logger.warn(`ws/2 proxy cache prune failed: ${err.message}`);
    }
  }
}

module.exports = { ProxyCache, cacheKey, normalizeQuery, isEmptySearch };
