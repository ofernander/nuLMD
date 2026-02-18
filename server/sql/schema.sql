-- nuLMD PostgreSQL Database Schema
-- Version: 1.0.0
-- Description: Complete schema for nuLMD metadata storage

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- CORE ENTITY TABLES
-- ============================================================================

-- Artists table
CREATE TABLE IF NOT EXISTS artists (
    mbid UUID PRIMARY KEY,
    name TEXT NOT NULL,
    sort_name TEXT,
    disambiguation TEXT,
    type VARCHAR(50),
    country VARCHAR(2),
    begin_date DATE,
    end_date DATE,
    gender VARCHAR(20),
    ended BOOLEAN DEFAULT FALSE,
    status VARCHAR(20),
    aliases JSONB DEFAULT '[]'::jsonb,
    tags JSONB DEFAULT '[]'::jsonb,
    genres JSONB DEFAULT '[]'::jsonb,
    rating DECIMAL(3,2),
    overview TEXT,
    
    -- Metadata
    first_fetched_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    ttl_expires_at TIMESTAMP WITH TIME ZONE,
    source_provider VARCHAR(50) DEFAULT 'musicbrainz',
    
    -- Access tracking
    last_accessed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    access_count INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Fetch completion tracking
    fetch_complete BOOLEAN DEFAULT FALSE,
    last_fetch_attempt TIMESTAMP WITH TIME ZONE,
    releases_fetched_count INTEGER DEFAULT 0
);

