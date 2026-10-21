-- Durable "this was looked up and the answer is final" state for the wiki and image work, kept on the rows themselves
-- (the job table is pruned to the latest 500 finished jobs, so a job row cannot be what remembers a lookup), and a
-- not-before time for a failed job so it is retried after a pause instead of at once.
--
--   <entity>.wiki_checked_at    the overview was looked for; a null overview with this set means "nothing found"
--   <entity>.images_checked_at  every image provider was asked and answered; the types still missing do not exist there
--   metadata_jobs.run_after     a job is not picked up before this time (set when it fails and will be retried)
--   artists.catalog_provisional the catalog was taken from a Lidarr metadata upstream because MusicBrainz could not
--                               answer: it serves Lidarr meanwhile, and the verified MusicBrainz fetch replaces it
--
-- A lookup that failed (network error, 429, 5xx) never sets these: only an answer does.

ALTER TABLE artists        ADD COLUMN wiki_checked_at   TIMESTAMP WITH TIME ZONE;
ALTER TABLE artists        ADD COLUMN images_checked_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE release_groups ADD COLUMN wiki_checked_at   TIMESTAMP WITH TIME ZONE;
ALTER TABLE release_groups ADD COLUMN images_checked_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE metadata_jobs  ADD COLUMN run_after         TIMESTAMP WITH TIME ZONE;
ALTER TABLE artists        ADD COLUMN catalog_provisional BOOLEAN NOT NULL DEFAULT FALSE;
