-- nuLMD v5 baseline schema  (migration 0001_baseline)
--
-- Entity tables hold three kinds of columns, always grouped and labelled in this order:
--   MusicBrainz data   exactly what MusicBrainz sends, in MusicBrainz's own form. This is the truth.
--   nuLMD enrichment   data MusicBrainz doesn't have (the Wikipedia overview). Images live in `images`.
--   bookkeeping        cache lifecycle and provenance. Never served to clients.
--
-- Dates are TEXT because MusicBrainz dates are partial ("1991", "1991-05"); they sort correctly as text.
-- `tracks` is derived: rebuilt from releases.media by its one writer, never edited.
-- Lidarr output and /ws/2 output are both translated from these tables.
--
-- mb_version: 0 = partial or legacy-shaped data (an upstream, or a converted v4 row), 1 = full MusicBrainz data.
-- Removed from v4: uuid-ossp extension, external_ids, sync_logs, search_cache, bulk_refresh_log,
--   artists.status, *.created_at, *.access_count, artists.fetch_complete/last_fetch_attempt/releases_fetched_count,
--   releases.catalog_number (labels already carries it), tracks.is_data_track,
--   images.url_verified/url_last_check/url_http_status/url_failure_count/url_first_failed_at.

-- ============================================================================
-- MUSICBRAINZ ENTITIES
-- ============================================================================

