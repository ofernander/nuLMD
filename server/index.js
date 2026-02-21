process.env.NODE_ENV = 'production';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const { logger } = require('./lib/logger');
const config = require('./lib/config');
const database = require('./sql/database');
const routes = require('./lib/routes');
const lidarr = require('./lib/lidarr');
const metaHandler = require('./lib/metaHandler');
const { registry } = require('./lib/providerRegistry');
const { initializeProviders } = require('./lib/providerRegistry');
const metadataJobQueue = require('./lib/metadataJobQueue');
const { processJob } = require('./lib/jobProcessor');
const imageDownloadQueue = require('./lib/imageDownloadQueue');
const bulkRefresher = require('./lib/bulkRefresher');

const app = express();
const PORT = process.env.PORT || 5001;

// Middleware
app.use(helmet({
  contentSecurityPolicy: false // Allow our web UI to load assets
}));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging (filter out noisy endpoints)
app.use((req, res, next) => {
  // Skip logging for high-frequency polling endpoints
  const skipPaths = [
    '/api/logs/tail',
    '/health',
    '/api/version',
    '/api/cache/stats',
    '/api/stats',
    '/api/config',
    '/api/providers'
  ];
  
  if (!skipPaths.includes(req.path)) {
    logger.info(`${req.method} ${req.path}`, {
      ip: req.ip,
      userAgent: req.get('user-agent')
    });
  }
  next();
});

// Serve static files for Web UI
app.use(express.static(path.join(__dirname, '../public')));

// Lidarr API Routes (at root level, no /api prefix)
app.get('/artist/:mbid', async (req, res) => {
  try {
    const { mbid } = req.params;
    logger.info(`Lidarr artist request: ${mbid}`);
    
    // Check if artist exists in DB
    let artist = await database.getArtist(mbid);
    
    if (!artist) {
      // Artist doesn't exist - fetch from MusicBrainz
      logger.info(`Artist ${mbid} not in DB, fetching from MusicBrainz`);
      await metaHandler.getArtist(mbid);
    } else {
      // Artist exists - check if TTL expired (7 days)
      const now = new Date();
      const ttlExpired = artist.ttl_expires_at && new Date(artist.ttl_expires_at) < now;
      
      if (ttlExpired) {
        logger.info(`Artist ${mbid} TTL expired, refreshing from MusicBrainz`);
        await metaHandler.refreshArtist(mbid);
      } else {
        logger.info(`Artist ${mbid} found in cache (TTL valid)`);
      }
    }
    
    // Check if artist has albums in DB
    const existingAlbums = await database.query(
      'SELECT mbid FROM release_groups rg JOIN artist_release_groups arg ON arg.release_group_mbid = rg.mbid WHERE arg.artist_mbid = $1',
      [mbid]
    );
    
    if (existingAlbums.rows.length === 0) {
      // No albums - fetch from MusicBrainz
      logger.info(`Artist ${mbid} has no albums, fetching from MusicBrainz`);
      
      const mbProvider = registry.getProvider('musicbrainz');
      if (!mbProvider) {
        throw new Error('MusicBrainz provider not available');
      }
      
      // Fetch all albums for this artist
      const albums = await mbProvider.getArtistAlbums(mbid);
      logger.info(`Found ${albums.length} albums for artist ${mbid}`);
      
      // Fetch ALL albums synchronously with their first Official release
      for (let i = 0; i < albums.length; i++) {
        const album = albums[i];
        try {
          const fullAlbum = await mbProvider.getReleaseGroup(album.id);
          await metaHandler.storeReleaseGroup(album.id, fullAlbum, mbid);
          logger.info(`Stored album ${album.id} (${i + 1}/${albums.length})`);
          
          // Paginated browse to get ALL releases for this release group (not capped at 25)
          const releases = await mbProvider.getReleasesByReleaseGroup(album.id);
          const officialRelease = releases.find(r => r.status === 'Official');
          const targetRelease = officialRelease || releases[0];

          if (targetRelease) {
            try {
              const fullRelease = await mbProvider.getRelease(targetRelease.id);
              await metaHandler.storeRelease(targetRelease.id, fullRelease);
              logger.info(`Stored release ${targetRelease.id} for album ${album.id}`);
            } catch (error) {
              logger.error(`Failed to fetch release ${targetRelease.id}:`, error);
            }
          }
        } catch (error) {
          logger.error(`Failed to fetch/store album ${album.id}:`, error);
        }
      }
    }
    
    const formatted = await lidarr.formatArtist(mbid);
    res.json(formatted);
  } catch (error) {
    logger.error(`Error formatting artist ${req.params.mbid}:`, error);
    res.status(500).json({ error: error.message });
  }
});

