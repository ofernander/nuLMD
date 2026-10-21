const database = require('../sql/database');
const { logger } = require('./logger');
const blocklist = require('./blocklist');

/**
 * LidarrFormatter - Complete translation from MusicBrainz format to Lidarr format
 *
 * This formatter translates ALL fields from our MusicBrainz-format database to the exact
 * format old LMD returned. We provide every field that old LMD had, even if Lidarr doesn't
 * use all of them. This ensures maximum compatibility.
 */
class LidarrFormatter {

  async formatArtistForAlbum(mbid) {
    // Format artist for embedding in album responses - uses LOWERCASE fields
    const artist = await database.getArtist(mbid);
    if (!artist) {
      throw new Error(`Artist ${mbid} not found`);
    }

    const links = await this.getLinksForEntity('artist', mbid);
    const images = await this.getImagesForEntity('artist', mbid);

    // Parse JSON fields
    const aliases = this.aliasNames(artist.aliases);
    const genres = this.genreNames(artist.genres);

    // Return with LOWERCASE field names (old LMD format for nested artists)
    return {
      artistaliases: aliases || [],
      artistname: artist.name,
      disambiguation: artist.disambiguation || '',
      genres: (genres || []).map(g => this.toTitleCase(g)),
      id: artist.mbid,
      images: images || [],
      links: links || [],
      oldids: [],
      overview: artist.overview || '',
      rating: artist.rating ? { Count: 0, Value: parseFloat(artist.rating) } : { Count: 0, Value: null },
      sortname: artist.sort_name,
      status: artist.ended ? 'ended' : 'active',
      type: artist.type || null
    };
  }

  async formatArtist(mbid) {
    const artist = await database.getArtist(mbid);
    if (!artist) {
      throw new Error(`Artist ${mbid} not found`);
    }

    const links = await this.getLinksForEntity('artist', mbid);
    const images = await this.getImagesForEntity('artist', mbid);
    const albums = await this.getAlbumsForArtist(mbid);

    // Parse JSON fields
    const aliases = this.aliasNames(artist.aliases);
    const genres = this.genreNames(artist.genres);

    // Return ALL fields that old LMD returned (lowercase top-level, PascalCase Albums)
    return {
      Albums: albums || [],
      artistaliases: aliases || [],
      artistname: artist.name,
      disambiguation: artist.disambiguation || '',
      genres: (genres || []).map(g => this.toTitleCase(g)),
      id: artist.mbid,
      images: images || [],
      links: links || [],
      oldids: [],
      overview: artist.overview || '',
      rating: artist.rating ? { Count: 0, Value: parseFloat(artist.rating) } : { Count: 0, Value: null },
      sortname: artist.sort_name,
      status: artist.ended ? 'ended' : 'active',
      type: artist.type || null
    };
  }

  // What Lidarr is sent for an artist nuLMD will not hold (a blocked one): its identity and no albums
  blockedArtist(mbid, name) {
    return {
      Albums: [], artistaliases: [], artistname: name || 'Blocked artist', disambiguation: '', genres: [],
      id: mbid, images: [], links: [], oldids: [], overview: '', rating: { Count: 0, Value: null },
      sortname: name || 'Blocked artist', status: 'active', type: null
    };
  }

  // Placeholder image so Lidarr always has something to show for a not-yet-cached entity.
  placeholderImages(type = 'Poster') {
    return [{ CoverType: type, Url: `${this.getServerUrl()}/assets/placeholder.png` }];
  }

  // Pad partial MB dates (YYYY, YYYY-MM) to full YYYY-MM-DD — matches what the store
  // path writes to the DATE column. Lidarr deserializes releasedate as DateTime and
  // rejects a partial like "2010", which fails the whole search response.
  _fullReleaseDate(d) {
    if (!d) return '0001-01-01';
    const s = String(d).split('T')[0];
    if (/^\d{4}$/.test(s)) return `${s}-01-01`;
    if (/^\d{4}-\d{2}$/.test(s)) return `${s}-01`;
    return s;
  }

  // Lightweight artist from a search result {id,name,sortName,disambiguation,type}.
  // Same shape as formatArtist minus Albums (search strips Albums anyway). No MB fetch —
  // full ingestion happens later when Lidarr looks up the picked artist via /artist/:mbid.
  formatArtistLight(sr) {
    return {
      artistaliases: [],
      artistname: sr.name || '',
      disambiguation: sr.disambiguation || '',
      genres: [],
      id: sr.id,
      images: this.placeholderImages(),
      links: [],
      oldids: [],
      overview: '',
      rating: { Count: 0, Value: null },
      sortname: sr.sortName || sr.name || '',
      status: 'active',
      type: (sr.type && sr.type !== 'Unknown') ? sr.type : null
    };
  }

