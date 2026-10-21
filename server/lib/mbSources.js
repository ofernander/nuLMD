/**
 * Resolves the effective list of MusicBrainz sources from config + environment.
 *
 * Sources (all merged, deduped by URL):
 *   - config.providers.musicbrainz.sources   (added in the UI, persisted in config.yml;
 *                                             each has type 'musicbrainz' (default) or 'lmd')
 *   - config.providers.musicbrainz.baseUrl / MUSICBRAINZ_URL   (legacy single-server setting)
 *   - MUSICBRAINZ_SOURCES   (compose-seeded MusicBrainz servers: url[|priority[|rateLimitMs]])
 *   - LMD_UPSTREAMS         (compose-seeded Lidarr metadata servers, same entry format)
 *
 * An 'lmd' source is a Lidarr metadata server (api.lidarr.audio or a self-hosted LMD). It never
 * replaces MusicBrainz: MB is the authority and serves what an LMD can't, so if no MB source is
 * configured the official server is added.
 *
 * Env-defined sources win over config entries for the same URL and are flagged `fromEnv`
 * so the UI can show them read-only. They are never written back to config.yml.
 *
 * If nothing is configured the pool is just the official server, exactly as before.
 * Lower priority number = tried first.
 */

const OFFICIAL_URL = 'https://musicbrainz.org/ws/2';
const OFFICIAL_RATE_LIMIT_MS = 2000;
const LMD_DEFAULT_RATE_LIMIT_MS = 1000;
const LMD_DEFAULT_MAX_CONCURRENT = 2;

// Politeness policy.
//
// The three big public servers are shared by everyone, so their limit is hardcoded and can't be changed
// from the UI, config.yml or compose: 1 request every 2 seconds, one at a time. They're matched by domain
// (any scheme, port, path or subdomain) so a variant URL can't be used to dodge the limit, and each host may
// appear only once because every entry runs its own limiter.
//   musicbrainz.org   official MusicBrainz
//   lidarr.audio      official Lidarr metadata server (api.lidarr.audio)
//   brainzmash.cc     community Lidarr metadata server (lidarrapi.brainzmash.cc)
//
// Any other server that isn't on your own network defaults to the same 2 seconds, but you can change it.
// Servers on your own network have no default limit.
const PROTECTED_DOMAINS = ['musicbrainz.org', 'lidarr.audio', 'brainzmash.cc'];
const PROTECTED_RATE_MS = 2000;
const PROTECTED_MAX_CONCURRENT = 1;
const REMOTE_DEFAULT_RATE_MS = 2000;
const REMOTE_DEFAULT_MAX_CONCURRENT = 2;