// Helper: Queue missing artists for an album
async function queueMissingArtists(releaseGroupMbid, releaseGroupData) {
  try {
    // Queue artist if not in DB
    const artistCredit = releaseGroupData['artist-credit'] || [];
    if (artistCredit.length > 0) {
      const artistId = artistCredit[0].artist.id;
      const artistExists = await database.getArtist(artistId);
      if (!artistExists) {
        await metadataJobQueue.queueJob('fetch_artist', 'artist', artistId, 10);
      }
    }
    
    // Collect all unique track artists from the first release we fetched
    const firstReleaseResult = await database.query(
      'SELECT media FROM releases WHERE release_group_mbid = $1 LIMIT 1',
      [releaseGroupMbid]
    );
    
    if (firstReleaseResult.rows.length > 0 && firstReleaseResult.rows[0].media) {
      const media = typeof firstReleaseResult.rows[0].media === 'string' 
        ? JSON.parse(firstReleaseResult.rows[0].media)
        : firstReleaseResult.rows[0].media;
      
      const trackArtistIds = new Set();
      if (media && Array.isArray(media)) {
        media.forEach(medium => {
          if (medium.tracks && Array.isArray(medium.tracks)) {
            medium.tracks.forEach(track => {
              const trackArtistCredit = track['artist-credit'] || [];
              if (trackArtistCredit.length > 0) {
                trackArtistIds.add(trackArtistCredit[0].artist.id);
              }
            });
          }
        });
      }
      
      // Queue any track artists not in DB
      for (const trackArtistId of trackArtistIds) {
        const exists = await database.getArtist(trackArtistId);
        if (!exists) {
          await metadataJobQueue.queueJob('fetch_artist', 'artist', trackArtistId, 8);
        }
      }
    }
  } catch (error) {
    logger.error(`Failed to queue missing artists for ${releaseGroupMbid}:`, error);
    // Don't throw - this is optional background work
  }
}

