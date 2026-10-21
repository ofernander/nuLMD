const BaseProvider = require('./base');
const { logger } = require('../lib/logger');

/**
 * LMD upstream: a Lidarr metadata server (api.lidarr.audio or a self-hosted LMD) used as a
 * source in the MusicBrainz pool.
 *
 * It answers the same operations as MusicBrainzProvider and returns the same normalized shapes,
 * so metaHandler/search stay untouched. An upstream serves whole artists (/artist/{id}, with all
 * album stubs) and whole albums (/album/{id}, with every release and its tracks) in one call, so
 * responses are memoized briefly and follow-up operations (getArtistAlbums, getReleasesByReleaseGroup,
 * getRelease) are answered from the memo with no extra HTTP.
 *
 * Data it can't provide (country, dates, gender, tags, barcode...) is left null; rows stored from
 * this source are flagged for MusicBrainz backfill.
 */

const PROVIDER_TAG = 'lidarr-upstream';
const MEMO_TTL_MS = 120000;
const MEMO_MAX = 40;

const SUPPORTED_OPS = [
  'getArtist', 'getArtistAlbums', 'getReleaseGroup', 'getReleasesByReleaseGroup', 'getRelease',
  'searchArtist', 'searchAlbum'
];

// Upstream gives country names ("United Kingdom"); nuLMD stores MusicBrainz's ISO codes (VARCHAR(2)).
const COUNTRY_ALIASES = {
  'worldwide': 'XW', '[worldwide]': 'XW', 'europe': 'XE',
  'czech republic': 'CZ', 'russia': 'RU', 'south korea': 'KR', 'north korea': 'KP', 'taiwan': 'TW',
  'united states of america': 'US', 'usa': 'US', 'uk': 'GB', 'great britain': 'GB',
  'serbia and montenegro': 'XS', 'yugoslavia': 'XY', 'soviet union': 'SU', 'czechoslovakia': 'XC',
  'east germany': 'XG', 'netherlands antilles': 'AN', 'macedonia': 'MK', 'ivory coast': 'CI',
  'hong kong': 'HK', 'macau': 'MO', 'palestine': 'PS', 'burma': 'MM', 'vietnam': 'VN', 'laos': 'LA',
  'moldova': 'MD', 'syria': 'SY', 'iran': 'IR', 'bolivia': 'BO', 'venezuela': 'VE', 'tanzania': 'TZ'
};
let countryByName = null;

function countryCode(name) {
  if (!name || typeof name !== 'string') return null;
  if (/^[A-Z]{2}$/.test(name)) return name;
  if (!countryByName) {
    countryByName = new Map(Object.entries(COUNTRY_ALIASES));
    try {
      const names = new Intl.DisplayNames(['en'], { type: 'region' });
      const A = 65;
      for (let i = 0; i < 26; i++) for (let j = 0; j < 26; j++) {
        const code = String.fromCharCode(A + i, A + j);
        const n = names.of(code);
        // first code wins: ICU also names reserved codes (UK -> United Kingdom) that sort after the real one (GB)
        if (n && n !== code && !countryByName.has(n.toLowerCase())) countryByName.set(n.toLowerCase(), code);
      }
    } catch (_) { /* no ICU: aliases only */ }
  }
  return countryByName.get(name.trim().toLowerCase()) || null;
}

function unsupported(op) {
  const err = new Error(`LMD: ${op} not supported by this source`);
  err.unsupported = true;
  return err;
}

// Upstream uses '0001-01-01' / null for "unknown"
function cleanDate(d) {
  if (!d || typeof d !== 'string' || d.startsWith('0001-01-01')) return null;
  return d;
}

// Upstream rating is 0-10; nuLMD stores MusicBrainz's 0-5 scale
function toMbRating(r) {
  const v = r && typeof r === 'object' ? r.Value : r;
  return typeof v === 'number' ? Math.round((v / 2) * 100) / 100 : null;
}

