/**
 * Browse requests: "the release groups of this artist", "the releases of this release group".
 *
 * How a request is answered:
 *  - We hold the complete list (table mb_lists): answered from it, filters and paging applied here, no outbound call.
 *  - We don't: MusicBrainz answers (and the reply is cached), and the whole list is fetched in the background
 *    when nuLMD is idle, so the next request can be answered locally.
 *  - Anything we can't apply ourselves (an include, an unusual filter): always passed through to MusicBrainz.
 *
 * MusicBrainz's own order is not stable (the same list comes back arranged differently for different page sizes),
 * so a list we serve has a fixed order of our own: date, then title, then id. Counts are exact.
 */
const { logger } = require('../logger');

const PAGE = 100;                                  // the most MusicBrainz returns per request
const PRIMARY_TYPES = ['album', 'single', 'ep', 'broadcast', 'other'];
const SECONDARY_TYPES = ['compilation', 'soundtrack', 'spokenword', 'interview', 'audiobook', 'audio drama', 'live',
  'remix', 'dj-mix', 'mixtape/street', 'demo', 'field recording'];
const STATUSES = ['official', 'promotion', 'bootleg', 'pseudo-release', 'withdrawn', 'expunged', 'cancelled'];

// Which lists we keep: resource -> the browse parameter that names its parent
const LISTS = { 'release-group': { param: 'artist', parent: 'artist' }, release: { param: 'release-group', parent: 'release-group' } };
const JOBS = { 'release-group': 'complete_rg_list', release: 'complete_release_list' };

const QUEUE_THROTTLE_MS = 5 * 60 * 1000;
const itemsKey = resource => `${resource}s`;

/**
 * MusicBrainz's `type` filter on release groups, verified against live counts: the primary types named are
 * alternatives (album|ep), but every secondary type named must be present (live|compilation needs both).
 */
function matchesTypes(item, types) {
  const primary = types.filter(t => PRIMARY_TYPES.includes(t));
  const secondary = types.filter(t => !PRIMARY_TYPES.includes(t));
  const own = (item['secondary-types'] || []).map(t => t.toLowerCase());
  return (!primary.length || primary.includes((item['primary-type'] || '').toLowerCase())) &&
    secondary.every(t => own.includes(t));
}

const matchesStatus = (item, statuses) => !statuses.length || statuses.includes((item.status || '').toLowerCase());

// Our order: earliest first, undated last, then by title (and country for releases), then id so it never ties
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
function orderOf(resource, items) {
  const date = i => (resource === 'release' ? i.date : i['first-release-date']) || '￿';
  return [...items].sort((a, b) =>
    cmp(date(a), date(b)) || cmp(a.country || '', b.country || '') || cmp((a.title || '').toLowerCase(), (b.title || '').toLowerCase()) || cmp(a.id, b.id));
}

class Browse {
  constructor({ database, proxy, registry, config, queue = () => require('../backgroundJobQueue') }) {
    this.database = database;
    this.proxy = proxy;
    this.registry = registry;
    this.config = config;
    this.queue = queue;
    this.queuedAt = new Map();
  }

  mb() {
    const provider = this.registry.getProvider('musicbrainz');
    if (!provider) throw new Error('MusicBrainz provider not available');
    return typeof provider.onlyMusicBrainz === 'function' ? provider.onlyMusicBrainz() : provider;
  }

  ttlMs() {
    return Number(this.config.get('metadata.ttlDays', 30)) * 24 * 3600 * 1000;
  }

  // ---- stored lists ----

  async getList(resource, mbid) {
    const r = await this.database.query(
      'SELECT items, fetched_at FROM mb_lists WHERE resource = $1 AND parent_type = $2 AND parent_mbid = $3',
      [resource, LISTS[resource].parent, mbid]);
    if (!r.rows.length) return null;
    const row = r.rows[0];
    return { items: orderOf(resource, typeof row.items === 'string' ? JSON.parse(row.items) : row.items), fetchedAt: new Date(row.fetched_at) };
  }

  async saveList(resource, mbid, items) {
    await this.database.query(
      `INSERT INTO mb_lists (resource, parent_type, parent_mbid, items, fetched_at) VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (resource, parent_type, parent_mbid) DO UPDATE SET items = EXCLUDED.items, fetched_at = NOW()`,
      [resource, LISTS[resource].parent, mbid, JSON.stringify(items)]);
  }

