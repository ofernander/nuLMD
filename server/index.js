process.env.NODE_ENV = 'production';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const { logger, setLogLevel } = require('./lib/logger');
const config = require('./lib/config');
const database = require('./sql/database');
const routes = require('./lib/routes');
const replySummary = require('./lib/replySummary');
const { logConnection, clientOf, init: initRequestLog, trackRequest, trackImage, flushImageBursts } = require('./lib/request');
const metaHandler = require('./lib/metaHandler');
const { registry } = require('./lib/providerRegistry');
const { initializeProviders } = require('./lib/providerRegistry');
const { lidarrSearch } = require('./lib/search');
const backgroundJobQueue = require('./lib/backgroundJobQueue');
const { processJob } = require('./lib/jobProcessor');
const imageDownloadQueue = require('./lib/imageDownloadQueue');
const lidarrClient = require('./lib/lidarrClient');
const blocklist = require('./lib/blocklist');

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

// The request card: what each of these requests has nuLMD call on its way to an answer is kept on its row
app.use(['/artist', '/album', '/search', '/ws/2'], trackRequest);

// ...and the image files Lidarr pulls from nuLMD (and the placeholder it is sent for a cover that is not there yet),
// grouped into one row per burst. Before the static files, which serve the placeholder.
app.get('/api/images/:type/:mbid/:file', trackImage);
app.get('/assets/placeholder.png', trackImage);

// Serve static files for Web UI
app.use(express.static(path.join(__dirname, '../public')));

// Lidarr API Routes (at root level, no /api prefix)
app.get('/artist/:mbid', async (req, res) => {
  try {
    const { mbid } = req.params;
    logger.info(`Lidarr artist request: ${mbid}`);
    const started = Date.now();
    const served = {};
    const formatted = await metaHandler.ensureArtist(mbid, served);
    const blocked = blocklist.isBlocked('artist', mbid);
    const catalogPending = !blocked && await metaHandler.catalogDue(mbid);
    logConnection({
        direction: 'inbound',
        label: 'Artist Lookup',
        detail: formatted.artistname || mbid.substring(0, 8) + '...',
        status: 'ok',
        api: 'LMD',
        outcome: served.how || null,
        reply: replySummary.describeArtist(formatted, { catalogPending }),
        durationMs: Date.now() - started,
        ...clientOf(req)
    });

    // The catalog (every release group and release, fetched in bulk) is brought up in the background when it is
    // missing or past its TTL. Until it is ready Lidarr is served what we hold, and is asked to refresh when done.
    if (catalogPending) {
      backgroundJobQueue.forceQueueJob('fetch_artist_albums', 'artist', mbid, 1, { via: 'artist-request' }, null, mbid)
        .catch(err => logger.error(`Failed to queue fetch_artist_albums for ${mbid}:`, err));
    } else if (!blocked && await metaHandler.imagesDue(mbid)) {
      // Held from an earlier preview and now in Lidarr: only the image lookups are missing, and Lidarr is refreshed when they are done
      backgroundJobQueue.forceQueueJob('fetch_artist_albums', 'artist', mbid, 1, { imagesOnly: true, via: 'artist-request' }, null, mbid)
        .catch(err => logger.error(`Failed to queue the image catch-up for ${mbid}:`, err));
    }

    res.json(formatted);
  } catch (error) {
    logger.error(`Error on artist request ${req.params.mbid}:`, error);
    logConnection({ direction: 'inbound', label: 'Artist Lookup', detail: req.params.mbid.substring(0, 8) + '...', status: 'error', api: 'LMD',
        outcome: `error: ${error.message}`, ...clientOf(req) });
    res.status(500).json({ error: error.message });
  }
});

app.get('/album/:mbid', async (req, res) => {
  try {
    const { mbid } = req.params;
    logger.info(`Lidarr album request: ${mbid}`);
    const started = Date.now();
    const { formatted, needsFullFetch, served } = await metaHandler.ensureAlbum(mbid);
    metaHandler.queueCatalogForAlbum(mbid);   // not awaited: the reply must not wait for it
    if (needsFullFetch) {
      backgroundJobQueue.queueJob('fetch_album_full', 'release_group', mbid, 1)
        .catch(err => logger.error(`Failed to queue fetch_album_full for ${mbid}:`, err));
    }
    logConnection({
        direction: 'inbound',
        label: 'Album Lookup',
        detail: formatted.title || mbid.substring(0, 8) + '...',
        status: 'ok',
        api: 'LMD',
        outcome: served || null,
        reply: replySummary.describeAlbum(formatted),
        durationMs: Date.now() - started,
        ...clientOf(req)
    });

    res.json(formatted);
  } catch (error) {
    if (error.blocked) {
      logConnection({ direction: 'inbound', label: 'Album Lookup', detail: req.params.mbid.substring(0, 8) + '...', status: 'ok', api: 'LMD',
          outcome: 'blocked', reply: 'not found (blocked)', ...clientOf(req) });
      return res.status(404).json({ error: 'Not found' });
    }
    logger.error(`Error on album request ${req.params.mbid}:`, error);
    logConnection({ direction: 'inbound', label: 'Album Lookup', detail: req.params.mbid.substring(0, 8) + '...', status: 'error', api: 'LMD',
        outcome: `error: ${error.message}`, ...clientOf(req) });
    res.status(500).json({ error: error.message });
  }
});

