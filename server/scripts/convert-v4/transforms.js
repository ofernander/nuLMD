/**
 * v4 row -> v5 row, one function per table. Pure: no database, so every rule here is unit tested.
 *
 * Each returns an object of v5 column -> value (JSON columns already stringified), or null to skip the row.
 * Columns a v4 row can't supply are left out, so they take the v5 column default.
 *
 * Conventions: dates arrive as text (the copy selects `col::text`, which avoids time-zone shifts), lists that
 * v4 kept as bare names become MusicBrainz objects (see legacyConvert.js), and anything v5 dropped is simply
 * not mentioned.
 */
const legacy = require('./legacyConvert');

const json = v => JSON.stringify(v === undefined || v === null ? [] : v);
const asList = v => { const p = legacy.parse(v); return Array.isArray(p) ? p : []; };

// Columns every converted row keeps from v4 (only those the v4 database actually has are selected)
const BOOKKEEPING = ['first_fetched_at', 'last_updated_at', 'ttl_expires_at', 'last_accessed_at', 'source_provider', 'needs_mb_backfill'];

function bookkeeping(row) {
  const out = {};
  for (const col of BOOKKEEPING) if (row[col] !== undefined) out[col] = row[col];
  return out;
}

function artist(row) {
  return {
    mbid: row.mbid,
    name: row.name,
    sort_name: row.sort_name,
    disambiguation: row.disambiguation,
    type: row.type,
    gender: row.gender,
    country: row.country,
    begin_date: row.begin_date,
    end_date: row.end_date,
    ended: row.ended,
    aliases: json(legacy.aliases(asList(row.aliases))),
    tags: json(legacy.tags(asList(row.tags))),
    genres: json(legacy.genres(asList(row.genres))),
    rating: row.rating,
    overview: row.overview,
    ...bookkeeping(row)
    // mb_version stays at its default (0): the row refreshes from MusicBrainz at its TTL
  };
}

function releaseGroup(row) {
  return {
    mbid: row.mbid,
    title: row.title,
    disambiguation: row.disambiguation,
    primary_type: row.primary_type,
    secondary_types: json(asList(row.secondary_types)),
    first_release_date: row.first_release_date,
    artist_credit: json(legacy.creditToMb(row.artist_credit)),
    aliases: json(legacy.releaseGroupAliases(asList(row.aliases))),
    tags: json(legacy.tags(asList(row.tags))),
    genres: json(legacy.genres(asList(row.genres))),
    rating: row.rating,
    overview: row.overview,
    ...bookkeeping(row)
  };
}

function artistReleaseGroup(row) {
  return {
    artist_mbid: row.artist_mbid,
    release_group_mbid: row.release_group_mbid,
    position: row.position,
    join_phrase: row.join_phrase
  };
}

// Releases were already stored as MusicBrainz's own media / label-info / artist-credit JSON
function release(row) {
  return {
    mbid: row.mbid,
    release_group_mbid: row.release_group_mbid,
    title: row.title,
    disambiguation: row.disambiguation,
    status: row.status,
    release_date: row.release_date,
    country: row.country,
    barcode: row.barcode,
    labels: json(asList(row.labels)),
    artist_credit: json(asList(row.artist_credit)),
    media: json(asList(row.media)),
    media_count: row.media_count,
    track_count: row.track_count,
    first_fetched_at: row.first_fetched_at,
    last_updated_at: row.last_updated_at
  };
}

function recording(row) {
  return {
    mbid: row.mbid,
    title: row.title,
    disambiguation: row.disambiguation,
    length_ms: row.length_ms,
    video: row.is_video,
    first_fetched_at: row.first_fetched_at,
    last_updated_at: row.last_updated_at
  };
}

function track(row) {
  return {
    mbid: row.mbid,
    release_mbid: row.release_mbid,
    recording_mbid: row.recording_mbid,
    position: row.position,
    medium_number: row.medium_number,
    title: row.title,
    length_ms: row.length_ms,
    artist_credit: json(asList(row.artist_credit)),
    first_fetched_at: row.first_fetched_at
  };
}

// v4 allowed 'album' (an old name for release_group) and a few types v5 doesn't keep
const ENTITY_TYPES = { artist: 'artist', release_group: 'release_group', album: 'release_group', release: 'release', recording: 'recording' };

// links -> relations
function relation(row) {
  const entityType = ENTITY_TYPES[row.entity_type];
  if (!entityType || !row.url) return null;
  return {
    entity_type: entityType,
    entity_mbid: row.entity_mbid,
    type: row.link_type,
    url: row.url,
    first_fetched_at: row.first_fetched_at
  };
}

function redirect(row) {
  const entityType = ENTITY_TYPES[row.entity_type];
  if (!entityType) return null;
  return { old_mbid: row.old_mbid, new_mbid: row.new_mbid, entity_type: entityType, created_at: row.created_at };
}

const IMAGE_COLUMNS = ['entity_type', 'entity_mbid', 'cover_type', 'provider', 'url', 'local_path', 'cached', 'cached_at',
  'cache_failed', 'cache_failed_reason', 'width', 'height', 'file_size_bytes', 'last_verified_at', 'user_uploaded', 'uploaded_at'];

// The five URL-health columns v4 never read are dropped
function image(row) {
  const out = {};
  for (const col of IMAGE_COLUMNS) if (row[col] !== undefined) out[col] = row[col];
  return out;
}

// Jobs keep their ids (and the completed fetch_artist_albums rows that gate Lidarr's album lists)
function job(row) {
  const out = {};
  for (const col of ['id', 'job_type', 'entity_type', 'entity_mbid', 'priority', 'status', 'attempts', 'max_attempts',
    'error_message', 'created_at', 'started_at', 'completed_at', 'root_artist_mbid']) {
    if (row[col] !== undefined) out[col] = row[col];
  }
  if (row.metadata !== undefined) out.metadata = row.metadata === null ? null : (typeof row.metadata === 'string' ? row.metadata : JSON.stringify(row.metadata));
  return out;
}

module.exports = { artist, releaseGroup, artistReleaseGroup, release, recording, track, relation, redirect, image, job, ENTITY_TYPES };
