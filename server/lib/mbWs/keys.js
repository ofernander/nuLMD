/**
 * API keys for /ws/2. Any number, each with a label so a person can tell them apart (an app, a person, a machine).
 *
 * A key is generated here, shown once, and never stored: only its SHA-256 hash is, plus its first few characters so the
 * list can tell keys apart. With no keys at all the endpoint is open; once there is one, a key is required. The
 * `ws2.apiKey` setting (the WS2_API_KEY environment variable) still works as one more key, shown in the list as read-only.
 */
const crypto = require('crypto');
const { logger } = require('../logger');

const MAX_KEYS = 50;
const MAX_LABEL = 60;
const CACHE_MS = 30 * 1000;          // how long the key list is trusted before it is read again
const FLUSH_MS = 60 * 1000;          // how often usage counts are written back

const sha256 = value => crypto.createHash('sha256').update(String(value)).digest('hex');

class KeyError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

class ApiKeys {
  constructor({ database, config, now = () => Date.now() }) {
    this.database = database;
    this.config = config;
    this.now = now;
    this.cache = null;               // { at, byHash: Map(hash -> { id, label }) }
    this.pending = new Map();        // id -> uses not yet written back
    this.lastFlush = 0;
  }

  envKey() {
    return String(this.config.get('ws2.apiKey', '') || '');
  }

  async snapshot() {
    if (this.cache && this.now() - this.cache.at < CACHE_MS) return this.cache;
    try {
      const rows = (await this.database.query('SELECT id, label, key_hash FROM ws2_api_keys')).rows;
      this.cache = { at: this.now(), byHash: new Map(rows.map(r => [r.key_hash, { id: String(r.id), label: r.label }])) };
    } catch (err) {
      // Keep going on the list we last had; with none, refuse rather than guess (guessing "no keys" would open the door)
      if (!this.cache) throw err;
      logger.warn(`ws/2 keys: could not refresh the key list (${err.message}), using the last one`);
      this.cache.at = this.now();
    }
    return this.cache;
  }

  /**
   * Is this request allowed? { ok, label } where label names the key used (null when the endpoint is open).
   * `presented` is whatever key the client sent, or empty.
   */
  async check(presented) {
    const { byHash } = await this.snapshot();
    const env = this.envKey();
    if (byHash.size === 0 && !env) return { ok: true, label: null, open: true };
    if (!presented) return { ok: false };

    const hash = sha256(presented);
    const found = byHash.get(hash);
    if (found) { this.touch(found.id); return { ok: true, label: found.label }; }
    if (env && crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(sha256(env)))) return { ok: true, label: 'env key' };
    return { ok: false };
  }

  // Use is counted in memory and written back now and then, so a busy client does not mean a write per request
  touch(id) {
    this.pending.set(id, (this.pending.get(id) || 0) + 1);
    if (this.now() - this.lastFlush >= FLUSH_MS) this.flush().catch(() => {});
  }

  async flush() {
    this.lastFlush = this.now();
    const batch = [...this.pending];
    this.pending.clear();
    for (const [id, uses] of batch) {
      try {
        await this.database.query(
          'UPDATE ws2_api_keys SET last_used_at = NOW(), request_count = request_count + $2 WHERE id = $1', [id, uses]);
      } catch (err) {
        this.pending.set(id, (this.pending.get(id) || 0) + uses);
        logger.warn(`ws/2 keys: could not record use: ${err.message}`);
      }
    }
  }

  async list() {
    await this.flush();
    const rows = (await this.database.query(
      'SELECT id, label, key_prefix, created_at, last_used_at, request_count FROM ws2_api_keys ORDER BY created_at, id')).rows;
    const keys = rows.map(r => ({
      id: String(r.id), label: r.label, prefix: r.key_prefix,
      createdAt: r.created_at, lastUsedAt: r.last_used_at, requestCount: Number(r.request_count || 0), env: false
    }));
    const env = this.envKey();
    if (env) keys.push({ id: 'env', label: 'Set in the environment (WS2_API_KEY)', prefix: `${env.slice(0, 4)}…`, createdAt: null, lastUsedAt: null, requestCount: null, env: true });
    return { keys, open: keys.length === 0 };
  }

  /** Make a key. The returned `key` is the only time it can be seen. */
  async create(rawLabel) {
    const label = String(rawLabel || '').replace(/\s+/g, ' ').trim();
    if (!label) throw new KeyError('Give the key a name, so you can tell it apart later.');
    if (label.length > MAX_LABEL) throw new KeyError(`The name can be at most ${MAX_LABEL} characters.`);

    const existing = (await this.database.query('SELECT id, label FROM ws2_api_keys')).rows;
    if (existing.length >= MAX_KEYS) throw new KeyError(`There can be at most ${MAX_KEYS} keys.`);
    if (existing.some(r => r.label.toLowerCase() === label.toLowerCase())) throw new KeyError('A key with that name already exists.', 409);

    const key = `nulmd_${crypto.randomBytes(24).toString('base64url')}`;
    const prefix = `${key.slice(0, 10)}…`;
    const row = (await this.database.query(
      'INSERT INTO ws2_api_keys (label, key_hash, key_prefix) VALUES ($1, $2, $3) RETURNING id, created_at',
      [label, sha256(key), prefix])).rows[0];
    this.cache = null;               // the next request sees it straight away
    return { id: String(row.id), label, prefix, createdAt: row.created_at, key };
  }

  async remove(id) {
    const result = await this.database.query('DELETE FROM ws2_api_keys WHERE id = $1', [id]);
    this.cache = null;               // and a removed key stops working at once
    this.pending.delete(String(id));
    return (result.rowCount || 0) > 0;
  }
}

module.exports = { ApiKeys, KeyError, sha256, MAX_KEYS };