  // Lightweight album from a search result {id,title,disambiguation,primaryType,
  // secondaryTypes,firstReleaseDate,artistCredit}. Includes the primary artist in `artists`
  // so Tubifarry won't throw KeyNotFoundException. No MB fetch.
  formatAlbumLight(sr) {
    const ac = sr.artistCredit || [];
    const primary = (ac[0] && ac[0].artist) || {};
    const artistId = primary.id || '';
    const artistName = primary.name || (ac[0] && ac[0].name) || '';
    const artists = artistId ? [{
      artistaliases: [], artistname: artistName, disambiguation: primary.disambiguation || '',
      genres: [], id: artistId, images: [], links: [], oldids: [],
      overview: '', rating: { Count: 0, Value: null },
      sortname: artistName, status: 'active', type: null
    }] : [];
    return {
      aliases: [],
      artistid: artistId,
      artists,
      disambiguation: sr.disambiguation || '',
      genres: [],
      id: sr.id,
      images: this.placeholderImages(),
      links: [],
      oldids: [],
      overview: '',
      rating: { Count: 0, Value: null },
      releasedate: this._fullReleaseDate(sr.firstReleaseDate),
      releases: [],
      secondarytypes: sr.secondaryTypes || [],
      title: sr.title || '',
      type: sr.primaryType || 'Other'
    };
  }

  // Which of these release-group MBIDs are already stored (so search can format from DB).
  async getReleaseGroupsPresent(mbids) {
    if (!mbids.length) return new Set();
    const result = await database.query(
      'SELECT mbid FROM release_groups WHERE mbid = ANY($1)',
      [mbids]
    );
    return new Set(result.rows.map(row => row.mbid));
  }

  async getArtistsBatch(mbids) {
    if (!mbids.length) return new Map();
    const result = await database.query(
      'SELECT * FROM artists WHERE mbid = ANY($1)',
      [mbids]
    );
    return new Map(result.rows.map(a => [a.mbid, a]));
  }

  async getLinksBatch(entityType, mbids) {
    if (!mbids.length) return new Map();
    const result = await database.query(
      'SELECT entity_mbid, type, url FROM relations WHERE entity_type = $1 AND entity_mbid = ANY($2) AND url IS NOT NULL',
      [entityType, mbids]
    );
    const map = new Map();
    result.rows.forEach(row => {
      if (!map.has(row.entity_mbid)) map.set(row.entity_mbid, []);
      map.get(row.entity_mbid).push({ target: row.url, type: row.type });
    });
    return map;
  }

  async getImagesBatch(entityType, mbids) {
    if (!mbids.length) return new Map();
    const serverUrl = this.getServerUrl();
    const path = require('path');
    const result = await database.query(
      'SELECT entity_mbid, url, cover_type, cached, cache_failed, local_path FROM images WHERE entity_type = $1 AND entity_mbid = ANY($2)',
      [entityType, mbids]
    );
    const map = new Map();
    result.rows.forEach(row => {
      // A cover still waiting to be downloaded is left out (the placeholder stands in): Lidarr must not fetch it from the provider
      if (!row.cached && !row.cache_failed) return;
      const url = row.cached && row.local_path
        ? `${serverUrl}/api/images/${entityType}/${row.entity_mbid}/${path.basename(row.local_path)}`
        : row.url;
      // Skip empty URLs — Lidarr HEADs cover URLs and errors on a blank one.
      if (!url || String(url).trim() === '') return;
      if (!map.has(row.entity_mbid)) map.set(row.entity_mbid, []);
      map.get(row.entity_mbid).push({ CoverType: row.cover_type, Url: url });
    });
    return map;
  }