class LmdUpstreamProvider extends BaseProvider {
  /**
   * @param {object} config
   *   baseUrl        e.g. https://api.lidarr.audio/api/v0.4
   *   rateLimitMs    spacing between requests (default 1000)
   *   enabledOps     optional allow-list of operations (e.g. drop the search ops)
   *   label          short tag for log/error names
   *   singleAttempt  the source pool owns retry/failover
   */
  constructor(config) {
    const rateLimitMs = config.rateLimitMs !== undefined ? config.rateLimitMs : 1000;
    super(config.label ? `LMD(${config.label})` : 'LMD', {
      ...config,
      baseUrl: String(config.baseUrl || '').replace(/\/+$/, ''),
      rateLimit: rateLimitMs > 0 ? { requests: 1, period: rateLimitMs } : null
    });
    this.singleAttempt = !!config.singleAttempt;
    this.enabledOps = Array.isArray(config.enabledOps) && config.enabledOps.length
      ? new Set(config.enabledOps) : null;
    this.memoTtlMs = config.memoTtlMs || MEMO_TTL_MS;
    this._memo = new Map();          // 'artist:<id>' | 'album:<id>' -> { at, promise }
    this._releaseIndex = new Map();  // release id -> album memo key
  }

  // ─── Capability hooks used by the source pool ──────────────────────────────

  _fresh(key) {
    const e = this._memo.get(key);
    if (!e) return null;
    if (Date.now() - e.at > this.memoTtlMs) { this._memo.delete(key); return null; }
    return e;
  }

  _releaseAlbumKey(releaseId) {
    const key = this._releaseIndex.get(releaseId);
    return key && this._fresh(key) ? key : null;
  }

  supports(op, args = []) {
    if (!SUPPORTED_OPS.includes(op)) return false;
    if (this.enabledOps && !this.enabledOps.has(op)) return false;
    // Upstream has no release endpoint: only answerable from an album we already fetched
    if (op === 'getRelease') return !!this._releaseAlbumKey(args[0]);
    // Upstream search can't evaluate nuLMD's artist-filtered Lucene query
    if (op === 'searchAlbum') return !args[1];
    return true;
  }

  // True when the call can be answered without an HTTP request (or an identical one is in flight)
  isWarm(op, args = []) {
    switch (op) {
      case 'getArtist':
      case 'getArtistAlbums': return !!this._fresh(`artist:${args[0]}`);
      case 'getReleaseGroup':
      case 'getReleasesByReleaseGroup': return !!this._fresh(`album:${args[0]}`);
      case 'getRelease': return !!this._releaseAlbumKey(args[0]);
      default: return false;
    }
  }

  // ─── Memoized upstream fetches ──────────────────────────────────────────────

  _load(key, path) {
    const existing = this._fresh(key);
    if (existing) return existing.promise;

    logger.info(`${this.name}: GET ${path}`);
    const promise = this.client.get(path).then(r => r.data);
    this._memo.set(key, { at: Date.now(), promise });
    promise.then(
      data => {
        if (key.startsWith('album:') && data) {
          for (const r of data.Releases || []) this._releaseIndex.set(r.Id, key);
        }
      },
      () => this._memo.delete(key) // never memoize failures
    );

    while (this._memo.size > MEMO_MAX) this._memo.delete(this._memo.keys().next().value);
    return promise;
  }

  _artist(id) { return this._load(`artist:${id}`, `/artist/${id}`); }
  _album(id) { return this._load(`album:${id}`, `/album/${id}`); }

  // ─── Operations (same names/shapes as MusicBrainzProvider) ──────────────────

  async getArtist(id) {
    return this.normalizeArtist(await this._artist(id));
  }

  async getArtistAlbums(artistMbid) {
    const raw = await this._artist(artistMbid);
    return (raw.Albums || []).map(a => {
      const stub = {
        id: a.Id,
        title: a.Title,
        disambiguation: '',
        'secondary-types': a.SecondaryTypes || [],
        provider: PROVIDER_TAG
      };
      if (a.Type) stub['primary-type'] = a.Type;
      const date = cleanDate(a.ReleaseDate);
      if (date) stub['first-release-date'] = date;
      const rating = toMbRating(a.Rating);
      if (rating !== null) stub.rating = { value: rating, 'votes-count': (a.Rating && a.Rating.Count) || 0 };
      return stub;
    });
  }

