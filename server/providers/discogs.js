const BaseProvider = require('./base');

class DiscogsProvider extends BaseProvider {
  constructor(config) {
    super('Discogs', config);
    this.token = config.token;
  }

  async initialize() {
    await super.initialize();
    if (this.token) {
      this.client.defaults.headers.common['Authorization'] = `Discogs token=${this.token}`;
    }
  }

  async searchArtist(query, limit = 10) {
    // TODO: Implement Discogs artist search
    throw new Error('Discogs provider not yet implemented');
  }

  async getArtist(id) {
    // TODO: Implement Discogs artist retrieval
    throw new Error('Discogs provider not yet implemented');
  }

  async searchAlbum(query, artist = null, limit = 10) {
    // TODO: Implement Discogs album search
    throw new Error('Discogs provider not yet implemented');
  }

  async getAlbum(id) {
    // TODO: Implement Discogs album retrieval
    throw new Error('Discogs provider not yet implemented');
  }

  async getAlbumTracks(albumId) {
    // TODO: Implement Discogs release retrieval
    throw new Error('Discogs provider not yet implemented');
  }
}

module.exports = DiscogsProvider;
