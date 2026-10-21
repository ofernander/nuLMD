/**
 * Loads one entity for a /ws/2 lookup: from the tables when they hold complete, fresh MusicBrainz data,
 * otherwise from MusicBrainz (never from a Lidarr metadata upstream, whose data is partial) and stored first.
 * If a refresh fails but we already hold full data, the stale copy is served instead of an error.
 */
const { logger } = require('../logger');
const { NegativeCache } = require('./negativeCache');
const blocklist = require('../blocklist');

const isNotFound = err => !!(err && err.message && /not found/i.test(err.message));

class WsLookup {
  constructor({ database, metaHandler, registry, config }) {
    this.database = database;
    this.meta = metaHandler;
    this.registry = registry;
    this.config = config;
    this.inflight = new Map();      // concurrent requests for one entity share a single fetch
    this.isrcChecked = new Set();   // recordings we already asked MusicBrainz for ISRCs this run
    this.negatives = new NegativeCache(config);   // entities MusicBrainz recently said do not exist
  }

  mb() {
    const provider = this.registry.getProvider('musicbrainz');
    if (!provider) throw new Error('MusicBrainz provider not available');
    return typeof provider.onlyMusicBrainz === 'function' ? provider.onlyMusicBrainz() : provider;
  }

  shared(key, fn) {
    if (!this.inflight.has(key)) this.inflight.set(key, fn().finally(() => this.inflight.delete(key)));
    return this.inflight.get(key);
  }

  isStale(row) {
    return !row.ttl_expires_at || new Date(row.ttl_expires_at) < new Date();
  }

  // An MBID MusicBrainz has merged into another one answers as the new entity
  async redirected(mbid) {
    const r = await this.database.query('SELECT new_mbid FROM mbid_redirects WHERE old_mbid = $1', [mbid]);
    return r.rows.length ? r.rows[0].new_mbid : mbid;
  }

  async noteRedirect(oldMbid, data, type) {
    if (!data || !data.id || data.id === oldMbid) return oldMbid;
    await this.database.query(
      'INSERT INTO mbid_redirects (old_mbid, new_mbid, entity_type) VALUES ($1, $2, $3) ON CONFLICT (old_mbid) DO UPDATE SET new_mbid = EXCLUDED.new_mbid',
      [oldMbid, data.id, type]
    );
    logger.info(`ws/2: ${type} ${oldMbid} is now ${data.id}`);
    return data.id;
  }

  async refresh(type, mbid, row, fetchAndStore) {
    const key = `${type}:${mbid}`;
    const refused = this.negatives.recall(key);
    if (refused) throw refused;
    try {
      return await this.shared(key, fetchAndStore);
    } catch (err) {
      // Keep serving what we have when MusicBrainz is just unavailable; a missing entity stays missing
      if (row && row.mb_version === 1 && !isNotFound(err)) {
        logger.warn(`ws/2: refreshing ${type} ${mbid} failed (${err.message}), serving stored copy`);
        return mbid;
      }
      this.negatives.remember(key, err);
      throw err;
    }
  }

  // A blocked entity is answered as not found, and never fetched or stored
  refuseBlocked(type, mbid) {
    if (blocklist.isBlocked(type, mbid)) throw new Error(`${type} ${mbid} not found (blocked)`);
  }

  async artist(requested) {
    this.refuseBlocked('artist', requested);
    let mbid = await this.redirected(requested);
    this.refuseBlocked('artist', mbid);
    let row = await this.database.getArtist(mbid);
    const fetched = !row || row.mb_version !== 1 || this.isStale(row);
    if (fetched) {
      mbid = await this.refresh('artist', mbid, row, async () => {
        const data = await this.mb().getArtist(mbid);
        const id = await this.noteRedirect(mbid, data, 'artist');
        const current = id === mbid ? row : await this.database.getArtist(id);
        await this.meta.storeArtist(id, { ...data, overview: (current && current.overview) || '' }, true);
        return id;
      });
      this.refuseBlocked('artist', mbid);   // a merge can land on a blocked id
      row = await this.database.getArtist(mbid);
    }
    const relations = await this.relations('artist', mbid);
    return { row, relations, fetched };
  }

  async releaseGroup(requested) {
    this.refuseBlocked('release_group', requested);
    let mbid = await this.redirected(requested);
    this.refuseBlocked('release_group', mbid);
    let row = await this.database.getReleaseGroup(mbid);
    const fetched = !row || row.mb_version !== 1 || this.isStale(row);
    if (fetched) {
      mbid = await this.refresh('release-group', mbid, row, async () => {
        const data = await this.mb().getReleaseGroup(mbid);
        const id = await this.noteRedirect(mbid, data, 'release_group');
        const current = id === mbid ? row : await this.database.getReleaseGroup(id);
        const credit = data['artist-credit'] || [];
        await this.meta.storeReleaseGroup(id, { ...data, overview: (current && current.overview) || '' },
          credit.length ? credit[0].artist.id : null, { force: true });
        return id;
      });
      this.refuseBlocked('release_group', mbid);
      row = await this.database.getReleaseGroup(mbid);
    }
    const relations = await this.relations('release_group', mbid);
    return { row, relations, fetched };
  }

  async release(requested) {
    this.refuseBlocked('release', requested);
    let mbid = await this.redirected(requested);
    this.refuseBlocked('release', mbid);
    const get = async id => (await this.database.query('SELECT * FROM releases WHERE mbid = $1', [id])).rows[0];
    let row = await get(mbid);
    const fetched = !row || row.mb_version !== 1;
    if (fetched) {
      mbid = await this.refresh('release', mbid, row, async () => {
        const data = await this.mb().getRelease(mbid);
        const id = await this.noteRedirect(mbid, data, 'release');
        const rg = data['release-group'];
        this.refuseBlocked('release_group', rg && rg.id);
        this.refuseBlocked('release', id);
        if (rg && rg.id && !(await this.database.getReleaseGroup(rg.id))) {
          const credit = data['artist-credit'] || [];
          await this.meta.storeReleaseGroup(rg.id, { ...rg, 'artist-credit': rg['artist-credit'] || credit },
            credit.length ? credit[0].artist.id : null, { full: false });
        }
        await this.meta.storeRelease(id, data);
        return id;
      });
      row = await get(mbid);
    }
    const releaseGroup = await this.database.getReleaseGroup(row.release_group_mbid);
    return { row, releaseGroup, fetched };
  }

  async recording(requested, wantsIsrcs) {
    let mbid = await this.redirected(requested);
    const get = async id => (await this.database.query('SELECT * FROM recordings WHERE mbid = $1', [id])).rows[0];
    let row = await get(mbid);
    const needsIsrcs = wantsIsrcs && row && (!row.isrcs || row.isrcs.length === 0) && !this.isrcChecked.has(mbid);
    const fetched = !row || row.mb_version !== 1 || needsIsrcs;
    if (fetched) {
      mbid = await this.refresh('recording', mbid, row, async () => {
        const data = await this.mb().getRecording(mbid);
        const id = await this.noteRedirect(mbid, data, 'recording');
        await this.meta.storeRecording(id, data, { full: true });
        this.isrcChecked.add(id);
        return id;
      });
      row = await get(mbid);
    }
    return { row, fetched };
  }

  async relations(entityType, mbid) {
    return (await this.database.query(
      'SELECT * FROM relations WHERE entity_type = $1 AND entity_mbid = $2 ORDER BY type, url', [entityType, mbid])).rows;
  }
}

module.exports = { WsLookup, isNotFound };
