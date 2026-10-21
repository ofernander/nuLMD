-- What nuLMD answered an inbound request with, and what it did to answer it, for the dashboard's request card: the
-- request, the calls it made to other sources, and the reply, as one group.
--
--      request_log.outcome      a few words: "from cache", "fetched from MusicBrainz", "5 results", "error: ..."
--      request_log.duration_ms  how long nuLMD took to answer
--      request_log.calls        the outgoing calls made while the request waited, as {"items": [...], "more": n}
--                               (each item: label, detail, status, outcome, durationMs); for an image fetch, the files
--
-- Rows from before this existed have none of them; the card shows them as plainly answered or failed.

ALTER TABLE request_log ADD COLUMN outcome     TEXT;
ALTER TABLE request_log ADD COLUMN duration_ms INTEGER;
ALTER TABLE request_log ADD COLUMN calls       JSONB;
