/**
 * Remembers for a few minutes that MusicBrainz said "no" to a request that asking again cannot fix: the thing does not
 * exist (404), or it needs an account nuLMD does not have (401/403). A client that tries again at once (a tagger
 * retrying a bad id, a script in a loop) gets the same answer without another request to MusicBrainz.
 *
 * Kept in memory only and for a short time (`ws2.negativeTtlMinutes`, 0 = off): a pause, not data. Anything else that
 * goes wrong (a busy or unreachable MusicBrainz) is never remembered, because the next try may well work.
 */
const MAX_ENTRIES = 2000;

class NegativeCache {
  constructor(config, { now = Date.now } = {}) {
    this.config = config;
    this.now = now;
    this.entries = new Map();   // key -> { until, status, message, upstreamMessage }
  }

  ttlMs() {
    const minutes = Number(this.config.get('ws2.negativeTtlMinutes', 10));
    return Number.isFinite(minutes) && minutes > 0 ? minutes * 60 * 1000 : 0;
  }

  // Is this a final "no"?
  static isFinal(err) {
    if (!err) return false;
    return err.status === 404 || err.status === 401 || err.status === 403 || /Resource not found/i.test(err.message || '');
  }

  /** The error to answer with if this request was refused recently, else null. */
  recall(key) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (this.now() >= entry.until) {
      this.entries.delete(key);
      return null;
    }
    return Object.assign(new Error(entry.message), { status: entry.status, upstreamMessage: entry.upstreamMessage, negativeCached: true });
  }

  remember(key, err) {
    const ttl = this.ttlMs();
    if (!ttl || !NegativeCache.isFinal(err)) return;
    this.entries.delete(key);   // re-inserted last, so the oldest entry is always the first
    this.entries.set(key, { until: this.now() + ttl, status: err.status, message: err.message, upstreamMessage: err.upstreamMessage });
    while (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value);
  }
}

module.exports = { NegativeCache };