  async formatAlbum(mbid) {
    const releaseGroup = await database.getReleaseGroup(mbid);
    if (!releaseGroup) {
      throw new Error(`Album ${mbid} not found`);
    }

    const links = await this.getLinksForEntity('release_group', mbid);
    const images = await this.getImagesForEntity('release_group', mbid);

    // Parse JSON fields
    const artistCredit = this.parseJson(releaseGroup.artist_credit);
    const secondaryTypes = this.parseJson(releaseGroup.secondary_types);
    const genres = this.genreNames(releaseGroup.genres);

    // Extract primary artist ID
    const artistId = artistCredit && artistCredit.length > 0 ? artistCredit[0].artist.id : '';

    // Populate artistMap ONLY from track-level artist IDs (matching oldLMD behavior)
    const artistMap = new Map();
    const releases = await this.getReleasesForAlbum(mbid, null);

    // Collect ALL unique track-level artist IDs
    const trackArtistIds = new Set();
    for (const release of (releases || [])) {
      for (const track of (release.tracks || [])) {
        if (track.artistid) {
          trackArtistIds.add(track.artistid);
        }
      }
    }
    if (trackArtistIds.size > 0) {
      const trackArtistMbids = [...trackArtistIds];
      const trackArtistsMap = await this.getArtistsBatch(trackArtistMbids);
      const trackLinksMap = await this.getLinksBatch('artist', trackArtistMbids);
      const trackImagesMap = await this.getImagesBatch('artist', trackArtistMbids);
      for (const id of trackArtistMbids) {
        const a = trackArtistsMap.get(id);
        if (a) {
          artistMap.set(id, {
            artistaliases: this.aliasNames(a.aliases),
            artistname: a.name,
            disambiguation: a.disambiguation || '',
            genres: this.genreNames(a.genres).map(g => this.toTitleCase(g)),
            id: a.mbid,
            images: trackImagesMap.get(id) || [],
            links: trackLinksMap.get(id) || [],
            oldids: [],
            overview: a.overview || '',
            rating: a.rating ? { Count: 0, Value: parseFloat(a.rating) } : { Count: 0, Value: null },
            sortname: a.sort_name,
            status: a.ended ? 'ended' : 'active',
            type: a.type || null
          });
        } else {
          // Not stored: a blocked artist is named from the blocklist, any other by its id
          const label = blocklist.cachedName('artist', id) || id;
          artistMap.set(id, {
            artistaliases: [], artistname: label, disambiguation: '',
            genres: [], id: id, images: [], links: [], oldids: [],
            overview: '', rating: { Count: 0, Value: null },
            sortname: label, status: 'active', type: null
          });
        }
      }
    }

    // Always ensure the primary album artist is in the map.
    // Some albums (compilations, remix albums) have track-level credits
    // that don't include the primary artist — Tubifarry builds a dictionary
    // keyed by artist ID and throws KeyNotFoundException if the primary artist
    // is missing from the artists array.
    if (artistId && !artistMap.has(artistId)) {
      const primaryArtist = await database.getArtist(artistId);
      if (primaryArtist) {
        const primaryLinks = await this.getLinksForEntity('artist', artistId);
        const primaryImages = await this.getImagesForEntity('artist', artistId);
        artistMap.set(artistId, {
          artistaliases: this.aliasNames(primaryArtist.aliases),
          artistname: primaryArtist.name,
          disambiguation: primaryArtist.disambiguation || '',
          genres: this.genreNames(primaryArtist.genres).map(g => this.toTitleCase(g)),
          id: primaryArtist.mbid,
          images: primaryImages || [],
          links: primaryLinks || [],
          oldids: [],
          overview: primaryArtist.overview || '',
          rating: primaryArtist.rating ? { Count: 0, Value: parseFloat(primaryArtist.rating) } : { Count: 0, Value: null },
          sortname: primaryArtist.sort_name,
          status: primaryArtist.ended ? 'ended' : 'active',
          type: primaryArtist.type || null
        });
      } else if (blocklist.isBlocked('artist', artistId)) {
        // Not stored because it is blocked: the album still has to list its primary artist
        const blocked = this.blockedArtist(artistId, blocklist.cachedName('artist', artistId) || (artistCredit[0] && (artistCredit[0].name || artistCredit[0].artist.name)) || null);
        delete blocked.Albums;
        artistMap.set(artistId, blocked);
      }
    }

    // Return all artists — album-level credits + track-level credits
    const artists = [...artistMap.values()];

    // Return with lowercase fields — alphabetical order matching oldLMD exactly
    const releasedate = releaseGroup.first_release_date
      ? this._fullReleaseDate(releaseGroup.first_release_date)
      : '';

    return {
      aliases: [],
      artistid: artistId,
      artists: artists || [],
      disambiguation: releaseGroup.disambiguation || '',
      genres: (genres || []).map(g => this.toTitleCase(g)),
      id: releaseGroup.mbid,
      images: images || [],
      links: links || [],
      oldids: [],
      overview: releaseGroup.overview || '',
      rating: releaseGroup.rating ? { Count: 0, Value: parseFloat(releaseGroup.rating) } : { Count: 0, Value: null },
      releasedate: releasedate || '0001-01-01',
      releases: releases || [],
      secondarytypes: secondaryTypes || [],
      title: releaseGroup.title,
      type: releaseGroup.primary_type || 'Other'
    };
  }

