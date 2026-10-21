/**
 * MusicBrainz web-service (ws/2) compatible API, mounted at /ws/2.
 * Lets any MusicBrainz client use nuLMD as a caching proxy: answers come from the stored MusicBrainz data and
 * anything missing is fetched from MusicBrainz first. Open until the first API key is made (Settings in the web UI);
 * after that a key is required (see keys.js).
 */
const express = require('express');
const config = require('../config');
const { logConnection, clientOf } = require('../request');
const { describeList } = require('../replySummary');
const { logger } = require('../logger');
const render = require('./render');
const xml = require('./xml');
const services = require('./services');
const { isNotFound } = require('./lookup');
const blocklist = require('../blocklist');
const { PRIMARY_TYPES, SECONDARY_TYPES } = require('./browse');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HELP = 'For usage, please see: https://musicbrainz.org/development/mmd';
const RESOURCES = { artist: 'artist', 'release-group': 'releaseGroup', release: 'release', recording: 'recording' };

// Errors come back in the format the client asked for, like MusicBrainz's own
const fail = (res, status, message, headers = {}) => {
  for (const [k, v] of Object.entries(headers)) res.set(k, v);
  if (res.locals.fmt === 'json') return res.status(status).json({ error: message, help: HELP });
  return res.status(status).type('application/xml').send(xml.errorXml(message, HELP));
};

// XML unless JSON is asked for (fmt=json, or an Accept header naming it), as on musicbrainz.org
function formatOf(req) {
  const fmt = req.query.fmt;
  if (fmt === 'json' || fmt === 'xml') return fmt;
  if (fmt !== undefined) return null;
  return /application\/json/.test(req.get('accept') || '') ? 'json' : 'xml';
}

function keyFrom(req) {
  const auth = req.get('authorization') || '';
  return req.get('x-api-key') || (/^Bearer /i.test(auth) ? auth.slice(7) : '') || req.query.apikey || '';
}


// Parameters a browse request may carry. Anything else is ignored; these are forwarded to MusicBrainz when we pass a request through.
const LINK_PARAMS = ['artist', 'release-group', 'release', 'recording', 'label', 'track-artist', 'area', 'collection'];
const BROWSE_RESOURCES = ['artist', 'release-group', 'release', 'recording'];
// Every resource MusicBrainz can search. Lookups and browse cover four of them; a search is passed through whole.
const SEARCH_RESOURCES = ['annotation', 'area', 'artist', 'event', 'instrument', 'label', 'place', 'recording',
  'release', 'release-group', 'series', 'tag', 'url', 'work'];
const DEFAULT_LIMIT = 25, MAX_LIMIT = 100;

// Lookups of things nuLMD doesn't store. They are asked of MusicBrainz in the format the client wants and the reply
// is cached as sent (the same pass-through as search). Each kind of id is checked before MusicBrainz is asked.
const uuidId = { valid: v => UUID.test(v), normalize: v => v.toLowerCase(), error: 'Invalid mbid.' };
const PASS_LOOKUPS = {
  label: uuidId, work: uuidId, area: uuidId, url: uuidId, series: uuidId, event: uuidId, place: uuidId, instrument: uuidId,
  isrc: { valid: v => /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(v), normalize: v => v.toUpperCase(), error: 'Invalid ISRC.' },
  iswc: { valid: v => /^T-?\d{3}\.?\d{3}\.?\d{3}-?\d$/.test(v), normalize: v => v.toUpperCase(), error: 'Invalid ISWC.' },
  discid: { valid: v => /^[A-Za-z0-9._-]{28}$/.test(v), normalize: v => v, error: 'Invalid discid.' }
};
// The few query parameters such a lookup takes (a disc id lookup takes the disc's table of contents)
const PASS_LOOKUP_PARAMS = ['inc', 'toc', 'cdstubs', 'media-format'];
// An artist, release group, release or recording asked for something we don't keep (works, relationships, the full
// release list of an artist...): MusicBrainz answers the whole request. `type` and `status` filter the lists it adds.
const WHOLE_LOOKUP_PARAMS = ['inc', 'type', 'status'];

