-- Browse lists and a general MusicBrainz reply cache, for the /ws/2 API.

-- A complete list MusicBrainz gave for a parent entity (an artist's release groups, a release group's releases):
-- every item exactly as MusicBrainz sent it. Filters and paging are applied when we answer from it, in an order of
-- our own, because MusicBrainz's order changes with the page size and is not something a client can rely on.
CREATE TABLE mb_lists (
    resource    VARCHAR(20) NOT NULL CHECK (resource IN ('release-group', 'release')),
    parent_type VARCHAR(20) NOT NULL CHECK (parent_type IN ('artist', 'release-group')),
    parent_mbid UUID NOT NULL,
    items       JSONB NOT NULL DEFAULT '[]'::jsonb,
    fetched_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    PRIMARY KEY (resource, parent_type, parent_mbid)
);

-- MusicBrainz replies we pass through for requests we can't build ourselves (unusual filters, includes, searches),
-- and for lists we have not finished fetching.
CREATE TABLE mb_proxy_cache (
    cache_key  TEXT PRIMARY KEY,                    -- resource plus the sorted query
    body       TEXT NOT NULL,                       -- the reply as JSON
    fetched_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_mb_proxy_cache_fetched ON mb_proxy_cache(fetched_at);