  async getReleaseGroup(mbid) {
    return this.normalizeReleaseGroup(await this._album(mbid));
  }

  async getReleasesByReleaseGroup(releaseGroupMbid) {
    const raw = await this._album(releaseGroupMbid);
    return (raw.Releases || []).map(r => this.releaseStub(r));
  }

  async getRelease(releaseId) {
    const key = this._releaseAlbumKey(releaseId);
    if (!key) throw unsupported('getRelease');
    const album = await this._memo.get(key).promise;
    const release = (album.Releases || []).find(r => r.Id === releaseId);
    if (!release) throw unsupported('getRelease');
    return this.normalizeRelease(release, album);
  }

  async searchArtist(query, limit = 10) {
    const cacheKey = `lmd:artist:search:${this.config.baseUrl}:${query}:${limit}`;
    return this.cachedRequest(cacheKey, async () => {
      logger.info(`${this.name}: Searching for artist "${query}"`);
      const response = await this.client.get('/search', { params: { type: 'artist', query } });
      const hits = this.unwrapSearch(response.data, 'artist');
      return hits.slice(0, limit).map((a, i) => ({
        id: a.id,
        name: a.artistname,
        sortName: a.sortname || a.artistname,
        disambiguation: a.disambiguation || '',
        type: a.type || 'Unknown',
        country: null,
        score: hits.score?.[i] ?? 100 - i,
        provider: PROVIDER_TAG
      }));
    });
  }

  async searchAlbum(query, artist = null, limit = 10) {
    if (artist) throw unsupported('searchAlbum');
    const cacheKey = `lmd:album:search:${this.config.baseUrl}:${query}:${limit}`;
    return this.cachedRequest(cacheKey, async () => {
      logger.info(`${this.name}: Searching for album "${query}"`);
      const response = await this.client.get('/search', { params: { type: 'album', query } });
      const hits = this.unwrapSearch(response.data, 'album');
      return hits.slice(0, limit).map((a, i) => ({
        id: a.id,
        title: a.title,
        disambiguation: a.disambiguation || '',
        primaryType: a.type || null,
        secondaryTypes: a.secondarytypes || [],
        firstReleaseDate: cleanDate(a.releasedate),
        artistCredit: this.mbCredit(a).map(c => ({ artist: c.artist, name: c.name, joinPhrase: '' })),
        score: hits.score?.[i] ?? 100 - i,
        provider: PROVIDER_TAG
      }));
    });
  }

  // type=artist|album returns bare entities; type=all returns [{score, artist, album}]
  unwrapSearch(data, kind) {
    const list = Array.isArray(data) ? data : [];
    const out = [];
    const score = [];
    for (const item of list) {
      const entity = item && item[kind] !== undefined ? item[kind] : (item && item.score === undefined ? item : null);
      if (entity && entity.id) { out.push(entity); score.push(item.score ?? 100 - out.length + 1); }
    }
    out.score = score;
    return out;
  }

  // ─── Normalizers: upstream (Lidarr) format -> nuLMD's MB-normalized shapes ──

  // MusicBrainz-shaped JSON with only what an upstream can supply; absent keys mean "unknown",
  // so the store never overwrites real MusicBrainz data with blanks (see lib/mbMap.js).
  normalizeArtist(raw) {
    const rating = toMbRating(raw.rating);
    const artist = {
      id: raw.id,
      name: raw.artistname,
      'sort-name': raw.sortname || raw.artistname,
      disambiguation: raw.disambiguation || '',
      'life-span': { ended: raw.status === 'ended' },
      aliases: (raw.artistaliases || []).map(name => ({ name, 'sort-name': name })),
      genres: (raw.genres || []).map(name => ({ name })),
      relations: this.relations(raw.links),
      overview: raw.overview || '',
      provider: PROVIDER_TAG
    };
    if (raw.type) artist.type = raw.type;
    if (rating !== null) artist.rating = { value: rating, 'votes-count': (raw.rating && raw.rating.Count) || 0 };
    return artist;
  }