app.get('/album/:mbid', async (req, res) => {
  try {
    const { mbid } = req.params;
    logger.info(`Lidarr album request: ${mbid}`);
    
    // Check if album exists in DB
    let album = await database.getReleaseGroup(mbid);
    
    if (!album) {
      // Fetch release group from MusicBrainz
      logger.info(`Album ${mbid} not in DB, fetching from MusicBrainz`);
      
      const mbProvider = registry.getProvider('musicbrainz');
      if (!mbProvider) {
        throw new Error('MusicBrainz provider not available');
      }
      
      // Fetch release group (includes minimal release list)
      const releaseGroupData = await mbProvider.getReleaseGroup(mbid);
      
      // Extract artist ID from release group data
      let artistId = null;
      if (releaseGroupData['artist-credit'] && releaseGroupData['artist-credit'].length > 0) {
        artistId = releaseGroupData['artist-credit'][0].artist.id;
        
        // Check if artist exists in DB, fetch if not
        const artistExists = await database.getArtist(artistId);
        if (!artistExists) {
          logger.info(`Artist ${artistId} not in DB, fetching from MusicBrainz`);
          await metaHandler.getArtist(artistId);
        }
      }
      
      // Store release group in database
      await metaHandler.storeReleaseGroup(mbid, releaseGroupData, artistId);
      
      const releases = releaseGroupData.releases || [];
      
      // Sort releases by status priority: Official > Promotion > Other
      const sortedReleases = [...releases].sort((a, b) => {
        const statusPriority = { 'Official': 0, 'Promotion': 1 };
        const aPriority = statusPriority[a.status] ?? 2;
        const bPriority = statusPriority[b.status] ?? 2;
        return aPriority - bPriority;
      });
      
      // Separate Official releases from others
      const officialReleases = sortedReleases.filter(r => r.status === 'Official');
      const otherReleases = sortedReleases.filter(r => r.status !== 'Official');
      
      logger.info(`Stored release group ${mbid}: ${officialReleases.length} Official, ${otherReleases.length} other releases`);
      
      // Fetch ALL Official releases synchronously (most likely to match user files)
      for (let i = 0; i < officialReleases.length; i++) {
        const release = officialReleases[i];
        try {
          const fullRelease = await mbProvider.getRelease(release.id);
          await metaHandler.storeRelease(release.id, fullRelease);
          logger.info(`Stored Official release ${release.id} (${i + 1}/${officialReleases.length})`);
        } catch (error) {
          logger.error(`Failed to fetch Official release ${release.id}:`, error);
        }
      }
      
      // Queue missing track artists from first release
      if (officialReleases.length > 0) {
        await queueMissingArtists(mbid, releaseGroupData);
      }
      
      // Queue non-Official releases as background job
      if (otherReleases.length > 0) {
        await metadataJobQueue.queueJob('fetch_album_full', 'release_group', mbid, 3);
        logger.info(`Queued ${otherReleases.length} non-Official releases for background fetch`);
      }
      
    } else {
      // Album exists - check if we have releases
      const existingReleases = await database.query(
        'SELECT mbid FROM releases WHERE release_group_mbid = $1',
        [mbid]
      );
      
      if (existingReleases.rows.length === 0) {
        // We have the album but no releases - fetch them now
        logger.info(`Album ${mbid} exists but has no releases, fetching from MusicBrainz`);
        
        const mbProvider = registry.getProvider('musicbrainz');
        const releaseGroupData = await mbProvider.getReleaseGroup(mbid);
        
        const releases = releaseGroupData.releases || [];
        logger.info(`Fetching first of ${releases.length} releases for album ${mbid}`);
        
        // Fetch FIRST release synchronously
        if (releases.length > 0) {
          try {
            const firstRelease = releases[0];
            const fullRelease = await mbProvider.getRelease(firstRelease.id);
            await metaHandler.storeRelease(firstRelease.id, fullRelease);
            logger.info(`Stored first release ${firstRelease.id}`);
            
            // Queue missing track artists from this first release
            await queueMissingArtists(mbid, releaseGroupData);
          } catch (error) {
            logger.error(`Failed to fetch first release:`, error);
          }
        }
        
        // Queue complete album fetch as background job
        if (releases.length > 1) {
          await metadataJobQueue.queueJob('fetch_album_full', 'release_group', mbid, 3);
          logger.info(`Queued complete album fetch for ${mbid} (${releases.length} releases)`);
        }
      }
    }
    
    const formatted = await lidarr.formatAlbum(mbid);
    res.json(formatted);
  } catch (error) {
    logger.error(`Error formatting album ${req.params.mbid}:`, error);
    res.status(500).json({ error: error.message });
  }
});

