const { registry } = require('./providerRegistry');
const { logger } = require('./logger');

async function searchArtists(query, limit = 3) {
  const mbProvider = registry.getProvider('musicbrainz');
  if (!mbProvider) throw new Error('MusicBrainz provider not available');

  const wikiProvider = registry.getProvider('wikipedia');
  const tadbProvider = registry.getProvider('theaudiodb');
  const fanartProvider = registry.getProvider('fanart');

  const results = await mbProvider.searchArtist(query, limit);

  return Promise.all(results.map(async (result) => {
    let overview = '';
    let images = [];

    // Overview from Wikipedia
    if (wikiProvider) {
      try {
        overview = await wikiProvider.getArtistOverview(null, result.name, result.type) || '';
      } catch (err) {
        logger.warn(`Wiki overview failed for ${result.name}: ${err.message}`);
      }
    }

    // Images from TheAudioDB, fallback to Fanart
    if (tadbProvider) {
      try {
        images = await tadbProvider.getArtistImages(result.name, result.id);
      } catch (err) {
        logger.warn(`TADB images failed for ${result.name}: ${err.message}`);
      }
    }
    if (images.length === 0 && fanartProvider) {
      try {
        images = await fanartProvider.getArtistImages(result.id);
      } catch (err) {
        logger.warn(`Fanart images failed for ${result.name}: ${err.message}`);
      }
    }

    return { ...result, overview, images };
  }));
}

async function searchAlbums(query, limit = 3) {
  const mbProvider = registry.getProvider('musicbrainz');
  if (!mbProvider) throw new Error('MusicBrainz provider not available');

  const caaProvider = registry.getProvider('coverartarchive');
  const tadbProvider = registry.getProvider('theaudiodb');

  const results = await mbProvider.searchAlbum(query, null, limit);

  return Promise.all(results.map(async (result) => {
    let images = [];

    // Cover art from CAA, fallback to TADB
    if (caaProvider) {
      try {
        images = await caaProvider.getAlbumImages(result.id);
      } catch (err) {
        logger.warn(`CAA images failed for ${result.id}: ${err.message}`);
      }
    }
    if (images.length === 0 && tadbProvider) {
      try {
        const artistCredit = result.artistCredit || [];
        const artistName = artistCredit.length > 0 ? artistCredit[0].artist.name : null;
        if (artistName) images = await tadbProvider.getAlbumImages(result.title, artistName, result.id);
      } catch (err) {
        logger.warn(`TADB album images failed for ${result.title}: ${err.message}`);
      }
    }

    return { ...result, images };
  }));
}

module.exports = { searchArtists, searchAlbums };
