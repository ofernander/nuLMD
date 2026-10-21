const database = require('../sql/database');
const { logger } = require('./logger');

// MusicBrainz special entities (Various Artists and the like): never fetched as an artist, not removable
const BUILTIN_ARTISTS = new Map([
  ['89ad4ac3-39f7-470e-963a-56509c546377', 'Various Artists'],
  ['fe5b7087-438f-4e6e-bf3d-4a5b65e8d8b6', 'Various Artists']
]);

const TYPES = ['artist', 'release_group', 'release'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What nuLMD must never ingest: the built-in special artists plus whatever the user blocked (table blocked_entities).
 * The user's entries are held in memory (loaded at startup, kept in step by add/remove) so the checks on every store
 * and every queued job are a Set lookup, not a query.
 */
class Blocklist {
  constructor() {
    this.sets = { artist: new Set(), release_group: new Set(), release: new Set() };
    this.names = new Map();   // mbid -> label, for replies that mention a blocked artist (an album credits it)
  }

  async load() {
    const rows = (await database.query('SELECT entity_type, mbid, name FROM blocked_entities')).rows;
    this.sets = { artist: new Set(), release_group: new Set(), release: new Set() };
    this.names = new Map();
    for (const r of rows) { this.sets[r.entity_type].add(r.mbid); if (r.name) this.names.set(r.mbid, r.name); }
    if (rows.length) logger.info(`Blocklist: ${rows.length} blocked entit${rows.length === 1 ? 'y' : 'ies'} loaded`);
  }

  isBuiltin(mbid) { return BUILTIN_ARTISTS.has(String(mbid).toLowerCase()); }

  isBlocked(type, mbid) {
    if (!mbid) return false;
    const id = String(mbid).toLowerCase();
    if (type === 'artist' && BUILTIN_ARTISTS.has(id)) return true;
    const set = this.sets[type];
    return !!set && set.has(id);
  }

  isArtistBlocked(mbid) { return this.isBlocked('artist', mbid); }

  /** A job for a blocked entity (or one queued under a blocked artist's tree) is never queued */
  blocksJob(entityType, entityMbid, rootArtistMbid) {
    return this.isBlocked(entityType, entityMbid) || this.isBlocked('artist', rootArtistMbid);
  }

  /** Browse params of /ws/2 ({artist: id} / {'release-group': id} / {release: id}) that name a blocked entity */
  blocksBrowse(params = {}) {
    return this.isBlocked('artist', params.artist) || this.isBlocked('release_group', params['release-group']) || this.isBlocked('release', params.release);
  }

  /** The label to show for a blocked entity (the stored one, or the built-in one), without a query */
  cachedName(type, mbid) {
    const id = String(mbid).toLowerCase();
    if (type === 'artist' && BUILTIN_ARTISTS.has(id)) return BUILTIN_ARTISTS.get(id);
    return this.isBlocked(type, id) ? (this.names.get(id) || null) : null;
  }

  async nameOf(type, mbid) { return this.cachedName(type, mbid); }

  async add({ type, mbid, name = null, reason = null }) {
    if (!TYPES.includes(type)) throw Object.assign(new Error(`Unknown entity type: ${type}`), { status: 400 });
    if (!UUID.test(String(mbid))) throw Object.assign(new Error('Invalid mbid'), { status: 400 });
    const id = String(mbid).toLowerCase();
    if (type === 'artist' && BUILTIN_ARTISTS.has(id)) return { alreadyBuiltin: true };
    await database.query(
      `INSERT INTO blocked_entities (entity_type, mbid, name, reason) VALUES ($1, $2, $3, $4)
       ON CONFLICT (entity_type, mbid) DO UPDATE SET name = COALESCE(EXCLUDED.name, blocked_entities.name),
                                                     reason = COALESCE(EXCLUDED.reason, blocked_entities.reason)`,
      [type, id, name || null, reason || null]);
    this.sets[type].add(id);
    if (name) this.names.set(id, name);
    logger.info(`Blocklist: ${type} ${id}${name ? ` (${name})` : ''} blocked`);
    return { alreadyBuiltin: false };
  }

  async remove(type, mbid) {
    if (!TYPES.includes(type)) throw Object.assign(new Error(`Unknown entity type: ${type}`), { status: 400 });
    const id = String(mbid).toLowerCase();
    if (type === 'artist' && BUILTIN_ARTISTS.has(id)) throw Object.assign(new Error('Built-in entries cannot be unblocked'), { status: 400 });
    const r = await database.query('DELETE FROM blocked_entities WHERE entity_type = $1 AND mbid = $2', [type, id]);
    this.sets[type].delete(id);
    this.names.delete(id);
    logger.info(`Blocklist: ${type} ${id} unblocked`);
    return r.rowCount > 0;
  }

  async list() {
    const rows = (await database.query(
      'SELECT entity_type, mbid, name, reason, created_at FROM blocked_entities ORDER BY created_at DESC')).rows;
    const builtin = [...BUILTIN_ARTISTS].map(([mbid, name]) => ({ entity_type: 'artist', mbid, name, builtin: true }));
    return { builtin, entries: rows };
  }
}

module.exports = new Blocklist();
module.exports.TYPES = TYPES;
module.exports.UUID = UUID;
module.exports.BUILTIN_ARTISTS = BUILTIN_ARTISTS;