const list = v => String(v || '').split('|').map(x => x.trim().toLowerCase()).filter(Boolean);
const first = v => (Array.isArray(v) ? v[v.length - 1] : v);

// limit (default 25, at most 100) and offset, checked: { limit, offset, params } or { error }
function pagingOf(query) {
  const params = {};
  let limit = DEFAULT_LIMIT, offset = 0;
  if (query.limit !== undefined) {
    limit = Number(first(query.limit));
    if (!Number.isInteger(limit) || limit < 1) return { error: [400, 'Invalid limit.'] };
    params.limit = limit = Math.min(limit, MAX_LIMIT);
  }
  if (query.offset !== undefined) {
    offset = Number(first(query.offset));
    if (!Number.isInteger(offset) || offset < 0) return { error: [400, 'Invalid offset.'] };
    params.offset = offset;
  }
  return { limit, offset, params };
}

// A search request, checked: { q } or { error }
function parseSearch(resource, query) {
  const text = String(first(query.query) || '').trim();
  if (!text) return { error: [400, 'Invalid query: nothing to search for.'] };
  const paging = pagingOf(query);
  if (paging.error) return paging;
  const params = { query: text, ...paging.params };
  if (['true', 'false'].includes(first(query.dismax))) params.dismax = first(query.dismax);
  return { q: { resource, params } };
}

// A browse request, checked: { q } on success, { error: [status, message] } if the request is malformed
function parseBrowse(resource, query) {
  const params = {};
  for (const name of LINK_PARAMS) {
    const v = first(query[name]);
    if (v === undefined || v === '') continue;
    if (!UUID.test(v)) return { error: [400, 'Invalid mbid.'] };
    params[name] = v.toLowerCase();
  }
  if (!Object.keys(params).length) return { error: [400, `Invalid ${resource} browse request: a linked entity is needed (for example artist=<mbid>).`] };

  const paging = pagingOf(query);
  if (paging.error) return paging;
  const { limit, offset } = paging;
  Object.assign(params, paging.params);

  const types = list(first(query.type)), statuses = list(first(query.status));
  if (resource === 'release-group') {
    const unknown = types.find(t => !PRIMARY_TYPES.includes(t) && !SECONDARY_TYPES.includes(t));
    if (unknown) return { error: [400, `${unknown} is not a recognized release-group type.`] };
  }
  if (types.length) params.type = types.join('|');
  if (statuses.length) params.status = statuses.join('|');
  if (query.inc !== undefined && String(first(query.inc)).trim()) params.inc = String(first(query.inc)).trim().replace(/\s+/g, '+');   // (already without account-only includes)
  return { q: { resource, params, types, statuses, limit, offset, inc: params.inc || '' } };
}

// What a failed request to MusicBrainz means for our answer
function upstreamFailure(err) {
  if (isNotFound(err) || err.status === 404) return [404, 'Not Found'];
  if (err.status === 400) return [400, err.upstreamMessage || 'Bad request.'];
  // Needs a MusicBrainz account, which nuLMD does not have. Not 401 (a client would try to log in) and not 503
  // (a client would retry, and every retry would be another request to MusicBrainz that can never work)
  if (err.status === 401 || err.status === 403) return [403, err.upstreamMessage || 'MusicBrainz requires an account for this request.'];
  return null;
}

