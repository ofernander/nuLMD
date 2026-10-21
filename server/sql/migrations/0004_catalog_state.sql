-- Durable "is this complete" state, kept on the rows themselves instead of in the job table (which is pruned to the
-- latest 500 finished jobs, so a job row cannot be what says "done").
--
--   artists.catalog_complete_at        the artist's release groups, and every release of each, are stored:
--                                      Lidarr may be given its album list
--   artists.catalog_verified_at        that was checked against the totals MusicBrainz reported (a bulk fetch).
--                                      Empty = data from before this check, or provisional data from a fallback source
--   release_groups.releases_complete_at  every release MusicBrainz lists for this group is stored
--                                      (a group confirmed empty on MusicBrainz counts)

ALTER TABLE artists        ADD COLUMN catalog_complete_at  TIMESTAMP WITH TIME ZONE;
ALTER TABLE artists        ADD COLUMN catalog_verified_at  TIMESTAMP WITH TIME ZONE;
ALTER TABLE release_groups ADD COLUMN releases_complete_at TIMESTAMP WITH TIME ZONE;

-- Libraries that are already being served keep being served: what a completed fetch_artist_albums job covered counts
-- as complete, and a group with any release stored is answered from the tables as it was before. Both stay
-- unverified, so the verified bulk fetch replaces them when each artist reaches its TTL.
-- (The v4 converter runs these same two statements after copying, because it migrates before the data exists.)
UPDATE artists a SET catalog_complete_at = j.at
FROM (SELECT entity_mbid, MAX(COALESCE(completed_at, NOW())) AS at
      FROM metadata_jobs
      WHERE job_type = 'fetch_artist_albums' AND status = 'completed'
      GROUP BY entity_mbid) j
WHERE a.mbid = j.entity_mbid;

UPDATE release_groups rg SET releases_complete_at = NOW()
WHERE EXISTS (SELECT 1 FROM releases r WHERE r.release_group_mbid = rg.mbid);
