process.env.NODE_ENV = 'production';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const { logger } = require('./lib/logger');
const config = require('./lib/config');
const database = require('./sql/database');
const routes = require('./lib/routes');
const { logConnection, init: initRequestLog } = require('./lib/request');
const lidarr = require('./lib/lidarr');
const metaHandler = require('./lib/metaHandler');
const { registry } = require('./lib/providerRegistry');
const { initializeProviders } = require('./lib/providerRegistry');
const { lidarrSearch } = require('./lib/search');
const backgroundJobQueue = require('./lib/backgroundJobQueue');
const { processJob } = require('./lib/jobProcessor');
const imageDownloadQueue = require('./lib/imageDownloadQueue');
const lidarrClient = require('./lib/lidarrClient');

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
  // Only log non-browser requests (Lidarr, curl, API clients)
  // All browsers include 'Mozilla' in UA due to 1990s compat legacy
  const isWebApp = (req.headers['user-agent'] || '').includes('Mozilla');
  
  if (!isWebApp) {
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
    const formatted = await metaHandler.ensureArtist(mbid);
    logConnection({
        direction: 'inbound',
        label: 'Artist Lookup',
        detail: formatted.artistname || mbid.substring(0, 8) + '...',
        status: 'ok'
    });

    const artistCheck = await database.getArtist(mbid);
    if (artistCheck && !artistCheck.overview) {
      const wikiDone = await database.query(
        `SELECT 1 FROM metadata_jobs WHERE job_type = 'fetch_artist_wiki' AND entity_mbid = $1 AND status = 'completed' LIMIT 1`,
        [mbid]
      );
      if (wikiDone.rows.length === 0) {
        backgroundJobQueue.queueJob('fetch_artist_wiki', 'artist', mbid, 1);
      } else {
        logger.info(`Wiki already fetched for artist ${mbid}, skipping`);
      }
    }
    if (backgroundJobQueue.hasArtistImageProvider()) {
      backgroundJobQueue.queueJob('fetch_artist_images', 'artist', mbid, 1);
    }

    // Queue background job to fetch releases for all albums
    backgroundJobQueue.queueJob('fetch_artist_albums', 'artist', mbid, 1)
      .catch(err => logger.error(`Failed to queue fetch_artist_albums for ${mbid}:`, err));

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
    const formatted = await metaHandler.ensureAlbum(mbid);
    logConnection({
        direction: 'inbound',
        label: 'Album Lookup',
        detail: formatted.title || mbid.substring(0, 8) + '...',
        status: 'ok'
    });

    const albumCheck = await database.getReleaseGroup(mbid);
    if (albumCheck && !albumCheck.overview) {
      const wikiDone = await database.query(
        `SELECT 1 FROM metadata_jobs WHERE job_type = 'fetch_album_wiki' AND entity_mbid = $1 AND status = 'completed' LIMIT 1`,
        [mbid]
      );
      if (wikiDone.rows.length === 0) {
        backgroundJobQueue.queueJob('fetch_album_wiki', 'release_group', mbid, 1);
      } else {
        logger.info(`Wiki already fetched for album ${mbid}, skipping`);
      }
    }
    if (backgroundJobQueue.hasAlbumImageProvider()) {
      backgroundJobQueue.queueJob('fetch_album_images', 'release_group', mbid, 1);
    }

    res.json(formatted);
  } catch (error) {
    logger.error(`Error on album request ${req.params.mbid}:`, error);
    res.status(500).json({ error: error.message });
  }
});

// Lidarr search - delegates to search.js, replicates oldLMD /search behavior
app.get('/search', async (req, res) => {
  try {
    const { query, type, limit = 10, artist, includeTracks } = req.query;
    if (!query) return res.json([]);
    logger.info(`Lidarr search: ${query} (type=${type})`);
    logConnection({
        direction: 'inbound',
        label: 'Search',
        detail: query.length > 30 ? query.substring(0, 30) + '…' : query,
        status: 'ok'
    });
    const results = await lidarrSearch(query, type, {
      limit: parseInt(limit),
      artist,
      includeTracks: includeTracks === '1' || includeTracks === 'true'
    });
    if (results.error) {
      return res.status(results.status).json({ error: results.error });
    }
    res.json(results);
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

    // Load persisted request log from DB
    await initRequestLog(database);
    logger.info('Request log initialized');

    // Initialize metadata providers
    await initializeProviders();
    logger.info('Metadata providers initialized');

    // Start background job queue (MB + wiki + image worker pools)
    await backgroundJobQueue.startProcessor(processJob, 1000);
    logger.info('Background job queue started');

    // Start image download queue (downloads stored URLs to disk)
    await imageDownloadQueue.startProcessor(500);
    logger.info('Image download queue processor started');

    // Initialize Lidarr integration client
    lidarrClient.initialize();
    if (lidarrClient.enabled) {
      const result = await lidarrClient.testConnection();
      if (result.success) {
        logger.info(`Lidarr integration active — Lidarr v${result.version}`);
        await lidarrClient.refreshArtistMap();
      } else {
        logger.warn(`Lidarr integration enabled but connection failed: ${result.error}`);
      }
    }

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
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  backgroundJobQueue.stopProcessor();
  imageDownloadQueue.stopProcessor();
  process.exit(0);
});

start();