-- Release Groups (Albums) table
CREATE TABLE IF NOT EXISTS release_groups (
    mbid UUID PRIMARY KEY,
    title TEXT NOT NULL,
    disambiguation TEXT,
    primary_type VARCHAR(50),
    secondary_types JSONB DEFAULT '[]'::jsonb,
    first_release_date DATE,
    artist_credit JSONB DEFAULT '[]'::jsonb,
    aliases JSONB DEFAULT '[]'::jsonb,
    tags JSONB DEFAULT '[]'::jsonb,
    genres JSONB DEFAULT '[]'::jsonb,
    rating DECIMAL(3,2),
    overview TEXT,
    
    -- Metadata
    first_fetched_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    ttl_expires_at TIMESTAMP WITH TIME ZONE,
    source_provider VARCHAR(50) DEFAULT 'musicbrainz',
    
    -- Access tracking
    last_accessed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    access_count INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Releases table
CREATE TABLE IF NOT EXISTS releases (
    mbid UUID PRIMARY KEY,
    release_group_mbid UUID NOT NULL REFERENCES release_groups(mbid) ON DELETE CASCADE,
    title TEXT NOT NULL,
    status VARCHAR(50),
    release_date DATE,
    country VARCHAR(2),
    barcode TEXT,
    catalog_number TEXT,
    labels JSONB DEFAULT '[]'::jsonb,
    artist_credit JSONB DEFAULT '[]'::jsonb,
    media_count INTEGER,
    track_count INTEGER,
    disambiguation TEXT,
    media JSONB DEFAULT '[]'::jsonb,
    
    -- Metadata
    first_fetched_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Recordings table
CREATE TABLE IF NOT EXISTS recordings (
    mbid UUID PRIMARY KEY,
    title TEXT NOT NULL,
    disambiguation TEXT DEFAULT '',
    length_ms INTEGER,
    is_video BOOLEAN DEFAULT FALSE,
    
    -- Metadata
    first_fetched_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Tracks table
CREATE TABLE IF NOT EXISTS tracks (
    mbid UUID PRIMARY KEY,
    release_mbid UUID NOT NULL REFERENCES releases(mbid) ON DELETE CASCADE,
    recording_mbid UUID REFERENCES recordings(mbid) ON DELETE SET NULL,
    position INTEGER NOT NULL,
    medium_number INTEGER NOT NULL,
    title TEXT NOT NULL,
    length_ms INTEGER,
    artist_credit JSONB DEFAULT '[]'::jsonb,
    is_data_track BOOLEAN DEFAULT FALSE,
    
    -- Metadata
    first_fetched_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================================
-- RELATIONSHIP TABLES
-- ============================================================================

-- Artist to Release Group many-to-many
CREATE TABLE IF NOT EXISTS artist_release_groups (
    artist_mbid UUID NOT NULL REFERENCES artists(mbid) ON DELETE CASCADE,
    release_group_mbid UUID NOT NULL REFERENCES release_groups(mbid) ON DELETE CASCADE,
    position INTEGER DEFAULT 0,
    join_phrase TEXT,
    PRIMARY KEY (artist_mbid, release_group_mbid)
);

-- ============================================================================
-- ASSET TABLES
-- ============================================================================

-- Images table
CREATE TABLE IF NOT EXISTS images (
    id BIGSERIAL PRIMARY KEY,
    entity_type VARCHAR(20) NOT NULL CHECK (entity_type IN ('artist', 'release_group')),
    entity_mbid UUID NOT NULL,
    url TEXT NOT NULL,
    local_path TEXT,
    
    -- Caching status
    cached BOOLEAN DEFAULT FALSE,
    cached_at TIMESTAMP WITH TIME ZONE,
    cache_failed BOOLEAN DEFAULT FALSE,
    cache_failed_reason TEXT,
    
    -- URL health tracking
    url_verified BOOLEAN DEFAULT TRUE,
    url_last_check TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    url_http_status INTEGER,
    url_failure_count INTEGER DEFAULT 0,
    url_first_failed_at TIMESTAMP WITH TIME ZONE,
    
    -- Image metadata
    cover_type VARCHAR(20) NOT NULL,
    width INTEGER,
    height INTEGER,
    file_size_bytes BIGINT,
    provider VARCHAR(50) NOT NULL,
    last_verified_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    CONSTRAINT unique_entity_image UNIQUE(entity_mbid, cover_type, provider)
);

-- Links table
CREATE TABLE IF NOT EXISTS links (
    id BIGSERIAL PRIMARY KEY,
    entity_type VARCHAR(20) NOT NULL CHECK (entity_type IN ('artist', 'album', 'release_group', 'release', 'recording')),
    entity_mbid UUID NOT NULL,
    link_type VARCHAR(50) NOT NULL,
    url TEXT NOT NULL,
    first_fetched_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    CONSTRAINT unique_entity_link UNIQUE(entity_mbid, link_type, url)
);

-- ============================================================================
-- MAPPING TABLES
-- ============================================================================

-- MBID Redirects table
CREATE TABLE IF NOT EXISTS mbid_redirects (
    old_mbid UUID PRIMARY KEY,
    new_mbid UUID NOT NULL,
    entity_type VARCHAR(20) NOT NULL CHECK (entity_type IN ('artist', 'album', 'release', 'track', 'recording')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- External ID mappings table
CREATE TABLE IF NOT EXISTS external_ids (
    id BIGSERIAL PRIMARY KEY,
    mbid UUID NOT NULL,
    entity_type VARCHAR(20) NOT NULL CHECK (entity_type IN ('artist', 'album')),
    provider VARCHAR(50) NOT NULL,
    external_id TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    CONSTRAINT unique_external_mapping UNIQUE(mbid, entity_type, provider)
);

-- ============================================================================
-- TRACKING TABLES
-- ============================================================================

-- Bulk refresh tracking table
CREATE TABLE IF NOT EXISTS bulk_refresh_log (
    id SERIAL PRIMARY KEY,
    started_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE,
    artists_refreshed INTEGER DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'running',
    CHECK (status IN ('running', 'completed', 'failed'))
);

-- Sync logs table
CREATE TABLE IF NOT EXISTS sync_logs (
    id BIGSERIAL PRIMARY KEY,
    sync_type VARCHAR(50) NOT NULL,
    started_at TIMESTAMP WITH TIME ZONE NOT NULL,
    completed_at TIMESTAMP WITH TIME ZONE,
    entities_updated INTEGER DEFAULT 0,
    errors JSONB DEFAULT '[]'::jsonb,
    status VARCHAR(20) NOT NULL,
    
    CHECK (status IN ('running', 'completed', 'failed'))
);

-- Search cache table
CREATE TABLE IF NOT EXISTS search_cache (
    cache_key VARCHAR(255) PRIMARY KEY,
    search_type VARCHAR(20) NOT NULL CHECK (search_type IN ('artist', 'album')),
    query TEXT NOT NULL,
    artist_filter TEXT,
    results JSONB NOT NULL,
    searched_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    ttl_expires_at TIMESTAMP WITH TIME ZONE NOT NULL
);

-- Metadata fetch job queue
CREATE TABLE IF NOT EXISTS metadata_jobs (
    id BIGSERIAL PRIMARY KEY,
    job_type VARCHAR(50) NOT NULL, -- 'artist_full', 'artist_releases', 'release_tracks'
    entity_type VARCHAR(20) NOT NULL, -- 'artist', 'release_group', 'release'
    entity_mbid UUID NOT NULL,
    priority INTEGER DEFAULT 0, -- higher = more important
    status VARCHAR(20) DEFAULT 'pending', -- pending, processing, completed, failed
    attempts INTEGER DEFAULT 0,
    max_attempts INTEGER DEFAULT 10,
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    metadata JSONB, -- arbitrary job-specific data
    CONSTRAINT unique_job UNIQUE(job_type, entity_mbid),
    CHECK (status IN ('pending', 'processing', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_metadata_jobs_status ON metadata_jobs(status, priority DESC, created_at);
CREATE INDEX IF NOT EXISTS idx_metadata_jobs_entity ON metadata_jobs(entity_type, entity_mbid);
CREATE INDEX IF NOT EXISTS idx_metadata_jobs_pending ON metadata_jobs(status) WHERE status = 'pending';


-- ============================================================================
-- INDEXES
-- ============================================================================

-- Artists indexes
CREATE INDEX IF NOT EXISTS idx_artists_name ON artists(name);
CREATE INDEX IF NOT EXISTS idx_artists_last_accessed ON artists(last_accessed_at);
CREATE INDEX IF NOT EXISTS idx_artists_ttl_expires ON artists(ttl_expires_at);
CREATE INDEX IF NOT EXISTS idx_artists_last_updated ON artists(last_updated_at);

-- Release groups indexes
CREATE INDEX IF NOT EXISTS idx_release_groups_title ON release_groups(title);
CREATE INDEX IF NOT EXISTS idx_release_groups_last_accessed ON release_groups(last_accessed_at);
CREATE INDEX IF NOT EXISTS idx_release_groups_ttl_expires ON release_groups(ttl_expires_at);
CREATE INDEX IF NOT EXISTS idx_release_groups_last_updated ON release_groups(last_updated_at);

-- Releases indexes
CREATE INDEX IF NOT EXISTS idx_releases_release_group ON releases(release_group_mbid);
CREATE INDEX IF NOT EXISTS idx_releases_last_updated ON releases(last_updated_at);

-- Tracks indexes
CREATE INDEX IF NOT EXISTS idx_tracks_release ON tracks(release_mbid);
CREATE INDEX IF NOT EXISTS idx_tracks_recording ON tracks(recording_mbid);
CREATE INDEX IF NOT EXISTS idx_tracks_position ON tracks(release_mbid, medium_number, position);

-- Artist release groups indexes
CREATE INDEX IF NOT EXISTS idx_arg_artist ON artist_release_groups(artist_mbid);
CREATE INDEX IF NOT EXISTS idx_arg_release_group ON artist_release_groups(release_group_mbid);

-- Images indexes
CREATE INDEX IF NOT EXISTS idx_images_entity ON images(entity_type, entity_mbid);
CREATE INDEX IF NOT EXISTS idx_images_cached ON images(cached) WHERE cached = TRUE;
CREATE INDEX IF NOT EXISTS idx_images_cache_failed ON images(cache_failed) WHERE cache_failed = TRUE;
CREATE INDEX IF NOT EXISTS idx_images_url_verified ON images(url_verified) WHERE url_verified = FALSE;
CREATE INDEX IF NOT EXISTS idx_images_needs_verification ON images(url_last_check) WHERE url_verified = TRUE;

-- Links indexes
CREATE INDEX IF NOT EXISTS idx_links_entity ON links(entity_type, entity_mbid);

-- MBID redirects indexes
CREATE INDEX IF NOT EXISTS idx_redirects_new_mbid ON mbid_redirects(new_mbid, entity_type);

-- External IDs indexes
CREATE INDEX IF NOT EXISTS idx_external_ids_mbid ON external_ids(mbid, entity_type);
CREATE INDEX IF NOT EXISTS idx_external_ids_external ON external_ids(provider, external_id);

-- Search cache indexes
CREATE INDEX IF NOT EXISTS idx_search_cache_expires ON search_cache(ttl_expires_at);
CREATE INDEX IF NOT EXISTS idx_search_cache_type_query ON search_cache(search_type, query);

-- Sync logs indexes
CREATE INDEX IF NOT EXISTS idx_sync_logs_started ON sync_logs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_logs_status ON sync_logs(status);

-- ============================================================================
-- FUNCTIONS AND TRIGGERS
-- ============================================================================

-- Function to update last_updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.last_updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers for automatic timestamp updates
CREATE TRIGGER update_artists_updated_at
    BEFORE UPDATE ON artists
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_release_groups_updated_at
    BEFORE UPDATE ON release_groups
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_releases_updated_at
    BEFORE UPDATE ON releases
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_recordings_updated_at
    BEFORE UPDATE ON recordings
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE artists IS 'Stores artist metadata from MusicBrainz and other providers';
COMMENT ON TABLE release_groups IS 'Stores album/EP/single metadata (release groups in MB terminology)';
COMMENT ON TABLE releases IS 'Stores specific releases/pressings of albums';
COMMENT ON TABLE tracks IS 'Stores track listings for releases';
COMMENT ON TABLE recordings IS 'Stores MusicBrainz recording entities';
COMMENT ON TABLE images IS 'Stores image URLs and cached files for artists and albums';
COMMENT ON TABLE links IS 'Stores external links (Wikipedia, official sites, etc.)';
COMMENT ON TABLE mbid_redirects IS 'Handles MusicBrainz entity merges and redirects';
COMMENT ON TABLE external_ids IS 'Maps MusicBrainz IDs to external provider IDs (Spotify, Discogs, etc.)';
COMMENT ON TABLE sync_logs IS 'Audit trail of background sync operations';
COMMENT ON TABLE search_cache IS 'Caches search results to avoid repeated queries';

COMMENT ON COLUMN artists.ttl_expires_at IS 'When this cached data is considered stale';
COMMENT ON COLUMN artists.last_accessed_at IS 'Last time Lidarr requested this artist';
COMMENT ON COLUMN artists.access_count IS 'Number of times this artist has been accessed';
COMMENT ON COLUMN images.url_verified IS 'Whether the image URL is still valid';
COMMENT ON COLUMN images.cached IS 'Whether the image file is cached locally on disk';