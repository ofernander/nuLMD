const BaseProvider = require('./base');

class LastFmProvider extends BaseProvider {
  constructor(config) {
    super('Last.fm', config);
    this.apiKey = config.apiKey;
  }

  async initialize() {
    await super.initialize();
    if (this.apiKey) {
      this.client.defaults.params = { api_key: this.apiKey, format: 'json' };
    }
  }

  async searchArtist(query, limit = 10) {
    // TODO: Implement Last.fm artist search
    throw new Error('Last.fm provider not yet implemented');
  }

  async getArtist(id) {
    // TODO: Implement Last.fm artist retrieval
    throw new Error('Last.fm provider not yet implemented');
  }

  async searchAlbum(query, artist = null, limit = 10) {
    // TODO: Implement Last.fm album search
    throw new Error('Last.fm provider not yet implemented');
  }

  async getAlbum(id) {
    // TODO: Implement Last.fm album retrieval
    throw new Error('Last.fm provider not yet implemented');
  }

  async getAlbumTracks(albumId) {
    // TODO: Implement Last.fm track retrieval
    throw new Error('Last.fm provider not yet implemented');
  }
}

module.exports = LastFmProvider;
