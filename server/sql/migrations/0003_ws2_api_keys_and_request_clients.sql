-- API keys for the /ws/2 endpoint, and who made each request in the request feed.

-- Any number of keys, each with a label so a person can tell them apart (one per app or per person). The key itself
-- is shown once when it is created and never stored: only its hash is, plus the first few characters for the list.
-- With no keys at all the endpoint is open; once there is one, a key is required.
CREATE TABLE ws2_api_keys (
    id            BIGSERIAL PRIMARY KEY,
    label         TEXT NOT NULL,
    key_hash      TEXT NOT NULL UNIQUE,
    key_prefix    TEXT NOT NULL,
    created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    last_used_at  TIMESTAMP WITH TIME ZONE,
    request_count BIGINT NOT NULL DEFAULT 0
);

-- Who asked, and for which API: 'LMD' (the Lidarr metadata API) or 'MB' (/ws/2). Outbound rows leave them empty,
-- and rows from before this change read as Lidarr asking for LMD.
ALTER TABLE request_log ADD COLUMN api         VARCHAR(10);
ALTER TABLE request_log ADD COLUMN client_ip   TEXT;
ALTER TABLE request_log ADD COLUMN client_name TEXT;
