-- What MusicBrainz reported for an artist at its last full catalog fetch, so a later check can tell whether anything was
-- added or removed with two tiny requests instead of fetching the whole catalog again.
--
--   artists.mb_release_group_count  release groups MusicBrainz listed for the artist
--   artists.mb_release_count        releases MusicBrainz listed for the artist
--   artists.catalog_full_at         when the whole catalog was last fetched (not just checked)
--
-- Empty on artists stored before this: they get a full fetch at their next TTL, which fills these in.

ALTER TABLE artists ADD COLUMN mb_release_group_count INTEGER;
ALTER TABLE artists ADD COLUMN mb_release_count       INTEGER;
ALTER TABLE artists ADD COLUMN catalog_full_at        TIMESTAMP WITH TIME ZONE;
