const express = require('express');
const router = express.Router();
const { createKeyRouter } = require('./mbWs/keyRoutes');
const { getRequestLog } = require('./request');
const { registry } = require('./providerRegistry');
const config = require('./config');
const { resolveMusicBrainzSources, sanitizeSources, normalizeUrl, isOfficialUrl } = require('./mbSources');
const { logger, getRecentLogs, resolveLevel } = require('./logger');
const metaHandler = require('./metaHandler');
const lidarr = require('./lidarr');
const backgroundJobQueue = require('./backgroundJobQueue');
const lidarrClient = require('./lidarrClient');
const { USER_AGENT } = require('./userAgent');
const database = require('../sql/database');
const blocklist = require('./blocklist');
const metadataClear = require('./metadataClear');
const multer = require('multer');
const fs = require('fs').promises;
const path = require('path');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const ARTIST_IMAGE_TYPES = ['Poster', 'Banner', 'Fanart', 'Logo', 'Clearart', 'Thumb'];
const ALBUM_IMAGE_TYPES  = ['Cover', 'Disc', 'Clearart'];
const MIME_TO_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const IMAGES_BASE = path.join(__dirname, '../../data/images');

// Shell out to `du` for accurate directory size — same as `du -sb`
// Result is cached for 30 seconds to avoid running on every stats poll
const { execFile } = require('child_process');
let _imageDirSizeCache = { bytes: 0, ts: 0 };
const IMAGE_DIR_SIZE_TTL = 30000;

async function getDirSizeBytes(dirPath) {
  if (Date.now() - _imageDirSizeCache.ts < IMAGE_DIR_SIZE_TTL) {
    return _imageDirSizeCache.bytes;
  }
  return new Promise(resolve => {
    execFile('du', ['-sb', dirPath], (err, stdout) => {
      if (err) { resolve(_imageDirSizeCache.bytes); return; }
      const bytes = parseInt(stdout.split('\t')[0], 10) || 0;
      _imageDirSizeCache = { bytes, ts: Date.now() };
      resolve(bytes);
    });
  });
}

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
    const stats = await backgroundJobQueue.getStats();
    res.json(stats);
  } catch (error) {
    next(error);
  }
});

router.post('/jobs/clear', async (req, res, next) => {
  try {
    const result = await database.query(
      `DELETE FROM metadata_jobs WHERE status = 'pending' RETURNING id`
    );
    logger.info(`Cleared ${result.rows.length} pending jobs from queue`);
    res.json({ success: true, cleared: result.rows.length });
  } catch (error) { next(error); }
});

router.post('/jobs/kill-active', async (req, res, next) => {
  try {
    const result = await database.query(
      `UPDATE metadata_jobs SET status = 'failed', error_message = 'Killed by user', attempts = max_attempts
       WHERE status = 'processing' RETURNING id`
    );
    logger.info(`Killed ${result.rows.length} active jobs`);
    res.json({ success: true, killed: result.rows.length });
  } catch (error) { next(error); }
});

router.post('/downloads/clear', async (req, res, next) => {
  try {
    const result = await database.query(
      `UPDATE images SET cache_failed = true, cache_failed_reason = 'Cleared by user'
       WHERE cached = false AND cache_failed = false RETURNING id`
    );
    logger.info(`Cleared ${result.rows.length} pending downloads`);
    res.json({ success: true, cleared: result.rows.length });
  } catch (error) { next(error); }
});

