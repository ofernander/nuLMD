-- Entities nuLMD must never ingest (the UI's Block button, the Blocked card in Settings). The two Various Artists ids are
-- built into the code, not stored here. Blocking removes what is held for the entity and stops every later fetch,
-- queued job and store of it; unblocking only lifts the ban (nothing is fetched until it is asked for again).
--
--      blocked_entities.name    a label for the list, taken from the row the block was made from (may be empty)
--      blocked_entities.reason  free text, optional

CREATE TABLE blocked_entities (
    entity_type VARCHAR(20) NOT NULL CHECK (entity_type IN ('artist', 'release_group', 'release')),
    mbid UUID NOT NULL,
    name TEXT,
    reason TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (entity_type, mbid)
);
