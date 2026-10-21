const database = require('../sql/database');
const { logger } = require('./logger');
const { registry } = require('./providerRegistry');
const lidarr = require('./lidarr');
const backgroundJobQueue = require('./backgroundJobQueue');
const lidarrClient = require('./lidarrClient');
const config = require('./config');
const mbMap = require('./mbMap');
const { archiveKey } = require('./mbRequests');
const BaseProvider = require('../providers/base');
const blocklist = require('./blocklist');

// A release-group list longer than this is refused (the same safety limit the artist job always had)
const MAX_GROUPS = 2000;

// An artist's catalog job is queued from an album request at most this often
const CATALOG_QUEUE_THROTTLE_MS = 10 * 60 * 1000;
// An album request waits at most this long for its artist's running catalog job before fetching the album alone
const ALBUM_WAIT_MS = 30 * 1000;
const ALBUM_WAIT_POLL_MS = 1000;
// The upstream fallback is used for a catalog job's second failed attempt, not the first: a blip is not an outage
const FALLBACK_AFTER_ATTEMPTS = 2;
const DAY_MS = 24 * 60 * 60 * 1000;

// Data normalized from a non-MusicBrainz source (e.g. an LMD upstream) is tagged by its provider.
// Untagged data (legacy callers, search stubs) is treated as MusicBrainz.
function isPartialSource(data) {
  return !!data && !!data.provider && data.provider !== 'musicbrainz';
}

class ArtistService {
  // Overlapping ensureAlbum calls for one group share a single run
  albumFlights = new Map();

  // artist -> when its catalog job was last queued from an album request
  catalogQueuedAt = new Map();

  albumWaitMs = ALBUM_WAIT_MS;
  albumWaitPollMs = ALBUM_WAIT_POLL_MS;

  async getArtist(mbid) {
    const mbProvider = registry.getProvider('musicbrainz');
    if (!mbProvider) throw new Error('MusicBrainz provider not available');
    const mbData = await mbProvider.getArtist(mbid);
    await this.storeArtist(mbid, mbData, true);
  }
  
  async searchArtist(query, limit = 10) {
    logger.info(`Searching for artist: ${query}`);
    
    const mbProvider = registry.getProvider('musicbrainz');
    if (!mbProvider) {
      throw new Error('MusicBrainz provider not available');
    }
    
    // Search MusicBrainz - get basic results
    const searchResults = await mbProvider.searchArtist(query, limit);
    
    // For each result, fetch FULL artist details (like old LMD did)
    const fullArtists = [];
    for (const result of searchResults) {
      if (blocklist.isBlocked('artist', result.id)) continue;
      try {
        // Fetch full artist data
        const fullData = await mbProvider.getArtist(result.id);
        
        // Store with full data
        await this.storeArtist(result.id, fullData, true);
        
        // Get from database and format
        const artist = await database.getArtist(result.id);
        fullArtists.push(await lidarr.formatArtist(result.id));
      } catch (error) {
        logger.error(`Failed to fetch full details for artist ${result.id}:`, error);
        // Fall back to basic search result
        await this.storeArtist(result.id, result, false);
        const artist = await database.getArtist(result.id);
        fullArtists.push(await lidarr.formatArtist(result.id));
      }
    }
    
    return fullArtists;
  }
  
