const fs = require('fs').promises;
const database = require('../sql/database');
const { logger } = require('./logger');

/**
 * Clearing cached metadata: the stored copy of an artist, a release group, or (trim) every artist Lidarr no longer has.
 *
 * Deleting an artist row only removes its links; release groups, releases and tracks stay, and several tables have no
 * foreign key at all (relations, images, the raw archive, the stored lists, the proxy cache, jobs). This is the one place
 * that knows the whole set, and it works in a single transaction on temp tables so a trim of thousands of artists never
 * moves their ids through JavaScript.
 *
 * Rules (the same ones the image trim follows):
 *  - a release group is deleted only if every artist linked to it is being cleared; one nobody is linked to (a stub made
 *    for another artist's release) goes with the artist it is credited to;
 *  - a release group in `protectedRgIds` (Lidarr's album set) is never deleted;
 *  - an artist still credited on a release group that stays keeps its row (the name Lidarr's album replies need) but loses
 *    its catalog, so it is fetched again only if asked for; unless `forceDeleteRows` (a block);
 *  - recordings are removed only when they belonged to the deleted tracks and no remaining track uses them;
 *  - image rows go with their files (user uploads too: an explicit clear removes everything of the entity).
 */

const UUID_ARRAY = '::uuid[]';
const { UUID } = require('./blocklist');

/** A processing job for these artists (or this release group's artists) would write the data right back */
async function activeJobFor({ artistIds = [], rgIds = [] }) {
  const r = await database.query(`
    SELECT 1 FROM metadata_jobs
    WHERE status = 'processing'
      AND (entity_mbid = ANY($1${UUID_ARRAY}) OR root_artist_mbid = ANY($1${UUID_ARRAY})
           OR entity_mbid = ANY($2${UUID_ARRAY})
           OR (job_type = 'fetch_artist_albums' AND entity_mbid IN (
                 SELECT artist_mbid FROM artist_release_groups WHERE release_group_mbid = ANY($2${UUID_ARRAY}))))
    LIMIT 1`, [artistIds, rgIds]);
  return r.rows.length > 0;
}

// A statement that takes this long is logged as it finishes, so a slow clear shows where it is while it runs
const SLOW_STEP_MS = 1000;
const labelOf = sql => (sql.text || String(sql)).replace(/\s+/g, ' ').trim().slice(0, 70);

async function removeImageFiles(rows) {
  let bytes = 0;
  for (const img of rows) {
    if (!img.local_path) { bytes += Number(img.file_size_bytes) || 0; continue; }
    try {
      const st = await fs.stat(img.local_path);
      bytes += st.size;
      await fs.unlink(img.local_path);
    } catch (err) {
      if (err.code !== 'ENOENT') logger.warn(`clear: could not delete ${img.local_path}: ${err.message}`);
    }
  }
  return bytes;
}

/**
 * Plan and (unless dryRun) carry out one clear.
 * @param {string[]} artistIds     artists whose stored metadata goes
 * @param {string[]} rgIds         release groups that go on their own account (a clear of one release group)
 * @param {string[]} releaseIds    releases that go on their own account (a clear of one release)
 * @param {string[]} protectedRgIds release groups that must stay
 * @param {boolean} forceDeleteRows delete artist rows even when a remaining album credits them (a block)
 * @returns counts of what was (or would be) removed
 */