function hostnameOf(url) {
  const m = String(url || '').trim().match(/^https?:\/\/(\[[^\]]+\]|[^/:?#]+)/i);
  return m ? m[1].replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '') : '';
}

// The protected domain this URL belongs to, or null
function protectedDomain(url) {
  const host = hostnameOf(url);
  return PROTECTED_DOMAINS.find(d => host === d || host.endsWith('.' + d)) || null;
}

function isProtectedUrl(url) {
  return protectedDomain(url) !== null;
}

// Loopback, private/link-local ranges, and names that can only resolve on a LAN or container network
function isLocalHost(url) {
  const host = hostnameOf(url);
  if (!host) return false;
  if (host === 'localhost' || /\.(localhost|local|lan|internal|home\.arpa)$/.test(host)) return true;
  if (!host.includes('.') && !host.includes(':')) return true; // bare name, e.g. a docker service ("mb")
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (host.includes(':')) return host === '::1' || host === '::' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
  return false;
}

function normalizeUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

// The one exact URL of the official MusicBrainz web service
function isOfficialUrl(url) {
  return normalizeUrl(url).toLowerCase() === OFFICIAL_URL;
}

function toPositiveInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function toNonNegativeInt(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

// "http://mb1:5000/ws/2|1|0,http://mb2:5000/ws/2" -> [{url, priority, rateLimitMs}]
function parseEnvSources(raw, type = 'musicbrainz') {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean)
    .map(entry => {
      const [url, priority, rateLimitMs] = entry.split('|').map(s => s.trim());
      return {
        url: normalizeUrl(url),
        priority: toPositiveInt(priority, 1),
        rateLimitMs: toNonNegativeInt(rateLimitMs),
        type,
        fromEnv: true
      };
    })
    .filter(s => s.url);
}

function resolveMusicBrainzSources(mbConfig = {}, env = process.env) {
  const byUrl = new Map();
  const add = (source) => {
    // Protected hosts collapse to one entry per hostname, whatever scheme/path was typed
    const key = isProtectedUrl(source.url) ? `protected:${hostnameOf(source.url)}` : normalizeUrl(source.url).toLowerCase();
    if (!key || key === 'protected:') return;
    // Env entries overwrite config entries; otherwise first one wins
    if (!byUrl.has(key) || source.fromEnv) byUrl.set(key, source);
  };

  const legacyUrl = normalizeUrl(mbConfig.baseUrl || env.MUSICBRAINZ_URL);
  if (legacyUrl) add({ url: legacyUrl, priority: 1, fromEnv: !mbConfig.baseUrl && !!env.MUSICBRAINZ_URL });

  for (const s of Array.isArray(mbConfig.sources) ? mbConfig.sources : []) {
    // fromEnv entries persisted in config.yml are stale copies; the env is the source of truth
    if (!s || !s.url || s.fromEnv) continue;
    add({
      url: normalizeUrl(s.url),
      priority: toPositiveInt(s.priority, 1),
      rateLimitMs: toNonNegativeInt(s.rateLimitMs),
      maxConcurrent: toPositiveInt(s.maxConcurrent, undefined),
      enabledOps: Array.isArray(s.enabledOps) ? s.enabledOps : undefined,
      type: s.type === 'lmd' ? 'lmd' : 'musicbrainz',
      enabled: s.enabled !== false,
      fromEnv: false
    });
  }

  parseEnvSources(env.MUSICBRAINZ_SOURCES).forEach(add);
  parseEnvSources(env.LMD_UPSTREAMS, 'lmd').forEach(add);

  // MusicBrainz stays in the pool no matter what upstreams are configured
  const hasMb = Array.from(byUrl.values()).some(s => s.type !== 'lmd' && s.enabled !== false);
  if (!hasMb) add({ url: OFFICIAL_URL, priority: 1 });

  // Legacy global rate limit for custom servers (MUSICBRAINZ_RATE_LIMIT, ms; 0 = none when set explicitly)
  const envRate = toNonNegativeInt(env.MUSICBRAINZ_RATE_LIMIT);

  return Array.from(byUrl.values()).map(s => {
    const lmd = s.type === 'lmd';
    const locked = isProtectedUrl(s.url);
    const remote = !isLocalHost(s.url);
    const official = !lmd && isOfficialUrl(s.url);

    // Default spacing: remote servers 2s; local none (LMD upstreams keep a gentle 1s). Explicit values win,
    // except for the protected hosts, which are fixed.
    const defaultRate = remote ? REMOTE_DEFAULT_RATE_MS : (lmd ? LMD_DEFAULT_RATE_LIMIT_MS : 0);
    const requestedRate = s.rateLimitMs ?? (!lmd && envRate !== undefined ? envRate : defaultRate);
    const defaultParallel = lmd ? LMD_DEFAULT_MAX_CONCURRENT : (remote ? REMOTE_DEFAULT_MAX_CONCURRENT : 4);

    return {
      type: lmd ? 'lmd' : 'musicbrainz',
      url: official ? OFFICIAL_URL : s.url,
      priority: s.priority || 1,
      enabled: s.enabled !== false,
      fromEnv: !!s.fromEnv,
      isOfficial: official,
      protected: locked,
      remote,
      defaultRateMs: defaultRate,
      rateLimitMs: locked ? PROTECTED_RATE_MS : requestedRate,
      maxConcurrent: locked ? PROTECTED_MAX_CONCURRENT : (s.maxConcurrent || defaultParallel),
      ...(lmd ? { enabledOps: s.enabledOps } : {})
    };
  });
}

const LMD_OPS = [
  'getArtist', 'getArtistAlbums', 'getReleaseGroup', 'getReleasesByReleaseGroup', 'getRelease',
  'searchArtist', 'searchAlbum'
];

/**
 * Validate/clean a source list coming from the UI. Returns { sources, errors }.
 * Env-seeded entries are dropped (the environment owns them) and duplicate URLs collapse.
 */
function sanitizeSources(list) {
  const errors = [];
  const adjusted = [];
  const sources = [];
  const seen = new Set();
  if (!Array.isArray(list)) return { sources, errors: ['sources must be a list'], adjusted };

  list.forEach((raw, i) => {
    const label = raw && typeof raw.url === 'string' && raw.url.trim() ? raw.url.trim() : `Source ${i + 1}`;
    if (!raw || typeof raw !== 'object') { errors.push(`${label}: invalid entry`); return; }
    if (raw.fromEnv) return;

    const url = normalizeUrl(raw.url);
    if (!/^https?:\/\/[^\s/]+(\/\S*)?$/i.test(url)) { errors.push(`${label}: URL must start with http:// or https://`); return; }
    const type = raw.type === 'lmd' ? 'lmd' : 'musicbrainz';

    // The public servers speak one protocol each, and may appear only once (one limiter per entry)
    const domain = protectedDomain(url);
    if (domain) {
      const expected = domain === 'musicbrainz.org' ? 'musicbrainz' : 'lmd';
      if (type !== expected) {
        errors.push(`${label}: ${hostnameOf(url)} is a ${expected === 'lmd' ? 'Lidarr metadata server' : 'MusicBrainz server'}, not a ${type === 'lmd' ? 'Lidarr metadata server' : 'MusicBrainz server'}`);
        return;
      }
    }
    const key = domain ? `protected:${hostnameOf(url)}` : url.toLowerCase();
    if (seen.has(key)) { errors.push(`${label}: ${domain ? hostnameOf(url) + ' can only be listed once' : 'duplicate URL ' + url}`); return; }
    seen.add(key);

    const priority = raw.priority === undefined || raw.priority === '' ? 1 : parseInt(raw.priority, 10);
    if (!Number.isInteger(priority) || priority < 1 || priority > 99) { errors.push(`${label}: priority must be 1-99`); return; }

    const entry = { url, type, priority, enabled: raw.enabled !== false };
    let rate;
    if (raw.rateLimitMs !== undefined && raw.rateLimitMs !== null && raw.rateLimitMs !== '') {
      rate = parseInt(raw.rateLimitMs, 10);
      if (!Number.isInteger(rate) || rate < 0) { errors.push(`${label}: rate limit must be 0 or more milliseconds`); return; }
    }
    let parallel;
    if (raw.maxConcurrent !== undefined && raw.maxConcurrent !== null && raw.maxConcurrent !== '') {
      parallel = parseInt(raw.maxConcurrent, 10);
      if (!Number.isInteger(parallel) || parallel < 1 || parallel > 32) { errors.push(`${label}: max concurrent must be 1-32`); return; }
    }

    if (domain) {
      // Fixed for the shared public servers: nothing is stored, resolve() applies the hardcoded values
      if ((rate !== undefined && rate !== PROTECTED_RATE_MS) || (parallel !== undefined && parallel !== PROTECTED_MAX_CONCURRENT)) {
        adjusted.push(`${hostnameOf(url)}: fixed at 1 request every ${PROTECTED_RATE_MS / 1000}s, one at a time (shared public server)`);
      }
    } else {
      if (rate !== undefined) entry.rateLimitMs = rate;
      if (parallel !== undefined) entry.maxConcurrent = parallel;
    }
    if (type === 'lmd' && Array.isArray(raw.enabledOps)) {
      const ops = raw.enabledOps.filter(o => LMD_OPS.includes(o));
      if (ops.length && ops.length < LMD_OPS.length) entry.enabledOps = ops;
    }
    sources.push(entry);
  });

  return { sources, errors, adjusted };
}

module.exports = {
  PROTECTED_DOMAINS,
  PROTECTED_RATE_MS,
  PROTECTED_MAX_CONCURRENT,
  REMOTE_DEFAULT_RATE_MS,
  isLocalHost,
  isProtectedUrl,
  protectedDomain,
  LMD_OPS,
  sanitizeSources,
  OFFICIAL_URL,
  OFFICIAL_RATE_LIMIT_MS,
  normalizeUrl,
  isOfficialUrl,
  parseEnvSources,
  resolveMusicBrainzSources
};
