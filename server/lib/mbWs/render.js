/**
 * Turns stored rows back into MusicBrainz web-service (ws/2) JSON: the reverse of lib/mbMap.js.
 *
 * The tables hold MusicBrainz's own vocabulary, so this is mostly renaming columns back to kebab-case and
 * deciding, per `inc`, which parts of the entity to include. Only what we store completely can be rendered. A
 * request that asks for anything else is not answered from here at all: the routes pass it to MusicBrainz whole,
 * so a client never gets a quietly smaller answer than musicbrainz.org would give.
 */

// The includes each resource can be answered with from our own data. (Not `release-groups` on an artist or `releases`
// on a release group: we hold only some of those lists, so an answer from here would look complete and not be.)
const INCLUDES = {
  artist: ['aliases', 'tags', 'genres', 'ratings', 'url-rels'],
  'release-group': ['artists', 'artist-credits', 'aliases', 'tags', 'genres', 'ratings', 'url-rels'],
  release: ['artists', 'artist-credits', 'labels', 'recordings', 'release-groups', 'media'],
  recording: ['artists', 'artist-credits', 'isrcs']
};

// Includes that are one person's own data on musicbrainz.org (their tags, ratings, genres, collections). MusicBrainz
// answers 401 to any request that asks for them without logging in, and nuLMD has no MusicBrainz account, so they are
// left out before a request goes anywhere. (`collections` is public and is not on this list.)
const PRIVATE_INCLUDES = ['user-collections', 'user-tags', 'user-ratings', 'user-genres'];

const incTokens = raw => (Array.isArray(raw) ? raw : [raw]).filter(Boolean).join(' ').split(/[\s+,]+/).filter(Boolean);

// The `inc` a client sent, minus the account-only includes: { inc: "a+b" ('' when nothing is left), removed: [..] }
function splitPrivate(raw) {
  const kept = [], removed = [];
  for (const t of incTokens(raw)) {
    if (PRIVATE_INCLUDES.includes(t)) { if (!removed.includes(t)) removed.push(t); }
    else if (!kept.includes(t)) kept.push(t);
  }
  return { inc: kept.join('+'), removed };
}

// "tags+aliases", "tags aliases" or repeated parameters -> { include: Set of what we can answer, other: [the rest] }
// Anything in `other` (works, relationships, unknown values...) means MusicBrainz has to answer the whole request.
function parseInc(resource, raw) {
  const tokens = incTokens(raw);
  const include = new Set(), other = [];
  for (const t of tokens) {
    if (INCLUDES[resource].includes(t)) include.add(t);
    else if (!other.includes(t)) other.push(t);
  }
  return { include, other };
}

const orNull = v => (v === undefined || v === '' ? null : v);

const ratingOf = row => ({
  'votes-count': row.rating_votes === null || row.rating_votes === undefined ? 0 : row.rating_votes,
  value: row.rating === null || row.rating === undefined ? null : Number(row.rating)
});

// MusicBrainz's url relation, from a `relations` row
function relation(r) {
  return {
    type: r.type,
    'type-id': r.type_id || undefined,
    'target-type': r.target_type || 'url',
    direction: r.direction || 'forward',
    url: { id: r.url_id || undefined, resource: r.url },
    begin: orNull(r.begin_date),
    end: orNull(r.end_date),
    ended: !!r.ended,
    attributes: Array.isArray(r.attributes) ? r.attributes : [],
    'attribute-values': {},
    'attribute-ids': {},
    'source-credit': '',
    'target-credit': ''
  };
}

