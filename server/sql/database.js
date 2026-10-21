const { Pool } = require('pg');
const { logger } = require('../lib/logger');
const config = require('../lib/config');
const { resolveSettings, ensureDatabase } = require('./connection');
const { migrate } = require('./migrate');

class Database {
  constructor() {
    this.pool = null;
  }

  async initialize() {
    // Environment variables win over config.yml (see connection.js); create the database if it's new
    const dbConfig = resolveSettings(config.get('postgres'));
    logger.info(`Initializing database connection (${dbConfig.host}:${dbConfig.port}/${dbConfig.database})...`);
    await ensureDatabase(dbConfig, { log: msg => logger.info(msg) });

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

    try {
      const client = await this.pool.connect();
      logger.info('Database connection successful');
      client.release();
    } catch (error) {
      logger.error('Failed to connect to database:', error);
      throw error;
    }

    await this.ensureSchema(dbConfig.database);
  }

  // Applies any migration this database hasn't had yet; refuses a v4 database (see migrate.js)
  async ensureSchema(databaseName) {
    logger.info('Checking database schema...');
    const client = await this.pool.connect();
    try {
      const result = await migrate({
        query: (text, params) => client.query(text, params),
        database: databaseName,
        log: msg => logger.info(msg)
      });
      logger.info(result.applied.length ? `Schema up to date (applied: ${result.applied.join(', ')})` : 'Schema up to date');
    } finally {
      client.release();
    }
  }

  async query(text, params) {
    try {
      const result = await this.pool.query(text, params);
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
      SET last_accessed_at = NOW()
      WHERE mbid = $1
    `, [mbid]);
  }

  // An exact count of a big table is a full scan, and the dashboard asks every second: above this size the planner's own
  // estimate (kept up to date by autovacuum, within a few percent) is used instead
  async approximateCount(table) {
    const estimate = (await this.query(`SELECT reltuples::bigint AS n FROM pg_class WHERE oid = to_regclass($1)`, [table])).rows[0];
    if (estimate && Number(estimate.n) >= 100000) return Number(estimate.n);
    return Number((await this.query(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n);
  }

  async getStats() {
    const trackCount = await this.approximateCount('recordings');
    const result = await this.query(`
      SELECT 
        (SELECT COUNT(*) FROM artists) as artist_count,
        (SELECT COUNT(*) FROM artists WHERE catalog_provisional) as catalogs_provisional,
        (SELECT COUNT(*) FROM artists WHERE NOT catalog_provisional AND catalog_verified_at IS NOT NULL) as catalogs_verified,
        (SELECT COUNT(*) FROM artists WHERE NOT catalog_provisional AND catalog_verified_at IS NULL AND catalog_complete_at IS NOT NULL) as catalogs_unverified,
        (SELECT COUNT(*) FROM artists WHERE catalog_complete_at IS NULL) as catalogs_incomplete,
        (SELECT COUNT(*) FROM release_groups) as album_count,
        (SELECT COUNT(*) FROM releases) as release_count,
        $1::bigint as track_count,
        (SELECT COUNT(*) FROM images WHERE cached = true) as cached_images,
        (SELECT pg_database_size(current_database())) as db_size_bytes
    `, [trackCount]);
    return result.rows[0];
  }

  // Fetch completion tracking methods
  // Bulk refresh tracking methods
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
        a.catalog_complete_at,
        a.catalog_verified_at,
        a.catalog_provisional,
        COALESCE(c.albums, 0)::bigint as album_count,
        COALESCE(c.releases, 0)::bigint as release_count,
        COALESCE(c.tracks, 0)::bigint as track_count,
        (SELECT COUNT(*) FROM images i WHERE i.entity_type = 'artist' AND i.entity_mbid = a.mbid AND i.cached = true) as artist_image_count,
        (SELECT COUNT(*) FROM images i2 WHERE i2.entity_type = 'release_group' AND i2.entity_mbid IN (SELECT arg2.release_group_mbid FROM artist_release_groups arg2 WHERE arg2.artist_mbid = a.mbid) AND i2.cached = true) as album_image_count
      FROM artists a
      LEFT JOIN (
        -- counted once per artist, from the releases themselves (a release holds its own tracklist and track count)
        SELECT arg.artist_mbid, COUNT(DISTINCT arg.release_group_mbid) AS albums, COUNT(r.mbid) AS releases,
               COALESCE(SUM(r.track_count), 0) AS tracks
        FROM artist_release_groups arg
        LEFT JOIN releases r ON r.release_group_mbid = arg.release_group_mbid
        GROUP BY arg.artist_mbid
      ) c ON c.artist_mbid = a.mbid
      ORDER BY a.last_accessed_at DESC NULLS LAST
    `);
    return result.rows;
  }

  async getArtistWithMetadata(mbid) {
    const result = await this.query(`
      SELECT 
        a.*,
        COUNT(DISTINCT arg.release_group_mbid) as album_count,
        COUNT(r.mbid) as release_count,
        COALESCE(SUM(r.track_count), 0) as track_count
      FROM artists a
      LEFT JOIN artist_release_groups arg ON arg.artist_mbid = a.mbid
      LEFT JOIN releases r ON r.release_group_mbid = arg.release_group_mbid
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
        COUNT(r.mbid) as release_count,
        COALESCE(SUM(r.track_count), 0) as track_count
      FROM release_groups rg
      JOIN artist_release_groups arg ON arg.release_group_mbid = rg.mbid
      LEFT JOIN releases r ON r.release_group_mbid = rg.mbid
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