CREATE TABLE artists (
    mbid UUID PRIMARY KEY,

    -- MusicBrainz data
    name TEXT NOT NULL,
    sort_name TEXT,
    disambiguation TEXT DEFAULT '',
    type VARCHAR(50),
    type_id UUID,
    gender VARCHAR(20),
    gender_id UUID,
    country VARCHAR(2),
    begin_date TEXT,                          -- as sent, may be partial
    end_date TEXT,
    ended BOOLEAN DEFAULT FALSE,
    area JSONB,                               -- {id, name, sort-name, iso-3166-1-codes, ...}
    begin_area JSONB,
    end_area JSONB,
    isnis JSONB DEFAULT '[]'::jsonb,
    ipis JSONB DEFAULT '[]'::jsonb,
    aliases JSONB DEFAULT '[]'::jsonb,        -- [{name, sort-name, type, type-id, locale, primary, begin, end, ended}]
    tags JSONB DEFAULT '[]'::jsonb,           -- [{name, count}]
    genres JSONB DEFAULT '[]'::jsonb,         -- [{id, name, count, disambiguation}]
    rating DECIMAL(3,2),
    rating_votes INTEGER,

    -- nuLMD enrichment
    overview TEXT,

    -- bookkeeping
    mb_version SMALLINT NOT NULL DEFAULT 0,
    source_provider VARCHAR(50) DEFAULT 'musicbrainz',
    needs_mb_backfill BOOLEAN DEFAULT FALSE,
    first_fetched_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    ttl_expires_at TIMESTAMP WITH TIME ZONE,
    last_accessed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE release_groups (
    mbid UUID PRIMARY KEY,

    -- MusicBrainz data
    title TEXT NOT NULL,
    disambiguation TEXT DEFAULT '',
    primary_type VARCHAR(50),
    primary_type_id UUID,
    secondary_types JSONB DEFAULT '[]'::jsonb,
    secondary_type_ids JSONB DEFAULT '[]'::jsonb,
    first_release_date TEXT,                  -- as sent, may be partial
    artist_credit JSONB DEFAULT '[]'::jsonb,  -- MusicBrainz shape: [{name, joinphrase, artist:{id, name, sort-name, disambiguation}}]
    aliases JSONB DEFAULT '[]'::jsonb,
    tags JSONB DEFAULT '[]'::jsonb,
    genres JSONB DEFAULT '[]'::jsonb,
    rating DECIMAL(3,2),
    rating_votes INTEGER,

    -- nuLMD enrichment
    overview TEXT,

    -- bookkeeping
    mb_version SMALLINT NOT NULL DEFAULT 0,
    source_provider VARCHAR(50) DEFAULT 'musicbrainz',
    needs_mb_backfill BOOLEAN DEFAULT FALSE,
    first_fetched_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    ttl_expires_at TIMESTAMP WITH TIME ZONE,
    last_accessed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE releases (
    mbid UUID PRIMARY KEY,
    release_group_mbid UUID NOT NULL REFERENCES release_groups(mbid) ON DELETE CASCADE,

    -- MusicBrainz data
    title TEXT NOT NULL,
    disambiguation TEXT DEFAULT '',
    status VARCHAR(50),
    status_id UUID,
    release_date TEXT,                        -- MusicBrainz "date", may be partial
    country VARCHAR(2),
    barcode TEXT,
    asin TEXT,
    quality VARCHAR(20),
    packaging TEXT,
    packaging_id UUID,
    text_representation JSONB,                -- {language, script}
    release_events JSONB DEFAULT '[]'::jsonb, -- [{date, area}]
    cover_art_archive JSONB,                  -- {artwork, count, front, back, darkened}
    labels JSONB DEFAULT '[]'::jsonb,         -- MusicBrainz label-info
    artist_credit JSONB DEFAULT '[]'::jsonb,
    media JSONB DEFAULT '[]'::jsonb,          -- MusicBrainz media with their tracks and recordings: the truth for tracklists

    -- derived from media
    media_count INTEGER,
    track_count INTEGER,

    -- bookkeeping
    mb_version SMALLINT NOT NULL DEFAULT 0,
    first_fetched_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE recordings (
    mbid UUID PRIMARY KEY,

    -- MusicBrainz data
    title TEXT NOT NULL,
    disambiguation TEXT DEFAULT '',
    length_ms INTEGER,
    video BOOLEAN DEFAULT FALSE,
    first_release_date TEXT,
    artist_credit JSONB DEFAULT '[]'::jsonb,
    isrcs JSONB DEFAULT '[]'::jsonb,

    -- bookkeeping
    mb_version SMALLINT NOT NULL DEFAULT 0,
    first_fetched_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Derived index of releases.media: powers counts and the metadata browser. Lossy by design (no track
-- number text, medium format, ...), so it can never be the source of a response.
CREATE TABLE tracks (
    mbid UUID PRIMARY KEY,
    release_mbid UUID NOT NULL REFERENCES releases(mbid) ON DELETE CASCADE,
    recording_mbid UUID REFERENCES recordings(mbid) ON DELETE SET NULL,
    position INTEGER NOT NULL,
    medium_number INTEGER NOT NULL,
    title TEXT NOT NULL,
    length_ms INTEGER,
    artist_credit JSONB DEFAULT '[]'::jsonb,
    first_fetched_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE artist_release_groups (
    artist_mbid UUID NOT NULL REFERENCES artists(mbid) ON DELETE CASCADE,
    release_group_mbid UUID NOT NULL REFERENCES release_groups(mbid) ON DELETE CASCADE,
    position INTEGER DEFAULT 0,
    join_phrase TEXT,
    PRIMARY KEY (artist_mbid, release_group_mbid)
);

-- MusicBrainz relations (was `links`). URL relations today; target_type/target_mbid leave room for
-- artist-artist, artist-work, ... relations without a redesign.
CREATE TABLE relations (
    id BIGSERIAL PRIMARY KEY,
    entity_type VARCHAR(20) NOT NULL CHECK (entity_type IN ('artist', 'release_group', 'release', 'recording')),
    entity_mbid UUID NOT NULL,
    type VARCHAR(100) NOT NULL,               -- e.g. "official homepage"
    type_id UUID,
    target_type VARCHAR(20) NOT NULL DEFAULT 'url',
    url TEXT,                                 -- the target when target_type = 'url'
    url_id UUID,
    target_mbid UUID,                         -- the target when it is another MusicBrainz entity (not stored yet)
    direction VARCHAR(10),
    begin_date TEXT,
    end_date TEXT,
    ended BOOLEAN,
    attributes JSONB,
    first_fetched_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT unique_url_relation UNIQUE (entity_mbid, type, url)
);

-- MusicBrainz merges: a request for an old id is answered with the new entity.
CREATE TABLE mbid_redirects (
    old_mbid UUID PRIMARY KEY,
    new_mbid UUID NOT NULL,
    entity_type VARCHAR(20) NOT NULL CHECK (entity_type IN ('artist', 'release_group', 'release', 'recording')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Raw replies exactly as MusicBrainz sent them. A backup/rebuild source only: never served directly,
-- re-running the mapper over it refills the tables above without calling MusicBrainz.
CREATE TABLE mb_raw_archive (
    entity_type VARCHAR(20) NOT NULL,
    mbid UUID NOT NULL,
    request_key TEXT NOT NULL,                -- e.g. "inc=aliases+genres+ratings+tags+url-rels"
    body TEXT NOT NULL,                       -- Postgres compresses large values automatically
    source VARCHAR(100),                      -- which server answered
    fetched_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (entity_type, mbid, request_key)
);

-- ============================================================================
-- IMAGES (not MusicBrainz data; irreplaceable when users upload their own)
-- ============================================================================

CREATE TABLE images (
    id BIGSERIAL PRIMARY KEY,
    entity_type VARCHAR(20) NOT NULL CHECK (entity_type IN ('artist', 'release_group')),
    entity_mbid UUID NOT NULL,
    cover_type VARCHAR(20) NOT NULL,
    provider VARCHAR(50) NOT NULL,
    url TEXT NOT NULL,
    local_path TEXT,

    cached BOOLEAN DEFAULT FALSE,
    cached_at TIMESTAMP WITH TIME ZONE,
    cache_failed BOOLEAN DEFAULT FALSE,
    cache_failed_reason TEXT,

    width INTEGER,
    height INTEGER,
    file_size_bytes BIGINT,
    last_verified_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    user_uploaded BOOLEAN DEFAULT FALSE,
    uploaded_at TIMESTAMP WITH TIME ZONE,

    CONSTRAINT unique_entity_image UNIQUE (entity_mbid, cover_type, provider)
);

-- ============================================================================
-- JOBS AND LOGS
-- ============================================================================

CREATE TABLE metadata_jobs (
    id BIGSERIAL PRIMARY KEY,
    job_type VARCHAR(50) NOT NULL,
    entity_type VARCHAR(20) NOT NULL,
    entity_mbid UUID NOT NULL,
    priority INTEGER DEFAULT 0,               -- higher = more important
    status VARCHAR(20) DEFAULT 'pending',
    attempts INTEGER DEFAULT 0,
    max_attempts INTEGER DEFAULT 10,
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    metadata JSONB,
    -- Tree tracking: parent_job_id is the immediate parent, root_artist_mbid the root of the tree.
    -- NULL root_artist_mbid = standalone job.
    parent_job_id BIGINT REFERENCES metadata_jobs(id) ON DELETE SET NULL,
    root_artist_mbid UUID,
    CHECK (status IN ('pending', 'processing', 'completed', 'failed'))
);

CREATE TABLE request_log (
    id BIGSERIAL PRIMARY KEY,
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    direction VARCHAR(10) NOT NULL,
    label TEXT NOT NULL,
    detail TEXT NOT NULL,
    status VARCHAR(10) NOT NULL DEFAULT 'ok'
);

-- ============================================================================
-- INDEXES
-- ============================================================================

CREATE INDEX idx_artists_name ON artists(name);
CREATE INDEX idx_artists_last_accessed ON artists(last_accessed_at);
CREATE INDEX idx_artists_ttl_expires ON artists(ttl_expires_at);
CREATE INDEX idx_artists_last_updated ON artists(last_updated_at);
CREATE INDEX idx_artists_needs_mb_backfill ON artists(mbid) WHERE needs_mb_backfill;

CREATE INDEX idx_release_groups_title ON release_groups(title);
CREATE INDEX idx_release_groups_last_accessed ON release_groups(last_accessed_at);
CREATE INDEX idx_release_groups_ttl_expires ON release_groups(ttl_expires_at);
CREATE INDEX idx_release_groups_last_updated ON release_groups(last_updated_at);
CREATE INDEX idx_release_groups_needs_mb_backfill ON release_groups(mbid) WHERE needs_mb_backfill;

CREATE INDEX idx_releases_release_group ON releases(release_group_mbid);
CREATE INDEX idx_releases_last_updated ON releases(last_updated_at);

CREATE INDEX idx_tracks_release ON tracks(release_mbid);
CREATE INDEX idx_tracks_recording ON tracks(recording_mbid);
CREATE INDEX idx_tracks_position ON tracks(release_mbid, medium_number, position);

CREATE INDEX idx_arg_artist ON artist_release_groups(artist_mbid);
CREATE INDEX idx_arg_release_group ON artist_release_groups(release_group_mbid);

CREATE INDEX idx_relations_entity ON relations(entity_type, entity_mbid);
CREATE INDEX idx_redirects_new_mbid ON mbid_redirects(new_mbid, entity_type);

CREATE INDEX idx_images_entity ON images(entity_type, entity_mbid);
CREATE INDEX idx_images_cached ON images(cached) WHERE cached = TRUE;
CREATE INDEX idx_images_cache_failed ON images(cache_failed) WHERE cache_failed = TRUE;

CREATE UNIQUE INDEX idx_jobs_standalone ON metadata_jobs(job_type, entity_mbid) WHERE root_artist_mbid IS NULL;
CREATE UNIQUE INDEX idx_jobs_tree ON metadata_jobs(job_type, entity_mbid, root_artist_mbid) WHERE root_artist_mbid IS NOT NULL;
CREATE INDEX idx_metadata_jobs_status ON metadata_jobs(status, priority DESC, created_at);
CREATE INDEX idx_metadata_jobs_entity ON metadata_jobs(entity_type, entity_mbid);
CREATE INDEX idx_metadata_jobs_pending ON metadata_jobs(status) WHERE status = 'pending';
CREATE INDEX idx_metadata_jobs_parent ON metadata_jobs(parent_job_id);
CREATE INDEX idx_metadata_jobs_root_artist ON metadata_jobs(root_artist_mbid) WHERE root_artist_mbid IS NOT NULL;
CREATE INDEX idx_metadata_jobs_created_at ON metadata_jobs(created_at DESC);

CREATE INDEX idx_request_log_timestamp ON request_log(timestamp DESC);

-- ============================================================================
-- MIGRATION TRACKING (new in v5). This file is migration 0001; every later change is a numbered file
-- in this folder that runs once, in order, and is recorded here by the runner (server/sql/migrate.js).
-- ============================================================================

CREATE TABLE schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