async function run({ artistIds = [], rgIds = [], releaseIds = [], protectedRgIds = [], forceDeleteRows = false, dryRun = false } = {}) {
  const client = await database.getClient();
  let outcome;
  try {
    const started = Date.now();
    const steps = [];
    logger.info(`clear: started${dryRun ? ' (dry run)' : ''}: ${artistIds.length} artist(s), ${rgIds.length} release group(s), ${releaseIds.length} release(s), ${protectedRgIds.length} protected group(s)`);
    const summary = () => {
      const slowest = [...steps].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([label, ms]) => `${ms} ms ${label}`).join(' | ');
      logger.info(`clear: ${dryRun ? 'dry run' : 'statements'} took ${Date.now() - started} ms; slowest: ${slowest}`);
    };
    await client.query('BEGIN');
    const q = async sql => {
      const at = Date.now();
      try {
        return await client.query(sql);
      } finally {
        const ms = Date.now() - at;
        steps.push([labelOf(sql), ms]);
        if (ms >= SLOW_STEP_MS) logger.info(`clear: slow step (${ms} ms): ${labelOf(sql)}`);
      }
    };
    await q({ text: `CREATE TEMP TABLE _c_artist (mbid uuid PRIMARY KEY) ON COMMIT DROP` });
    await q({ text: `CREATE TEMP TABLE _c_keep (mbid uuid PRIMARY KEY) ON COMMIT DROP` });
    await q({ text: `CREATE TEMP TABLE _c_rg (mbid uuid PRIMARY KEY) ON COMMIT DROP` });
    await q({ text: `CREATE TEMP TABLE _c_release (mbid uuid PRIMARY KEY) ON COMMIT DROP` });
    await q({ text: `CREATE TEMP TABLE _c_recording (mbid uuid PRIMARY KEY) ON COMMIT DROP` });

    await q({ text: `INSERT INTO _c_artist SELECT DISTINCT unnest($1${UUID_ARRAY}) ON CONFLICT DO NOTHING`, values: [artistIds] });
    // 1. release groups only these artists are linked to
    await q({ text: `
      INSERT INTO _c_rg
      SELECT DISTINCT arg.release_group_mbid FROM artist_release_groups arg
      JOIN _c_artist c ON c.mbid = arg.artist_mbid
      WHERE NOT EXISTS (SELECT 1 FROM artist_release_groups o
                        WHERE o.release_group_mbid = arg.release_group_mbid AND o.artist_mbid NOT IN (SELECT mbid FROM _c_artist))
      ON CONFLICT DO NOTHING` });
    // 2. stubs nobody is linked to, credited first to one of these artists
    await q({ text: `
      INSERT INTO _c_rg
      SELECT rg.mbid FROM release_groups rg
      WHERE NOT EXISTS (SELECT 1 FROM artist_release_groups x WHERE x.release_group_mbid = rg.mbid)
        AND rg.artist_credit->0->'artist'->>'id' IN (SELECT mbid::text FROM _c_artist)
      ON CONFLICT DO NOTHING` });
    // 3. release groups named outright
    await q({ text: `INSERT INTO _c_rg SELECT DISTINCT unnest($1${UUID_ARRAY}) ON CONFLICT DO NOTHING`, values: [rgIds] });
    // 4. what must stay
    await q({ text: `DELETE FROM _c_rg WHERE mbid = ANY($1${UUID_ARRAY})`, values: [protectedRgIds] });

    // Artists still credited on a release group that stays keep their row (but lose their catalog)
    if (!forceDeleteRows && artistIds.length) {
      await q({ text: `
        INSERT INTO _c_keep
        SELECT DISTINCT (elem->'artist'->>'id')::uuid
        FROM release_groups rg,
             jsonb_array_elements(CASE WHEN jsonb_typeof(rg.artist_credit) = 'array' THEN rg.artist_credit ELSE '[]'::jsonb END) elem
        WHERE rg.mbid NOT IN (SELECT mbid FROM _c_rg)
          AND elem->'artist'->>'id' IN (SELECT mbid::text FROM _c_artist)
        ON CONFLICT DO NOTHING` });
    }

    await q({ text: `INSERT INTO _c_release SELECT mbid FROM releases WHERE release_group_mbid IN (SELECT mbid FROM _c_rg)` });
    await q({ text: `INSERT INTO _c_release SELECT mbid FROM releases WHERE mbid = ANY($1${UUID_ARRAY}) ON CONFLICT DO NOTHING`, values: [releaseIds] });
    await q({ text: `
      INSERT INTO _c_recording
      SELECT DISTINCT recording_mbid FROM tracks
      WHERE release_mbid IN (SELECT mbid FROM _c_release) AND recording_mbid IS NOT NULL` });

    const stats = (await q({ text: `
      SELECT (SELECT count(*) FROM _c_artist)::int AS artists,
             (SELECT count(*) FROM _c_keep)::int AS artists_kept,
             (SELECT count(*) FROM _c_rg)::int AS release_groups,
             (SELECT count(*) FROM _c_release)::int AS releases,
             (SELECT count(*) FROM tracks WHERE release_mbid IN (SELECT mbid FROM _c_release))::int AS tracks` })).rows[0];

    const images = (await q({ text: `
      SELECT id, local_path, file_size_bytes FROM images
      WHERE (entity_type = 'artist' AND entity_mbid IN (SELECT mbid FROM _c_artist WHERE mbid NOT IN (SELECT mbid FROM _c_keep)))
         OR (entity_type = 'release_group' AND entity_mbid IN (SELECT mbid FROM _c_rg))` })).rows;
    stats.images = images.length;
    stats.bytes = images.reduce((n, i) => n + (Number(i.file_size_bytes) || 0), 0);
    if (dryRun) {
      await client.query('ROLLBACK');
      summary();
      return stats;
    }

    const gone = `SELECT mbid FROM _c_artist WHERE mbid NOT IN (SELECT mbid FROM _c_keep)`;
    if (images.length) await q({ text: `DELETE FROM images WHERE id = ANY($1::bigint[])`, values: [images.map(i => i.id)] });
    await q({ text: `
      DELETE FROM relations
      WHERE (entity_type = 'artist' AND entity_mbid IN (${gone}))
         OR (entity_type = 'release_group' AND entity_mbid IN (SELECT mbid FROM _c_rg))
         OR (entity_type = 'release' AND entity_mbid IN (SELECT mbid FROM _c_release))` });
    await q({ text: `
      DELETE FROM mb_raw_archive
      WHERE (entity_type = 'artist' AND mbid IN (${gone}))
         OR (entity_type = 'release_group' AND mbid IN (SELECT mbid FROM _c_rg))
         OR (entity_type = 'release' AND mbid IN (SELECT mbid FROM _c_release))` });
    await q({ text: `
      DELETE FROM mb_lists
      WHERE (parent_type = 'artist' AND parent_mbid IN (SELECT mbid FROM _c_artist))
         OR (parent_type = 'release-group' AND parent_mbid IN (SELECT mbid FROM _c_rg))` });
    // The reply cache is keyed by text: for a single entity its own id is looked for, for a bulk trim only the artists'
    await q({ text: `
      DELETE FROM mb_proxy_cache p
      WHERE EXISTS (SELECT 1 FROM _c_artist c WHERE position(c.mbid::text in p.cache_key) > 0)
         OR ($1::int <= 5 AND EXISTS (SELECT 1 FROM _c_rg g WHERE position(g.mbid::text in p.cache_key) > 0))`,
      values: [stats.release_groups] });
    await q({ text: `
      DELETE FROM metadata_jobs
      WHERE entity_mbid IN (SELECT mbid FROM _c_artist) OR root_artist_mbid IN (SELECT mbid FROM _c_artist)
         OR entity_mbid IN (SELECT mbid FROM _c_rg) OR entity_mbid IN (SELECT mbid FROM _c_release)` });
    // The release groups: their releases and tracks follow (ON DELETE CASCADE)
    await q({ text: `DELETE FROM release_groups WHERE mbid IN (SELECT mbid FROM _c_rg)` });
    await q({ text: `DELETE FROM releases WHERE mbid IN (SELECT mbid FROM _c_release)` });   // releases named outright
    const recordings = await q({ text: `
      DELETE FROM recordings r USING _c_recording c
      WHERE r.mbid = c.mbid AND NOT EXISTS (SELECT 1 FROM tracks t WHERE t.recording_mbid = r.mbid)` });
    stats.recordings = recordings.rowCount;
    await q({ text: `
      UPDATE artists SET catalog_complete_at = NULL, catalog_verified_at = NULL, catalog_provisional = FALSE, catalog_full_at = NULL,
                         mb_release_group_count = NULL, mb_release_count = NULL
      WHERE mbid IN (SELECT mbid FROM _c_keep)` });
    await q({ text: `DELETE FROM artists WHERE mbid IN (${gone})` });
    await client.query('COMMIT');
    summary();
    outcome = { stats, images };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* nothing open */ }
    throw error;
  } finally {
    client.release();
  }

  const { stats, images } = outcome;
  stats.bytes = await removeImageFiles(images);
  logger.info(`clear: removed ${stats.artists - stats.artists_kept} artists (${stats.artists_kept} kept as a name only), ${stats.release_groups} release groups, ${stats.releases} releases, ${stats.tracks} tracks, ${stats.recordings} recordings, ${stats.images} images (${stats.bytes} bytes)`);
  return stats;
}