  // MusicBrainz-shaped JSON with only what an upstream knows (absent keys mean "unknown", see lib/mbMap.js)
  normalizeReleaseGroup(raw) {
    const rg = {
      id: raw.id,
      title: raw.title,
      disambiguation: raw.disambiguation || '',
      'secondary-types': raw.secondarytypes || [],
      'artist-credit': this.mbCredit(raw),
      aliases: (raw.aliases || []).map(name => ({ name, 'sort-name': name })),
      genres: (raw.genres || []).map(name => ({ name })),
      relations: this.relations(raw.links),
      releases: (raw.Releases || []).map(r => this.releaseStub(r)),
      overview: raw.overview || '',
      provider: PROVIDER_TAG
    };
    if (raw.type) rg['primary-type'] = raw.type;
    const date = cleanDate(raw.releasedate);
    if (date) rg['first-release-date'] = date;
    const rating = toMbRating(raw.rating);
    if (rating !== null) rg.rating = { value: rating, 'votes-count': (raw.rating && raw.rating.Count) || 0 };
    return rg;
  }

  releaseStub(r) {
    return {
      id: r.Id,
      title: r.Title,
      date: cleanDate(r.ReleaseDate),
      country: countryCode(r.Country && r.Country[0]),
      status: r.Status || null
    };
  }

  normalizeRelease(r, album) {
    const artistNames = new Map((album.artists || []).map(a => [a.id, a.artistname]));

    const tracks = r.Tracks || [];
    let media = (r.Media || []).map(m => ({ position: m.Position, format: m.Format || null, title: m.Name || '' }));
    if (media.length === 0) {
      media = [...new Set(tracks.map(t => t.MediumNumber || 1))].sort((a, b) => a - b)
        .map(position => ({ position, format: null, title: '' }));
    }

    const release = {
      id: r.Id,
      title: r.Title,
      status: r.Status || null,
      country: countryCode(r.Country && r.Country[0]),
      disambiguation: r.Disambiguation || '',
      'release-group': { id: album.id },
      'label-info': (r.Label || []).map(name => ({ label: { name } })),
      'artist-credit': this.mbCredit(album),
      media: media.map(m => {
        const mediumTracks = tracks.filter(t => (t.MediumNumber || 1) === m.position);
        return {
          ...m,
          'track-count': mediumTracks.length,
          tracks: mediumTracks.map(t => ({
            id: t.Id,
            position: t.TrackPosition,
            number: t.TrackNumber,
            title: t.TrackName,
            length: t.DurationMs,
            recording: { id: t.RecordingId, title: t.TrackName, length: t.DurationMs },
            'artist-credit': [{
              name: artistNames.get(t.ArtistId) || '',
              joinphrase: '',
              artist: { id: t.ArtistId, name: artistNames.get(t.ArtistId) || '', disambiguation: '' }
            }]
          }))
        };
      }),
      provider: PROVIDER_TAG
    };
    const date = cleanDate(r.ReleaseDate);
    if (date) release.date = date;
    return release;
  }

  // Album-level credit in MusicBrainz's artist-credit shape. Upstream drops join phrases;
  // the primary artist (artistid) is first.
  mbCredit(raw) {
    const artists = (raw.artists || []).slice();
    const primaryIdx = artists.findIndex(a => a.id === raw.artistid);
    if (primaryIdx > 0) artists.unshift(artists.splice(primaryIdx, 1)[0]);
    if (artists.length === 0 && raw.artistid) artists.push({ id: raw.artistid, artistname: '' });
    return artists.map(a => ({
      name: a.artistname || '',
      joinphrase: '',
      artist: { id: a.id, name: a.artistname || '', disambiguation: a.disambiguation || '' }
    }));
  }

  // URL relations in MusicBrainz's shape
  relations(links) {
    return (links || []).filter(l => l && l.target).map(l => ({
      type: l.type || 'other', 'target-type': 'url', direction: 'forward', url: { resource: l.target }
    }));
  }
}

LmdUpstreamProvider.PROVIDER_TAG = PROVIDER_TAG;
LmdUpstreamProvider.countryCode = countryCode;
LmdUpstreamProvider.SUPPORTED_OPS = SUPPORTED_OPS;

module.exports = LmdUpstreamProvider;
