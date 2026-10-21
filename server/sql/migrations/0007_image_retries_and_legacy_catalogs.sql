-- 1. A failed image download is retried by the download queue itself (a few times, an hour apart), independent of any TTL.
--
--      images.download_failures  how many times the download failed since it last succeeded (a permanent refusal such as
--                                a 404 counts as all of them, so it is never retried)
--      images.last_failed_at     when it last failed; failures from before this column existed stay failed until refreshed
--                                by hand in the image explorer
--
-- 2. Artists stored before the catalog markers existed whose job record was pruned have no catalog_complete_at, so Lidarr
--    was given an empty album list for them until the catalog job finished. If every release group of such an artist is
--    held in full (not as a browse stub), it was fetched completely once: it keeps being served, like those 0004 marked
--    from job records, and the verified fetch replaces it at its TTL. (The v4 converter runs the same statement after
--    copying, because it migrates before the data exists.)

ALTER TABLE images ADD COLUMN download_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE images ADD COLUMN last_failed_at    TIMESTAMP WITH TIME ZONE;

UPDATE artists a SET catalog_complete_at = NOW()
WHERE a.catalog_complete_at IS NULL
  AND EXISTS (SELECT 1 FROM artist_release_groups arg WHERE arg.artist_mbid = a.mbid)
  AND NOT EXISTS (SELECT 1 FROM artist_release_groups arg JOIN release_groups rg ON rg.mbid = arg.release_group_mbid
                  WHERE arg.artist_mbid = a.mbid AND rg.mb_version <> 1);
