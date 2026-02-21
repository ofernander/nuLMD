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
    const artist = await database.getArtist(mbid);

    if (artist) {
      // Artist exists - check if TTL expired (7 days)
      const now = new Date();
      const ttlExpired = artist.ttl_expires_at && new Date(artist.ttl_expires_at) < now;
      
      if (ttlExpired) {
        logger.info(`Artist ${mbid} TTL expired, refreshing from MusicBrainz`);
        await metaHandler.refreshArtist(mbid);
      }
      
      // Update access tracking
      await database.updateArtistAccess(mbid);
      
      // Return formatted data
      const formatted = await lidarr.formatArtist(mbid);
      return res.json(formatted);
    }

    // No data at all - fetch artist immediately
    logger.info(`Artist ${mbid} not in DB, fetching from MusicBrainz`);
    await metaHandler.getArtist(mbid);
    
    // Return formatted data
    const formatted = await lidarr.formatArtist(mbid);
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

// Metadata browser endpoints
router.get('/metadata/artists', async (req, res, next) => {
  try {
    const artists = await database.getAllArtistsWithCounts();
    res.json(artists);
  } catch (error) {
    next(error);
  }
});

router.get('/metadata/artist/:mbid', async (req, res, next) => {
  try {
    const { mbid } = req.params;
    
    // Get artist
    const artist = await database.getArtistWithMetadata(mbid);
    
    // Get albums with release status info and secondary types
    const albumsResult = await database.query(`
      SELECT 
        rg.mbid,
        rg.title,
        rg.primary_type,
        rg.secondary_types,
        rg.first_release_date,
        rg.last_updated_at,
        COUNT(DISTINCT r.mbid) as release_count,
        COUNT(DISTINCT t.mbid) as track_count,
        (
          SELECT r2.status
          FROM releases r2
          WHERE r2.release_group_mbid = rg.mbid
          ORDER BY 
            CASE WHEN r2.status = 'Official' THEN 0 ELSE 1 END,
            r2.release_date ASC NULLS LAST
          LIMIT 1
        ) as first_release_status
      FROM release_groups rg
      JOIN artist_release_groups arg ON arg.release_group_mbid = rg.mbid
      LEFT JOIN releases r ON r.release_group_mbid = rg.mbid
      LEFT JOIN tracks t ON t.release_mbid = r.mbid
      WHERE arg.artist_mbid = $1
      GROUP BY rg.mbid, rg.title, rg.primary_type, rg.secondary_types, rg.first_release_date, rg.last_updated_at
      ORDER BY rg.first_release_date DESC NULLS LAST
    `, [mbid]);
    
    res.json({
      artist,
      albums: albumsResult.rows
    });
  } catch (error) {
    next(error);
  }
});

router.get('/metadata/album-tracks/:mbid', async (req, res, next) => {
  try {
    const { mbid } = req.params;
    
    // Query database for tracks from ONLY the first release of this album
    const result = await database.query(`
      SELECT 
        t.mbid,
        t.title,
        t.position,
        t.medium_number,
        t.length_ms
      FROM tracks t
      WHERE t.release_mbid = (
        SELECT r.mbid
        FROM releases r
        WHERE r.release_group_mbid = $1
        ORDER BY 
          CASE WHEN r.status = 'Official' THEN 0 ELSE 1 END,
          r.release_date ASC NULLS LAST
        LIMIT 1
      )
      ORDER BY t.medium_number, t.position
    `, [mbid]);
    
    res.json({
      tracks: result.rows
    });
  } catch (error) {
    next(error);
  }
});

// UI fetch endpoints - respond immediately, run in background
router.post('/ui/fetch-artist/:mbid', async (req, res, next) => {
  try {
    const { mbid } = req.params;
    await metadataJobQueue.queueJob('artist_full', 'artist', mbid, 10);
    logger.info(`UI artist fetch queued for ${mbid}`);
    res.json({ success: true, message: `Fetch queued for ${mbid}` });
  } catch (error) {
    next(error);
  }
});

router.post('/ui/fetch-album/:mbid', async (req, res, next) => {
  try {
    const { mbid } = req.params;
    await metadataJobQueue.queueJob('fetch_album_full', 'release_group', mbid, 10);
    logger.info(`UI album fetch queued for ${mbid}`);
    res.json({ success: true, message: `Fetch queued for ${mbid}` });
  } catch (error) {
    next(error);
  }
});

// Refresh endpoints
const bulkRefresher = require('./bulkRefresher');

router.get('/refresh/status', async (req, res, next) => {
  try {
    const status = await bulkRefresher.getStatus();
    res.json(status);
  } catch (error) {
    next(error);
  }
});

router.post('/refresh/artist/:mbid', async (req, res, next) => {
  try {
    const { mbid } = req.params;
    logger.info(`Manual refresh requested for artist ${mbid}`);
    
    await metaHandler.refreshArtist(mbid);
    
    res.json({ success: true, message: `Artist ${mbid} refreshed successfully` });
  } catch (error) {
    next(error);
  }
});

