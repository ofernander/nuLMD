const { logger } = require('./logger');
const BaseProvider = require('../providers/base');

/**
 * SourcePool - dispatches metadata calls across several equivalent sources.
 *
 * Sources are grouped into priority tiers (lower number first). Within a tier requests are
 * round-robined across sources that aren't busy; if the whole tier is busy the request spills
 * to the next tier. If everything is busy it goes to the source with the shortest wait.
 *
 * A source is "busy" when its estimated wait (in-flight calls x its rate-limit spacing) exceeds
 * BUSY_WAIT_MS or its concurrency cap is full. Each source has a circuit breaker so a dead or
 * slow source stops receiving traffic until a probe request succeeds.
 *
 * Retry/failover lives here, not in the sources: a retryable failure re-dispatches to another
 * source immediately; only once every source has failed in a round do we back off.
 */

const BUSY_WAIT_MS = 1500;
const BREAKER_THRESHOLD = 3;
const BREAKER_OPEN_MS = 30000;

const NOT_FOUND = 'Resource not found';

class PoolSource {
  /**
   * @param {object} opts  { id, url, priority, rateLimitMs, maxConcurrent, enabled, fromEnv, isOfficial }
   * @param {object} provider  anything exposing the pool's operations
   */
  constructor(opts, provider) {
    this.id = opts.id;
    this.type = opts.type || 'musicbrainz';
    this.url = opts.url;
    this.priority = opts.priority || 1;
    this.rateLimitMs = opts.rateLimitMs || 0;
    this.maxConcurrent = opts.maxConcurrent || Infinity;
    this.enabled = opts.enabled !== false;
    this.fromEnv = !!opts.fromEnv;
    this.isOfficial = !!opts.isOfficial;
    this.provider = provider;

    this.inflight = 0;
    this.served = 0;
    this.failed = 0;
    this.failures = 0;        // consecutive retryable failures
    this.openUntil = 0;       // breaker open until this timestamp
    this.probing = false;     // half-open probe in flight
    this.lastError = null;
    this.lastSuccessAt = null;
  }

  // Providers may declare which calls they can answer (default: everything) and which are
  // already cached locally (warm = free, so it skips the busy check).
  supports(op, args) {
    return typeof this.provider.supports === 'function' ? this.provider.supports(op, args) : true;
  }

  isWarm(op, args) {
    return typeof this.provider.isWarm === 'function' ? this.provider.isWarm(op, args) : false;
  }

  estimatedWaitMs() {
    return this.inflight * this.rateLimitMs;
  }

  isBusy() {
    return this.inflight >= this.maxConcurrent || this.estimatedWaitMs() > BUSY_WAIT_MS;
  }

  breakerState(now = Date.now()) {
    if (this.openUntil === 0) return 'closed';
    return now < this.openUntil ? 'open' : 'half-open';
  }

  // Breaker lets a request through when closed, or one probe when half-open
  allows(now = Date.now()) {
    const state = this.breakerState(now);
    if (state === 'closed') return true;
    if (state === 'half-open') return !this.probing;
    return false;
  }

  recordSuccess() {
    this.served++;
    this.failures = 0;
    this.openUntil = 0;
    this.probing = false;
    this.lastError = null;
    this.lastSuccessAt = Date.now();
  }

  recordFailure(error) {
    this.failed++;
    this.failures++;
    this.lastError = error.message;
    const wasProbing = this.probing;
    this.probing = false;
    if (wasProbing || this.failures >= BREAKER_THRESHOLD) {
      this.openUntil = Date.now() + BREAKER_OPEN_MS;
      logger.warn(`Source ${this.id}: circuit open for ${BREAKER_OPEN_MS / 1000}s after ${this.failures} failures (${error.message})`);
    }
  }

  status() {
    return {
      id: this.id,
      type: this.type,
      url: this.url,
      priority: this.priority,
      enabled: this.enabled,
      fromEnv: this.fromEnv,
      isOfficial: this.isOfficial,
      rateLimitMs: this.rateLimitMs,
      maxConcurrent: Number.isFinite(this.maxConcurrent) ? this.maxConcurrent : null,
      inflight: this.inflight,
      breaker: this.breakerState(),
      consecutiveFailures: this.failures,
      served: this.served,
      failed: this.failed,
      lastError: this.lastError,
      lastSuccessAt: this.lastSuccessAt
    };
  }
}

