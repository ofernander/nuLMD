/**
 * The include (`inc=`) lists nuLMD asks MusicBrainz for, per entity. One definition, used by the provider (what
 * it requests) and by the raw archive (the key a reply is filed under), so the two can never drift apart.
 */
const INC = {
  artist: 'aliases+tags+ratings+genres+url-rels',
  release_group: 'artists+releases+tags+genres+ratings+url-rels',
  release: 'artist-credits+labels+recordings+release-groups+media',
  recording: 'artist-credits+isrcs',
  // A bulk browse of release groups: the same stored fields as a group lookup, asked for a whole artist at a time
  release_group_browse: 'artist-credits+tags+genres+ratings+url-rels'
};

const archiveKey = entityType => `inc=${INC[entityType]}`;

module.exports = { INC, archiveKey };
