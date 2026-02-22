const database = require('../sql/database');
const { logger } = require('./logger');
const { registry } = require('./providerRegistry');
const lidarr = require('./lidarr');

class ArtistService {
  
  async getArtist(mbid) {
    // Check database first
    let artist = await database.getArtist(mbid);
    
    // Check if we have albums already
    const existingAlbums = artist ? await this.getArtistAlbumsFromDB(mbid) : [];
    
    // If artist exists with albums and not stale, return it
    if (artist && existingAlbums.length > 0 && !this.isStale(artist)) {
      logger.info(`Artist ${mbid} found in cache with full data and ${existingAlbums.length} albums`);
      await database.updateArtistAccess(mbid);
      
      const formatted = await lidarr.formatArtist(mbid);
      return formatted;
    }
    
    // Need to fetch artist details from MusicBrainz
    logger.info(`Fetching artist details for ${mbid} from MusicBrainz`);
    const mbProvider = registry.getProvider('musicbrainz');
    
    if (!mbProvider) {
      throw new Error('MusicBrainz provider not available');
    }
    
    // Fetch full artist details (but NOT albums - those are fetched by background jobs)
    const mbData = await mbProvider.getArtist(mbid);
    
    // Store artist data in database
    await this.storeArtist(mbid, mbData, true);
    
    // Return formatted data (albums will be empty, but background job will fetch them)
    artist = await database.getArtist(mbid);
    const formatted = await lidarr.formatArtist(mbid);
    return formatted;
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
  
  async storeArtist(mbid, data, isFullData = false) {
    const config = require('./config');
    const now = new Date();
    const ttlDays = config.get('refresh.artistTTL', 7);
    const ttlExpires = new Date(now.getTime() + (ttlDays * 24 * 60 * 60 * 1000));
    
    // Extract fields - handle both search results and full artist data
    const artistData = {
      name: data.name || data.ArtistName,
      sort_name: data.sortName || data.sort_name || data.SortName,
      disambiguation: data.disambiguation || data.Disambiguation || '',
      type: data.type || data.Type,
      country: data.country || data.Country,
      begin_date: data.beginDate || data.begin_date || data.BeginDate || null,
      end_date: data.endDate || data.end_date || data.EndDate || null,
      gender: data.gender || data.Gender || null,
      ended: data.ended || data.Ended || false,
      status: data.status || data.Status || null,
      aliases: data.aliases || data.Aliases || [],
      tags: data.tags || data.Tags || [],
      genres: data.genres || data.Genres || [],
      rating: data.rating || data.Rating || null,
      overview: isFullData ? (data.overview || data.Overview || '') : null,
      links: data.links || data.Links || []
    };
    
    // Wikipedia and images handled by dedicated background queues
    // wikiJobQueue handles Wikipedia, providerImageQueue handles TADB/Fanart
    artistData.images = [];
    
    // Check if artist exists
    const existing = await database.query(
      'SELECT mbid FROM artists WHERE mbid = $1',
      [mbid]
    );
    
    if (existing.rows.length > 0) {
      // Update existing - only update overview if we have full data
      const updateFields = `
        name = $1,
        sort_name = $2,
        disambiguation = $3,
        type = $4,
        country = $5,
        begin_date = $6,
        end_date = $7,
        gender = $8,
        ended = $9,
        status = $10,
        aliases = $11,
        tags = $12,
        genres = $13,
        rating = $14,
        ${isFullData ? 'overview = $15,' : ''}
        last_updated_at = NOW(),
        ttl_expires_at = $${isFullData ? 16 : 15},
        last_accessed_at = NOW(),
        access_count = access_count + 1
      `;
      
      const values = [
        artistData.name,
        artistData.sort_name,
        artistData.disambiguation,
        artistData.type,
        artistData.country,
        artistData.begin_date,
        artistData.end_date,
        artistData.gender,
        artistData.ended,
        artistData.status,
        JSON.stringify(artistData.aliases),
        JSON.stringify(artistData.tags),
        JSON.stringify(artistData.genres),
        artistData.rating
      ];
      
      if (isFullData) {
        values.push(artistData.overview);
      }
      
      values.push(ttlExpires);
      values.push(mbid);
      
      await database.query(
        `UPDATE artists SET ${updateFields} WHERE mbid = $${isFullData ? 17 : 16}`,
        values
      );
      
      logger.info(`Updated artist ${mbid} in database${isFullData ? ' (full data)' : ''}`);
    } else {
      // Insert new
      const values = [
        mbid,
        artistData.name,
        artistData.sort_name,
        artistData.disambiguation,
        artistData.type,
        artistData.country,
        artistData.begin_date,
        artistData.end_date,
        artistData.gender,
        artistData.ended,
        artistData.status,
        JSON.stringify(artistData.aliases),
        JSON.stringify(artistData.tags),
        JSON.stringify(artistData.genres),
        artistData.rating,
        artistData.overview,
        ttlExpires
      ];
      
      await database.query(`
        INSERT INTO artists (
          mbid, name, sort_name, disambiguation, type, country,
          begin_date, end_date, gender, ended, status,
          aliases, tags, genres, rating, overview,
          ttl_expires_at, last_accessed_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW())
      `, values);
      
      logger.info(`Inserted artist ${mbid} into database${isFullData ? ' (full data)' : ''}`);
    }
    
    // Store links
    if (artistData.links && artistData.links.length > 0) {
      logger.info(`Artist ${mbid} has ${artistData.links.length} links to store`);
      await this.storeLinks('artist', mbid, artistData.links);
    } else {
      logger.info(`Artist ${mbid} has no links to store`);
    }
    
    // Queue wiki and image fetch jobs (handled by background queue worker pools)
    if (isFullData) {
      const backgroundJobQueue = require('./backgroundJobQueue');
      await backgroundJobQueue.queueJob('fetch_artist_wiki', 'artist', mbid, 1);
      if (backgroundJobQueue.hasArtistImageProvider()) {
        await backgroundJobQueue.queueJob('fetch_artist_images', 'artist', mbid, 1);
      }
    }
  }
  
  async storeLinks(entityType, entityMbid, links) {
    for (const link of links) {
      const url = typeof link === 'string' ? link : link.url;
      const linkType = typeof link === 'object' ? link.type : 'official';

      await database.query(`
        INSERT INTO links (entity_type, entity_mbid, link_type, url)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (entity_mbid, link_type, url) DO NOTHING
      `, [entityType, entityMbid, linkType, url]);
    }

    logger.info(`Stored ${links.length} links for ${entityType} ${entityMbid}`);
  }
  
  async storeImages(entityType, entityMbid, images, provider = 'unknown') {
    // Delete existing images for this entity from this provider
    await database.query(
      'DELETE FROM images WHERE entity_type = $1 AND entity_mbid = $2 AND provider = $3',
      [entityType, entityMbid, provider]
    );
    
    // Insert new images (downloadQueue will pick them up automatically)
    for (const image of images) {
      const imageProvider = image.Provider || provider;
      
      await database.query(`
        INSERT INTO images (entity_type, entity_mbid, url, cover_type, provider, last_verified_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (entity_mbid, cover_type, provider) DO UPDATE
        SET url = EXCLUDED.url, last_verified_at = NOW(), cached = false, cache_failed = false
      `, [entityType, entityMbid, image.Url, image.CoverType, imageProvider]);
    }
    
    logger.info(`Stored ${images.length} images for ${entityType} ${entityMbid} from ${provider} (download queue will process)`);
  }
  
  isStale(artist) {
    if (!artist.ttl_expires_at) return true;
    return new Date(artist.ttl_expires_at) < new Date();
  }
  
  async storeArtistAlbums(artistMbid, albums) {
    const mbProvider = registry.getProvider('musicbrainz');
    
    // MusicBrainz rate limit: 1 request per second per IP
    // This applies to public MB API only
    // Local/mirror servers have no rate limit
    const delayMs = mbProvider.useLocalServer ? 0 : 1000;
    
    for (let i = 0; i < albums.length; i++) {
      const album = albums[i];
      
      // Fetch full details for this release group
      const fullAlbum = await mbProvider.getReleaseGroup(album.id);
      
      await this.storeReleaseGroup(fullAlbum.id, fullAlbum, artistMbid);
      
      // Add delay between requests to avoid rate limiting (only for public API)
      if (delayMs > 0 && i < albums.length - 1) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  
  async storeReleaseGroup(mbid, data, artistMbid) {
    const config = require('./config');
    const now = new Date();
    const ttlDays = config.get('refresh.artistTTL', 7);
    const ttlExpires = new Date(now.getTime() + (ttlDays * 24 * 60 * 60 * 1000));
    
    // Date is already normalized in normalizeReleaseGroup
    const releaseDate = data.firstReleaseDate || data['first-release-date'] || null;

    // Get artist name for album overview and image search
    let artistName = null;
    if (artistMbid) {
      const artist = await database.getArtist(artistMbid);
      artistName = artist ? artist.name : null;
    }
    
    // Overview and images are fetched by dedicated background queues
    // wikiJobQueue handles Wikipedia, providerImageQueue handles CAA/TADB/Fanart
    const albumOverview = data.overview || '';
    const albumImages = [];
    
    // Check if release group exists
    const existing = await database.query(
      'SELECT mbid, ttl_expires_at, overview FROM release_groups WHERE mbid = $1',
      [mbid]
    );

    // If within TTL and has overview, skip external provider fetches
    if (existing.rows.length > 0) {
      const rg = existing.rows[0];
      if (rg.ttl_expires_at && new Date(rg.ttl_expires_at) > new Date() && rg.overview) {
        logger.info(`Release group ${mbid} within TTL, skipping external fetches`);
        // Still ensure artist link exists
        if (artistMbid) {
          const link = await database.query(
            'SELECT * FROM artist_release_groups WHERE artist_mbid = $1 AND release_group_mbid = $2',
            [artistMbid, mbid]
          );
          if (link.rows.length === 0) {
            await database.query(
              'INSERT INTO artist_release_groups (artist_mbid, release_group_mbid, position) VALUES ($1, $2, 0)',
              [artistMbid, mbid]
            );
          }
        }
        return;
      }
    }

    await database.query(`
      INSERT INTO release_groups (
        mbid, title, disambiguation, primary_type, secondary_types,
        first_release_date, artist_credit, aliases, tags, genres, rating, overview, ttl_expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (mbid) DO UPDATE SET
        title = EXCLUDED.title,
        disambiguation = EXCLUDED.disambiguation,
        primary_type = EXCLUDED.primary_type,
        secondary_types = EXCLUDED.secondary_types,
        first_release_date = EXCLUDED.first_release_date,
        artist_credit = EXCLUDED.artist_credit,
        aliases = EXCLUDED.aliases,
        tags = EXCLUDED.tags,
        genres = EXCLUDED.genres,
        rating = EXCLUDED.rating,
        overview = EXCLUDED.overview,
        last_updated_at = NOW(),
        ttl_expires_at = EXCLUDED.ttl_expires_at
    `, [
      mbid,
      data.title,
      data.disambiguation || '',
      data.primaryType || data['primary-type'],
      JSON.stringify(data.secondaryTypes || []),
      releaseDate,
      JSON.stringify(data.artistCredit || []),
      JSON.stringify(data.aliases || []),
      JSON.stringify(data.tags || []),
      JSON.stringify(data.genres || []),
      data.rating || null,
      albumOverview,
      ttlExpires
    ]);
    
    // Store links
    if (data.links && data.links.length > 0) {
      await this.storeLinks('release_group', mbid, data.links);
    }

    // Queue wiki job (handled by background queue worker pool)
    // Image job NOT queued here — only queued when Lidarr explicitly requests this album via ensureAlbum
    const backgroundJobQueue = require('./backgroundJobQueue');
    await backgroundJobQueue.queueJob('fetch_album_wiki', 'release_group', mbid, 1);

    // Link artist to release group if not already linked
    if (artistMbid) {
      const link = await database.query(
        'SELECT * FROM artist_release_groups WHERE artist_mbid = $1 AND release_group_mbid = $2',
        [artistMbid, mbid]
      );
      
      if (link.rows.length === 0) {
        await database.query(`
          INSERT INTO artist_release_groups (artist_mbid, release_group_mbid, position)
          VALUES ($1, $2, 0)
        `, [artistMbid, mbid]);
      }
    }
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
  
  async getArtistAlbumsFromDB(artistMbid) {
    const result = await database.query(`
      SELECT rg.* 
      FROM release_groups rg
      JOIN artist_release_groups arg ON arg.release_group_mbid = rg.mbid
      WHERE arg.artist_mbid = $1
      ORDER BY rg.first_release_date DESC
    `, [artistMbid]);
    
    return result.rows.map(album => ({
      Id: album.mbid,
      Title: album.title,
      Type: album.primary_type,
      ReleaseDate: album.first_release_date
    }));
  }

  async storeRelease(mbid, data) {
    // Normalize date
    let releaseDate = data.date || data.releaseDate || null;
    if (releaseDate) {
      if (releaseDate.length === 4) {
        releaseDate = `${releaseDate}-01-01`;
      } else if (releaseDate.length === 7) {
        releaseDate = `${releaseDate}-01`;
      }
    }

    // Extract release group MBID
    const releaseGroupMbid = data['release-group']?.id || data.releaseGroupId || data.release_group_mbid;
    
    if (!releaseGroupMbid) {
      throw new Error(`Release ${mbid} has no release group MBID`);
    }

    // Calculate media count and track count
    const media = data.media || [];
    const mediaCount = media.length;
    const trackCount = media.reduce((sum, m) => sum + (m['track-count'] || m.trackCount || 0), 0);

    await database.query(`
      INSERT INTO releases (
        mbid, release_group_mbid, title, status, release_date, country,
        barcode, labels, artist_credit, media_count, track_count, disambiguation, media
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (mbid) DO UPDATE SET
        title = EXCLUDED.title,
        status = EXCLUDED.status,
        release_date = EXCLUDED.release_date,
        country = EXCLUDED.country,
        barcode = EXCLUDED.barcode,
        labels = EXCLUDED.labels,
        artist_credit = EXCLUDED.artist_credit,
        media_count = EXCLUDED.media_count,
        track_count = EXCLUDED.track_count,
        disambiguation = EXCLUDED.disambiguation,
        media = EXCLUDED.media,
        last_updated_at = NOW()
    `, [
      mbid,
      releaseGroupMbid,
      data.title,
      data.status,
      releaseDate,
      data.country,
      data.barcode || null,
      JSON.stringify(data['label-info'] || data.labelInfo || []),
      JSON.stringify(data['artist-credit'] || []),
      mediaCount,
      trackCount,
      data.disambiguation || '',
      JSON.stringify(media)
    ]);

    // Store recordings/tracks if present
    if (media && media.length > 0) {
      await this.storeTracksFromMedia(mbid, media);
    }

    logger.info(`Stored release ${mbid} with ${trackCount} tracks across ${mediaCount} media`);
  }

  async storeTracksFromMedia(releaseMbid, media) {
    for (const medium of media) {
      const tracks = medium.tracks || [];
      
      for (const track of tracks) {
        const recording = track.recording;
        if (!recording || !recording.id) continue;

        // Store the recording
        await this.storeRecording(recording.id, recording);

        // Store the track (links recording to release)
        await this.storeTrack(track.id, track, releaseMbid, recording.id, medium.position);
      }
    }
  }

  async storeRecording(mbid, data) {
    const length = data.length || data.duration || null;

    await database.query(`
      INSERT INTO recordings (mbid, title, disambiguation, length_ms)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (mbid) DO UPDATE SET
        title = EXCLUDED.title,
        disambiguation = EXCLUDED.disambiguation,
        length_ms = EXCLUDED.length_ms,
        last_updated_at = NOW()
    `, [
      mbid,
      data.title,
      data.disambiguation || '',
      length
    ]);
  }

  async storeTrack(trackId, data, releaseMbid, recordingMbid, mediumPosition) {
    const position = data.position || data.number || 0;
    const title = data.title || '';
    const length = data.length || data.duration || null;
    const artistCredit = data['artist-credit'] || [];

    await database.query(`
      INSERT INTO tracks (mbid, recording_mbid, release_mbid, position, medium_number, title, length_ms, artist_credit)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (mbid) DO UPDATE SET
        recording_mbid = EXCLUDED.recording_mbid,
        release_mbid = EXCLUDED.release_mbid,
        position = EXCLUDED.position,
        medium_number = EXCLUDED.medium_number,
        title = EXCLUDED.title,
        length_ms = EXCLUDED.length_ms,
        artist_credit = EXCLUDED.artist_credit
    `, [
      trackId,
      recordingMbid,
      releaseMbid,
      position,
      mediumPosition,
      title,
      length,
      JSON.stringify(artistCredit)
    ]);
  }
  
  /**
   * Force refresh artist data from MusicBrainz (ignores TTL)
   * Used when TTL expires or manual refresh requested
   */
  async refreshArtist(mbid) {
    logger.info(`Refreshing artist ${mbid} from MusicBrainz (TTL expired or manual refresh)`);
    
    const mbProvider = registry.getProvider('musicbrainz');
    if (!mbProvider) {
      throw new Error('MusicBrainz provider not available');
    }
    
    // Fetch fresh artist data
    const artistData = await mbProvider.getArtist(mbid);
    await this.storeArtist(mbid, artistData, true);
    
    // Fetch fresh album list
    const albums = await mbProvider.getArtistAlbums(mbid);
    logger.info(`Refreshing ${albums.length} albums for artist ${mbid}`);
    
    // Check which albums are NEW (not in database)
    const existingAlbumMbids = await this.getArtistReleaseGroups(mbid);
    const newAlbums = albums.filter(album => !existingAlbumMbids.includes(album.id));
    
    if (newAlbums.length > 0) {
      logger.info(`Found ${newAlbums.length} NEW albums for artist ${mbid}`);
      // Fetch only new albums synchronously
      for (const album of newAlbums) {
        try {
          const fullAlbum = await mbProvider.getReleaseGroup(album.id);
          await this.storeReleaseGroup(album.id, fullAlbum, mbid);
          logger.info(`Stored new album ${album.id}`);
        } catch (error) {
          logger.error(`Failed to fetch new album ${album.id}:`, error);
        }
      }
    } else {
      logger.info(`No new albums found for artist ${mbid}`);
    }
    
    logger.info(`Artist ${mbid} refresh complete`);
  }
  
  /**
   * Single entry point for artist metadata.
   * Ensures artist + albums + first Official release per album are in DB.
   * Called by both Lidarr endpoint and UI fetch button.
   */
  async ensureArtist(mbid) {
    const mbProvider = registry.getProvider('musicbrainz');
    if (!mbProvider) throw new Error('MusicBrainz provider not available');

    // Fetch/refresh artist record
    let artist = await database.getArtist(mbid);
    if (!artist) {
      logger.info(`Artist ${mbid} not in DB, fetching from MusicBrainz`);
      await this.getArtist(mbid);
    } else if (this.isStale(artist)) {
      logger.info(`Artist ${mbid} TTL expired, refreshing`);
      await this.refreshArtist(mbid);
    }

    // Ensure artist overview populated once before album loop
    // Previously this check ran inside storeReleaseGroup on every album = N MB requests
    artist = await database.getArtist(mbid);
    if (artist && (!artist.overview || artist.overview === '')) {
      logger.info(`Artist ${mbid} missing overview, fetching once before album loop`);
      try {
        const fullArtistData = await mbProvider.getArtist(mbid);
        await this.storeArtist(mbid, fullArtistData, true);
      } catch (error) {
        logger.error(`Failed to fetch artist overview for ${mbid}:`, error.message);
      }
    }

    // Fetch albums if none exist
    const existingAlbums = await database.query(
      'SELECT mbid FROM release_groups rg JOIN artist_release_groups arg ON arg.release_group_mbid = rg.mbid WHERE arg.artist_mbid = $1',
      [mbid]
    );

    if (existingAlbums.rows.length === 0) {
      logger.info(`Artist ${mbid} has no albums, fetching from MusicBrainz`);
      const albums = await mbProvider.getArtistAlbums(mbid);
      logger.info(`Found ${albums.length} albums for artist ${mbid}`);

      const filteredAlbums = albums.filter(a => this.matchesFetchTypeFilter(a));
      logger.info(`Fetching ${filteredAlbums.length}/${albums.length} albums after type filter for artist ${mbid}`);

      for (let i = 0; i < filteredAlbums.length; i++) {
        const album = filteredAlbums[i];
        try {
          const fullAlbum = await mbProvider.getReleaseGroup(album.id);
          await this.storeReleaseGroup(album.id, fullAlbum, mbid);
          logger.info(`Stored album ${album.id} (${i + 1}/${filteredAlbums.length})`);

          const releases = await mbProvider.getReleasesByReleaseGroup(album.id);
          const filteredReleases = releases.filter(r => this.matchesStatusFilter(r));
          for (const release of filteredReleases) {
            try {
              const fullRelease = await mbProvider.getRelease(release.id);
              await this.storeRelease(release.id, fullRelease);
            } catch (err) {
              logger.error(`Failed to fetch release ${release.id}:`, err);
            }
          }
        } catch (err) {
          logger.error(`Failed to fetch album ${album.id}:`, err);
        }
      }
    }

    return lidarr.formatArtist(mbid);
  }

  /**
   * Single entry point for album metadata.
   * Ensures release group + Official releases are in DB.
   * Called by both Lidarr endpoint and UI fetch button.
   */
  async ensureAlbum(mbid) {
    const mbProvider = registry.getProvider('musicbrainz');
    if (!mbProvider) throw new Error('MusicBrainz provider not available');

    const album = await database.getReleaseGroup(mbid);

    // Serve from cache if within TTL
    if (album && album.ttl_expires_at && new Date(album.ttl_expires_at) > new Date()) {
      logger.info(`Album ${mbid} within TTL, serving from DB`);
      return lidarr.formatAlbum(mbid);
    }

    if (!album) {
      logger.info(`Album ${mbid} not in DB, fetching from MusicBrainz`);
      const releaseGroupData = await mbProvider.getReleaseGroup(mbid);

      // Ensure artist exists
      let artistId = null;
      if (releaseGroupData['artist-credit']?.length > 0) {
        artistId = releaseGroupData['artist-credit'][0].artist.id;
        const artistExists = await database.getArtist(artistId);
        if (!artistExists) {
          logger.info(`Artist ${artistId} not in DB, fetching`);
          await this.getArtist(artistId);
        }
      }

      // If this release group doesn't match the configured fetch type filter,
      // store metadata only — no releases, no tracks fetched
      if (!this.matchesFetchTypeFilter(releaseGroupData)) {
        logger.info(`Album ${mbid} (${releaseGroupData.primaryType || 'Unknown'}) skipped by fetch type filter — storing metadata only`);
        await this.storeReleaseGroup(mbid, releaseGroupData, artistId);
        return lidarr.formatAlbum(mbid);
      }

      await this.storeReleaseGroup(mbid, releaseGroupData, artistId);

      // Queue album image job — only for albums Lidarr explicitly requested
      const backgroundJobQueue = require('./backgroundJobQueue');
      if (backgroundJobQueue.hasAlbumImageProvider()) {
        await backgroundJobQueue.queueJob('fetch_album_images', 'release_group', mbid, 1);
      }

      // Fetch releases matching configured status filter
      const config = require('./config');
      const statusFilter = config.get('metadata.fetchTypes.releaseStatuses', ['Official']);
      const releases = await mbProvider.getReleasesByReleaseGroup(mbid);
      const wantedReleases = statusFilter.length > 0
        ? releases.filter(r => statusFilter.includes(r.status || 'Official'))
        : releases;
      const otherReleases = statusFilter.length > 0
        ? releases.filter(r => !statusFilter.includes(r.status || 'Official'))
        : [];

      logger.info(`Album ${mbid}: ${wantedReleases.length} matching status filter, ${otherReleases.length} other releases`);

      for (let i = 0; i < wantedReleases.length; i++) {
        const release = wantedReleases[i];
        try {
          const fullRelease = await mbProvider.getRelease(release.id);
          await this.storeRelease(release.id, fullRelease);
          logger.info(`Stored release ${release.id} [${release.status}] (${i + 1}/${wantedReleases.length})`);
        } catch (err) {
          logger.error(`Failed to fetch release ${release.id}:`, err);
        }
      }

      if (otherReleases.length > 0) {
        await backgroundJobQueue.queueJob('fetch_album_full', 'release_group', mbid, 3);
        logger.info(`Queued ${otherReleases.length} non-matching releases for background fetch`);
      }

    } else {
      // Album exists - check releases
      const existingReleases = await database.query(
        'SELECT mbid FROM releases WHERE release_group_mbid = $1',
        [mbid]
      );

      if (existingReleases.rows.length === 0) {
        logger.info(`Album ${mbid} exists but has no releases, fetching`);
        const releases = await mbProvider.getReleasesByReleaseGroup(mbid);
        const target = releases.find(r => r.status === 'Official') || releases[0];
        if (target) {
          try {
            const fullRelease = await mbProvider.getRelease(target.id);
            await this.storeRelease(target.id, fullRelease);
            logger.info(`Stored release ${target.id}`);
          } catch (err) {
            logger.error(`Failed to fetch release ${target.id}:`, err);
          }
        }
      }
    }

    return lidarr.formatAlbum(mbid);
  }

  matchesStatusFilter(release) {
    const config = require('./config');
    const statusFilter = config.get('metadata.fetchTypes.releaseStatuses', ['Official']);
    if (statusFilter.length === 0) return true;
    const status = release.status || 'Official';
    return statusFilter.includes(status);
  }

  matchesFetchTypeFilter(rg) {
    const config = require('./config');
    const albumTypes = config.get('metadata.fetchTypes.albumTypes', ['Studio']);
    const primaryType = rg['primary-type'] || rg.primaryType || '';
    const secondaryTypes = rg['secondary-types'] || rg.secondaryTypes || [];

    // Each named type maps to exact MB conditions (same logic as Metadata Browser filter)
    // A release group passes if it matches ANY selected type
    return albumTypes.some(type => {
      switch (type) {
        case 'Studio':        return primaryType === 'Album' && secondaryTypes.length === 0;
        case 'Live':          return secondaryTypes.includes('Live');
        case 'Compilation':   return secondaryTypes.includes('Compilation');
        case 'Soundtrack':    return secondaryTypes.includes('Soundtrack');
        case 'Remix':         return secondaryTypes.includes('Remix');
        case 'DJ-mix':        return secondaryTypes.includes('DJ-mix');
        case 'Mixtape':       return secondaryTypes.includes('Mixtape/Street');
        case 'Demo':          return secondaryTypes.includes('Demo');
        case 'Spokenword':    return secondaryTypes.includes('Spokenword');
        case 'Interview':     return secondaryTypes.includes('Interview');
        case 'Audiobook':     return secondaryTypes.includes('Audiobook');
        case 'Audio drama':   return secondaryTypes.includes('Audio drama');
        case 'Field recording': return secondaryTypes.includes('Field recording');
        case 'EP':            return primaryType === 'EP';
        case 'Single':        return primaryType === 'Single';
        case 'Broadcast':     return primaryType === 'Broadcast';
        case 'Other':         return primaryType === 'Other';
        default:              return false;
      }
    });
  }

  // Formatting removed - use lidarr.js formatArtist() instead
}

module.exports = new ArtistService();