class SourcePool {
  /**
   * @param {PoolSource[]} sources
   * @param {function} retryProfile  (method) => { maxRetries, backoffMs, maxBackoffMs?, jitterMs? }
   * @param {function} sleep  injectable for tests
   */
  constructor(sources, { retryProfile = () => ({ maxRetries: 10, backoffMs: 3000 }), sleep } = {}) {
    this.sources = sources;
    this.retryProfile = retryProfile;
    this.sleep = sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this._rr = new Map(); // priority -> last-used index within tier
  }

  enabledSources() {
    return this.sources.filter(s => s.enabled);
  }

  // How many MB-bound jobs can usefully run at once
  capacity() {
    return Math.max(1, this.enabledSources().length);
  }

  status() {
    return this.sources.map(s => s.status());
  }

  // Nothing in flight on any enabled source
  isIdle() {
    return this.enabledSources().every(s => s.inflight === 0);
  }

  /** Pick the best source for the next call, skipping `exclude`. Returns null if none usable. */
  pick(exclude = new Set(), op = null, args = [], types = null) {
    const now = Date.now();
    const usable = this.sources.filter(s =>
      s.enabled && !exclude.has(s) && s.allows(now) && (!types || types.includes(s.type)) &&
      (!op || s.supports(op, args)));
    if (usable.length === 0) return null;

    // A source that already holds the answer costs nothing and keeps one album/artist flow
    // on one source, so it wins over round-robin (best priority first).
    if (op) {
      const warm = usable.filter(s => s.isWarm(op, args)).sort((a, b) => a.priority - b.priority);
      if (warm.length) return warm[0];
    }

    const priorities = [...new Set(usable.map(s => s.priority))].sort((a, b) => a - b);
    for (const priority of priorities) {
      const tier = usable.filter(s => s.priority === priority);
      const free = tier.filter(s => !s.isBusy());
      if (free.length === 0) continue;

      // Round-robin: first free source after the last one used in this tier
      const last = this._rr.get(priority) ?? -1;
      const ordered = tier.filter(s => free.includes(s));
      const next = ordered.find(s => tier.indexOf(s) > last) || ordered[0];
      this._rr.set(priority, tier.indexOf(next));
      return next;
    }

    // Everything usable is busy: queue on whichever will answer soonest (priority breaks ties)
    return usable.reduce((best, s) => {
      const w = s.estimatedWaitMs(), bw = best.estimatedWaitMs();
      return (w < bw || (w === bw && s.priority < best.priority)) ? s : best;
    });
  }