function artist(row, include, { relations = [] } = {}) {
  const out = {
    id: row.mbid,
    name: row.name,
    'sort-name': row.sort_name,
    disambiguation: row.disambiguation || '',
    type: orNull(row.type),
    'type-id': orNull(row.type_id),
    gender: orNull(row.gender),
    'gender-id': orNull(row.gender_id),
    country: orNull(row.country),
    area: row.area || null,
    'begin-area': row.begin_area || null,
    'end-area': row.end_area || null,
    'life-span': { begin: orNull(row.begin_date), end: orNull(row.end_date), ended: !!row.ended },
    isnis: row.isnis || [],
    ipis: row.ipis || []
  };
  if (include.has('aliases')) out.aliases = row.aliases || [];
  if (include.has('tags')) out.tags = row.tags || [];
  if (include.has('genres')) out.genres = row.genres || [];
  if (include.has('ratings')) out.rating = ratingOf(row);
  if (include.has('url-rels')) out.relations = relations.map(relation);
  return out;
}

function releaseGroup(row, include, { relations = [] } = {}) {
  const out = {
    id: row.mbid,
    title: row.title,
    disambiguation: row.disambiguation || '',
    'primary-type': orNull(row.primary_type),
    'primary-type-id': orNull(row.primary_type_id),
    'secondary-types': row.secondary_types || [],
    'secondary-type-ids': row.secondary_type_ids || [],
    'first-release-date': row.first_release_date || ''
  };
  if (include.has('artists') || include.has('artist-credits')) out['artist-credit'] = row.artist_credit || [];
  if (include.has('aliases')) out.aliases = row.aliases || [];
  if (include.has('tags')) out.tags = row.tags || [];
  if (include.has('genres')) out.genres = row.genres || [];
  if (include.has('ratings')) out.rating = ratingOf(row);
  if (include.has('url-rels')) out.relations = relations.map(relation);
  return out;
}

// A tracklist with only the parts the caller asked for (MusicBrainz leaves credits out unless `artist-credits`)
function media(rows, withTracks, withCredits) {
  return (rows || []).map(m => {
    const { tracks, ...rest } = m;
    if (!withTracks) return rest;
    const strip = o => {
      if (!o || withCredits) return o;
      const { 'artist-credit': _, ...kept } = o;
      return kept;
    };
    return { ...rest, tracks: (tracks || []).map(t => {
      const out = strip(t);
      return t.recording ? { ...out, recording: strip(t.recording) } : out;
    }) };
  });
}

function release(row, include, { releaseGroup: rg } = {}) {
  const out = {
    id: row.mbid,
    title: row.title,
    disambiguation: row.disambiguation || '',
    status: orNull(row.status),
    'status-id': orNull(row.status_id),
    quality: orNull(row.quality),
    packaging: orNull(row.packaging),
    'packaging-id': orNull(row.packaging_id),
    'text-representation': row.text_representation || { language: null, script: null },
    date: row.release_date || '',
    country: orNull(row.country),
    'release-events': row.release_events || [],
    barcode: orNull(row.barcode),
    asin: orNull(row.asin),
    'cover-art-archive': row.cover_art_archive || undefined   // only when the source sent it
  };
  const withCredits = include.has('artists') || include.has('artist-credits');
  if (withCredits) out['artist-credit'] = row.artist_credit || [];
  if (include.has('labels')) out['label-info'] = row.labels || [];
  if (include.has('release-groups') && rg) out['release-group'] = releaseGroup(rg, withCredits ? new Set(['artist-credits']) : new Set());
  if (include.has('recordings') || include.has('media')) out.media = media(row.media, include.has('recordings'), withCredits);
  return out;
}

function recording(row, include) {
  const out = {
    id: row.mbid,
    title: row.title,
    disambiguation: row.disambiguation || '',
    length: row.length_ms === undefined ? null : row.length_ms,
    video: !!row.video,
    'first-release-date': row.first_release_date || ''
  };
  if (include.has('artists') || include.has('artist-credits')) out['artist-credit'] = row.artist_credit || [];
  if (include.has('isrcs')) out.isrcs = row.isrcs || [];
  return out;
}

module.exports = { INCLUDES, PRIVATE_INCLUDES, splitPrivate, parseInc, relation, artist, releaseGroup, release, recording };