  async getLinksForEntity(entityType, entityMbid) {
    const result = await database.query(`
      SELECT type, url
      FROM relations
      WHERE entity_type = $1 AND entity_mbid = $2 AND url IS NOT NULL
      ORDER BY type, url
    `, [entityType, entityMbid]);

    return (result.rows || []).map(link => ({
      target: link.url,
      type: link.type
    }));
  }

  async getImagesForEntity(entityType, entityMbid) {
    const result = await database.query(`
      SELECT url, cover_type, cached, cache_failed, local_path
      FROM images
      WHERE entity_type = $1 AND entity_mbid = $2
      ORDER BY cover_type
    `, [entityType, entityMbid]);

    const serverUrl = this.getServerUrl();

    // No images yet — return placeholder so Lidarr shows something
    // while the image pipeline runs in the background
    if (result.rows.length === 0) {
      return [{ CoverType: 'Poster', Url: `${serverUrl}/assets/placeholder.png` }];
    }

    // A cover still waiting to be downloaded is left out, so the placeholder below stands in for it: handing Lidarr the
    // provider's own URL would make Lidarr fetch from there itself. A failed download keeps the external URL as a fallback.
    const mapped = (result.rows || []).filter(image => image.cached || image.cache_failed).map(image => {
      // If image is cached locally, return local URL
      if (image.cached && image.local_path) {
        const path = require('path');
        const filename = path.basename(image.local_path);
        return {
          CoverType: image.cover_type,
          Url: `${serverUrl}/api/images/${entityType}/${entityMbid}/${filename}`
        };
      }

      // Otherwise return external URL as fallback
      return {
        CoverType: image.cover_type,
        Url: image.url
      };
    })
    // Drop entries with an empty/missing URL: newer Lidarr HEAD-checks every
    // cover and throws "Invalid URI: The URI is empty" on a blank RemoteUrl.
    .filter(img => img.Url && String(img.Url).trim() !== '');

    // If every stored row had an empty URL, fall back to the placeholder so
    // Lidarr still receives a valid, non-empty URL.
    if (mapped.length === 0) {
      return [{ CoverType: 'Poster', Url: `${serverUrl}/assets/placeholder.png` }];
    }

    return mapped;
  }

  getServerUrl() {
    const config = require('./config');
    const os = require('os');
    
    // Priority 1: Config file
    const configUrl = config.get('serverUrl');
    if (configUrl) {
      if (!configUrl.startsWith('http://') && !configUrl.startsWith('https://')) {
        return `http://${configUrl}`;
      }
      return configUrl;
    }
    
    // Priority 2: Environment variable
    if (process.env.SERVER_URL) {
      return process.env.SERVER_URL;
    }
    
    // Priority 3: Docker hostname detection
    const hostname = os.hostname();
    if (hostname && hostname !== 'localhost' && !hostname.match(/^[0-9a-f]{12}$/)) {
      // If hostname looks like a Docker service name (not a random hash)
      const port = process.env.PORT || 5001;
      return `http://${hostname}:${port}`;
    }
    
    // Priority 4: Fallback to localhost
    const port = process.env.PORT || 5001;
    return `http://localhost:${port}`;
  }

  async getAlbumsForArtist(artistMbid) {
    // Only return albums once the artist's catalog is complete (every release group, and every release of each,
    // stored and checked by the catalog job). Until then return an empty list: Lidarr adds the artist with zero
    // albums and is asked to refresh when the catalog is ready. The credits arrive with the bulk fetch, so a
    // collaborative release never reaches Lidarr under the wrong artist.
    const done = await database.query(
      'SELECT 1 FROM artists WHERE mbid = $1 AND catalog_complete_at IS NOT NULL',
      [artistMbid]
    );
    if (done.rows.length === 0) {
      logger.info(`getAlbumsForArtist ${artistMbid}: catalog not yet complete — returning empty list`);
      return [];
    }

    const result = await database.query(`
      SELECT
        rg.mbid,
        rg.title,
        rg.primary_type,
        rg.secondary_types,
        rg.first_release_date,
        rg.artist_credit,
        COALESCE(
          (
            SELECT json_agg(DISTINCT COALESCE(r.status, 'Pseudo-Release'))
            FROM releases r
            WHERE r.release_group_mbid = rg.mbid
          ),
          '[]'::json
        ) as release_statuses
      FROM release_groups rg
      JOIN artist_release_groups arg ON arg.release_group_mbid = rg.mbid
      WHERE arg.artist_mbid = $1
      ORDER BY rg.first_release_date DESC NULLS LAST, rg.title, rg.mbid
    `, [artistMbid]);

    const filtered = (result.rows || []).filter(album => {
      const ac = this.parseJson(album.artist_credit);
      return ac && ac.length > 0 && ac[0].artist && ac[0].artist.id === artistMbid;
    });

    logger.info(`getAlbumsForArtist ${artistMbid}: ${result.rows.length} release groups found, ${filtered.length} pass artist_credit[0] filter`);
    logger.debug(`getAlbumsForArtist ${artistMbid}: filtered out ${result.rows.length - filtered.length} collaborative/non-primary albums`);

    return filtered.map(album => {
      const secondaryTypes = this.parseJson(album.secondary_types);
      const releaseStatuses = this.parseJson(album.release_statuses);

      return {
        Id: album.mbid,
        OldIds: [],
        ReleaseStatuses: releaseStatuses || [],
        SecondaryTypes: secondaryTypes || [],
        Title: album.title,
        Type: album.primary_type || 'Other',
      };
    });
  }