  /**
   * Run `method(...args)` on a source, failing over on transient errors.
   * opts.types restricts the call to sources of those types (e.g. ['musicbrainz'] for backfill).
   */
  async execute(method, args, { types = null } = {}) {
    const live = this.enabledSources().filter(s => !types || types.includes(s.type));
    if (live.length === 0) throw new Error('MusicBrainz: Service unavailable (no sources enabled)');

    // One source: delegate untouched, it keeps its own retry behaviour
    if (this.sources.length === 1) {
      const only = this.sources[0];
      only.inflight++;
      try {
        const result = await only.provider[method](...args);
        only.recordSuccess();
        return result;
      } catch (error) {
        only.failed++;
        only.lastError = error.message;
        throw error;
      } finally {
        only.inflight--;
      }
    }

    if (!live.some(s => s.supports(method, args))) {
      const err = new Error(`MusicBrainz: ${method} is not supported by any enabled source`);
      err.unsupported = true;
      throw err;
    }

    const profile = this.retryProfile(method);
    const maxAttempts = profile.maxRetries || 10;
    let attempts = 0;
    let lastError = null;
    let notFoundError = null;
    let tried = new Set();
    let round = 0;

    while (attempts < maxAttempts) {
      const source = this.pick(tried, method, args, types);

      if (!source) {
        // Every usable source was tried this round. If they all said 404 (none failed), it's a real not-found.
        if (notFoundError && !lastError) throw notFoundError;
        if (!lastError) lastError = new Error('MusicBrainz: Service unavailable (all sources down)');
        round++;
        attempts++; // guarantees termination even when every breaker is open
        if (attempts >= maxAttempts) break;
        const capped = Math.min(round * (profile.backoffMs || 3000), profile.maxBackoffMs || Infinity);
        const wait = capped + Math.floor(Math.random() * (profile.jitterMs || 0));
        logger.warn(`SourcePool: ${method} failed on all sources (${lastError.message}) - retrying in ${(wait / 1000).toFixed(1)}s`);
        await this.sleep(wait);
        tried = new Set();
        continue;
      }

      attempts++;
      tried.add(source);
      source.inflight++;
      if (source.breakerState() === 'half-open') source.probing = true;

      try {
        const result = await source.provider[method](...args);
        source.recordSuccess();
        return result;
      } catch (error) {
        if (error.unsupported) {
          // Source couldn't answer after all (e.g. memo expired mid-flow): not its fault, try another
          source.probing = false;
          continue;
        }
        if (error.message && error.message.includes(NOT_FOUND)) {
          // The official server's 404 is final. A mirror may just be behind: try another source.
          source.probing = false;
          if (source.isOfficial) throw error;
          notFoundError = error;
          continue;
        }
        if (!BaseProvider.isRetryableError(error)) {
          source.probing = false;
          throw error; // bad request, auth, etc: another source won't help
        }
        lastError = error;
        source.recordFailure(error);
        logger.warn(`SourcePool: ${method} failed on ${source.id}: ${error.message}`);
      } finally {
        source.inflight--;
      }
    }

    if (notFoundError && !lastError) throw notFoundError;
    throw lastError || new Error('MusicBrainz: Service unavailable');
  }
}

// Operations the rest of nuLMD calls on the MusicBrainz provider
const MB_OPERATIONS = [
  'searchArtist', 'getArtist', 'getArtistAlbums',
  'searchAlbum', 'getReleaseGroup', 'getRelease', 'getReleasesByReleaseGroup', 'getRecording', 'getRaw', 'getSearch',
  // Bulk browses: only MusicBrainz sources declare them, so an LMD upstream is never asked
  'browseReleaseGroups', 'browseReleases', 'countReleaseGroups', 'countReleases'
];

/**
 * Drop-in for a single MusicBrainzProvider: same methods, routed through the pool, so existing
 * `registry.getProvider('musicbrainz')` call sites don't change.
 */
class PooledMusicBrainz {
  constructor(pool) {
    this.name = 'MusicBrainz';
    this.pool = pool;
    for (const op of MB_OPERATIONS) {
      this[op] = (...args) => this.pool.execute(op, args);
    }
  }

  getStatus() {
    return this.pool.status();
  }

  isIdle() {
    return this.pool.isIdle();
  }

  /** Same operations, but only ever served by MusicBrainz sources (never an LMD upstream). */
  onlyMusicBrainz() {
    const view = {};
    for (const op of MB_OPERATIONS) view[op] = (...args) => this.pool.execute(op, args, { types: ['musicbrainz'] });
    return view;
  }

  /** Same operations, served by the Lidarr metadata upstreams only (the fallback when MusicBrainz cannot answer). */
  onlyUpstreams() {
    const view = {};
    for (const op of MB_OPERATIONS) view[op] = (...args) => this.pool.execute(op, args, { types: ['lmd'] });
    return view;
  }

  /** Is an enabled Lidarr metadata upstream configured? */
  hasUpstreams() {
    return this.pool.enabledSources().some(s => s.type === 'lmd');
  }

  getCapacity() {
    return this.pool.capacity();
  }
}

module.exports = { SourcePool, PoolSource, PooledMusicBrainz, MB_OPERATIONS, BUSY_WAIT_MS, BREAKER_THRESHOLD, BREAKER_OPEN_MS };