// Master search endpoint - routes based on type parameter
app.get('/search', async (req, res) => {
  try {
    const type = req.query.type;
    const { query, artist, limit = 3 } = req.query;
    
    if (!type) {
      return res.status(400).json({ error: 'Type not provided' });
    }
    
    if (!query) {
      return res.json([]);
    }
    
    const mbProvider = registry.getProvider('musicbrainz');
    if (!mbProvider) {
      throw new Error('MusicBrainz provider not available');
    }
    
    if (type === 'artist') {
      logger.info(`Lidarr artist search: ${query}`);
      
      // Search for artists - DO NOT store results yet
      const searchResults = await mbProvider.searchArtist(query, limit);
      logger.info(`Found ${searchResults.length} artist search results for "${query}"`);
      
      // Format search results without storing to DB
      const formattedResults = searchResults.map(result => ({
        Id: result.id,
        ArtistName: result.name,
        SortName: result.sortName || result.name,  // Already normalized by provider
        Disambiguation: result.disambiguation || '',
        Status: 'active',  // Match old LMD format
        Type: result.type || null,  // Can be null (not 'Unknown')
        Country: result.country || '',
        Gender: '',  // Search results don't have gender
        Overview: '',
        Rating: { Count: 0, Value: null },  // Value should be null, not 0
        ArtistAliases: [],
        Tags: [],
        Genres: [],
        Links: [],
        Images: [],
        Albums: [],
        OldIds: []
      }));
      
      return res.json(formattedResults);
      
    } else if (type === 'album') {
      logger.info(`Lidarr album search: ${query}${artist ? ` by ${artist}` : ''}`);
      
      // Search for albums - DO NOT store results yet
      const searchResults = await mbProvider.searchAlbum(query, artist, limit);
      logger.info(`Found ${searchResults.length} album search results for "${query}"`);
      
      // Format search results without storing to DB
      const formattedResults = searchResults.map(result => {
        const artistCredit = result.artistCredit || [];  // Already normalized
        const artistId = artistCredit.length > 0 ? artistCredit[0].artist.id : '';
        
        return {
          id: result.id,
          title: result.title,
          disambiguation: result.disambiguation || '',
          overview: '',
          releasedate: result.firstReleaseDate || null,  // Already normalized
          artistid: artistId,
          artists: [],
          releases: [],
          aliases: [],
          oldids: [],
          rating: { Count: 0, Value: null },  // Value should be null
          genres: [],
          links: [],
          images: []
        };
      });
      
      return res.json(formattedResults);
      
    } else if (type === 'all') {
      logger.info(`Lidarr combined search: ${query}`);
      
      // Search for BOTH artists and albums
      const [artistResults, albumResults] = await Promise.all([
        mbProvider.searchArtist(query, limit),
        mbProvider.searchAlbum(query, null, limit)
      ]);
      
      logger.info(`Found ${artistResults.length} artists and ${albumResults.length} albums for "${query}"`);
      
      // Process artists in parallel (faster!)
      const artistPromises = artistResults.map(async (result) => {
        try {
          // Check if artist exists in DB
          let artist = await database.getArtist(result.id);
          
          if (!artist) {
            // Fetch basic artist data
            await metaHandler.getArtist(result.id);
            // Queue background job to fetch all albums (don't wait)
            metadataJobQueue.queueJob('fetch_artist_albums', 'artist', result.id, 5).catch(err => 
              logger.error(`Failed to queue artist albums job for ${result.id}:`, err)
            );
          }
          
          // Format for response (will have full data if in DB)
          const formatted = await lidarr.formatArtistForAlbum(result.id);
          return {
            album: null,
            artist: formatted,
            score: result.score || 100
          };
        } catch (error) {
          logger.error(`Failed to fetch artist ${result.id}:`, error);
          return null;
        }
      });
      
      // Process albums in parallel (faster!)
      const albumPromises = albumResults.map(async (result) => {
        try {
          // Check if album exists in DB
          let album = await database.getReleaseGroup(result.id);
          
          if (!album) {
            // Fetch basic album data
            const fullAlbum = await mbProvider.getReleaseGroup(result.id);
            
            // Extract and fetch artist if needed
            let artistId = null;
            if (fullAlbum['artist-credit'] && fullAlbum['artist-credit'].length > 0) {
              artistId = fullAlbum['artist-credit'][0].artist.id;
              const artistExists = await database.getArtist(artistId);
              if (!artistExists) {
                await metaHandler.getArtist(artistId);
              }
            }
            
            await metaHandler.storeReleaseGroup(result.id, fullAlbum, artistId);
            // Queue background job to fetch all releases (don't wait)
            metadataJobQueue.queueJob('fetch_album_full', 'release_group', result.id, 3).catch(err =>
              logger.error(`Failed to queue album full job for ${result.id}:`, err)
            );
          }
          
          // Format for response (will have full data if in DB)
          const formatted = await lidarr.formatAlbum(result.id);
          return {
            album: formatted,
            artist: null,
            score: result.score || 100
          };
        } catch (error) {
          logger.error(`Failed to fetch album ${result.id}:`, error);
          return null;
        }
      });
      
      // Wait for all to complete in parallel
      const [formattedArtists, formattedAlbums] = await Promise.all([
        Promise.all(artistPromises),
        Promise.all(albumPromises)
      ]);
      
      // Filter out nulls (failed fetches)
      const validArtists = formattedArtists.filter(a => a !== null);
      const validAlbums = formattedAlbums.filter(a => a !== null);
      
      // Combine and return (old LMD format: array of {album, artist, score})
      const combined = [...validArtists, ...validAlbums];
      return res.json(combined);
      
    } else {
      return res.status(400).json({ error: `Unsupported search type ${type}` });
    }
  } catch (error) {
    logger.error(`Error in search endpoint:`, error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/search/artist', async (req, res) => {
  try {
    const { query, limit = 3 } = req.query;
    logger.info(`Lidarr artist search: ${query}`);
    
    if (!query) {
      return res.json([]);
    }
    
    const mbProvider = registry.getProvider('musicbrainz');
    if (!mbProvider) {
      throw new Error('MusicBrainz provider not available');
    }
    
    // Search for artists - DO NOT store results yet
    const searchResults = await mbProvider.searchArtist(query, limit);
    logger.info(`Found ${searchResults.length} artist search results for "${query}"`);
    
    // Format search results without storing to DB
    const formattedResults = searchResults.map(result => ({
      Id: result.id,
      ArtistName: result.name,
      SortName: result.sortName || result.name,  // Already normalized by provider
      Disambiguation: result.disambiguation || '',
      Status: 'continuing',  // Search results don't have life-span data
      Type: result.type || null,  // Can be null
      Country: result.country || '',
      Gender: '',  // Search results don't have gender
      Overview: '',
      Rating: { Count: 0, Value: null },  // Value should be null
      ArtistAliases: [],
      Tags: [],
      Genres: [],
      Links: [],
      Images: [],
      Albums: [],
      OldIds: []
    }));
    
    res.json(formattedResults);
  } catch (error) {
    logger.error(`Error searching artists:`, error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/search/album', async (req, res) => {
  try {
    const { query, artist, limit = 3 } = req.query;
    logger.info(`Lidarr album search: ${query}${artist ? ` by ${artist}` : ''}`);
    
    if (!query) {
      return res.json([]);
    }
    
    const mbProvider = registry.getProvider('musicbrainz');
    if (!mbProvider) {
      throw new Error('MusicBrainz provider not available');
    }
    
    // Search for albums - DO NOT store results yet
    const searchResults = await mbProvider.searchAlbum(query, artist, limit);
    logger.info(`Found ${searchResults.length} album search results for "${query}"`);
    
    // Format search results without storing to DB
    const formattedResults = searchResults.map(result => {
      const artistCredit = result.artistCredit || [];  // Already normalized
      const artistId = artistCredit.length > 0 ? artistCredit[0].artist.id : '';
      
      return {
        id: result.id,
        title: result.title,
        disambiguation: result.disambiguation || '',
        overview: '',
        releasedate: result.firstReleaseDate || null,  // Already normalized
        artistid: artistId,
        artists: [],
        releases: [],
        aliases: [],
        oldids: [],
        rating: { Count: 0, Value: null },  // Value should be null
        genres: [],
        links: [],
        images: []
      };
    });
    
    res.json(formattedResults);
  } catch (error) {
    logger.error(`Error searching albums:`, error);
    res.status(500).json({ error: error.message });
  }
});

// API Routes (internal, for Web UI)
app.use('/api', routes);

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: require('../package.json').version,
    uptime: process.uptime()
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, req, res, next) => {
  logger.error('Server error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error'
  });
});

// Initialize and start server
async function start() {
  try {
    // Load configuration
    await config.load();
    logger.info('Configuration loaded');

    // Initialize database
    await database.initialize();
    logger.info('Database initialized');

    // Initialize metadata providers
    await initializeProviders();
    logger.info('Metadata providers initialized');

    // Start background job processor
    await metadataJobQueue.startProcessor(processJob, 5000); // Check for jobs every 5 seconds
    logger.info('Metadata job processor started');

    // Start image download queue processor (runs independently with per-provider rate limiting)
    await imageDownloadQueue.startProcessor(500); // Check every 500ms, rate limiting handled per-provider
    logger.info('Image download queue processor started');

    // Start bulk refresh scheduler (runs daily at 3am)
    bulkRefresher.start();
    logger.info('Bulk refresh scheduler started');

    // Start listening
    app.listen(PORT, () => {
      const serverUrl = process.env.SERVER_URL || `http://localhost:${PORT}`;
      logger.info(`nuLMD server running on port ${PORT}`);
      logger.info(`Server URL: ${serverUrl}`);
      logger.info(`Web UI available at ${serverUrl}`);
      logger.info(`API available at ${serverUrl}/api`);
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  metadataJobQueue.stopProcessor();
  imageDownloadQueue.stopProcessor();
  bulkRefresher.stop();
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  metadataJobQueue.stopProcessor();
  imageDownloadQueue.stopProcessor();
  bulkRefresher.stop();
  process.exit(0);
});

start();