  async getReleasesForAlbum(releaseGroupMbid, artistMap = null) {
    const result = await database.query(`
      SELECT
        mbid,
        title,
        status,
        release_date,
        country,
        barcode,
        labels,
        artist_credit,
        media_count,
        track_count,
        disambiguation,
        media
      FROM releases
      WHERE release_group_mbid = $1
      ORDER BY release_date ASC NULLS LAST, country, title, mbid
    `, [releaseGroupMbid]);

    return (result.rows || []).map(release => {
      const media = this.parseJson(release.media);
      const labels = this.parseJson(release.labels);

      const { mediaOutput, allTracks } = this.formatMediaForLidarr(media || [], artistMap);

      // Extract label names
      const labelNames = labels && labels.length > 0
        ? labels.map(l => l.label?.name || '').filter(Boolean)
        : [];

      // Return with LOWERCASE
      return {
        id: release.mbid,
        title: release.title,
        disambiguation: release.disambiguation || '',
        status: release.status || 'Pseudo-Release',
        releasedate: this._fullReleaseDate(release.release_date),
        country: release.country ? [release.country] : [],
        label: labelNames || [],
        media: mediaOutput,
        track_count: release.track_count,
        tracks: allTracks,
        oldids: []
      };
    });
  }

  formatMediaForLidarr(media, artistMap = null) {
    if (!media || !Array.isArray(media)) {
      return { mediaOutput: [], allTracks: [] };
    }

    const mediaOutput = [];
    const allTracks = [];

    for (const medium of media) {
      const mediumNumber = medium.position || 1;
      const mediumFormat = medium.format || 'Unknown';

      // Format tracks
      const tracks = this.formatTracksForLidarr(medium.tracks || [], mediumNumber, artistMap);
      allTracks.push(...tracks);

      // Old LMD media objects only have Format/Name/Position
      mediaOutput.push({
        Format: mediumFormat,
        Name: medium.name || medium.title || '',
        Position: mediumNumber
      });
    }

    return { mediaOutput, allTracks };
  }

  formatTracksForLidarr(tracks, mediumNumber = 1, artistMap = null) {
    if (!tracks || !Array.isArray(tracks)) {
      return [];
    }

    return tracks.map(track => {
      const recording = track.recording || {};
      const artistCredit = track['artist-credit'] || recording['artist-credit'] || [];
      const artistId = artistCredit.length > 0 ? artistCredit[0].artist.id : '';
      const position = parseInt(track.position) || parseInt(track.number) || 0;
      const title = track.title || recording.title || '';
      const duration = track.length || recording.length || 0;
      const recordingId = recording.id || '';

      // Return with LOWERCASE fields (old LMD format)
      return {
        id: track.id,
        trackname: title,
        recordingid: recordingId,
        artistid: artistId,
        durationms: duration,
        tracknumber: String(position),
        trackposition: position,
        mediumnumber: mediumNumber,
        oldids: [],
        oldrecordingids: []
      };
    });
  }

  // Helper to apply title case to a string
  toTitleCase(str) {
    return str.replace(/\b\w/g, c => c.toUpperCase());
  }

  // Helper to parse JSON fields safely
  // Artists store MusicBrainz's alias/genre objects; Lidarr wants plain names (tolerates old bare strings)
  aliasNames(value) {
    return (this.parseJson(value) || []).map(a => (typeof a === 'string' ? a : a && a.name)).filter(Boolean);
  }

  genreNames(value) {
    return (this.parseJson(value) || []).map(g => (typeof g === 'string' ? g : g && g.name)).filter(Boolean);
  }

  parseJson(value) {
    if (!value) return null;
    if (typeof value === 'string') {
      try {
        return JSON.parse(value);
      } catch (e) {
        return null;
      }
    }
    return value;
  }
}

module.exports = new LidarrFormatter();
