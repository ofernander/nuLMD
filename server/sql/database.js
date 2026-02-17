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
    }
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
        (SELECT COUNT(*) FROM tracks) as track_count,
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
}

module.exports = new Database();