// Lidarr search - delegates to search.js, replicates oldLMD /search behavior
app.get('/search', async (req, res) => {
  try {
    const { query, type, limit = 5, artist, includeTracks } = req.query;
    if (!query) return res.json([]);
    logger.info(`Lidarr search: ${query} (type=${type})`);
    const started = Date.now();
    const searched = { direction: 'inbound', label: 'Search', detail: query.length > 30 ? query.substring(0, 30) + '…' : query, api: 'LMD', ...clientOf(req) };
    const results = await lidarrSearch(query, type, {
      // Hard-cap at 5 regardless of what Lidarr requests — top matches are always near
      // the top, and fewer results = less per-result formatting work.
      limit: Math.min(parseInt(limit) || 5, 5),
      artist,
      includeTracks: includeTracks === '1' || includeTracks === 'true'
    });
    if (results.error) {
      logConnection({ ...searched, status: 'error', outcome: `error: ${results.error}`, durationMs: Date.now() - started });
      return res.status(results.status).json({ error: results.error });
    }
    logConnection({ ...searched, status: 'ok', reply: replySummary.describeSearch(results), durationMs: Date.now() - started });
    res.json(results);
  } catch (error) {
    logger.error(`Error in search endpoint:`, error);
    const q = String(req.query.query || '');
    logConnection({ direction: 'inbound', label: 'Search', detail: q.length > 30 ? q.substring(0, 30) + '…' : q, status: 'error', api: 'LMD',
        outcome: `error: ${error.message}`, ...clientOf(req) });
    res.status(500).json({ error: error.message });
  }
});

// API Routes (internal, for Web UI)
app.use('/api', routes);
app.use('/ws/2', require('./lib/mbWs/routes').createRouter());

// Health check
app.get('/health', async (req, res) => {
  const DB_TIMEOUT_MS = 2000;

  const dbCheck = (async () => {
    try {
      const t0 = Date.now();
      await Promise.race([
        database.query('SELECT 1'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), DB_TIMEOUT_MS))
      ]);
      return { ok: true, latency_ms: Date.now() - t0 };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  })();

  const lidarrCheck = (async () => {
    try {
      const s = lidarrClient.getStats();
      return { ok: !s.enabled || s.connected, enabled: !!s.enabled, connected: !!s.connected };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  })();

  const queueCheck = (async () => {
    try {
      const s = await backgroundJobQueue.getStats();
      return { ok: true, active: s.processing || 0, pending: s.pending || 0 };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  })();

  const [database_, lidarr_, job_queue_] = await Promise.all([dbCheck, lidarrCheck, queueCheck]);
  const checks = { database: database_, lidarr: lidarr_, job_queue: job_queue_ };

  // Status determination:
  //   unhealthy (503) — DB broken; restart-worthy
  //   degraded (200)  — non-critical dependency broken; do not restart
  //   ok (200)        — everything works
  let status;
  if (!checks.database.ok) status = 'unhealthy';
  else if (!checks.lidarr.ok) status = 'degraded';
  else status = 'ok';

  res.status(status === 'unhealthy' ? 503 : 200).json({
    status,
    version: require('../package.json').version,
    uptime_seconds: Math.round(process.uptime()),
    checks
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

    // Apply persisted log level — overrides env var if user has saved a preference via UI
    const persistedLevel = config.get('server.logLevel');
    if (persistedLevel) {
      setLogLevel(persistedLevel);
      logger.info(`Log level applied from config: ${persistedLevel}`);
    }

    // Initialize database
    await database.initialize();
    logger.info('Database initialized');

    // What the user has blocked is held in memory from here on (every store and queued job checks it)
    await blocklist.load();

    // Load persisted request log from DB
    await initRequestLog(database, { retentionDays: Number(config.get('logs.requestLogDays', 30)) });
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

    // Periodic health check — reconnects if Lidarr restarts after nuLMD starts
    lidarrClient.startHealthCheck();

    // Start listening
    app.listen(PORT, () => {
      const serverUrl = process.env.SERVER_URL || `http://localhost:${PORT}`;
      logger.info(`nuLMD server running on port ${PORT}`);
      logger.info(`Server URL: ${serverUrl}`);
      logger.info(`Web UI available at ${serverUrl}`);
      logger.info(`API available at ${serverUrl}/api`);
    });
  } catch (error) {
    if (error.code === 'NULMD_LEGACY_DB') {
      // Not a crash to debug: the user has a v4 database and needs the upgrade steps, not a stack trace
      logger.error(`\n${error.message}\n`);
    } else {
      logger.error('Failed to start server:', error);
    }
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  flushImageBursts();   // an image burst still open is written out
  backgroundJobQueue.stopProcessor();
  imageDownloadQueue.stopProcessor();
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  flushImageBursts();   // an image burst still open is written out
  backgroundJobQueue.stopProcessor();
  imageDownloadQueue.stopProcessor();
  process.exit(0);
});

start();
