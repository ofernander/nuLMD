-- What an inbound request was answered with, in a few words, for the dashboard's Responses card: "6 albums · images: 2 nuLMD,
-- 1 placeholder", "0 albums (catalog still being fetched)", "5 results · top: Thug Life". (request_log.outcome, from 0008, says
-- how it was made: "from cache", "fetched from MusicBrainz".) Rows from before this have none.

ALTER TABLE request_log ADD COLUMN reply TEXT;