  /**
   * Fetch the whole list from MusicBrainz and keep it (replacing any older copy only once all of it has arrived).
   * `between` runs before each further page, so a background job can wait for nuLMD to be idle.
   */
  async build(resource, mbid, { between } = {}) {
    const held = [], seen = new Set();
    let offset = 0, total = null;
    while (total === null || offset < total) {
      if (between && offset > 0) await between();
      const reply = await this.mb().getRaw(`/${resource}`, { [LISTS[resource].param]: mbid, limit: PAGE, offset });
      total = reply[`${resource}-count`] || 0;
      const page = reply[itemsKey(resource)] || [];
      if (!page.length) break;                       // nothing more, whatever the count says
      offset += page.length;
      for (const item of page) if (!seen.has(item.id)) { seen.add(item.id); held.push(item); }
    }
    // A list that came up short (MusicBrainz changed it while we paged) is not stored as if it were whole
    if (held.length < total) throw new Error(`${resource} list for ${mbid} came back incomplete (${held.length}/${total})`);
    await this.saveList(resource, mbid, held);
    return held.length;
  }

  // Asked for on every request that finds a list missing or stale, so it is throttled: once per list per few minutes
  async queueBuild(resource, mbid, { refresh = false } = {}) {
    const key = `${resource}:${mbid}`;
    if (Date.now() - (this.queuedAt.get(key) || 0) < QUEUE_THROTTLE_MS) return;
    this.queuedAt.set(key, Date.now());
    try {
      const entity = LISTS[resource].parent === 'artist' ? 'artist' : 'release_group';
      await this.queue().forceQueueJob(JOBS[resource], entity, mbid, 1, refresh ? { refresh: true } : null);
    } catch (err) {
      this.queuedAt.delete(key);
      logger.warn(`ws/2: could not queue ${JOBS[resource]} for ${mbid}: ${err.message}`);
    }
  }

  /** Background job: fetch (or re-fetch) a whole list. Waits for nuLMD to be idle between pages. */
  async runJob(job, { waitIdle } = {}) {
    const resource = Object.keys(JOBS).find(r => JOBS[r] === job.job_type);
    if (!resource) throw new Error(`Not a list job: ${job.job_type}`);
    const n = await this.build(resource, job.entity_mbid, { between: waitIdle });
    logger.info(`ws/2: ${resource} list for ${job.entity_mbid} stored (${n} items)`);
  }

  // ---- answering ----

  /**
   * q: { resource, params, types, statuses, limit, offset, inc, format }  (params = the query to forward when we pass it through)
   * Returns { served, body } when we built the answer (a wrapper object) or { served, raw } when MusicBrainz's own
   * reply is passed through (text, in q.format). `served` is shown to clients as X-nuLMD-Served.
   */
  async answer(q) {
    const list = LISTS[q.resource];
    const parentMbid = list && q.params[list.param];
    if (!list || !parentMbid || q.inc || !this.onlyOwnParams(q, list)) return this.passThrough(q);

    const stored = await this.getList(q.resource, parentMbid);
    if (!stored) {
      this.queueBuild(q.resource, parentMbid);
      return this.passThrough(q);
    }
    if (Date.now() - stored.fetchedAt.getTime() > this.ttlMs()) this.queueBuild(q.resource, parentMbid, { refresh: true });

    const kept = stored.items.filter(i => matchesTypes(i, q.types) && matchesStatus(i, q.statuses));
    return {
      body: { [`${q.resource}-count`]: kept.length, [`${q.resource}-offset`]: q.offset, [itemsKey(q.resource)]: kept.slice(q.offset, q.offset + q.limit) },
      served: 'list'
    };
  }

  // The list is only reusable when every parameter is one we can apply ourselves
  onlyOwnParams(q, list) {
    const own = new Set([list.param, 'type', 'status', 'limit', 'offset']);
    if (Object.keys(q.params).some(k => !own.has(k))) return false;
    if (q.resource === 'release' && q.types.length) return false;          // a release doesn't carry its group's types
    if (q.resource === 'release-group' && q.statuses.length) return false;
    if (q.statuses.some(s => !STATUSES.includes(s))) return false;         // let MusicBrainz judge unknown values
    return true;
  }

  async passThrough(q) {
    const { body, cached } = await this.proxy.get(q.resource, q.params, { format: q.format || 'json' });
    return { raw: body, served: cached ? 'proxy-cached' : 'proxy' };
  }
}

module.exports = { Browse, matchesTypes, matchesStatus, orderOf, PAGE, PRIMARY_TYPES, SECONDARY_TYPES, STATUSES, LISTS, JOBS, itemsKey };