// System stats
router.get('/stats', async (req, res, next) => {
  try {
    const [dbStats, jobStats, imageDirBytes] = await Promise.all([
      database.getStats(),
      backgroundJobQueue.getStats(),
      getDirSizeBytes(IMAGES_BASE)
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
        releases: parseInt(dbStats.release_count),
        tracks: parseInt(dbStats.track_count),
        images: parseInt(dbStats.cached_images),
        images_mb: Math.round(imageDirBytes / 1024 / 1024 * 10) / 10,
        size_mb: Math.round(parseInt(dbStats.db_size_bytes) / 1024 / 1024),
        // Where each artist's catalog stands: checked against MusicBrainz, older (renewed at its TTL), taken from an
        // upstream while MusicBrainz was down (provisional), or not fetched yet
        catalogs: {
          verified: parseInt(dbStats.catalogs_verified),
          unverified: parseInt(dbStats.catalogs_unverified),
          provisional: parseInt(dbStats.catalogs_provisional),
          incomplete: parseInt(dbStats.catalogs_incomplete)
        }
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

    // Blocked artists (the special MusicBrainz entities and the user's) are never fully processed
    if (blocklist.isBlocked('artist', mbid)) {
      logger.info(`Blocked artist ${mbid}, returning minimal response`);
      const formatted = await lidarr.formatArtist(mbid).catch(async () => lidarr.blockedArtist(mbid, await blocklist.nameOf('artist', mbid)));
      return res.json(formatted);
    }

    // Check if we have the artist in DB
    const artist = await database.getArtist(mbid);

    if (artist) {
      // Artist exists - check if TTL expired (configurable, default 30 days)
      const now = new Date();
      const ttlExpired = artist.ttl_expires_at && new Date(artist.ttl_expires_at) < now;
      
      if (ttlExpired) {
        backgroundJobQueue.queueJob('fetch_artist_albums', 'artist', mbid, 5, null, null, mbid)
          .catch(err => logger.error(`Failed to queue refresh for artist ${mbid}:`, err));
        logger.info(`Artist ${mbid} TTL expired, queued fetch_artist_albums, serving stale data`);
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

    // Queue fetch_artist_albums as the root job — spawns wiki/image children and
    // triggers Lidarr refresh when the entire tree completes.
    await backgroundJobQueue.queueJob('fetch_artist_albums', 'artist', mbid, 5, null, null, mbid);

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
    if (blocklist.isBlocked('release_group', mbid)) return res.status(404).json({ error: 'Not found' });

    const formatted = await lidarr.formatAlbum(mbid);

    // Only what still has something to look up is queued: the row itself remembers an overview, images, or a recorded
    // "nothing found" (the job table is pruned, so a finished job is not proof of anything)
    if ((await backgroundJobQueue.albumsNeedingWiki([mbid])).length > 0) {
      await backgroundJobQueue.queueJob('fetch_album_wiki', 'release_group', mbid, 1);
    }
    if (backgroundJobQueue.hasAlbumImageProvider() && (await backgroundJobQueue.albumsNeedingImages([mbid])).length > 0) {
      await backgroundJobQueue.queueJob('fetch_album_images', 'release_group', mbid, 1);
    }

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

// Configuration endpoints
router.get('/config', (req, res) => {
  const cfg = config.getAll();
  // Resolve env vars so UI shows what's actually in use
  if (cfg.providers?.musicbrainz) {
    if (!cfg.providers.musicbrainz.baseUrl) {
      cfg.providers.musicbrainz.baseUrl = process.env.MUSICBRAINZ_URL || '';
    }
    // Effective source list: UI-added + compose-seeded (flagged fromEnv, read-only in the UI)
    cfg.providers.musicbrainz.sources = resolveMusicBrainzSources(config.get('providers.musicbrainz', {}));
  }
  // Fanart and the Lidarr integration are shown as they are in use: environment values win, "enabled" is whether they have
  // what they need, and the *FromEnv marks tell the UI which fields can only be changed in compose. Copies, so what is
  // masked below is never the live configuration.
  {
    const fanart = config.fanartSettings();
    cfg.providers = { ...cfg.providers, fanart: { ...(cfg.providers && cfg.providers.fanart), apiKey: fanart.apiKey, enabled: fanart.enabled, apiKeyFromEnv: fanart.apiKeyFromEnv } };
    const lidarrSettings = config.lidarrSettings();
    cfg.lidarrIntegration = { ...cfg.lidarrIntegration, url: lidarrSettings.url, apiKey: lidarrSettings.apiKey, enabled: lidarrSettings.enabled,
      urlFromEnv: lidarrSettings.urlFromEnv, apiKeyFromEnv: lidarrSettings.apiKeyFromEnv };
  }
  // Show masked API keys (first half + ***) so user knows if configured
  if (cfg.providers) {
    Object.keys(cfg.providers).forEach(key => {
      const provider = cfg.providers[key];
      if (provider.apiKey && provider.apiKey.length > 4) {
        const half = Math.ceil(provider.apiKey.length / 2);
        provider.apiKey = provider.apiKey.substring(0, half) + '***';
      }
      if (provider.clientSecret && provider.clientSecret.length > 4) {
        const half = Math.ceil(provider.clientSecret.length / 2);
        provider.clientSecret = provider.clientSecret.substring(0, half) + '***';
      }
      if (provider.token && provider.token.length > 4) {
        const half = Math.ceil(provider.token.length / 2);
        provider.token = provider.token.substring(0, half) + '***';
      }
    });
  }
  // Mask lidarrIntegration API key
  if (cfg.lidarrIntegration?.apiKey && cfg.lidarrIntegration.apiKey.length > 4) {
    const half = Math.ceil(cfg.lidarrIntegration.apiKey.length / 2);
    cfg.lidarrIntegration.apiKey = cfg.lidarrIntegration.apiKey.substring(0, half) + '***';
  }
  res.json(cfg);
});

router.post('/config', async (req, res, next) => {
  try {
    const updates = req.body;

    // Compose-seeded sources live in the environment, never in config.yml
    const mbSources = updates.providers?.musicbrainz?.sources;
    if (Array.isArray(mbSources)) {
      updates.providers.musicbrainz.sources = mbSources.filter(s => !s.fromEnv);
    }
    
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

// Provider status
router.get('/providers', (req, res) => {
  const providers = registry.getActiveProviderNames().map(name => {
    const provider = registry.getProvider(name);
    return {
      name: name,
      type: provider.name,
      configured: true,
      ...(typeof provider.getStatus === 'function' ? { sources: provider.getStatus() } : {})
    };
  });
  
  res.json(providers);
});

// ─── Metadata sources (MusicBrainz servers + Lidarr metadata upstreams) ──────────────

// Configured sources merged with live pool state (breaker, in-flight, served/failed)
router.get('/sources', (req, res) => {
  const resolved = resolveMusicBrainzSources(config.get('providers.musicbrainz', {}) || {});
  const mb = registry.getProvider('musicbrainz');
  const live = new Map(
    (mb && typeof mb.getStatus === 'function' ? mb.getStatus() : [])
      .map(s => [normalizeUrl(s.url).toLowerCase(), s])
  );
  res.json({
    sources: resolved.map(s => ({ ...s, live: live.get(normalizeUrl(s.url).toLowerCase()) || null })),
    workers: { mb: backgroundJobQueue.maxMbWorkers }
  });
});

// Replace the UI-managed source list and apply it without a restart
router.put('/sources', async (req, res, next) => {
  try {
    const { sources, errors, adjusted } = sanitizeSources((req.body || {}).sources);
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });

    const previous = {
      sources: config.get('providers.musicbrainz.sources', []),
      baseUrl: config.get('providers.musicbrainz.baseUrl', '')
    };
    // A legacy single baseUrl is migrated into the list by the editor, so clear it here
    config.set('providers.musicbrainz.sources', sources);
    config.set('providers.musicbrainz.baseUrl', '');

    try {
      await registry.reloadMusicBrainz();
    } catch (error) {
      config.set('providers.musicbrainz.sources', previous.sources);
      config.set('providers.musicbrainz.baseUrl', previous.baseUrl);
      return res.status(400).json({ error: `Could not apply sources: ${error.message}` });
    }
    await config.save();
    backgroundJobQueue.refreshMbCapacity();
    res.json({ success: true, applied: true, adjusted });
  } catch (error) {
    next(error);
  }
});

// Quick reachability check for a source before saving it
router.post('/sources/test', async (req, res) => {
  const { url: rawUrl, type } = req.body || {};
  const url = normalizeUrl(rawUrl);
  if (!/^https?:\/\/[^\s/]+(\/\S*)?$/i.test(url)) {
    return res.json({ ok: false, detail: 'URL must start with http:// or https://' });
  }
  const lmd = type === 'lmd';
  if (lmd && isOfficialUrl(url)) return res.json({ ok: false, detail: 'musicbrainz.org is a MusicBrainz source, not an LMD upstream' });

  const axios = require('axios');
  const radiohead = 'a74b1b7f-71a5-4011-9441-d0b5e4122711';
  const started = Date.now();
  try {
    const response = await axios.get(`${url}/artist/${radiohead}`, {
      params: lmd ? undefined : { fmt: 'json' },
      timeout: 10000,
      headers: { 'User-Agent': USER_AGENT }
    });
    const name = lmd ? response.data?.artistname : response.data?.name;
    const ms = Date.now() - started;
    if (!name) return res.json({ ok: false, ms, detail: `Responded, but not like a ${lmd ? 'Lidarr metadata server' : 'MusicBrainz server'}` });
    res.json({ ok: true, ms, detail: `${name} in ${ms}ms` });
  } catch (error) {
    const ms = Date.now() - started;
    const status = error.response?.status;
    res.json({ ok: false, ms, detail: status ? `HTTP ${status}` : (error.code || error.message) });
  }
});

// ─── Idle-time MusicBrainz backfill ───────────────────────────────────────────────

router.get('/backfill', async (req, res, next) => {
  try {
    const counts = await database.query(`
      SELECT
        (SELECT COUNT(*)::int FROM artists WHERE needs_mb_backfill) AS artists,
        (SELECT COUNT(*)::int FROM release_groups WHERE needs_mb_backfill) AS albums,
        (SELECT COUNT(*)::int FROM metadata_jobs
           WHERE job_type IN ('backfill_artist', 'backfill_album') AND status IN ('pending', 'processing')) AS queued
    `);
    const row = counts.rows[0] || {};
    res.json({
      idle: await backgroundJobQueue.isIdle(),
      running: backgroundJobQueue.backfillWorkers,
      artists: Number(row.artists) || 0,
      albums: Number(row.albums) || 0,
      queued: Number(row.queued) || 0
    });
  } catch (error) {
    next(error);
  }
});

// ─── Raw MusicBrainz archive ───────────────────────────────────────────────────

router.get('/archive', async (req, res, next) => {
  try {
    const stats = await database.query(`
      SELECT entity_type, COUNT(*)::int AS entries FROM mb_raw_archive GROUP BY entity_type
    `);
    const size = await database.query(`SELECT pg_total_relation_size('mb_raw_archive')::bigint AS bytes`);
    const byType = {};
    for (const row of stats.rows) byType[row.entity_type] = Number(row.entries) || 0;
    res.json({
      entries: byType,
      total: Object.values(byType).reduce((a, b) => a + b, 0),
      bytes: Number(size.rows[0] && size.rows[0].bytes) || 0
    });
  } catch (error) {
    next(error);
  }
});

// Empties the archive. The tables keep working: it is only a rebuild source.
router.post('/archive/clear', async (req, res, next) => {
  try {
    await database.query('TRUNCATE mb_raw_archive');
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// Queue flagged rows now; the worker still waits for idle before running them
router.post('/backfill/sweep', async (req, res, next) => {
  try {
    const queued = await backgroundJobQueue.sweepBackfill();
    res.json({ success: true, queued });
  } catch (error) {
    next(error);
  }
});

// Log level endpoints
router.get('/log-level', (req, res) => {
  const { logger } = require('./logger');
  res.json({ level: logger.level });
});

router.post('/log-level', (req, res) => {
  const { level } = req.body;
  const { setLogLevel } = require('./logger');

  const resolved = resolveLevel(level);
  const validLevels = ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'];
  if (!validLevels.includes(resolved)) {
    return res.status(400).json({ error: 'Invalid log level' });
  }

  setLogLevel(resolved);

  // Persist so level survives restart
  config.set('server.logLevel', resolved);
  config.save().catch(err => logger.error('Failed to persist log level:', err));

  res.json({ success: true, level: resolved });
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
        COUNT(r.mbid) as release_count,
        COALESCE(SUM(r.track_count), 0) as track_count,
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
    
    // The tracks of ONLY the first release of this album, read from the tracklist the release itself holds
    const result = await database.query(`
      SELECT r.media
      FROM releases r
      WHERE r.release_group_mbid = $1
      ORDER BY
        CASE WHEN r.status = 'Official' THEN 0 ELSE 1 END,
        r.release_date ASC NULLS LAST
      LIMIT 1
    `, [mbid]);

    const media = result.rows[0] && result.rows[0].media;
    const tracks = [];
    for (const medium of Array.isArray(media) ? media : []) {
      for (const track of medium.tracks || []) {
        tracks.push({
          mbid: track.id,
          title: track.title || '',
          position: Number(track.position) || 0,
          medium_number: medium.position,
          length_ms: track.length || null
        });
      }
    }
    tracks.sort((a, b) => (a.medium_number - b.medium_number) || (a.position - b.position));

    res.json({
      tracks
    });
  } catch (error) {
    next(error);
  }
});

// Image browser endpoints
router.get('/images/artist/:mbid', async (req, res, next) => {
  try {
    const images = await database.getImagesForEntity('artist', req.params.mbid);
    res.json(images);
  } catch (error) { next(error); }
});

router.get('/images/album/:mbid', async (req, res, next) => {
  try {
    const images = await database.getImagesForEntity('release_group', req.params.mbid);
    res.json(images);
  } catch (error) { next(error); }
});

router.get('/images/artist-albums/:mbid', async (req, res, next) => {
  try {
    const albums = await database.getArtistAlbumsBasic(req.params.mbid);
    res.json(albums);
  } catch (error) { next(error); }
});

// Image upload endpoints
async function handleImageUpload(req, res, next, entityType, allowedTypes) {
  try {
    const { mbid } = req.params;
    const { type } = req.body;

    if (!type || !allowedTypes.includes(type)) {
      return res.status(400).json({ error: `Invalid type. Allowed: ${allowedTypes.join(', ')}` });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const ext = MIME_TO_EXT[req.file.mimetype];
    if (!ext) {
      return res.status(400).json({ error: 'Unsupported image format. Use JPEG, PNG, WebP, or GIF.' });
    }

    // Write file to disk
    const dirPath = path.join(IMAGES_BASE, entityType, mbid);
    await fs.mkdir(dirPath, { recursive: true });
    const filename = `${type.toLowerCase()}.${ext}`;
    const filePath = path.join(dirPath, filename);
    await fs.writeFile(filePath, req.file.buffer);

    // Remove any auto-fetched rows for this cover_type so they don't compete with the upload
    await database.query(`
      DELETE FROM images
      WHERE entity_type = $1 AND entity_mbid = $2 AND cover_type = $3 AND (user_uploaded = false OR user_uploaded IS NULL)
    `, [entityType, mbid, type]);

    // Upsert DB record — user upload always wins, overwrites existing manual entry of same type
    const result = await database.query(`
      INSERT INTO images
        (entity_type, entity_mbid, cover_type, provider, url, local_path, cached, user_uploaded, uploaded_at)
      VALUES ($1, $2, $3, 'manual', $4, $5, true, true, NOW())
      ON CONFLICT (entity_mbid, cover_type, provider)
      DO UPDATE SET
        local_path   = EXCLUDED.local_path,
        url          = EXCLUDED.url,
        cached       = true,
        user_uploaded = true,
        uploaded_at  = NOW(),
        cache_failed = false
      RETURNING *
    `, [entityType, mbid, type, `/api/images/${entityType}/${mbid}/${filename}`, filePath]);

    logger.info(`User uploaded ${type} image for ${entityType} ${mbid}: ${filePath}`);
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
}

router.post('/images/artist/:mbid/upload', upload.single('file'), (req, res, next) => {
  handleImageUpload(req, res, next, 'artist', ARTIST_IMAGE_TYPES);
});

router.post('/images/album/:mbid/upload', upload.single('file'), (req, res, next) => {
  handleImageUpload(req, res, next, 'release_group', ALBUM_IMAGE_TYPES);
});

// Image delete endpoint
router.delete('/images/:id', async (req, res, next) => {
  try {
    const { id } = req.params;

    const result = await database.query('SELECT * FROM images WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Image not found' });
    }

    const image = result.rows[0];

    // Delete file from disk if it exists
    if (image.local_path) {
      try {
        await fs.unlink(image.local_path);
        logger.info(`Deleted image file: ${image.local_path}`);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          logger.warn(`Could not delete image file ${image.local_path}: ${err.message}`);
        }
      }
    }

    // Remove DB record
    await database.query('DELETE FROM images WHERE id = $1', [id]);

    logger.info(`Deleted image record ${id} (${image.entity_type} ${image.entity_mbid} ${image.cover_type})`);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// Trim locally-cached images for artists/albums no longer in Lidarr.
// Rule: if an image's artist is still in Lidarr, keep it (including user uploads);
// if the artist has left Lidarr, remove everything for it (uploads included).
// For albums whose artist is still present, auto-fetched art is trimmed only when
// the specific album isn't in Lidarr's set (user uploads for present artists are kept).
router.post('/images/prune-not-in-lidarr', async (req, res, next) => {
  try {
    if (!lidarrClient.enabled) {
      return res.status(400).json({ success: false, error: 'Lidarr integration not enabled' });
    }
    // Re-init + probe with a one-shot retry so a transient blip doesn't fail the run.
    if (!(await lidarrClient.ensureConnected())) {
      return res.status(502).json({ success: false, error: 'Lidarr unreachable — aborted, nothing deleted' });
    }

    // Artist set — abort if unreachable or empty so a bad map can never wipe everything.
    const artistRes = await lidarrClient.refreshArtistMap();
    if (!artistRes.reachable) {
      return res.status(502).json({ success: false, error: 'Lidarr unreachable — aborted, nothing deleted' });
    }
    const artistIds = lidarrClient.getArtistForeignIds();
    if (artistIds.size === 0) {
      return res.status(400).json({ success: false, error: 'Lidarr returned 0 artists — aborted as a safety guard' });
    }

    // Album set — if this fetch fails we skip per-album trimming rather than guess.
    const albumRes = await lidarrClient.getAlbumForeignIds();
    const albumIds = albumRes.ids;
    const albumTrimEnabled = albumRes.reachable;

    // release_group -> [artist_mbid,...] so we can tell if an album's artist is still in Lidarr.
    const rgArtists = new Map();
    const argRows = await database.query(
      `SELECT release_group_mbid, array_agg(artist_mbid) AS artists
       FROM artist_release_groups GROUP BY release_group_mbid`
    );
    for (const r of argRows.rows) rgArtists.set(r.release_group_mbid, r.artists || []);

    const artistPresentFor = (img) => {
      if (img.entity_type === 'artist') return artistIds.has(img.entity_mbid);
      const owners = rgArtists.get(img.entity_mbid) || [];
      return owners.some(a => artistIds.has(a));
    };

    const { rows } = await database.query(
      `SELECT id, entity_type, entity_mbid, local_path, user_uploaded FROM images`
    );

    let deletedArtists = 0, deletedAlbums = 0, bytesFreed = 0;
    const idsToDelete = [];

    for (const img of rows) {
      const artistPresent = artistPresentFor(img);
      let del = false;
      if (!artistPresent) {
        // Artist gone from Lidarr — remove everything for it, user uploads included.
        del = true;
      } else if (img.entity_type === 'release_group' && !img.user_uploaded && albumTrimEnabled) {
        // Artist still present but this specific album isn't tracked — trim auto-fetched art only.
        del = !albumIds.has(img.entity_mbid);
      }
      if (!del) continue;

      if (img.entity_type === 'artist') deletedArtists++; else deletedAlbums++;
      idsToDelete.push(img.id);
      if (img.local_path) {
        try {
          const st = await fs.stat(img.local_path);
          bytesFreed += st.size;
          await fs.unlink(img.local_path);
        } catch (err) {
          if (err.code !== 'ENOENT') logger.warn(`prune: could not delete ${img.local_path}: ${err.message}`);
        }
      }
    }

    if (idsToDelete.length > 0) {
      await database.query('DELETE FROM images WHERE id = ANY($1)', [idsToDelete]);
    }

    logger.info(`prune-not-in-lidarr: removed ${idsToDelete.length} images (${deletedArtists} artist, ${deletedAlbums} album), freed ${bytesFreed} bytes; albumTrim=${albumTrimEnabled}`);
    res.json({ success: true, deleted: idsToDelete.length, artists: deletedArtists, albums: deletedAlbums, bytesFreed, albumTrimEnabled });
  } catch (error) {
    next(error);
  }
});

// ─── Clearing cached metadata, and the blocklist ──────────────────────────────────────────────────────────────────

const isUuid = v => blocklist.UUID.test(String(v));

// Lidarr's artist and album sets for a trim. Anything short of two sets that can be trusted stops the run: it never guesses.
async function lidarrSetsForTrim() {
  if (!lidarrClient.enabled) return { error: [400, 'Lidarr integration not enabled'] };
  if (!(await lidarrClient.ensureConnected())) return { error: [502, 'Lidarr unreachable — aborted, nothing deleted'] };
  const artistRes = await lidarrClient.refreshArtistMap();
  if (!artistRes.reachable) return { error: [502, 'Lidarr unreachable — aborted, nothing deleted'] };
  const artistIds = lidarrClient.getArtistForeignIds();
  if (artistIds.size === 0) return { error: [400, 'Lidarr returned 0 artists — aborted as a safety guard'] };
  const albumRes = await lidarrClient.getAlbumForeignIds();
  if (!albumRes.reachable) return { error: [502, 'Lidarr album list unavailable — aborted, nothing deleted'] };
  if (albumRes.ids.size === 0) return { error: [400, 'Lidarr returned 0 albums — aborted as a safety guard'] };
  return { artistIds, albumIds: albumRes.ids };
}

// Is this entity in Lidarr's library? 'off' (integration disabled: nothing to check against), 'in', 'out', or 'unknown'
async function lidarrMembership(type, mbid) {
  if (!lidarrClient.enabled) return 'off';
  if (type === 'artist') {
    const known = await lidarrClient.isInLidarr(mbid);
    return known === true ? 'in' : known === false ? 'out' : 'unknown';
  }
  if (type === 'release_group') {
    if (!(await lidarrClient.ensureConnected())) return 'unknown';
    const albums = await lidarrClient.getAlbumForeignIds();
    if (!albums.reachable) return 'unknown';
    return albums.ids.has(mbid) ? 'in' : 'out';
  }
  return 'off';   // a single release is not something Lidarr's sets name
}

const clearOf = { artist: metadataClear.clearArtist, release_group: metadataClear.clearReleaseGroup, release: metadataClear.clearRelease };
const nameQuery = {
  artist: 'SELECT name FROM artists WHERE mbid = $1',
  release_group: 'SELECT title AS name FROM release_groups WHERE mbid = $1',
  release: 'SELECT title AS name FROM releases WHERE mbid = $1'
};

// What clearing an artist or a release group would remove, for the confirm dialog
router.get('/metadata/clear-preview/:type/:mbid', async (req, res, next) => {
  try {
    const { type, mbid } = req.params;
    if (!['artist', 'release_group'].includes(type) || !isUuid(mbid)) return res.status(400).json({ success: false, error: 'Invalid request' });
    const stats = await clearOf[type](mbid.toLowerCase(), { dryRun: true });
    res.json({ success: true, ...stats, lidarr: await lidarrMembership(type, mbid.toLowerCase()) });
  } catch (error) { next(error); }
});

router.delete('/metadata/artist/:mbid', async (req, res, next) => {
  try {
    if (!isUuid(req.params.mbid)) return res.status(400).json({ success: false, error: 'Invalid mbid' });
    const stats = await metadataClear.clearArtist(req.params.mbid.toLowerCase());
    res.json({ success: true, ...stats });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, error: error.message });
    next(error);
  }
});

router.delete('/metadata/album/:mbid', async (req, res, next) => {
  try {
    if (!isUuid(req.params.mbid)) return res.status(400).json({ success: false, error: 'Invalid mbid' });
    const stats = await metadataClear.clearReleaseGroup(req.params.mbid.toLowerCase());
    res.json({ success: true, ...stats });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, error: error.message });
    next(error);
  }
});

// Trim the stored metadata of artists Lidarr does not have (same safeguards as the image trim; `dryRun` only counts).
// Artists and release groups Lidarr has are kept, and so is the name of any artist still credited on an album that stays.
router.post('/metadata/prune-not-in-lidarr', async (req, res, next) => {
  try {
    const sets = await lidarrSetsForTrim();
    if (sets.error) return res.status(sets.error[0]).json({ success: false, error: sets.error[1] });
    const dryRun = !!(req.body && req.body.dryRun);
    const stats = await metadataClear.trimNotInLidarr({ lidarrArtistIds: sets.artistIds, lidarrAlbumIds: sets.albumIds, dryRun });
    logger.info(`prune metadata not in Lidarr${dryRun ? ' (dry run)' : ''}: ${JSON.stringify(stats)}`);
    res.json({ success: true, dryRun, ...stats });
  } catch (error) { next(error); }
});

router.get('/blocklist', async (req, res, next) => {
  try { res.json(await blocklist.list()); } catch (error) { next(error); }
});

// Block an artist, release group or release, and (unless `clear: false`) remove what is held for it.
// An artist or album in Lidarr's library is refused (a library artist sent no albums could cost Lidarr its albums), and so is
// one Lidarr cannot confirm about while the integration is on.
router.post('/blocklist', async (req, res, next) => {
  try {
    const { type, name, reason } = req.body || {};
    const mbid = String((req.body && req.body.mbid) || '').toLowerCase();
    const clear = !(req.body && req.body.clear === false);
    if (!blocklist.TYPES.includes(type) || !isUuid(mbid)) return res.status(400).json({ success: false, error: 'A type (artist, release_group, release) and a valid mbid are needed' });
    if (blocklist.isBuiltin(mbid) && type === 'artist') return res.status(400).json({ success: false, error: 'Already blocked (built in)' });

    const where = await lidarrMembership(type, mbid);
    if (where === 'in') return res.status(409).json({ success: false, error: `This ${type.replace('_', ' ')} is in Lidarr's library: remove it from Lidarr first` });
    if (where === 'unknown') return res.status(409).json({ success: false, error: 'Lidarr cannot confirm whether this is in its library right now: nothing blocked' });

    const label = name || ((await database.query(nameQuery[type], [mbid])).rows[0] || {}).name || null;
    await blocklist.add({ type, mbid, name: label, reason });
    let cleared = null;
    if (clear) {
      try {
        cleared = await clearOf[type](mbid, { ignoreJobs: true, forceDeleteRows: true });
      } catch (error) {
        logger.error(`Blocked ${type} ${mbid}, but clearing it failed: ${error.message}`);
        return res.status(500).json({ success: false, blocked: true, error: `Blocked, but clearing its data failed: ${error.message}` });
      }
    }
    res.json({ success: true, blocked: true, cleared });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, error: error.message });
    next(error);
  }
});

router.delete('/blocklist/:type/:mbid', async (req, res, next) => {
  try {
    const { type, mbid } = req.params;
    if (!blocklist.TYPES.includes(type) || !isUuid(mbid)) return res.status(400).json({ success: false, error: 'Invalid request' });
    const removed = await blocklist.remove(type, mbid);
    res.json({ success: true, removed });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, error: error.message });
    next(error);
  }
});

// Image fetch endpoints — queue provider fetch jobs (user-uploaded images protected inside _storeImageUrls)
router.post('/images/fetch/artist-albums/:mbid', async (req, res, next) => {
  try {
    const { mbid } = req.params;
    const albums = await database.query(
      'SELECT release_group_mbid FROM artist_release_groups WHERE artist_mbid = $1',
      [mbid]
    );
    for (const row of albums.rows) {
      await backgroundJobQueue.forceQueueJob('fetch_album_images', 'release_group', row.release_group_mbid, 5, { force: true });
    }
    logger.info(`Album image fetch queued for ${albums.rows.length} albums of artist ${mbid}`);
    res.json({ success: true, queued: albums.rows.length });
  } catch (error) { next(error); }
});

router.post('/images/fetch/artist/:mbid', async (req, res, next) => {
  try {
    const { mbid } = req.params;
    await backgroundJobQueue.forceQueueJob('fetch_artist_images', 'artist', mbid, 5, { force: true });
    logger.info(`Image fetch queued for artist ${mbid}`);
    res.json({ success: true });
  } catch (error) { next(error); }
});

router.post('/images/fetch/album/:mbid', async (req, res, next) => {
  try {
    const { mbid } = req.params;
    await backgroundJobQueue.forceQueueJob('fetch_album_images', 'release_group', mbid, 5, { force: true });
    logger.info(`Image fetch queued for album ${mbid}`);
    res.json({ success: true });
  } catch (error) { next(error); }
});

router.post('/images/fetch/all', async (req, res, next) => {
  try {
    const artists = await database.query('SELECT mbid FROM artists');
    const albums = await database.query('SELECT mbid FROM release_groups');
    for (const row of artists.rows) {
      await backgroundJobQueue.forceQueueJob('fetch_artist_images', 'artist', row.mbid, 5);
    }
    for (const row of albums.rows) {
      await backgroundJobQueue.forceQueueJob('fetch_album_images', 'release_group', row.mbid, 5);
    }
    logger.info(`Image fetch queued for ${artists.rows.length} artists and ${albums.rows.length} albums`);
    res.json({ success: true, artists: artists.rows.length, albums: albums.rows.length });
  } catch (error) { next(error); }
});

// Image file serving — must come AFTER specific /images/* routes to avoid route conflict
// Regex ensures :filename must contain a dot (actual file extension) e.g. cover.jpg
router.get('/images/:entity_type/:mbid/:filename([^/]+[.][^/]+)', async (req, res, next) => {
  try {
    const { entity_type, mbid, filename } = req.params;
    const imagePath = path.join(__dirname, '../../data/images', entity_type, mbid, filename);
    try {
      await fs.access(imagePath);
    } catch (error) {
      return res.status(404).json({ error: 'Image not found' });
    }
    const ext = path.extname(filename).toLowerCase();
    const contentTypes = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };
    const contentType = contentTypes[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=31536000');
    res.sendFile(imagePath);
  } catch (error) {
    next(error);
  }
});

// UI fetch endpoints - respond immediately, run in background
router.post('/ui/fetch-artist/:mbid', async (req, res, next) => {
  try {
    const { mbid } = req.params;
    // fetch_artist_albums is the root job — spawns all children and triggers Lidarr refresh on completion
    await backgroundJobQueue.forceQueueJob('fetch_artist_albums', 'artist', mbid, 10, { skipArtistImages: true, skipAlbumImages: true, forceRefresh: true }, null, mbid);
    logger.info(`UI artist fetch queued for ${mbid}`);
    res.json({ success: true, message: `Fetch queued for ${mbid}` });
  } catch (error) {
    next(error);
  }
});

router.post('/ui/fetch-album/:mbid', async (req, res, next) => {
  try {
    const { mbid } = req.params;
    await backgroundJobQueue.queueJob('fetch_album_full', 'release_group', mbid, 10);
    logger.info(`UI album fetch queued for ${mbid}`);
    res.json({ success: true, message: `Fetch queued for ${mbid}` });
  } catch (error) {
    next(error);
  }
});

// Refresh endpoints
router.post('/refresh/artist/:mbid', async (req, res, next) => {
  try {
    const { mbid } = req.params;
    logger.info(`Manual refresh requested for artist ${mbid}`);
    
    await metaHandler.refreshArtist(mbid);
    
    res.json({ success: true, message: `Artist ${mbid} refresh queued` });
  } catch (error) {
    next(error);
  }
});

// Lidarr integration endpoints
router.get('/lidarr/status', (req, res) => {
  res.json(lidarrClient.getStats());
});

router.post('/lidarr/test', async (req, res, next) => {
  try {
    // Re-initialize from current config in case settings changed
    lidarrClient.initialize();
    if (!lidarrClient.enabled) {
      return res.json({ success: false, error: 'Lidarr integration not configured — set URL and API key' });
    }
    const result = await lidarrClient.testConnection();
    if (result.success) {
      await lidarrClient.refreshArtistMap();
    }
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post('/lidarr/refresh/:mbid', async (req, res, next) => {
  try {
    const { mbid } = req.params;
    if (!lidarrClient.enabled) {
      return res.json({ success: false, error: 'Lidarr integration not enabled' });
    }
    const result = await lidarrClient.refreshArtistByMbid(mbid);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// Recent jobs endpoint (unified: metadata jobs + image downloads)
// ?type=metadata — metadata jobs only
// ?type=downloads — image download rows only
// (no param) — all
router.get('/jobs/recent', async (req, res, next) => {
  try {
    const { type } = req.query;
    const includeMetadata = !type || type === 'metadata';
    const includeDownloads = !type || type === 'downloads';

    const parts = [];

    if (includeMetadata) {
      parts.push(`
        SELECT
          j.id, j.job_type, j.entity_type, j.entity_mbid, j.status,
          j.created_at, j.started_at, j.completed_at, j.error_message,
          j.root_artist_mbid, j.parent_job_id,
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
          END::bigint as album_count,
          CASE
            WHEN j.entity_type = 'artist' THEN
              (SELECT COUNT(*) FROM releases r
               JOIN release_groups rg3 ON rg3.mbid = r.release_group_mbid
               JOIN artist_release_groups arg2 ON arg2.release_group_mbid = rg3.mbid
               WHERE arg2.artist_mbid = j.entity_mbid)
            ELSE
              (SELECT COUNT(*) FROM releases r WHERE r.release_group_mbid = j.entity_mbid)
          END::bigint as release_count,
          CASE
            WHEN j.entity_type = 'artist' THEN
              (SELECT COALESCE(SUM(r2.track_count), 0) FROM releases r2
               JOIN artist_release_groups arg3 ON arg3.release_group_mbid = r2.release_group_mbid
               WHERE arg3.artist_mbid = j.entity_mbid)
            ELSE
              (SELECT COALESCE(SUM(r3.track_count), 0) FROM releases r3
               WHERE r3.release_group_mbid = j.entity_mbid)
          END::bigint as track_count,
          NULL::text as cover_type,
          NULL::text as image_provider,
          j.metadata->>'via' as via
        FROM (
          SELECT *
          FROM metadata_jobs
          WHERE status IN ('processing', 'pending', 'completed', 'failed')
          ORDER BY
            CASE status
              WHEN 'processing' THEN 0
              WHEN 'pending'    THEN 1
              ELSE 2
            END ASC,
            created_at DESC
          LIMIT 500
        ) j
        LEFT JOIN artists a ON a.mbid = j.entity_mbid
        LEFT JOIN release_groups rg ON rg.mbid = j.entity_mbid`);
    }

    if (includeDownloads) {
      parts.push(`
        SELECT
          i.id,
          'image_download' as job_type,
          i.entity_type,
          i.entity_mbid,
          'pending' as status,
          i.last_verified_at as created_at,
          NULL::timestamptz as started_at,
          NULL::timestamptz as completed_at,
          NULL::text as error_message,
          NULL::uuid as root_artist_mbid, NULL::bigint as parent_job_id,
          COALESCE(a2.name, rg2.title) as entity_name,
          CASE
            WHEN i.entity_type != 'artist' THEN
              (SELECT ar2.name FROM artists ar2
               JOIN artist_release_groups arg4 ON arg4.artist_mbid = ar2.mbid
               WHERE arg4.release_group_mbid = i.entity_mbid
               LIMIT 1)
            ELSE NULL
          END as artist_name,
          0::bigint as album_count, 0::bigint as release_count, 0::bigint as track_count,
          i.cover_type,
          i.provider as image_provider,
          NULL::text as via
        FROM images i
        LEFT JOIN artists a2 ON a2.mbid = i.entity_mbid
        LEFT JOIN release_groups rg2 ON rg2.mbid = i.entity_mbid
        WHERE i.cached = false AND i.cache_failed = false`);

      parts.push(`
        SELECT * FROM (
          SELECT
            i.id,
            'image_download' as job_type,
            i.entity_type,
            i.entity_mbid,
            'completed' as status,
            i.last_verified_at as created_at,
            NULL::timestamptz as started_at,
            i.cached_at as completed_at,
            NULL::text as error_message,
            NULL::uuid as root_artist_mbid, NULL::bigint as parent_job_id,
            COALESCE(a3.name, rg3.title) as entity_name,
            CASE
              WHEN i.entity_type != 'artist' THEN
                (SELECT ar3.name FROM artists ar3
                 JOIN artist_release_groups arg5 ON arg5.artist_mbid = ar3.mbid
                 WHERE arg5.release_group_mbid = i.entity_mbid
                 LIMIT 1)
              ELSE NULL
            END as artist_name,
            0::bigint as album_count, 0::bigint as release_count, 0::bigint as track_count,
            i.cover_type,
            i.provider as image_provider,
            NULL::text as via
          FROM images i
          LEFT JOIN artists a3 ON a3.mbid = i.entity_mbid
          LEFT JOIN release_groups rg3 ON rg3.mbid = i.entity_mbid
          WHERE i.cached = true
          ORDER BY i.cached_at DESC
          LIMIT 50
        ) recent_completed`);

      parts.push(`
        SELECT
          i.id,
          'image_download' as job_type,
          i.entity_type,
          i.entity_mbid,
          'failed' as status,
          i.last_verified_at as created_at,
          NULL::timestamptz as started_at,
          NULL::timestamptz as completed_at,
          i.cache_failed_reason as error_message,
          NULL::uuid as root_artist_mbid, NULL::bigint as parent_job_id,
          COALESCE(a4.name, rg4.title) as entity_name,
          CASE
            WHEN i.entity_type != 'artist' THEN
              (SELECT ar4.name FROM artists ar4
               JOIN artist_release_groups arg6 ON arg6.artist_mbid = ar4.mbid
               WHERE arg6.release_group_mbid = i.entity_mbid
               LIMIT 1)
            ELSE NULL
          END as artist_name,
          0::bigint as album_count, 0::bigint as release_count, 0::bigint as track_count,
          i.cover_type,
          i.provider as image_provider,
          NULL::text as via
        FROM images i
        LEFT JOIN artists a4 ON a4.mbid = i.entity_mbid
        LEFT JOIN release_groups rg4 ON rg4.mbid = i.entity_mbid
        WHERE i.cache_failed = true`);
    }

    const sql = `
      SELECT * FROM (
        ${parts.join('\n        UNION ALL\n')}
      ) combined
      ORDER BY
        CASE status
          WHEN 'processing' THEN 0
          WHEN 'pending'    THEN 1
          ELSE 2
        END ASC,
        created_at DESC
      LIMIT 100
    `;

    const result = await database.query(sql);

    // What the card needs to show about a job's retries, and for an artist's catalog job where the catalog stands
    const jobIds = result.rows.filter(r => r.job_type !== 'image_download').map(r => r.id);
    if (jobIds.length > 0) {
      const extra = await database.query(`
        SELECT j.id, j.attempts, j.max_attempts, j.run_after,
               CASE WHEN j.job_type <> 'fetch_artist_albums' THEN NULL
                    WHEN a.catalog_provisional THEN 'provisional'
                    WHEN a.catalog_verified_at IS NOT NULL THEN 'verified'
                    WHEN a.catalog_complete_at IS NOT NULL THEN 'unverified'
                    ELSE 'incomplete' END AS catalog_state
        FROM metadata_jobs j LEFT JOIN artists a ON a.mbid = j.entity_mbid
        WHERE j.id = ANY($1)
      `, [jobIds]);
      const byId = new Map(extra.rows.map(r => [String(r.id), r]));
      for (const row of result.rows) {
        if (row.job_type === 'image_download') continue;
        const more = byId.get(String(row.id));
        if (more) Object.assign(row, { attempts: more.attempts, max_attempts: more.max_attempts, run_after: more.run_after, catalog_state: more.catalog_state });
      }
    }

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

// API keys for the MusicBrainz-compatible /ws/2 endpoint (made and removed from the web UI)
router.use('/ws2/keys', createKeyRouter(() => require('./mbWs/services').keys()));

// Recent requests feed
// ?direction=inbound (who asked nuLMD) or ?direction=outbound (what nuLMD asked others and got back); both if omitted
router.get('/requests/recent', (req, res) => {
    const direction = ['inbound', 'outbound'].includes(req.query.direction) ? req.query.direction : null;
    res.json(getRequestLog(direction).slice(-50).reverse());
});

module.exports = router;
