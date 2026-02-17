const express = require('express');
const router = express.Router();
const { registry } = require('./providerRegistry');
const config = require('./config');
const cache = require('./cache');
const { logger, getRecentLogs } = require('./logger');
const metaHandler = require('./metaHandler');
const lidarr = require('./lidarr');
const metadataJobQueue = require('./metadataJobQueue');
const database = require('../sql/database');

// API version
router.get('/version', (req, res) => {
  res.json({
    name: 'nuLMD',
    version: require('../../package.json').version,
    providers: registry.getActiveProviderNames()
  });
});

// Job queue stats
router.get('/jobs/stats', async (req, res, next) => {
  try {
    const stats = await metadataJobQueue.getStats();
    res.json(stats);
  } catch (error) {
    next(error);
  }
});

// System stats
router.get('/stats', async (req, res, next) => {
  try {
    const [dbStats, jobStats] = await Promise.all([
      database.getStats(),
      metadataJobQueue.getStats()
    ]);
    
    // Calculate uptime
    const uptimeSeconds = process.uptime();
    const hours = Math.floor(uptimeSeconds / 3600);
    const minutes = Math.floor((uptimeSeconds % 3600) / 60);
    const uptime = `${hours}h ${minutes}m`;
    
    // Calculate memory usage
    const memUsage = process.memoryUsage();
    const memoryMB = Math.round(memUsage.heapUsed / 1024 / 1024);
    
    res.json({
      uptime,
      database: {
        connected: true,
        artists: parseInt(dbStats.artist_count),
        albums: parseInt(dbStats.album_count),
        tracks: parseInt(dbStats.track_count),
        size_mb: Math.round(parseInt(dbStats.db_size_bytes) / 1024 / 1024)
      },
      jobs: {
        active: jobStats.processing || 0,
        pending: jobStats.pending || 0,
        completed: jobStats.completed || 0,
        failed: jobStats.failed || 0
      },
      memory: {
        used_mb: memoryMB,
        total_mb: Math.round(memUsage.heapTotal / 1024 / 1024)
      }
    });
  } catch (error) {
    next(error);
  }
});

// Artist search - returns Lidarr-formatted artists
router.get('/search/artist', async (req, res, next) => {
  try {
    const { query, limit = 10 } = req.query;

    if (!query) {
      return res.status(400).json({ error: 'Query parameter is required' });
    }

    // Search and get basic results
    const searchResults = await metaHandler.searchArtist(query, parseInt(limit));
    
    // Format each result with Lidarr formatter
    const formatted = [];
    for (const artist of searchResults) {
      try {
        const lidarrArtist = await lidarr.formatArtist(artist.Id);
        formatted.push(lidarrArtist);
      } catch (error) {
        logger.error(`Failed to format artist ${artist.Id}:`, error);
        // Fall back to basic format
        formatted.push(artist);
      }
    }
    
    res.json(formatted);
  } catch (error) {
    next(error);
  }
});

// Get artist by ID - Lidarr format
router.get('/artist/:mbid', async (req, res, next) => {
  try {
    const { mbid } = req.params;

    // Check if we have the artist in DB
    logger.info(`Checking database for artist ${mbid}`);
    const artist = await database.getArtist(mbid);
    logger.info(`Artist found in DB: ${!!artist}`);

    // If we have artist data, check if it needs refresh
    if (artist) {
      const needsRefresh = await database.artistNeedsRefresh(artist);
      
      if (needsRefresh) {
        // Queue background refresh job
        await metadataJobQueue.queueJob('artist_releases', 'artist', mbid, 10);
        const reason = !artist.fetch_complete ? 'incomplete fetch' : 'data > 30 days old';
        logger.info(`Queued refresh job for artist ${mbid} (${reason})`);
      }
      
      // Return formatted data using Lidarr formatter
      await database.updateArtistAccess(mbid);
      const formatted = await lidarr.formatArtist(mbid);
      
      // Add status flags
      if (!artist.fetch_complete) {
        formatted._incomplete = true;
        formatted._status = `Fetching releases in background (${formatted.Albums.length} so far)`;
      }
      
      if (needsRefresh && artist.fetch_complete) {
        formatted._refreshing = true;
        formatted._status = 'Checking for new releases in background';
      }
      
      return res.json(formatted);
    }

    // No data at all - fetch artist immediately and queue releases for background
    logger.info(`No data for artist ${mbid}, fetching immediately`);
    const result = await metaHandler.getArtist(mbid);
    
    // Queue background job for full release data
    await metadataJobQueue.queueJob('artist_releases', 'artist', mbid, 10);
    logger.info(`Queued background job to fetch releases for NEW artist ${mbid}`);
    
    // Format and return
    const formatted = await lidarr.formatArtist(mbid);
    formatted._incomplete = true;
    formatted._status = 'Fetching releases in background';
    
    res.json(formatted);
  } catch (error) {
    next(error);
  }
});

// Get album by ID - Lidarr format
router.get('/album/:mbid', async (req, res, next) => {
  try {
    const { mbid } = req.params;

    const formatted = await lidarr.formatAlbum(mbid);
    res.json(formatted);
  } catch (error) {
    next(error);
  }
});

// Album search - placeholder for now
router.get('/search/album', async (req, res, next) => {
  try {
    const { query, artist, limit = 10, provider } = req.query;

    if (!query) {
      return res.status(400).json({ error: 'Query parameter is required' });
    }

    let results;

    if (provider) {
      const p = registry.getProvider(provider);
      if (!p) {
        return res.status(404).json({ error: `Provider ${provider} not found or not enabled` });
      }
      results = { [provider]: await p.searchAlbum(query, artist, parseInt(limit)) };
    } else {
      results = await registry.queryAll('searchAlbum', query, artist, parseInt(limit));
    }

    res.json(results);
  } catch (error) {
    next(error);
  }
});

