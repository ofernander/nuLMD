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
    
    // Fetch Wikipedia overview if we have full data and no overview yet
    if (isFullData && !artistData.overview) {
      const WikipediaProvider = require('../providers/wikipedia');
      const wikidataId = WikipediaProvider.extractWikidataId(data.relations || []);
      
      if (wikidataId || artistData.name) {
        const wikiProvider = registry.getProvider('wikipedia');
        if (wikiProvider) {
          try {
            const overview = await wikiProvider.getArtistOverview(wikidataId, artistData.name, artistData.type);
            if (overview) {
              artistData.overview = overview;
              logger.info(`Fetched Wikipedia overview for ${artistData.name} (${overview.length} chars)`);
            }
          } catch (error) {
            logger.error(`Failed to fetch Wikipedia overview for ${artistData.name}:`, error.message);
          }
        }
      }
    }
    
    // Fetch artist images if we have full data
    let images = [];
    if (isFullData) {
      const tadbProvider = registry.getProvider('theaudiodb');
      if (tadbProvider) {
        try {
          images = await tadbProvider.getArtistImages(artistData.name, mbid);
          if (images.length > 0) {
            logger.info(`Fetched ${images.length} images for ${artistData.name} from TheAudioDB`);
          }
        } catch (error) {
          logger.error(`Failed to fetch TheAudioDB images for ${artistData.name}:`, error.message);
        }
      }
      
      // If TheAudioDB didn't return images, try Fanart.tv
      if (images.length === 0) {
        const fanartProvider = registry.getProvider('fanart');
        if (fanartProvider) {
          try {
            const fanartImages = await fanartProvider.getArtistImages(mbid);
            if (fanartImages.length > 0) {
              images = fanartImages;
              logger.info(`Fetched ${images.length} images for ${artistData.name} from Fanart.tv`);
            }
          } catch (error) {
            logger.error(`Failed to fetch Fanart.tv images for ${artistData.name}:`, error.message);
          }
        }
      }
    }
    
    artistData.images = images;
    
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
    
    // Store images with provider tracking
    if (artistData.images && artistData.images.length > 0) {
      logger.info(`Artist ${mbid} has ${artistData.images.length} images to store`);
      const imagesWithProvider = artistData.images.map(img => ({
        ...img,
        Provider: img.Provider || 'theaudiodb'
      }));
      await this.storeImages('artist', mbid, imagesWithProvider, 'theaudiodb');
    } else {
      logger.info(`Artist ${mbid} has no images to store`);
    }
  }
  
  async storeLinks(entityType, entityMbid, links) {
    // Delete existing links for this entity
    await database.query(
      'DELETE FROM links WHERE entity_type = $1 AND entity_mbid = $2',
      [entityType, entityMbid]
    );
    
    // Insert new links
    for (const link of links) {
      const url = typeof link === 'string' ? link : link.url;
      const linkType = typeof link === 'object' ? link.type : 'official';
      
      await database.query(`
        INSERT INTO links (entity_type, entity_mbid, link_type, url)
        VALUES ($1, $2, $3, $4)
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
    
    // Fetch Wikipedia overview for the album
    let albumOverview = data.overview || '';
    if (!albumOverview) {
      // Check DB first — another worker may have already fetched it
      const existingRg = await database.query(
        'SELECT overview FROM release_groups WHERE mbid = $1',
        [mbid]
      );
      if (existingRg.rows[0]?.overview) {
        albumOverview = existingRg.rows[0].overview;
        logger.info(`[TIMING] Wikipedia album overview "${data.title}": skipped (DB hit)`);
      }
    }
    if (!albumOverview) {
      const WikipediaProvider = require('../providers/wikipedia');
      const wikidataId = WikipediaProvider.extractWikidataId(data.relations || []);
      
      if (wikidataId || data.title) {
        const wikiProvider = registry.getProvider('wikipedia');
        if (wikiProvider) {
          try {
            const tw = Date.now();
            const overview = await wikiProvider.getAlbumOverview(wikidataId, data.title, artistName);
            logger.info(`[TIMING] Wikipedia album overview "${data.title}": ${Date.now()-tw}ms`);
            if (overview) {
              albumOverview = overview;
            }
          } catch (error) {
            logger.error(`Failed to fetch Wikipedia overview for album "${data.title}":`, error.message);
          }
        }
      }
    }
    
    // Fetch album images - try providers in priority order
    let albumImages = [];
    
    // Priority 1: Cover Art Archive (MusicBrainz official, no hotlink protection)
    const caaProvider = registry.getProvider('coverartarchive');
    if (caaProvider) {
      try {
        const tc = Date.now();
        albumImages = await caaProvider.getAlbumImages(mbid);
        logger.info(`[TIMING] CAA images "${data.title}": ${Date.now()-tc}ms (${albumImages.length} found)`);
      } catch (error) {
        logger.warn(`Failed to fetch CoverArtArchive album images for "${data.title}":`, error.message);
      }
    }
    
    // Priority 2: TheAudioDB (if CAA didn't return images)
    if (albumImages.length === 0 && artistName && data.title) {
      const tadbProvider = registry.getProvider('theaudiodb');
      if (tadbProvider) {
        try {
          const tt = Date.now();
          albumImages = await tadbProvider.getAlbumImages(data.title, artistName, mbid);
          logger.info(`[TIMING] TADB images "${data.title}": ${Date.now()-tt}ms (${albumImages.length} found)`);
        } catch (error) {
          logger.error(`Failed to fetch TheAudioDB album images for "${data.title}":`, error.message);
        }
      }
    }
    
    // Priority 3: Fanart.tv (if both CAA and TheAudioDB didn't return images)
    if (albumImages.length === 0) {
      const fanartProvider = registry.getProvider('fanart');
      if (fanartProvider && fanartProvider.getAlbumImages) {
        try {
          const tf = Date.now();
          const fanartImages = await fanartProvider.getAlbumImages(mbid);
          logger.info(`[TIMING] Fanart images "${data.title}": ${Date.now()-tf}ms (${fanartImages.length} found)`);
          if (fanartImages.length > 0) {
            albumImages = fanartImages;
          }
        } catch (error) {
          logger.error(`Failed to fetch Fanart.tv album images for "${data.title}":`, error.message);
        }
      }
    }
    
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

    if (existing.rows.length > 0) {
      // Update existing
      await database.query(`
        UPDATE release_groups SET
          title = $1,
          disambiguation = $2,
          primary_type = $3,
          secondary_types = $4,
          first_release_date = $5,
          artist_credit = $6,
          aliases = $7,
          tags = $8,
          genres = $9,
          rating = $10,
          overview = $11,
          last_updated_at = NOW(),
          ttl_expires_at = $12
        WHERE mbid = $13
      `, [
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
        ttlExpires,
        mbid
      ]);
    } else {
      // Insert new
      await database.query(`
        INSERT INTO release_groups (
          mbid, title, disambiguation, primary_type, secondary_types,
          first_release_date, artist_credit, aliases, tags, genres, rating, overview, ttl_expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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
    }
    
    // Store links
    if (data.links && data.links.length > 0) {
      await this.storeLinks('release_group', mbid, data.links);
    }
    
    // Store album images with provider tracking
    if (albumImages.length > 0) {
      let usedProvider = 'unknown';
      if (albumImages[0].Provider) {
        usedProvider = albumImages[0].Provider;
      }
      await this.storeImages('release_group', mbid, albumImages, usedProvider);
    }
    
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

    // Check if release exists
    const existing = await database.query(
      'SELECT mbid FROM releases WHERE mbid = $1',
      [mbid]
    );

    if (existing.rows.length > 0) {
      // Update existing
      await database.query(`
        UPDATE releases SET
          title = $1,
          status = $2,
          release_date = $3,
          country = $4,
          barcode = $5,
          labels = $6,
          artist_credit = $7,
          media_count = $8,
          track_count = $9,
          disambiguation = $10,
          media = $11,
          last_updated_at = NOW()
        WHERE mbid = $12
      `, [
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
        JSON.stringify(media),
        mbid
      ]);
    } else {
      // Insert new
      await database.query(`
        INSERT INTO releases (
          mbid, release_group_mbid, title, status, release_date, country,
          barcode, labels, artist_credit, media_count, track_count, disambiguation, media
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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
    }

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
    const existing = await database.query(
      'SELECT mbid FROM recordings WHERE mbid = $1',
      [mbid]
    );

    const length = data.length || data.duration || null;

    if (existing.rows.length > 0) {
      await database.query(`
        UPDATE recordings SET
          title = $1,
          disambiguation = $2,
          length_ms = $3,
          last_updated_at = NOW()
        WHERE mbid = $4
      `, [
        data.title,
        data.disambiguation || '',
        length,
        mbid
      ]);
    } else {
      await database.query(`
        INSERT INTO recordings (mbid, title, disambiguation, length_ms)
        VALUES ($1, $2, $3, $4)
      `, [
        mbid,
        data.title,
        data.disambiguation || '',
        length
      ]);
    }
  }

  async storeTrack(trackId, data, releaseMbid, recordingMbid, mediumPosition) {
    const existing = await database.query(
      'SELECT mbid FROM tracks WHERE mbid = $1',
      [trackId]
    );

    const position = data.position || data.number || 0;
    const title = data.title || '';
    const length = data.length || data.duration || null;
    const artistCredit = data['artist-credit'] || [];

    if (existing.rows.length > 0) {
      await database.query(`
        UPDATE tracks SET
          recording_mbid = $1,
          release_mbid = $2,
          position = $3,
          medium_number = $4,
          title = $5,
          length_ms = $6,
          artist_credit = $7
        WHERE mbid = $8
      `, [
        recordingMbid,
        releaseMbid,
        position,
        mediumPosition,
        title,
        length,
        JSON.stringify(artistCredit),
        trackId
      ]);
    } else {
      await database.query(`
        INSERT INTO tracks (mbid, recording_mbid, release_mbid, position, medium_number, title, length_ms, artist_credit)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
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

      for (let i = 0; i < albums.length; i++) {
        const album = albums[i];
        try {
          let t0 = Date.now();
          const fullAlbum = await mbProvider.getReleaseGroup(album.id);
          logger.info(`[TIMING] getReleaseGroup ${album.id}: ${Date.now()-t0}ms`);

          t0 = Date.now();
          await this.storeReleaseGroup(album.id, fullAlbum, mbid);
          logger.info(`[TIMING] storeReleaseGroup ${album.id}: ${Date.now()-t0}ms`);

          logger.info(`Stored album ${album.id} (${i + 1}/${albums.length})`);

          t0 = Date.now();
          const releases = await mbProvider.getReleasesByReleaseGroup(album.id);
          logger.info(`[TIMING] getReleasesByReleaseGroup ${album.id} (${releases.length} releases): ${Date.now()-t0}ms`);

          for (const release of releases) {
            try {
              t0 = Date.now();
              const fullRelease = await mbProvider.getRelease(release.id);
              logger.info(`[TIMING] getRelease ${release.id}: ${Date.now()-t0}ms`);

              t0 = Date.now();
              await this.storeRelease(release.id, fullRelease);
              logger.info(`[TIMING] storeRelease ${release.id}: ${Date.now()-t0}ms`);
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

      await this.storeReleaseGroup(mbid, releaseGroupData, artistId);

      // Fetch all Official releases, queue others
      const releases = await mbProvider.getReleasesByReleaseGroup(mbid);
      const officialReleases = releases.filter(r => r.status === 'Official');
      const otherReleases = releases.filter(r => r.status !== 'Official');

      logger.info(`Album ${mbid}: ${officialReleases.length} Official, ${otherReleases.length} other releases`);

      for (let i = 0; i < officialReleases.length; i++) {
        const release = officialReleases[i];
        try {
          const fullRelease = await mbProvider.getRelease(release.id);
          await this.storeRelease(release.id, fullRelease);
          logger.info(`Stored Official release ${release.id} (${i + 1}/${officialReleases.length})`);
        } catch (err) {
          logger.error(`Failed to fetch release ${release.id}:`, err);
        }
      }

      if (otherReleases.length > 0) {
        const metadataJobQueue = require('./metadataJobQueue');
        await metadataJobQueue.queueJob('fetch_album_full', 'release_group', mbid, 3);
        logger.info(`Queued ${otherReleases.length} non-Official releases for background fetch`);
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

  // Formatting removed - use lidarr.js formatArtist() instead
}

module.exports = new ArtistService();