router.post('/refresh/all', async (req, res, next) => {
  try {
    // Start async, don't wait
    bulkRefresher.triggerManualRefresh().catch(err => {
      logger.error('Manual bulk refresh failed:', err);
    });
    
    res.json({ success: true, message: 'Bulk refresh started in background' });
  } catch (error) {
    next(error);
  }
});

// Recent jobs endpoint
router.get('/jobs/recent', async (req, res, next) => {
  try {
    const result = await database.query(`
      SELECT 
        j.id, j.job_type, j.entity_type, j.entity_mbid, j.status,
        j.created_at, j.started_at, j.completed_at, j.error_message,
        COALESCE(a.name, rg.title) as entity_name,
        CASE
          WHEN j.entity_type != 'artist' THEN
            COALESCE(
              (SELECT ar.name FROM artists ar
               JOIN artist_release_groups arg_n ON arg_n.artist_mbid = ar.mbid
               WHERE arg_n.release_group_mbid = j.entity_mbid
               LIMIT 1),
              (SELECT rg_ac.artist_credit->0->>'name'
               FROM release_groups rg_ac
               WHERE rg_ac.mbid = j.entity_mbid
               LIMIT 1)
            )
          ELSE NULL
        END as artist_name,
        CASE
          WHEN j.entity_type = 'artist' THEN
            (SELECT COUNT(*) FROM release_groups rg2
             JOIN artist_release_groups arg ON arg.release_group_mbid = rg2.mbid
             WHERE arg.artist_mbid = j.entity_mbid)
          ELSE 0
        END as album_count,
        CASE
          WHEN j.entity_type = 'artist' THEN
            (SELECT COUNT(*) FROM releases r
             JOIN release_groups rg3 ON rg3.mbid = r.release_group_mbid
             JOIN artist_release_groups arg2 ON arg2.release_group_mbid = rg3.mbid
             WHERE arg2.artist_mbid = j.entity_mbid)
          ELSE
            (SELECT COUNT(*) FROM releases r WHERE r.release_group_mbid = j.entity_mbid)
        END as release_count,
        CASE
          WHEN j.entity_type = 'artist' THEN
            (SELECT COUNT(DISTINCT t.recording_mbid) FROM tracks t
             JOIN releases r2 ON r2.mbid = t.release_mbid
             JOIN release_groups rg4 ON rg4.mbid = r2.release_group_mbid
             JOIN artist_release_groups arg3 ON arg3.release_group_mbid = rg4.mbid
             WHERE arg3.artist_mbid = j.entity_mbid)
          ELSE
            (SELECT COUNT(DISTINCT t.recording_mbid) FROM tracks t
             JOIN releases r3 ON r3.mbid = t.release_mbid
             WHERE r3.release_group_mbid = j.entity_mbid)
        END as track_count
      FROM metadata_jobs j
      LEFT JOIN artists a ON a.mbid = j.entity_mbid
      LEFT JOIN release_groups rg ON rg.mbid = j.entity_mbid
      ORDER BY j.created_at DESC
      LIMIT 50
    `);
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
});

// Log files list endpoint
router.get('/logs/files', async (req, res, next) => {
  try {
    const fs = require('fs').promises;
    const path = require('path');
    const logsDir = path.join(__dirname, '../../logs');

    const files = await fs.readdir(logsDir);
    const logFiles = files.filter(f => f.endsWith('.log') && !f.startsWith('.'));

    const fileStats = await Promise.all(logFiles.map(async (filename) => {
      const stat = await fs.stat(path.join(logsDir, filename));
      return {
        name: filename,
        size_bytes: stat.size,
        modified_at: stat.mtime
      };
    }));

    // Sort newest modified first
    fileStats.sort((a, b) => new Date(b.modified_at) - new Date(a.modified_at));

    res.json(fileStats);
  } catch (error) {
    if (error.code === 'ENOENT') return res.json([]);
    next(error);
  }
});

// Log file content endpoint
router.get('/logs/file', async (req, res, next) => {
  try {
    const fs = require('fs').promises;
    const path = require('path');
    const { name, tail = 500 } = req.query;

    if (!name) return res.status(400).json({ error: 'name parameter required' });

    // Prevent path traversal
    const safeName = path.basename(name);
    const filePath = path.join(__dirname, '../../logs', safeName);

    const content = await fs.readFile(filePath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    const tailLines = lines.slice(-parseInt(tail));

    // Parse JSON log lines
    const parsed = tailLines.map(line => {
      try { return JSON.parse(line); }
      catch { return { timestamp: null, level: 'info', message: line }; }
    });

    res.json(parsed);
  } catch (error) {
    if (error.code === 'ENOENT') return res.status(404).json({ error: 'Log file not found' });
    next(error);
  }
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
    
    // Filter out noisy low-level logs unless debug mode active
    const { logger: activeLogger } = require('./logger');
    if (activeLogger.level !== 'debug' && (level === 'debug' || level === 'http' || level === 'verbose' || level === 'silly')) return false;
    if (activeLogger.level === 'debug' && (level === 'http' || level === 'verbose' || level === 'silly')) return false;
    
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
