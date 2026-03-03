const { Pool } = require('pg');
const fs = require('fs').promises;
const path = require('path');
const { logger } = require('../lib/logger');
const config = require('../lib/config');

class Database {
  constructor() {
    this.pool = null;
  }

  async initialize() {
    const dbConfig = config.get('postgres');
    
    logger.info('Initializing database connection...');
    
    // Create connection pool
    this.pool = new Pool({
      host: dbConfig.host,
      port: dbConfig.port,
      database: dbConfig.database,
      user: dbConfig.user,
      password: dbConfig.password,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });

    // Test connection
    try {
      const client = await this.pool.connect();
      logger.info('Database connection successful');
      client.release();
    } catch (error) {
      logger.error('Failed to connect to database:', error);
      throw error;
    }

    // Check if schema needs initialization
    await this.ensureSchema();
  }

  async ensureSchema() {
    logger.info('Checking database schema...');
    
    // Check if artists table exists
    const result = await this.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'artists'
      );
    `);

    const schemaExists = result.rows[0].exists;

    if (!schemaExists) {
      logger.info('Schema not found, initializing database...');
      await this.runMigrations();
    } else {
      logger.info('Schema already exists');
      await this.runColumnMigrations();
    }
  }

  async runColumnMigrations() {
    logger.info('Checking column migrations...');
    
    await this.query(`
      ALTER TABLE images 
      ADD COLUMN IF NOT EXISTS user_uploaded BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS uploaded_at TIMESTAMP WITH TIME ZONE;
    `);
    
    logger.info('Column migrations complete');
  }

  async runMigrations() {
    logger.info('Running database migrations...');
    
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schemaSql = await fs.readFile(schemaPath, 'utf8');
    
    try {
      await this.query(schemaSql);
      logger.info('Database schema created successfully');
    } catch (error) {
      logger.error('Failed to create schema:', error);
      throw error;
    }
  }

  async query(text, params) {
    const start = Date.now();
    try {
      const result = await this.pool.query(text, params);
      const duration = Date.now() - start;
      logger.debug('Executed query', { duration, rows: result.rowCount });
      return result;
    } catch (error) {
      logger.error('Query error:', error);
      throw error;
    }
  }

  async getClient() {
    return await this.pool.connect();
  }

  async close() {
    if (this.pool) {
      await this.pool.end();
      logger.info('Database connection pool closed');
    }
  }

  // Helper methods for common operations
  async getArtist(mbid) {
    const result = await this.query(
      'SELECT * FROM artists WHERE mbid = $1',
      [mbid]
    );
    return result.rows[0];
  }

  async getReleaseGroup(mbid) {
    const result = await this.query(
      'SELECT * FROM release_groups WHERE mbid = $1',
      [mbid]
    );
    return result.rows[0];
  }

  async updateArtistAccess(mbid) {
    await this.query(`
      UPDATE artists 
      SET last_accessed_at = NOW(),
          access_count = access_count + 1
      WHERE mbid = $1
    `, [mbid]);
  }

  async updateReleaseGroupAccess(mbid) {
    await this.query(`
      UPDATE release_groups 
      SET last_accessed_at = NOW(),
          access_count = access_count + 1
      WHERE mbid = $1
    `, [mbid]);
  }

  async getStats() {
    const result = await this.query(`
      SELECT 
        (SELECT COUNT(*) FROM artists) as artist_count,
        (SELECT COUNT(*) FROM release_groups) as album_count,
        (SELECT COUNT(*) FROM releases) as release_count,
        (SELECT COUNT(DISTINCT recording_mbid) FROM tracks) as track_count,
        (SELECT COUNT(*) FROM images WHERE cached = true) as cached_images,
        (SELECT pg_database_size(current_database())) as db_size_bytes
    `);
    return result.rows[0];
  }

  // Fetch completion tracking methods
  async markArtistFetchStarted(mbid) {
    await this.query(`
      UPDATE artists 
      SET last_fetch_attempt = NOW(),
          fetch_complete = FALSE
      WHERE mbid = $1
    `, [mbid]);
    logger.info(`Marked artist ${mbid} fetch as started`);
  }

  async markArtistFetchComplete(mbid, releaseCount) {
    await this.query(`
      UPDATE artists 
      SET fetch_complete = TRUE,
          releases_fetched_count = $2,
          last_updated_at = NOW()
      WHERE mbid = $1
    `, [mbid, releaseCount]);
    logger.info(`Marked artist ${mbid} fetch as complete (${releaseCount} releases)`);
  }

  async artistNeedsRefresh(artist) {
    if (!artist) return true;
    
    // Incomplete fetch - always refresh (job queue prevents duplicates)
    if (!artist.fetch_complete) {
      return true;
    }
    
    // Complete fetch - check staleness (30 days)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    return new Date(artist.last_updated_at) < thirtyDaysAgo;
  }

  async getArtistReleaseMBIDs(artistMbid) {
    const result = await this.query(`
      SELECT DISTINCT r.mbid
      FROM releases r
      JOIN artist_release_groups arg ON r.release_group_mbid = arg.release_group_mbid
      WHERE arg.artist_mbid = $1
      ORDER BY r.mbid
    `, [artistMbid]);
    return result.rows.map(row => row.mbid);
  }

  // Bulk refresh tracking methods
  async getLastBulkRefresh() {
    const result = await this.query(`
      SELECT * FROM bulk_refresh_log
      WHERE status = 'completed'
      ORDER BY completed_at DESC
      LIMIT 1
    `);
    return result.rows[0];
  }

  async startBulkRefresh() {
    const result = await this.query(`
      INSERT INTO bulk_refresh_log (started_at, status)
      VALUES (NOW(), 'running')
      RETURNING id
    `);
    return result.rows[0].id;
  }

  async completeBulkRefresh(id, artistsRefreshed) {
    await this.query(`
      UPDATE bulk_refresh_log
      SET completed_at = NOW(),
          status = 'completed',
          artists_refreshed = $2
      WHERE id = $1
    `, [id, artistsRefreshed]);
  }

  async failBulkRefresh(id) {
    await this.query(`
      UPDATE bulk_refresh_log
      SET status = 'failed'
      WHERE id = $1
    `, [id]);
  }

  async getAllArtistMbids() {
    const result = await this.query('SELECT mbid FROM artists ORDER BY last_accessed_at DESC');
    return result.rows.map(row => row.mbid);
  }

  // Metadata browser methods
  async getAllArtistsWithCounts() {
    const result = await this.query(`
      SELECT 
        a.mbid,
        a.name,
        a.sort_name,
        a.type,
        a.country,
        a.last_updated_at,
        a.ttl_expires_at,
        a.last_accessed_at,
        COUNT(DISTINCT arg.release_group_mbid) as album_count,
        COUNT(DISTINCT r.mbid) as release_count,
        COUNT(DISTINCT t.mbid) as track_count,
        (SELECT COUNT(*) FROM images i WHERE i.entity_type = 'artist' AND i.entity_mbid = a.mbid AND i.cached = true) as artist_image_count,
        (SELECT COUNT(*) FROM images i2 WHERE i2.entity_type = 'release_group' AND i2.entity_mbid IN (SELECT arg2.release_group_mbid FROM artist_release_groups arg2 WHERE arg2.artist_mbid = a.mbid) AND i2.cached = true) as album_image_count
      FROM artists a
      LEFT JOIN artist_release_groups arg ON arg.artist_mbid = a.mbid
      LEFT JOIN releases r ON r.release_group_mbid = arg.release_group_mbid
      LEFT JOIN tracks t ON t.release_mbid = r.mbid
      GROUP BY a.mbid, a.name, a.sort_name, a.type, a.country, a.last_updated_at, a.ttl_expires_at, a.last_accessed_at
      ORDER BY a.last_accessed_at DESC NULLS LAST
    `);
    return result.rows;
  }

  async getArtistWithMetadata(mbid) {
    const result = await this.query(`
      SELECT 
        a.*,
        COUNT(DISTINCT arg.release_group_mbid) as album_count,
        COUNT(DISTINCT r.mbid) as release_count,
        COUNT(DISTINCT t.mbid) as track_count
      FROM artists a
      LEFT JOIN artist_release_groups arg ON arg.artist_mbid = a.mbid
      LEFT JOIN releases r ON r.release_group_mbid = arg.release_group_mbid
      LEFT JOIN tracks t ON t.release_mbid = r.mbid
      WHERE a.mbid = $1
      GROUP BY a.mbid
    `, [mbid]);
    return result.rows[0];
  }

  async getArtistAlbums(mbid) {
    const result = await this.query(`
      SELECT 
        rg.mbid,
        rg.title,
        rg.primary_type,
        rg.first_release_date,
        rg.last_updated_at,
        COUNT(DISTINCT r.mbid) as release_count,
        COUNT(DISTINCT t.mbid) as track_count
      FROM release_groups rg
      JOIN artist_release_groups arg ON arg.release_group_mbid = rg.mbid
      LEFT JOIN releases r ON r.release_group_mbid = rg.mbid
      LEFT JOIN tracks t ON t.release_mbid = r.mbid
      WHERE arg.artist_mbid = $1
      GROUP BY rg.mbid, rg.title, rg.primary_type, rg.first_release_date, rg.last_updated_at
      ORDER BY rg.first_release_date DESC NULLS LAST
    `, [mbid]);
    return result.rows;
  }
  async getImagesForEntity(entityType, entityMbid) {
    const result = await this.query(`
      SELECT id, entity_type, entity_mbid, cover_type, provider,
             url, local_path, cached, user_uploaded, uploaded_at,
             cache_failed, file_size_bytes, width, height
      FROM images
      WHERE entity_type = $1 AND entity_mbid = $2
      ORDER BY user_uploaded DESC, cover_type ASC
    `, [entityType, entityMbid]);
    return result.rows;
  }

  async getArtistAlbumsBasic(artistMbid) {
    const result = await this.query(`
      SELECT rg.mbid, rg.title, rg.primary_type, rg.first_release_date
      FROM release_groups rg
      JOIN artist_release_groups arg ON arg.release_group_mbid = rg.mbid
      WHERE arg.artist_mbid = $1
      ORDER BY rg.first_release_date ASC NULLS LAST
    `, [artistMbid]);
    return result.rows;
  }
}

module.exports = new Database();