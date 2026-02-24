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

    // Create artistMap and populate with album artists — batch fetch (3 queries regardless of artist count)
    const artistMap = new Map();
    if (artistCredit && artistCredit.length > 0) {
      const artistMbids = artistCredit.map(c => c.artist.id);
      const artistsMap = await this.getArtistsBatch(artistMbids);
      const linksMap = await this.getLinksBatch('artist', artistMbids);
      const imagesMap = await this.getImagesBatch('artist', artistMbids);

      for (const credit of artistCredit) {
        const id = credit.artist.id;
        const a = artistsMap.get(id);
        if (a) {
          artistMap.set(id, {
            artistaliases: this.parseJson(a.aliases) || [],
            artistname: a.name,
            disambiguation: a.disambiguation || '',
            genres: (this.parseJson(a.genres) || []).map(g => this.toTitleCase(g)),
            id: a.mbid,
            images: imagesMap.get(id) || [],
            links: linksMap.get(id) || [],
            oldids: [],
            overview: a.overview || '',
            rating: a.rating ? { Count: 0, Value: parseFloat(a.rating) } : { Count: 0, Value: null },
            sortname: a.sort_name,
            status: a.ended ? 'ended' : 'active',
            type: a.type || null
          });
        } else {
          // Fallback if artist not in DB — use data from artist_credit on the release group
          artistMap.set(id, {
            artistaliases: [],
            artistname: credit.artist.name,
            disambiguation: credit.artist.disambiguation || '',
            genres: [],
            id: id,
            images: [],
            links: [],
            oldids: [],
            overview: '',
            rating: { Count: 0, Value: null },
            sortname: credit.artist['sort-name'] || credit.artist.name || '',
            status: 'active',
            type: null
          });
        }
      }
    }
    const releases = await this.getReleasesForAlbum(mbid, null);

    // Convert artistMap to array
    const artists = Array.from(artistMap.values());

    // Return with lowercase fields (old LMD format)
    return {
      id: releaseGroup.mbid,

      // Present in oldLMD responses
      type: releaseGroup.primary_type || 'Album',
      secondarytypes: secondaryTypes || [],

      title: releaseGroup.title,
      disambiguation: releaseGroup.disambiguation || '',
      overview: releaseGroup.overview || '',
      releasedate: releaseGroup.first_release_date
        ? (releaseGroup.first_release_date instanceof Date
            ? releaseGroup.first_release_date.toISOString().split('T')[0]
            : String(releaseGroup.first_release_date).split('T')[0])
        : '',
      artistid: artistId,
      artists: artists || [],
      releases: releases || [],
      aliases: [],
      oldids: [],
      rating: releaseGroup.rating ? { Count: 0, Value: parseFloat(releaseGroup.rating) } : { Count: 0, Value: null },
      genres: (genres || []).map(g => this.toTitleCase(g)),
      links: links || [],
      images: images || []
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

    // Smart URL detection - try multiple sources in order
    const serverUrl = this.getServerUrl();

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
    const result = await database.query(`
      SELECT
        rg.mbid,
        rg.title,
        rg.primary_type,
        rg.secondary_types,
        rg.first_release_date,
        COALESCE(
          (
            SELECT json_agg(DISTINCT r.status)
            FROM releases r
            WHERE r.release_group_mbid = rg.mbid
            AND r.status IS NOT NULL
          ),
          '[]'::json
        ) as release_statuses
      FROM release_groups rg
      JOIN artist_release_groups arg ON arg.release_group_mbid = rg.mbid
      WHERE arg.artist_mbid = $1
      ORDER BY rg.first_release_date DESC NULLS LAST, rg.title
    `, [artistMbid]);

    return (result.rows || []).map(album => {
      const secondaryTypes = this.parseJson(album.secondary_types);
      const releaseStatuses = this.parseJson(album.release_statuses);

      return {
        Id: album.mbid,
        OldIds: [],
        ReleaseStatuses: releaseStatuses || [],
        SecondaryTypes: secondaryTypes || [],
        Title: album.title,
        Type: album.primary_type || 'Album'
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
      ORDER BY release_date DESC NULLS LAST, country, title
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
        status: release.status || 'Official',
        releasedate: release.release_date
          ? (release.release_date instanceof Date
              ? release.release_date.toISOString().split('T')[0]
              : String(release.release_date).split('T')[0])
          : '',
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