// Old album endpoints - kept for backwards compatibility
router.get('/album/:provider/:id', async (req, res, next) => {
  try {
    const { provider, id } = req.params;

    const p = registry.getProvider(provider);
    if (!p) {
      return res.status(404).json({ error: `Provider ${provider} not found or not enabled` });
    }

    const album = await p.getAlbum(id);
    res.json(album);
  } catch (error) {
    next(error);
  }
});

router.get('/album/:provider/:id/tracks', async (req, res, next) => {
  try {
    const { provider, id } = req.params;

    const p = registry.getProvider(provider);
    if (!p) {
      return res.status(404).json({ error: `Provider ${provider} not found or not enabled` });
    }

    const tracks = await p.getAlbumTracks(id);
    res.json(tracks);
  } catch (error) {
    next(error);
  }
});

// Image serving endpoint
router.get('/images/:entity_type/:mbid/:filename', async (req, res, next) => {
  try {
    const { entity_type, mbid, filename } = req.params;
    const path = require('path');
    const fs = require('fs').promises;
    
    // Construct the file path
    const imagePath = path.join(__dirname, '../../data/images', entity_type, mbid, filename);
    
    // Check if file exists
    try {
      await fs.access(imagePath);
    } catch (error) {
      return res.status(404).json({ error: 'Image not found' });
    }
    
    // Determine content type from extension
    const ext = path.extname(filename).toLowerCase();
    const contentTypes = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp'
    };
    
    const contentType = contentTypes[ext] || 'application/octet-stream';
    
    // Send the file
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=31536000'); // Cache for 1 year
    res.sendFile(imagePath);
    
  } catch (error) {
    next(error);
  }
});

// Configuration endpoints
router.get('/config', (req, res) => {
  const cfg = config.getAll();
  // Show masked API keys (first 4 chars + ***) so user knows if configured
  if (cfg.providers) {
    Object.keys(cfg.providers).forEach(key => {
      const provider = cfg.providers[key];
      if (provider.apiKey && provider.apiKey.length > 4) {
        provider.apiKey = provider.apiKey.substring(0, 4) + '***';
      }
      if (provider.clientSecret && provider.clientSecret.length > 4) {
        provider.clientSecret = provider.clientSecret.substring(0, 4) + '***';
      }
      if (provider.token && provider.token.length > 4) {
        provider.token = provider.token.substring(0, 4) + '***';
      }
    });
  }
  res.json(cfg);
});

router.post('/config', async (req, res, next) => {
  try {
    const updates = req.body;
    
    // Update configuration
    Object.keys(updates).forEach(key => {
      config.set(key, updates[key]);
    });
    
    // Save to file
    await config.save();
    
    res.json({ success: true, message: 'Configuration updated. Restart server to apply changes.' });
  } catch (error) {
    next(error);
  }
});

// Cache management
router.get('/cache/stats', (req, res) => {
  const stats = cache.getStats();
  res.json(stats);
});

router.post('/cache/flush', (req, res) => {
  cache.flush();
  res.json({ success: true, message: 'Cache flushed' });
});

// Provider status
router.get('/providers', (req, res) => {
  const providers = registry.getActiveProviderNames().map(name => {
    const provider = registry.getProvider(name);
    return {
      name: name,
      type: provider.name,
      configured: true
    };
  });
  
  res.json(providers);
});

// Log level endpoints
router.get('/log-level', (req, res) => {
  const { logger } = require('./logger');
  res.json({ level: logger.level });
});

router.post('/log-level', (req, res) => {
  const { level } = req.body;
  const { setLogLevel } = require('./logger');
  
  if (!['error', 'warn', 'info', 'debug'].includes(level)) {
    return res.status(400).json({ error: 'Invalid log level' });
  }
  
  setLogLevel(level);
  res.json({ success: true, level });
});

// Server restart endpoint
router.post('/restart', (req, res) => {
  logger.info('Server restart requested via API');
  res.json({ success: true, message: 'Server restarting...' });
  
  // Give response time to send before exiting
  setTimeout(() => {
    logger.info('Exiting process for restart (Docker will restart container)');
    process.exit(0);
  }, 100);
});

// Log tail endpoint
router.get('/logs/tail', (req, res) => {
  const { lines = 100 } = req.query;
  
  // Get MORE logs from buffer (since filtering removes most)
  // Request 10x what we want to display to account for filtering
  const bufferSize = Math.min(parseInt(lines) * 10, 5000);
  
  // Get recent logs from in-memory buffer and filter to only metadata-relevant logs
  const allLogs = getRecentLogs(bufferSize);
  const filteredLogs = allLogs.filter(log => {
    const msg = log.message || '';
    const level = log.level || 'info';
    
    // Only show INFO, WARN, and ERROR levels (skip DEBUG)
    if (level === 'debug' || level === 'http' || level === 'verbose' || level === 'silly') return false;
    
    // Filter out HTTP requests (not metadata work)
    if (msg.startsWith('GET ') || msg.startsWith('POST ') || msg.startsWith('PUT ') || msg.startsWith('DELETE ')) return false;
    
    // Filter out generic database messages
    if (msg === 'Executed query') return false;
    
    // Filter out startup messages after initial load
    if (msg.includes('server running on port')) return false;
    if (msg.includes('Web UI available')) return false;
    if (msg.includes('API available at')) return false;
    if (msg.includes('Starting job queue')) return false;
    if (msg.includes('Background job processor started')) return false;
    if (msg.includes('Configuration loaded')) return false;
    
    // Keep metadata work logs
    return true;
  });
  
  res.json(filteredLogs);
});

module.exports = router;
