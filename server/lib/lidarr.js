const database = require('../sql/database');
const { logger } = require('./logger');

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
    const aliases = this.parseJson(artist.aliases);
    const genres = this.parseJson(artist.genres);

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
    const aliases = this.parseJson(artist.aliases);
    const genres = this.parseJson(artist.genres);

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
      'SELECT entity_mbid, link_type, url FROM links WHERE entity_type = $1 AND entity_mbid = ANY($2)',
      [entityType, mbids]
    );
    const map = new Map();
    result.rows.forEach(row => {
      if (!map.has(row.entity_mbid)) map.set(row.entity_mbid, []);
      map.get(row.entity_mbid).push({ target: row.url, type: row.link_type });
    });
    return map;
  }

  async getImagesBatch(entityType, mbids) {
    if (!mbids.length) return new Map();
    const serverUrl = this.getServerUrl();
    const path = require('path');
    const result = await database.query(
      'SELECT entity_mbid, url, cover_type, cached, local_path FROM images WHERE entity_type = $1 AND entity_mbid = ANY($2)',
      [entityType, mbids]
    );
    const map = new Map();
    result.rows.forEach(row => {
      if (!map.has(row.entity_mbid)) map.set(row.entity_mbid, []);
      const url = row.cached && row.local_path
        ? `${serverUrl}/api/images/${entityType}/${row.entity_mbid}/${path.basename(row.local_path)}`
        : row.url;
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
    const genres = this.parseJson(releaseGroup.genres);

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
            artistaliases: this.parseJson(a.aliases) || [],
            artistname: a.name,
            disambiguation: a.disambiguation || '',
            genres: (this.parseJson(a.genres) || []).map(g => this.toTitleCase(g)),
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
          artistMap.set(id, {
            artistaliases: [], artistname: id, disambiguation: '',
            genres: [], id: id, images: [], links: [], oldids: [],
            overview: '', rating: { Count: 0, Value: null },
            sortname: id, status: 'active', type: null
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
          artistaliases: this.parseJson(primaryArtist.aliases) || [],
          artistname: primaryArtist.name,
          disambiguation: primaryArtist.disambiguation || '',
          genres: (this.parseJson(primaryArtist.genres) || []).map(g => this.toTitleCase(g)),
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
      }
    }

    // Return all artists — album-level credits + track-level credits
    const artists = [...artistMap.values()];

    // Return with lowercase fields — alphabetical order matching oldLMD exactly
    const releasedate = releaseGroup.first_release_date
      ? (releaseGroup.first_release_date instanceof Date
          ? releaseGroup.first_release_date.toISOString().split('T')[0]
          : String(releaseGroup.first_release_date).split('T')[0])
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
      SELECT link_type, url
      FROM links
      WHERE entity_type = $1 AND entity_mbid = $2
      ORDER BY link_type
    `, [entityType, entityMbid]);

    return (result.rows || []).map(link => ({
      target: link.url,
      type: link.link_type
    }));
  }

  async getImagesForEntity(entityType, entityMbid) {
    const result = await database.query(`
      SELECT url, cover_type, cached, local_path
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

    return (result.rows || []).map(image => {
      // If image is cached locally, return local URL
      if (image.cached && image.local_path) {
        const path = require('path');
        const filename = path.basename(image.local_path);
        const localUrl = `${serverUrl}/api/images/${entityType}/${entityMbid}/${filename}`;
        
        return {
          CoverType: image.cover_type,
          Url: localUrl
        };
      }
      
      // Otherwise return external URL as fallback
      return {
        CoverType: image.cover_type,
        Url: image.url
      };
    });
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
    // Only return albums after fetch_artist_albums job has completed.
    // Until then return empty list — Lidarr adds artist with zero albums.
    // fetchArtistAlbums runs ensureAlbum for every release group, gets correct
    // artist_credit from MB, then triggers a Lidarr refresh. Ghost albums
    // never reach Lidarr because their artistid points to a different artist.
    const jobDone = await database.query(
      `SELECT 1 FROM metadata_jobs
       WHERE job_type = 'fetch_artist_albums'
       AND entity_mbid = $1
       AND status = 'completed'
       LIMIT 1`,
      [artistMbid]
    );
    if (jobDone.rows.length === 0) {
      logger.info(`getAlbumsForArtist ${artistMbid}: fetch_artist_albums not yet complete — returning empty list`);
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
      ORDER BY rg.first_release_date DESC NULLS LAST, rg.title
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
      ORDER BY release_date ASC NULLS LAST, country, title
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
        releasedate: release.release_date
          ? (release.release_date instanceof Date
              ? release.release_date.toISOString().split('T')[0]
              : String(release.release_date).split('T')[0])
          : '0001-01-01',
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
