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
const search = require('./lib/search');
const { registry } = require('./lib/providerRegistry');
const { initializeProviders } = require('./lib/providerRegistry');
const backgroundJobQueue = require('./lib/backgroundJobQueue');
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
    '/api/jobs/recent',
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
    const existingAlbums = await database.query(
      'SELECT rg.mbid FROM release_groups rg JOIN artist_release_groups arg ON arg.release_group_mbid = rg.mbid WHERE arg.artist_mbid = $1 LIMIT 1',
      [mbid]
    );
    if (existingAlbums.rows.length === 0) {
      backgroundJobQueue.queueJob('artist_full', 'artist', mbid, 5).catch(err => logger.error(`Failed to queue artist job ${mbid}:`, err));
    }
    const formatted = await metaHandler.ensureArtist(mbid);

    // Queue wiki/image jobs — Lidarr explicitly requested this artist
    backgroundJobQueue.queueJob('fetch_artist_wiki', 'artist', mbid, 1);
    if (backgroundJobQueue.hasArtistImageProvider()) {
      backgroundJobQueue.queueJob('fetch_artist_images', 'artist', mbid, 1);
    }

    res.json(formatted);
  } catch (error) {
    logger.error(`Error on artist request ${req.params.mbid}:`, error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/album/:mbid', async (req, res) => {
  try {
    const { mbid } = req.params;
    logger.info(`Lidarr album request: ${mbid}`);
    const existingReleases = await database.query(
      'SELECT mbid FROM releases WHERE release_group_mbid = $1 LIMIT 1',
      [mbid]
    );
    if (existingReleases.rows.length === 0) {
      backgroundJobQueue.queueJob('fetch_album_full', 'release_group', mbid, 5).catch(err => logger.error(`Failed to queue album job ${mbid}:`, err));
    }
    const formatted = await metaHandler.ensureAlbum(mbid);

    // Queue wiki/image jobs — Lidarr explicitly requested this album
    backgroundJobQueue.queueJob('fetch_album_wiki', 'release_group', mbid, 1);
    if (backgroundJobQueue.hasAlbumImageProvider()) {
      backgroundJobQueue.queueJob('fetch_album_images', 'release_group', mbid, 1);
    }

    res.json(formatted);
  } catch (error) {
    logger.error(`Error on album request ${req.params.mbid}:`, error);
    res.status(500).json({ error: error.message });
  }
});

// Lidarr search - lightweight, no storage
app.get('/search', async (req, res) => {
  try {
    const { query, limit = 3 } = req.query;

    if (!query) return res.json([]);

    logger.info(`Lidarr search: ${query}`);

    const [artistResults, albumResults] = await Promise.all([
      search.searchArtists(query, limit),
      search.searchAlbums(query, limit)
    ]);

    logger.info(`Found ${artistResults.length} artists and ${albumResults.length} albums for "${query}"`);

    const artists = artistResults.map(result => ({
      Id: result.id,
      ArtistName: result.name,
      SortName: result.sortName || result.name,
      Disambiguation: result.disambiguation || '',
      Status: 'active',
      Type: result.type || null,
      Country: result.country || '',
      Gender: '',
      Overview: result.overview || '',
      Rating: { Count: 0, Value: null },
      ArtistAliases: [],
      Tags: [],
      Genres: [],
      Links: [],
      Images: result.images || [],
      Albums: [],
      OldIds: []
    }));

    const albums = albumResults.map(result => {
      const artistCredit = result.artistCredit || [];
      const artistId = artistCredit.length > 0 ? artistCredit[0].artist.id : '';
      return {
        id: result.id,
        title: result.title,
        disambiguation: result.disambiguation || '',
        overview: '',
        releasedate: result.firstReleaseDate || null,
        artistid: artistId,
        artists: [], releases: [], aliases: [], oldids: [],
        rating: { Count: 0, Value: null },
        genres: [], links: [],
        images: result.images || []
      };
    });

    res.json([
      ...artists.map(a => ({ album: null, artist: a, score: 100 })),
      ...albums.map(a => ({ album: a, artist: null, score: 100 }))
    ]);
  } catch (error) {
    logger.error(`Error in search endpoint:`, error);
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

    // Start background job queue (MB + wiki + image worker pools)
    await backgroundJobQueue.startProcessor(processJob, 1000);
    logger.info('Background job queue started');

    // Start image download queue (downloads stored URLs to disk)
    await imageDownloadQueue.startProcessor(500);
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
  backgroundJobQueue.stopProcessor();
  imageDownloadQueue.stopProcessor();
  bulkRefresher.stop();
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  backgroundJobQueue.stopProcessor();
  imageDownloadQueue.stopProcessor();
  bulkRefresher.stop();
  process.exit(0);
});

start();