const blockedByJob = what => Object.assign(new Error(`A fetch for this ${what} is running: let it finish (or kill active jobs) and try again`), { status: 409 });

/** Clear one artist. Refused while a job for it is running (unless `ignoreJobs`, which a block uses: its guards stop the writes). */
async function clearArtist(mbid, { ignoreJobs = false, forceDeleteRows = false, dryRun = false, protectedRgIds = [] } = {}) {
  if (!ignoreJobs && !dryRun && await activeJobFor({ artistIds: [mbid] })) throw blockedByJob('artist');
  return run({ artistIds: [mbid], forceDeleteRows, dryRun, protectedRgIds });
}

async function clearReleaseGroup(mbid, { ignoreJobs = false, dryRun = false } = {}) {
  if (!ignoreJobs && !dryRun && await activeJobFor({ rgIds: [mbid] })) throw blockedByJob('release group');
  return run({ rgIds: [mbid], dryRun });
}

async function clearRelease(mbid, { dryRun = false } = {}) {
  return run({ releaseIds: [mbid], dryRun });
}

/**
 * Trim the artists Lidarr does not have. The caller has already established the two Lidarr sets (and refused to go on if
 * either could not be read), so an empty or unreadable set never reaches here. Artists with a running job are left alone.
 */
async function trimNotInLidarr({ lidarrArtistIds, lidarrAlbumIds, dryRun = false }) {
  const lookedAt = Date.now();
  const isId = id => UUID.test(id);
  lidarrArtistIds = [...lidarrArtistIds].filter(isId);
  lidarrAlbumIds = [...lidarrAlbumIds].filter(isId);
  const candidates = (await database.query(`
    SELECT a.mbid FROM artists a
    WHERE NOT (a.mbid = ANY($1${UUID_ARRAY}))
      AND NOT EXISTS (SELECT 1 FROM metadata_jobs j
                      WHERE j.status = 'processing' AND (j.entity_mbid = a.mbid OR j.root_artist_mbid = a.mbid))`,
    [lidarrArtistIds])).rows.map(r => r.mbid);
  logger.info(`clear: trim found ${candidates.length} stored artist(s) not in Lidarr (${lidarrArtistIds.length} in Lidarr, ${lidarrAlbumIds.length} albums) in ${Date.now() - lookedAt} ms`);
  if (candidates.length === 0) return { artists: 0, artists_kept: 0, release_groups: 0, releases: 0, tracks: 0, images: 0, bytes: 0, recordings: 0 };
  return run({ artistIds: candidates, protectedRgIds: lidarrAlbumIds, dryRun });
}

module.exports = { run, clearArtist, clearReleaseGroup, clearRelease, trimNotInLidarr, activeJobFor, removeImageFiles };
