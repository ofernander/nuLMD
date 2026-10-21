/**
 * Maps MusicBrainz web-service JSON (as MusicBrainz returns it: kebab-case) to the values stored in
 * our tables. One vocabulary in, one set of columns out.
 *
 * A source that can only supply part of an entity (a Lidarr metadata server) emits the same
 * MB-shaped JSON with the missing keys left out. Keys that are absent come back `undefined`, so the
 * store can tell "MusicBrainz said null" from "this source doesn't know" and never blanks real data.
 */

const ARTIST_JSON_COLUMNS = new Set(['area', 'begin_area', 'end_area', 'isnis', 'ipis', 'aliases', 'tags', 'genres']);
// Fields where MusicBrainz sends rich objects. A partial source (an upstream sending bare names) must
// never replace these on a row that already holds full MusicBrainz data.
const ARTIST_RICH_COLUMNS = new Set(['area', 'begin_area', 'end_area', 'isnis', 'ipis', 'aliases', 'tags', 'genres', 'type_id', 'gender_id']);
const ARTIST_DEFAULTS = {
  disambiguation: '', ended: false, aliases: [], tags: [], genres: [], isnis: [], ipis: []
};

function artistRow(mb) {
  const life = mb['life-span'];
  const rating = mb.rating;
  return {
    name: mb.name,
    sort_name: mb['sort-name'] !== undefined ? mb['sort-name'] : mb.sortName, // search stubs use camelCase
    disambiguation: mb.disambiguation,
    type: mb.type,
    type_id: mb['type-id'],
    gender: mb.gender,
    gender_id: mb['gender-id'],
    country: mb.country,
    begin_date: life ? life.begin : undefined,
    end_date: life ? life.end : undefined,
    ended: life && life.ended !== undefined && life.ended !== null ? !!life.ended : undefined,
    area: mb.area,
    begin_area: mb['begin-area'],
    end_area: mb['end-area'],
    isnis: mb.isnis,
    ipis: mb.ipis,
    aliases: mb.aliases,
    tags: mb.tags,
    genres: mb.genres,
    rating: rating ? rating.value : undefined,
    rating_votes: rating ? rating['votes-count'] : undefined
  };
}

// URL relations only (that is all we request today). Keeps every field MusicBrainz sends with them.
function relationLinks(relations) {
  return (Array.isArray(relations) ? relations : [])
    .filter(r => r && r.url && r.url.resource)
    .map(r => ({
      type: r.type || 'other',
      type_id: r['type-id'],
      target_type: r['target-type'] || 'url',
      direction: r.direction,
      url: r.url.resource,
      url_id: r.url.id,
      begin_date: r.begin,
      end_date: r.end,
      ended: r.ended,
      attributes: r.attributes
    }));
}

// MusicBrainz sends "" for an unknown date; the column should say NULL
const nullIfEmpty = v => (v === '' ? null : v);

// Is this a value a source actually supplied? (absent, null, '' and [] all mean "no information")
const supplied = v => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0);

const RG_JSON_COLUMNS = new Set(['secondary_types', 'secondary_type_ids', 'artist_credit', 'aliases', 'tags', 'genres']);
const RG_RICH_COLUMNS = new Set(['primary_type_id', 'secondary_type_ids', 'artist_credit', 'aliases', 'tags', 'genres']);
const RG_DEFAULTS = { disambiguation: '', secondary_types: [], secondary_type_ids: [], artist_credit: [], aliases: [], tags: [], genres: [] };

function releaseGroupRow(mb) {
  const rating = mb.rating;
  return {
    title: mb.title,
    disambiguation: mb.disambiguation,
    primary_type: mb['primary-type'],
    primary_type_id: mb['primary-type-id'],
    secondary_types: mb['secondary-types'],
    secondary_type_ids: mb['secondary-type-ids'],
    first_release_date: nullIfEmpty(mb['first-release-date']),
    artist_credit: mb['artist-credit'],
    aliases: mb.aliases,
    tags: mb.tags,
    genres: mb.genres,
    rating: rating ? rating.value : undefined,
    rating_votes: rating ? rating['votes-count'] : undefined
  };
}

const RELEASE_JSON_COLUMNS = new Set(['text_representation', 'release_events', 'cover_art_archive', 'labels', 'artist_credit', 'media']);
const RELEASE_RICH_COLUMNS = new Set(['status_id', 'packaging_id', 'text_representation', 'release_events', 'cover_art_archive', 'labels', 'artist_credit', 'media']);
const RELEASE_DEFAULTS = { disambiguation: '', release_events: [], labels: [], artist_credit: [], media: [] };

function releaseRow(mb) {
  const row = {
    release_group_mbid: mb['release-group'] ? mb['release-group'].id : undefined,
    title: mb.title,
    disambiguation: mb.disambiguation,
    status: mb.status,
    status_id: mb['status-id'],
    release_date: nullIfEmpty(mb.date),
    country: mb.country,
    barcode: mb.barcode,
    asin: mb.asin,
    quality: mb.quality,
    packaging: mb.packaging,
    packaging_id: mb['packaging-id'],
    text_representation: mb['text-representation'],
    release_events: mb['release-events'],
    cover_art_archive: mb['cover-art-archive'],
    labels: mb['label-info'],
    artist_credit: mb['artist-credit'],
    media: mb.media
  };
  // Derived from the tracklist, only when the source sent one
  if (Array.isArray(mb.media)) {
    row.media_count = mb.media.length;
    row.track_count = mb.media.reduce((n, m) => n + (m['track-count'] || (m.tracks ? m.tracks.length : 0)), 0);
  }
  return row;
}

const RECORDING_JSON_COLUMNS = new Set(['artist_credit', 'isrcs']);
const RECORDING_RICH_COLUMNS = new Set(['artist_credit', 'isrcs']);
const RECORDING_DEFAULTS = { disambiguation: '', artist_credit: [], isrcs: [] };

function recordingRow(rec) {
  return {
    title: rec.title,
    disambiguation: rec.disambiguation,
    length_ms: rec.length,
    video: rec.video,
    first_release_date: nullIfEmpty(rec['first-release-date']),
    artist_credit: rec['artist-credit'],
    isrcs: rec.isrcs
  };
}

// One row of the derived `tracks` index, from a MusicBrainz track inside a medium
function trackRow(track, releaseMbid, recordingMbid, mediumPosition) {
  return {
    mbid: track.id,
    release_mbid: releaseMbid,
    recording_mbid: recordingMbid,
    position: Number(track.position) || 0,
    medium_number: mediumPosition,
    title: track.title || '',
    length_ms: track.length || null,
    artist_credit: track['artist-credit'] || []
  };
}

module.exports = {
  artistRow, relationLinks, ARTIST_JSON_COLUMNS, ARTIST_RICH_COLUMNS, ARTIST_DEFAULTS,
  releaseGroupRow, RG_JSON_COLUMNS, RG_RICH_COLUMNS, RG_DEFAULTS,
  releaseRow, RELEASE_JSON_COLUMNS, RELEASE_RICH_COLUMNS, RELEASE_DEFAULTS,
  recordingRow, RECORDING_JSON_COLUMNS, RECORDING_RICH_COLUMNS, RECORDING_DEFAULTS,
  trackRow, supplied, nullIfEmpty
};