function createRouter(deps = {}) {
  const router = express.Router();
  const cfg = deps.config || config;
  const lookup = deps.lookup || services.lookup();
  const browse = deps.browse || { answer: q => services.browse().answer(q) };
  const passthrough = deps.proxy || { get: (...a) => services.proxy().get(...a) };
  const keys = deps.keys || { check: presented => services.keys().check(presented) };

  router.use((req, res, next) => {
    res.locals.fmt = formatOf(req) || 'xml';
    res.locals.startedAt = Date.now();    // for the request feed: how long nuLMD took to answer
    next();
  });

  router.use((req, res, next) => {
    if (cfg.get('ws2.enabled', true) === false) return fail(res, 404, 'Not Found');
    keys.check(keyFrom(req)).then(who => {
      if (!who.ok) return fail(res, 401, 'Missing or invalid API key.');
      res.locals.keyLabel = who.label;        // which key was used (null when the endpoint is open), for the request feed
      next();
    }).catch(err => {
      logger.warn(`ws/2 could not check the API key: ${err.message}`);
      fail(res, 503, 'Temporarily unable to check the API key, try again shortly.', { 'Retry-After': '5' });
    });
  });

  router.use((req, res, next) => {
    if (!formatOf(req)) return fail(res, 400, "Invalid format. Valid formats are 'json' and 'xml'.");
    next();
  });

  // Account-only includes (Picard asks for user-collections on every release) can never be answered, so they are taken
  // out here, once, for every kind of request. What is left is what is looked up, forwarded and cached, and the client
  // is told what was left out.
  router.use((req, res, next) => {
    const { inc, removed } = render.splitPrivate(req.query.inc);
    res.locals.inc = inc;
    if (removed.length) res.set('X-nuLMD-Omitted', removed.join(','));
    next();
  });

  // One row in the request feed: who asked (the key's name, or the client's own), and that it was the MusicBrainz API
  // `outcome` is how nuLMD answered ("cached", "from MusicBrainz"), `reply` what the answer held, for the Responses card
  const record = (req, res, label, detail, status = 'ok', outcome = null, reply = null) =>
    logConnection({ direction: 'inbound', label, detail, status, api: 'MB', outcome, reply,
      durationMs: res.locals.startedAt ? Date.now() - res.locals.startedAt : null, ...clientOf(req, res.locals.keyLabel) });
  const where = served => (served === 'proxy-cached' ? 'cached' : served === 'proxy' ? 'from MusicBrainz' : null);

  // MusicBrainz's own reply, handed over as it came (in the format asked for)
  const sendRaw = (res, text, format) => res.type(format === 'xml' ? 'application/xml' : 'application/json').send(text);

  const failed = (req, res, resource, what, err) => {
    const known = upstreamFailure(err);
    if (known) return fail(res, known[0], known[1]);
    logger.warn(`ws/2 ${resource} ${what}: ${err.message}`);
    record(req, res, what[0].toUpperCase() + what.slice(1), resource, 'error', `error: ${err.message}`);
    return fail(res, 503, 'MusicBrainz is unavailable right now, try again shortly.', { 'Retry-After': '5' });
  };

  // GET /ws/2/<resource>?query=...  (a search, passed through and cached)
  // GET /ws/2/<resource>?<linked entity>=<mbid>  (a browse: the lists of an entity)
  router.get('/:resource', async (req, res) => {
    const { resource } = req.params;
    const format = res.locals.fmt;

    if (req.query.query !== undefined) {
      if (!SEARCH_RESOURCES.includes(resource)) return fail(res, 404, 'Not Found');
      const parsed = parseSearch(resource, req.query);
      if (parsed.error) return fail(res, parsed.error[0], parsed.error[1]);
      try {
        const { body, cached } = await passthrough.get(resource, parsed.q.params, { format, search: true });
        const served = cached ? 'proxy-cached' : 'proxy';
        res.set('X-nuLMD-Served', served);
        record(req, res, 'Search', `${resource} · "${parsed.q.params.query.slice(0, 30)}"`, 'ok', where(served));
        return sendRaw(res, body, format);
      } catch (err) {
        return failed(req, res, resource, 'search', err);
      }
    }

    if (!BROWSE_RESOURCES.includes(resource)) return fail(res, 404, 'Not Found');
    const parsed = parseBrowse(resource, { ...req.query, inc: res.locals.inc });
    if (parsed.error) return fail(res, parsed.error[0], parsed.error[1]);
    if (blocklist.blocksBrowse(parsed.q.params)) return fail(res, 404, 'Not Found');
    try {
      const { body, raw, served } = await browse.answer({ ...parsed.q, format });
      res.set('X-nuLMD-Served', served);
      record(req, res, 'Browse', resource, 'ok', served === 'list' ? 'from the stored list' : where(served), describeList(resource, body));
      if (raw !== undefined) return sendRaw(res, raw, format);
      if (format === 'json') return res.json(body);
      return res.type('application/xml').send(xml.toXmlList(resource, body));
    } catch (err) {
      return failed(req, res, resource, 'browse', err);
    }
  });

  // A lookup answered by MusicBrainz and cached: things we don't store at all (label, work, area, isrc, discid, ...)
  // and, for the four entities we do store, requests that ask for more than we keep
  const passLookup = async (req, res, rule, names) => {
    const { resource, mbid } = req.params;
    const id = rule.normalize(mbid);
    if (!rule.valid(id)) return fail(res, 400, rule.error);

    const params = {};
    for (const name of names) {
      const v = name === 'inc' ? res.locals.inc : first(req.query[name]);
      if (v === undefined || String(v).trim() === '') continue;
      params[name] = name === 'inc' ? String(v).trim().replace(/\s+/g, '+') : String(v);
    }
    const format = res.locals.fmt;
    try {
      const { body, cached } = await passthrough.get(`${resource}/${id}`, params, { format });
      const served = cached ? 'proxy-cached' : 'proxy';
      res.set('X-nuLMD-Served', served);
      record(req, res, 'Lookup', `${resource} ${id.substring(0, 8)}…`, 'ok', where(served));
      return sendRaw(res, body, format);
    } catch (err) {
      return failed(req, res, resource, 'lookup', err);
    }
  };

  router.get('/:resource/:mbid', async (req, res) => {
    const { resource, mbid } = req.params;
    if (PASS_LOOKUPS[resource]) return passLookup(req, res, PASS_LOOKUPS[resource], PASS_LOOKUP_PARAMS);
    const method = RESOURCES[resource];
    if (!method) return fail(res, 404, 'Not Found');
    if (!UUID.test(mbid)) return fail(res, 400, 'Invalid mbid.');

    // Anything beyond what we keep (and anything MusicBrainz would have to judge, such as an unknown include) goes to
    // MusicBrainz whole, so the client gets the answer musicbrainz.org would give
    const { include, other } = render.parseInc(resource, res.locals.inc);
    if (other.length) return passLookup(req, res, uuidId, WHOLE_LOOKUP_PARAMS);

    try {
      const id = mbid.toLowerCase();
      let body, fetched = false, entity = null;
      if (resource === 'artist') {
        const r = await lookup.artist(id);
        body = render.artist(r.row, include, r); fetched = r.fetched; entity = r.row.name;
      } else if (resource === 'release-group') {
        const r = await lookup.releaseGroup(id);
        body = render.releaseGroup(r.row, include, r); fetched = r.fetched; entity = r.row.title;
      } else if (resource === 'release') {
        const r = await lookup.release(id);
        body = render.release(r.row, include, r); fetched = r.fetched; entity = r.row.title;
      } else {
        const r = await lookup.recording(id, include.has('isrcs'));
        body = render.recording(r.row, include); fetched = r.fetched; entity = r.row.title;
      }
      record(req, res, 'Lookup', `${resource} ${id.substring(0, 8)}…`, 'ok', fetched ? 'fetched from MusicBrainz' : 'from cache', entity || null);
      if (res.locals.fmt === 'json') res.json(body);
      else res.type('application/xml').send(xml.toXml(resource, body));
    } catch (err) {
      const known = upstreamFailure(err);
      if (known) return fail(res, known[0], known[1]);
      logger.warn(`ws/2 ${resource} ${mbid}: ${err.message}`);
      record(req, res, 'Lookup', `${resource} ${mbid.substring(0, 8)}…`, 'error', `error: ${err.message}`);
      return fail(res, 503, 'MusicBrainz is unavailable right now, try again shortly.', { 'Retry-After': '5' });
    }
  });

  router.use((req, res) => fail(res, 404, 'Not Found'));
  return router;
}

module.exports = { createRouter };