  /**
   * One writer for every MusicBrainz entity table (row builders live in lib/mbMap.js).
   *  - writeAll: a full MusicBrainz reply, so every column is written (absent ones take their default)
   *  - otherwise only the columns the source actually supplied are written, and `rich` columns are left alone
   *    on a row that already holds full MusicBrainz data (a source with bare names must not replace MB's objects)
   * `provenance` tables (artists, release groups) also record where the row came from and whether MusicBrainz
   * still has to fill gaps. Returns the set of columns it wrote.
   */
  async writeEntity(table, mbid, row, { json, defaults = {}, rich = new Set(), writeAll, fromMb, provenance = false, access = false, touch = true, extra = {} }) {
    const toDb = (col, v) => {
      const value = v === undefined || v === null ? (col in defaults ? defaults[col] : null) : v;
      return json.has(col) && value !== null ? JSON.stringify(value) : value;
    };

    const existing = await database.query(`SELECT mbid, mb_version FROM ${table} WHERE mbid = $1`, [mbid]);
    const exists = existing.rows.length > 0;
    const hasFullMbData = exists && existing.rows[0].mb_version === 1;

    const values = [];
    const param = v => { values.push(v); return `$${values.length}`; };
    const written = new Set();

    if (exists) {
      const sets = [];
      for (const [col, v] of Object.entries(row)) {
        if (!writeAll && ((hasFullMbData && rich.has(col)) || !mbMap.supplied(v))) continue;
        sets.push(`${col} = ${param(toDb(col, v))}`);
        written.add(col);
      }
      for (const [col, v] of Object.entries(extra)) sets.push(`${col} = ${param(v)}`);
      if (writeAll) sets.push('mb_version = 1');
      if (provenance && fromMb) sets.push(`source_provider = 'musicbrainz'`, 'needs_mb_backfill = FALSE');
      if (touch) sets.push('last_updated_at = NOW()');
      if (access) sets.push('last_accessed_at = NOW()');
      await database.query(`UPDATE ${table} SET ${sets.join(', ')} WHERE mbid = ${param(mbid)}`, values);
    } else {
      const cols = ['mbid'], placeholders = [param(mbid)];
      for (const [col, v] of Object.entries(row)) { cols.push(col); placeholders.push(param(toDb(col, v))); written.add(col); }
      for (const [col, v] of Object.entries(extra)) { cols.push(col); placeholders.push(param(v)); }
      cols.push('mb_version'); placeholders.push(writeAll ? '1' : '0');
      if (provenance) {
        cols.push('source_provider', 'needs_mb_backfill');
        placeholders.push(`'${fromMb ? 'musicbrainz' : 'lidarr-upstream'}'`, String(!fromMb));
      }
      if (access) { cols.push('last_accessed_at'); placeholders.push('NOW()'); }
      await database.query(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`, values);
    }
    return { existed: exists, written };
  }

  /**
   * File the reply exactly as MusicBrainz sent it (minus nuLMD's own tags) so the tables can be rebuilt from it
   * later without calling MusicBrainz again. A backup only: nothing is ever served from here.
   * Never allowed to break a store: if it fails the metadata is still saved.
   */
  async archiveReply(entityType, mbid, data) {
    try {
      const { provider, overview, ...reply } = data;
      await database.query(`
        INSERT INTO mb_raw_archive (entity_type, mbid, request_key, body, source)
        VALUES ($1, $2, $3, $4, 'musicbrainz')
        ON CONFLICT (entity_type, mbid, request_key) DO UPDATE SET body = EXCLUDED.body, fetched_at = NOW()
      `, [entityType, mbid, archiveKey(entityType), JSON.stringify(reply)]);
    } catch (error) {
      logger.warn(`Archive: could not file ${entityType} ${mbid}: ${error.message}`);
    }
  }

  /**
   * Refill the tables from the archive without calling MusicBrainz: for after a mapper fix or a new column.
   * Parents before children (artists, release groups, releases). TTLs, overviews and timestamps are left alone.
   */
  async replayFromArchive({ types = ['artist', 'release_group', 'release'], dryRun = false, onProgress = () => {} } = {}) {
    const stats = {};
    for (const type of types) {
      stats[type] = { replayed: 0, failed: 0 };
      let last = '00000000-0000-0000-0000-000000000000';
      for (;;) {
        const batch = await database.query(
          `SELECT mbid, body FROM mb_raw_archive WHERE entity_type = $1 AND request_key = $2 AND mbid > $3 ORDER BY mbid LIMIT 200`,
          [type, archiveKey(type), last]);
        if (batch.rows.length === 0) break;
        for (const row of batch.rows) {
          last = row.mbid;
          if (dryRun) { stats[type].replayed++; continue; }
          try {
            const data = { ...JSON.parse(row.body), provider: 'musicbrainz' };
            if (type === 'artist') await this.storeArtist(row.mbid, data, true, { replay: true });
            else if (type === 'release_group') await this.storeReleaseGroup(row.mbid, data, null, { force: true, replay: true });
            else await this.storeRelease(row.mbid, data, { replay: true });
            stats[type].replayed++;
          } catch (error) {
            stats[type].failed++;
            logger.warn(`Replay: ${type} ${row.mbid} failed: ${error.message}`);
          }
        }
        onProgress(type, stats[type]);
      }
    }
    return stats;
  }

  async storeArtist(mbid, data, isFullData = false, { replay = false } = {}) {
    if (blocklist.isBlocked('artist', mbid)) { logger.info(`storeArtist: ${mbid} is blocked, not stored`); return; }
    const ttlDays = config.get('metadata.ttlDays', 30);
    const ttlExpires = new Date(Date.now() + (ttlDays * 24 * 60 * 60 * 1000));

    // Data from a non-MusicBrainz source (e.g. an LMD upstream) is partial: it can't supply
    // country/dates/gender/tags. It must never blank out what MusicBrainz already gave us, and
    // new rows from it are flagged so MB can fill the gaps later.
    const fromMb = !isPartialSource(data);
    const writeAll = fromMb && isFullData;
    const overview = isFullData ? (data.overview || '') : undefined;

    // Overview isn't MusicBrainz data: written for full data, but a partial source never blanks an existing one
    // (A replay from the archive refills columns only: no TTL, overview or timestamp changes)
    const extra = replay ? {} : { ttl_expires_at: ttlExpires };
    if (!replay && isFullData && (writeAll || mbMap.supplied(overview))) extra.overview = overview;

    const { existed } = await this.writeEntity('artists', mbid, mbMap.artistRow(data), {
      json: mbMap.ARTIST_JSON_COLUMNS, defaults: mbMap.ARTIST_DEFAULTS, rich: mbMap.ARTIST_RICH_COLUMNS,
      writeAll, fromMb, provenance: true, access: !replay, touch: !replay, extra
    });
    if (writeAll && !replay) await this.archiveReply('artist', mbid, data);
    logger.info(`${existed ? 'Updated' : 'Inserted'} artist ${mbid} in database${isFullData ? ' (full data)' : ''}`);

    // Relations: MusicBrainz sends them as `relations`; search stubs and older callers pass `links`
    const links = Array.isArray(data.relations) ? mbMap.relationLinks(data.relations) : (data.links || []);
    if (links.length > 0) {
      logger.info(`Artist ${mbid} has ${links.length} links to store`);
      await this.storeLinks('artist', mbid, links);
    } else {
      logger.info(`Artist ${mbid} has no links to store`);
    }

    // Wiki and image jobs are queued in route handlers only — when Lidarr explicitly requests this artist
  }
  
  async storeLinks(entityType, entityMbid, links) {
    for (const link of links) {
      // Accepts a bare url, an old {type, url}, or a full relation from mbMap.relationLinks
      const l = typeof link === 'string' ? { url: link, type: 'official' } : link;
      await database.query(`
        INSERT INTO relations (entity_type, entity_mbid, type, url, target_type, type_id, direction, url_id,
                               begin_date, end_date, ended, attributes)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (entity_mbid, type, url) DO UPDATE SET
          type_id = COALESCE(EXCLUDED.type_id, relations.type_id),
          direction = COALESCE(EXCLUDED.direction, relations.direction),
          url_id = COALESCE(EXCLUDED.url_id, relations.url_id),
          begin_date = COALESCE(EXCLUDED.begin_date, relations.begin_date),
          end_date = COALESCE(EXCLUDED.end_date, relations.end_date),
          ended = COALESCE(EXCLUDED.ended, relations.ended),
          attributes = COALESCE(EXCLUDED.attributes, relations.attributes)
      `, [
        entityType, entityMbid, l.type || 'official', l.url, l.target_type || 'url',
        l.type_id || null, l.direction || null, l.url_id || null,
        l.begin_date || null, l.end_date || null,
        l.ended === undefined ? null : l.ended,
        l.attributes === undefined || l.attributes === null ? null : JSON.stringify(l.attributes)
      ]);
    }

    logger.info(`Stored ${links.length} links for ${entityType} ${entityMbid}`);
  }
  
  isStale(artist) {
    if (!artist.ttl_expires_at) return true;
    return new Date(artist.ttl_expires_at) < new Date();
  }
  
  // `full: false` marks a browse stub (title, type, date): it fills what it has and never blanks the rest
  async storeReleaseGroup(mbid, data, artistMbid, { force = false, full = true, replay = false } = {}) {
    if (blocklist.isBlocked('release_group', mbid)) { logger.info(`storeReleaseGroup: ${mbid} is blocked, not stored`); return; }
    const ttlDays = config.get('metadata.ttlDays', 30);
    const ttlExpires = new Date(Date.now() + (ttlDays * 24 * 60 * 60 * 1000));

    const albumOverview = data.overview || '';
    const fromMb = !isPartialSource(data);
    const writeAll = fromMb && full;

    // If within TTL and has overview, skip update (unless force=true)
    const existing = await database.query(
      'SELECT mbid, ttl_expires_at, overview FROM release_groups WHERE mbid = $1',
      [mbid]
    );
    if (existing.rows.length > 0 && !force) {
      const rg = existing.rows[0];
      if (rg.ttl_expires_at && new Date(rg.ttl_expires_at) > new Date() && rg.overview) {
        logger.info(`Release group ${mbid} within TTL, skipping update`);
        logger.debug(`Release group ${mbid} TTL expires: ${rg.ttl_expires_at}, has overview: ${!!rg.overview}`);
        await this.linkArtistToReleaseGroup(artistMbid, mbid);
        return;
      }
    }

    // Overview isn't MusicBrainz data: a partial source never blanks an existing one
    const extra = replay ? {} : { ttl_expires_at: ttlExpires };
    if (!replay && (writeAll || mbMap.supplied(albumOverview))) extra.overview = albumOverview;

    await this.writeEntity('release_groups', mbid, mbMap.releaseGroupRow(data), {
      json: mbMap.RG_JSON_COLUMNS, defaults: mbMap.RG_DEFAULTS, rich: mbMap.RG_RICH_COLUMNS,
      writeAll, fromMb, provenance: true, access: !replay, touch: !replay, extra
    });
    if (writeAll && !replay) await this.archiveReply('release_group', mbid, data);

    // Relations
    const links = Array.isArray(data.relations) ? mbMap.relationLinks(data.relations) : (data.links || []);
    if (links.length > 0) {
      await this.storeLinks('release_group', mbid, links);
    }

    // Wiki and image jobs are queued in route handlers only — when Lidarr explicitly requests this album
    await this.linkArtistToReleaseGroup(artistMbid, mbid);
  }

  async linkArtistToReleaseGroup(artistMbid, releaseGroupMbid) {
    if (!artistMbid) return;
    const artistExists = await database.query('SELECT 1 FROM artists WHERE mbid = $1 LIMIT 1', [artistMbid]);
    if (artistExists.rows.length === 0) {
      logger.info(`storeReleaseGroup: skipping artist link — artist ${artistMbid} not in DB`);
      return;
    }
    await database.query(`
      INSERT INTO artist_release_groups (artist_mbid, release_group_mbid, position)
      VALUES ($1, $2, 0)
      ON CONFLICT DO NOTHING
    `, [artistMbid, releaseGroupMbid]);
  }

  async checkReleaseGroupExists(mbid) {
    const result = await database.query(
      'SELECT mbid FROM release_groups WHERE mbid = $1',
      [mbid]
    );
    return result.rows.length > 0;
  }

  async getArtistReleaseGroups(artistMbid) {
    // Get unique release-group MBIDs for an artist
    const result = await database.query(`
      SELECT DISTINCT rg.mbid
      FROM release_groups rg
      JOIN artist_release_groups arg ON arg.release_group_mbid = rg.mbid
      WHERE arg.artist_mbid = $1
    `, [artistMbid]);
    
    return result.rows.map(row => row.mbid);
  }
  
  // `recordingsSeen`: ids of the recordings already written by this run (an artist's releases repeat the same
  // recordings edition after edition); a recording in it is not written again
  async storeRelease(mbid, data, { replay = false, recordingsSeen = null } = {}) {
    const fromMb = !isPartialSource(data);
    const row = mbMap.releaseRow(data);
    if (!row.release_group_mbid) row.release_group_mbid = data.release_group_mbid;
    if (!row.release_group_mbid) {
      throw new Error(`Release ${mbid} has no release group MBID`);
    }
    if (blocklist.isBlocked('release', mbid) || blocklist.isBlocked('release_group', row.release_group_mbid)) {
      logger.info(`storeRelease: ${mbid} (or its release group) is blocked, not stored`);
      return;
    }

    const { written } = await this.writeEntity('releases', mbid, row, {
      json: mbMap.RELEASE_JSON_COLUMNS, defaults: mbMap.RELEASE_DEFAULTS, rich: mbMap.RELEASE_RICH_COLUMNS,
      writeAll: fromMb, fromMb, touch: !replay
    });
    if (fromMb && !replay) await this.archiveReply('release', mbid, data);

    // Tracks and recordings are derived from the tracklist, so they follow whenever the tracklist was written
    if (written.has('media') && Array.isArray(data.media) && data.media.length > 0) {
      await this.storeTracksFromMedia(mbid, data.media, { partial: !fromMb, recordingsSeen });
    }

    logger.info(`Stored release ${mbid} with ${row.track_count || 0} tracks across ${row.media_count || 0} media`);
  }

  async storeTracksFromMedia(releaseMbid, media, { partial = false, recordingsSeen = null } = {}) {
    const rows = [];
    for (const medium of media) {
      for (const track of medium.tracks || []) {
        const recording = track.recording;
        if (!recording || !recording.id) continue;

        // Store the recording (once per run: later editions carry the same recording with the same data)
        if (!(recordingsSeen && !partial && recordingsSeen.has(recording.id))) {
          await this.storeRecording(recording.id, recording, { partial });
          if (recordingsSeen && !partial) recordingsSeen.add(recording.id);
        }
        rows.push(mbMap.trackRow(track, releaseMbid, recording.id, medium.position));
      }
    }
    // The tracks (they link the recordings to the release) go in together
    await this.storeTracks(rows);
  }

  // A recording arrives from different contexts (a release's tracklist, later a recording lookup), each with
  // different fields, so only what a reply actually contains is ever written
  // `full`: the reply is a complete recording lookup (not a track inside a release), so every column is written,
  // including ones a tracklist never carries (ISRCs)
  async storeRecording(mbid, data, { partial = false, full = false } = {}) {
    await this.writeEntity('recordings', mbid, mbMap.recordingRow(data), {
      json: mbMap.RECORDING_JSON_COLUMNS, defaults: mbMap.RECORDING_DEFAULTS, rich: mbMap.RECORDING_RICH_COLUMNS,
      writeAll: full && !partial, fromMb: !partial
    });
    if (!partial) {
      await database.query('UPDATE recordings SET mb_version = 1 WHERE mbid = $1', [mbid]);
    }
  }

  // Derived index of releases.media (counts, metadata browser): rebuilt from the tracklist, never edited.
  // One statement per 500 tracks instead of one per track.
  async storeTracks(rows) {
    const unique = [...new Map(rows.map(t => [t.mbid, t])).values()];   // one row per track id in a statement
    for (let i = 0; i < unique.length; i += 500) {
      const values = [];
      const tuples = unique.slice(i, i + 500).map(t => {
        values.push(t.mbid, t.recording_mbid, t.release_mbid, t.position, t.medium_number, t.title, t.length_ms, JSON.stringify(t.artist_credit));
        const n = values.length;
        return `($${n - 7}, $${n - 6}, $${n - 5}, $${n - 4}, $${n - 3}, $${n - 2}, $${n - 1}, $${n})`;
      });
      await database.query(`
        INSERT INTO tracks (mbid, recording_mbid, release_mbid, position, medium_number, title, length_ms, artist_credit)
        VALUES ${tuples.join(', ')}
        ON CONFLICT (mbid) DO UPDATE SET
          recording_mbid = EXCLUDED.recording_mbid,
          release_mbid = EXCLUDED.release_mbid,
          position = EXCLUDED.position,
          medium_number = EXCLUDED.medium_number,
          title = EXCLUDED.title,
          length_ms = EXCLUDED.length_ms,
          artist_credit = EXCLUDED.artist_credit
      `, values);
    }
  }

  /**
   * Refresh an artist's catalog (the UI's refresh button). It is the same bulk job as every other fetch, queued:
   * the stored copy keeps being served until the new one is complete.
   */
  async refreshArtist(mbid) {
    logger.info(`Refresh of artist ${mbid} queued`);
    await backgroundJobQueue.forceQueueJob('fetch_artist_albums', 'artist', mbid, 10, { via: 'manual' }, null, mbid);
  }

  /**
   * The whole catalog of an artist in a few bulk calls: every release group with its credit, tags, genres, rating and
   * links, then every release of every status with its tracklist. Written through the same store functions as
   * everything else, then checked: the artist is marked complete only when what MusicBrainz reported is what we hold.
   * Any failure throws before the markers are set, and every store is an upsert, so running it again is safe.
   */
  async ingestCatalog(artistMbid, { force = false } = {}) {
    const mb = registry.getProvider('musicbrainz');
    if (!mb) throw new Error('MusicBrainz provider not available');
    const mbOnly = typeof mb.onlyMusicBrainz === 'function' ? mb.onlyMusicBrainz() : mb;

    // The artist record, when it is missing or past its TTL (this is what renews ttl_expires_at)
    const artist = await database.getArtist(artistMbid);
    const wasComplete = !!(artist && artist.catalog_complete_at);   // read before anything is written

    // Past its TTL but nothing added or removed on MusicBrainz: renew the TTL and keep what is stored
    if (!force && await this.catalogUnchanged(artist, mbOnly)) {
      const days = Number(config.get('metadata.ttlDays', 30));
      await database.query('UPDATE artists SET ttl_expires_at = $2 WHERE mbid = $1', [artistMbid, new Date(Date.now() + days * DAY_MS)]);
      await database.query(
        `UPDATE release_groups SET ttl_expires_at = $2
         WHERE mbid IN (SELECT release_group_mbid FROM artist_release_groups WHERE artist_mbid = $1)`,
        [artistMbid, new Date(Date.now() + days * DAY_MS)]);
      logger.info(`Catalog of artist ${artistMbid} unchanged on MusicBrainz (${artist.mb_release_group_count} release groups, ${artist.mb_release_count} releases): TTL renewed`);
      return { groups: artist.mb_release_group_count, releases: artist.mb_release_count, firstTime: false, unchanged: true };
    }

    if (!artist || force || this.isStale(artist) || artist.needs_mb_backfill || artist.catalog_provisional) await this.getArtist(artistMbid);

    // 1. Every release group
    const groupIds = [];
    const groupsBrowse = await mbOnly.browseReleaseGroups(artistMbid, {
      maxTotal: MAX_GROUPS,
      onPage: async page => {
        // A wiki overview is not MusicBrainz data and must survive the store
        const held = await database.query('SELECT mbid, overview FROM release_groups WHERE mbid = ANY($1::uuid[])', [page.map(g => g.id)]);
        const overviews = new Map(held.rows.map(r => [r.mbid, r.overview || '']));
        for (const g of page) {
          if (blocklist.isBlocked('release_group', g.id)) continue;
          await this.storeReleaseGroup(g.id, { ...g, provider: 'musicbrainz', overview: overviews.get(g.id) || '' }, artistMbid, { force: true });
          groupIds.push(g.id);
        }
      }
    });

    // 2. Every release of the artist, any status
    const known = new Set(groupIds);
    const withReleases = new Set();
    const releaseIds = [];
    const recordingsSeen = new Set();
    const store = async page => {
      for (const release of page) {
        // A blocked release, or one of a blocked group, is not stored and does not count towards the check below
        if (blocklist.isBlocked('release', release.id) || (release['release-group'] && blocklist.isBlocked('release_group', release['release-group'].id))) continue;
        await this.ensureGroupOf(release, known);
        await this.storeRelease(release.id, { ...release, provider: 'musicbrainz' }, { recordingsSeen });
        if (release['release-group']) withReleases.add(release['release-group'].id);
        releaseIds.push(release.id);
      }
    };
    const releasesBrowse = await mbOnly.browseReleases({ artist: artistMbid }, { onPage: store });

    // 3. A group the release browse never mentioned is empty on MusicBrainz, or its releases carry another credit:
    //    ask about it once. Groups confirmed on an earlier run are not asked again.
    const silent = groupIds.filter(id => !withReleases.has(id));
    if (silent.length) {
      const confirmed = await database.query(
        'SELECT mbid FROM release_groups WHERE mbid = ANY($1::uuid[]) AND releases_complete_at IS NOT NULL', [silent]);
      const skip = new Set(confirmed.rows.map(r => r.mbid));
      for (const id of silent.filter(id => !skip.has(id))) {
        await mbOnly.browseReleases({ releaseGroup: id }, { onPage: store });
      }
    }

    // 4. Check what is stored against what arrived, then mark
    const expected = new Set(releaseIds).size;
    const stored = releaseIds.length
      ? (await database.query('SELECT count(*)::int AS n FROM releases WHERE mbid = ANY($1::uuid[])', [[...new Set(releaseIds)]])).rows[0].n
      : 0;
    if (stored !== expected) throw new Error(`Catalog check failed for ${artistMbid}: ${stored} of ${expected} releases stored`);

    await database.query('UPDATE release_groups SET releases_complete_at = NOW() WHERE mbid = ANY($1::uuid[])', [groupIds]);
    // The totals MusicBrainz reported are kept, so the next time the TTL runs out two counts can show whether anything changed
    await database.query(
      `UPDATE artists SET catalog_complete_at = NOW(), catalog_verified_at = NOW(), catalog_provisional = FALSE,
                          catalog_full_at = NOW(), mb_release_group_count = $2, mb_release_count = $3
       WHERE mbid = $1`,
      [artistMbid, groupsBrowse && Number.isInteger(groupsBrowse.total) ? groupsBrowse.total : null,
        releasesBrowse && Number.isInteger(releasesBrowse.total) ? releasesBrowse.total : null]);
    logger.info(`Catalog of artist ${artistMbid} stored and checked: ${groupIds.length} release groups, ${expected} releases`);
    return { groups: groupIds.length, releases: expected, firstTime: !wasComplete };
  }

  /**
   * May a failed catalog fetch be answered from a Lidarr metadata upstream instead? Only when MusicBrainz could not be
   * reached (a retryable failure, twice in a row), an upstream is configured, and we hold no catalog for the artist
   * yet (a stored one keeps serving; it is never replaced by upstream data).
   */
  async upstreamFallbackAllowed(artistMbid, error, attempts) {
    if (!BaseProvider.isRetryableError(error) || attempts < FALLBACK_AFTER_ATTEMPTS) return false;
    const mb = registry.getProvider('musicbrainz');
    if (!mb || typeof mb.hasUpstreams !== 'function' || !mb.hasUpstreams()) return false;
    const artist = await database.getArtist(artistMbid);
    return !(artist && artist.catalog_complete_at);
  }

  /**
   * The catalog from the Lidarr metadata upstreams, for when MusicBrainz cannot answer. They serve a whole album per
   * call, so this is one call for the artist and one per album. What it stores is provisional: complete enough for
   * Lidarr to list and import (so it is marked complete), but never verified against MusicBrainz and missing what an
   * upstream cannot supply. Every row is flagged for backfill, the artist is marked provisional, and the verified
   * fetch replaces all of it once MusicBrainz answers again.
   */
  async ingestCatalogFromUpstream(artistMbid) {
    const mb = registry.getProvider('musicbrainz');
    if (!mb || typeof mb.onlyUpstreams !== 'function') throw new Error('No upstream source available');
    const upstream = mb.onlyUpstreams();

    let artist = await database.getArtist(artistMbid);
    if (!artist) {
      await this.storeArtist(artistMbid, await upstream.getArtist(artistMbid), true);
      artist = await database.getArtist(artistMbid);
    }

    const listed = await upstream.getArtistAlbums(artistMbid);
    if (listed.length > MAX_GROUPS) {
      throw Object.assign(new Error(`Upstream: artist ${artistMbid} has ${listed.length} release groups, over the limit of ${MAX_GROUPS}`), { overLimit: true });
    }
    const albums = listed.filter(a => !blocklist.isBlocked('release_group', a.id));

    // A release group of the artist's own list carries no credit: it is the artist's
    const credit = [{ artist: { id: artistMbid, name: artist ? artist.name : '', disambiguation: '' }, name: artist ? artist.name : '', joinphrase: '' }];
    for (const album of albums) {
      await this.storeReleaseGroup(album.id, { ...album, 'artist-credit': album['artist-credit'] && album['artist-credit'].length ? album['artist-credit'] : credit }, artistMbid, { full: false });
    }

    let releases = 0;
    for (const album of albums) {
      await this.storeReleaseGroup(album.id, await upstream.getReleaseGroup(album.id), artistMbid, { force: true });
      for (const stub of await upstream.getReleasesByReleaseGroup(album.id)) {
        if (blocklist.isBlocked('release', stub.id)) continue;
        await this.storeRelease(stub.id, await upstream.getRelease(stub.id));
        releases++;
      }
    }

    await database.query('UPDATE release_groups SET releases_complete_at = NOW() WHERE mbid = ANY($1::uuid[])', [albums.map(a => a.id)]);
    await database.query('UPDATE artists SET catalog_complete_at = NOW(), catalog_verified_at = NULL, catalog_provisional = TRUE WHERE mbid = $1', [artistMbid]);
    logger.warn(`Catalog of artist ${artistMbid} taken from an upstream (MusicBrainz could not answer): ${albums.length} release groups, ${releases} releases, provisional`);
    return { groups: albums.length, releases };
  }

  /**
   * Is this artist, now past its TTL, unchanged on MusicBrainz? Two requests for one item each give the totals of release
   * groups and releases MusicBrainz lists for the artist; if both are what the last full fetch recorded, nothing was
   * added or removed and the whole catalog need not be fetched again. Never answers yes for an artist that has no recorded
   * counts, is provisional or marked for backfill, is not yet past its TTL, or whose catalog was last fetched in full more
   * than `metadata.fullRefreshDays` ago (the backstop for edits that do not change the counts).
   */
  async catalogUnchanged(artist, mbOnly) {
    if (!artist || !artist.catalog_verified_at || artist.catalog_provisional || artist.needs_mb_backfill) return false;
    if (!this.isStale(artist)) return false;
    if (!Number.isInteger(artist.mb_release_group_count) || !Number.isInteger(artist.mb_release_count) || !artist.catalog_full_at) return false;
    const backstopMs = Number(config.get('metadata.fullRefreshDays', 180)) * DAY_MS;
    if (!(backstopMs > 0) || Date.now() - new Date(artist.catalog_full_at).getTime() >= backstopMs) return false;

    const groups = await mbOnly.countReleaseGroups(artist.mbid);
    if (groups !== artist.mb_release_group_count) return false;
    const releases = await mbOnly.countReleases(artist.mbid);
    return releases === artist.mb_release_count;
  }

  // A release can belong to a group the artist's own list does not hold (the group is credited to someone else):
  // keep a stub of that group so the release has a parent. Its own full release list is fetched if it is ever asked for.
  async ensureGroupOf(release, known) {
    const group = release['release-group'];
    if (!group || known.has(group.id)) return;
    if (!(await this.checkReleaseGroupExists(group.id))) {
      const credit = release['artist-credit'] || [];
      await this.storeReleaseGroup(group.id,
        { ...group, 'artist-credit': group['artist-credit'] || credit, provider: 'musicbrainz' },
        credit.length ? credit[0].artist.id : null, { full: false });
    }
    known.add(group.id);
  }

  /**
   * Does this artist's catalog need fetching? When it is missing or past its TTL, or when it came from an upstream
   * because MusicBrainz was down (provisional). An artist served from before the bulk fetch existed (complete, but
   * unverified) waits for its TTL like any other, so an upgrade is not a burst.
   */
  async catalogDue(mbid) {
    const artist = await database.getArtist(mbid);
    return !artist || !artist.catalog_complete_at || this.isStale(artist) || !!artist.catalog_provisional;
  }

  /**
   * An artist that is in Lidarr but whose covers were never looked up (its catalog was fetched while it was only a
   * preview, and images are fetched only for artists in Lidarr). False when the integration is off (nothing was held
   * back), when Lidarr cannot say, or once the artist and its albums have been looked up.
   */
  async imagesDue(mbid) {
    if (!lidarrClient.enabled) return false;
    if (!backgroundJobQueue.hasArtistImageProvider() && !backgroundJobQueue.hasAlbumImageProvider()) return false;
    if ((await lidarrClient.isInLidarr(mbid)) !== true) return false;
    if (backgroundJobQueue.hasArtistImageProvider() && await backgroundJobQueue.artistNeedsImages(mbid)) return true;
    if (!backgroundJobQueue.hasAlbumImageProvider()) return false;
    return (await backgroundJobQueue.albumsNeedingImages(await this.getArtistReleaseGroups(mbid))).length > 0;
  }

  /**
   * Lidarr scans a library album by album, long before it asks for the artist. The first album we see for an artist
   * whose catalog is not complete starts that artist's catalog job, so the rest of its albums are answered from the
   * tables. Never delays or fails the album reply: it is called without waiting, and errors are only logged.
   */
  async queueCatalogForAlbum(rgMbid) {
    try {
      const group = await database.getReleaseGroup(rgMbid);
      let credit = group && group.artist_credit;
      if (typeof credit === 'string') credit = JSON.parse(credit);
      const artistMbid = credit && credit[0] && credit[0].artist && credit[0].artist.id;
      if (!artistMbid || blocklist.isBlocked('artist', artistMbid) || blocklist.isBlocked('release_group', rgMbid)) return;
      if (Date.now() - (this.catalogQueuedAt.get(artistMbid) || 0) < CATALOG_QUEUE_THROTTLE_MS) return;
      if (!(await this.catalogDue(artistMbid))) return;
      // An artist that is only a credit on an album Lidarr asked for (a collaborator, a tribute subject) does not get its
      // whole catalog fetched. Confirmed not in Lidarr = skip; unknown (Lidarr off or unreachable) = proceed as before.
      if ((await lidarrClient.isInLidarr(artistMbid)) === false) {
        logger.info(`Album ${rgMbid}: artist ${artistMbid} is not in Lidarr, catalog not queued`);
        return;
      }
      this.catalogQueuedAt.set(artistMbid, Date.now());
      await backgroundJobQueue.forceQueueJob('fetch_artist_albums', 'artist', artistMbid, 1, { via: `album-credit:${rgMbid}` }, null, artistMbid);
      logger.info(`Album ${rgMbid}: catalog of artist ${artistMbid} queued`);
    } catch (error) {
      logger.warn(`Album ${rgMbid}: could not queue the artist catalog: ${error.message}`);
    }
  }

  /**
   * Single entry point for artist metadata, for a Lidarr artist request. Only the artist record is waited for (one
   * call, and only for an artist we have never seen); release groups and releases arrive with the catalog job, in
   * bulk, and a stale artist keeps being served while that job refreshes it. `served`, when given, receives `how`:
   * what the reply was made from, for the dashboard's request card.
   */
  async ensureArtist(mbid, served = {}) {
    if (blocklist.isBlocked('artist', mbid)) {
      logger.info(`ensureArtist: skipping blocked entity ${mbid}`);
      served.how = 'blocked';
      return lidarr.formatArtist(mbid).catch(async () => lidarr.blockedArtist(mbid, await blocklist.nameOf('artist', mbid)));
    }

    const mbProvider = registry.getProvider('musicbrainz');
    if (!mbProvider) throw new Error('MusicBrainz provider not available');

    const artist = await database.getArtist(mbid);
    if (!artist) {
      logger.info(`Artist ${mbid} not in DB, fetching from MusicBrainz`);
      await this.getArtist(mbid);
      served.how = 'fetched from MusicBrainz';
    } else {
      served.how = this.isStale(artist) ? 'stale copy, refreshing' : 'from cache';
      logger.info(`Artist ${mbid} found in DB — ${this.isStale(artist) ? 'TTL expired, serving the stored copy while the catalog refreshes' : 'TTL valid, serving from cache'}`);
      logger.debug(`Artist ${mbid} TTL expires: ${artist.ttl_expires_at}`);
    }

    return lidarr.formatArtist(mbid);
  }

  /**
   * Single entry point for album metadata, for a Lidarr album request.
   * A group whose releases are all stored is answered from the tables. Otherwise every release MusicBrainz lists for it
   * (any status, no cap) is fetched in as many pages as it takes, so the first reply is complete.
   * Requests for one group that overlap share a single run.
   */
  async ensureAlbum(mbid, force = false) {
    const key = `${mbid}:${force}`;
    if (!this.albumFlights.has(key)) {
      this.albumFlights.set(key, this._ensureAlbum(mbid, force).finally(() => this.albumFlights.delete(key)));
    }
    return this.albumFlights.get(key);
  }

  async _ensureAlbum(mbid, force) {
    if (blocklist.isBlocked('release_group', mbid)) throw Object.assign(new Error(`Album ${mbid} is blocked`), { blocked: true });
    const mbProvider = registry.getProvider('musicbrainz');
    if (!mbProvider) throw new Error('MusicBrainz provider not available');
    const mbOnly = typeof mbProvider.onlyMusicBrainz === 'function' ? mbProvider.onlyMusicBrainz() : mbProvider;

    const album = await database.getReleaseGroup(mbid);
    if (!force && album && album.releases_complete_at) {
      logger.info(`Album ${mbid} complete — serving from cache`);
      return { formatted: await lidarr.formatAlbum(mbid), needsFullFetch: false, served: 'from cache' };
    }

    // The artist's catalog job is running and stores this group's releases along with all the others: wait for it
    // (a bounded time) rather than fetch this group's releases alone, once per album of the artist
    if (!force && album && await this._awaitCatalogJob(mbid, album)) {
      logger.info(`Album ${mbid} completed by its artist's catalog job — serving from cache`);
      return { formatted: await lidarr.formatAlbum(mbid), needsFullFetch: false, served: 'from cache' };
    }

    // The group itself, when we hold nothing or only a stub of it
    if (!album || album.mb_version !== 1 || force) {
      logger.info(`Album ${mbid} ${album ? 'is not complete' : 'not in DB'}, fetching from MusicBrainz`);
      const data = await mbProvider.getReleaseGroup(mbid);
      const credit = data['artist-credit'] || [];
      await this.storeReleaseGroup(mbid, { ...data, overview: (album && album.overview) || '' },
        credit.length > 0 ? credit[0].artist.id : null, { force: true });

      // Now the artist is known: if its catalog job is running, that job brings this group's releases
      if (!force && await this._awaitCatalogJob(mbid, { artist_credit: credit })) {
        logger.info(`Album ${mbid} completed by its artist's catalog job — serving from cache`);
        return { formatted: await lidarr.formatAlbum(mbid), needsFullFetch: false, served: 'fetched from MusicBrainz' };
      }
    }

    const recordingsSeen = new Set();
    await mbOnly.browseReleases({ releaseGroup: mbid }, {
      onPage: async page => {
        for (const release of page) await this.storeRelease(release.id, { ...release, provider: 'musicbrainz' }, { recordingsSeen });
      }
    });
    await database.query('UPDATE release_groups SET releases_complete_at = NOW() WHERE mbid = $1', [mbid]);

    return { formatted: await lidarr.formatAlbum(mbid), needsFullFetch: false, served: 'fetched from MusicBrainz' };
  }

  /**
   * True once the group's releases are complete because the artist's catalog job stored them. Returns false at once when
   * there is no such job (or it ends without covering the group), and after albumWaitMs when it is still running.
   */
  async _awaitCatalogJob(rgMbid, album) {
    let credit = album.artist_credit;
    if (typeof credit === 'string') credit = JSON.parse(credit);
    const artistMbid = credit && credit[0] && credit[0].artist && credit[0].artist.id;
    if (!artistMbid || !(await backgroundJobQueue.isCatalogJobActive(artistMbid))) return false;

    logger.info(`Album ${rgMbid}: waiting for the catalog job of artist ${artistMbid}`);
    const deadline = Date.now() + this.albumWaitMs;
    for (;;) {
      const row = await database.query('SELECT releases_complete_at FROM release_groups WHERE mbid = $1', [rgMbid]);
      if (row.rows[0] && row.rows[0].releases_complete_at) return true;
      if (Date.now() >= deadline || !(await backgroundJobQueue.isCatalogJobActive(artistMbid))) return false;
      await new Promise(resolve => setTimeout(resolve, this.albumWaitPollMs));
    }
  }

  // Formatting removed - use lidarr.js formatArtist() instead
}

module.exports = new ArtistService();