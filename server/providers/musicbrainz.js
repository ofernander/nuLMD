const BaseProvider = require('./base');
const { logger } = require('../lib/logger');

class MusicBrainzProvider extends BaseProvider {
  constructor(config) {
    const baseUrl = config.baseUrl || process.env.MUSICBRAINZ_URL || 'https://musicbrainz.org/ws/2';
    
    // Detect if using official MusicBrainz server
    const isOfficialServer = baseUrl === 'https://musicbrainz.org/ws/2';
    
    // Determine rate limiting
    let rateLimit = null;
    
    if (isOfficialServer) {
      // Official MB always uses 2000ms rate limit (cannot be overridden)
      rateLimit = { requests: 1, period: 2000 };
      logger.info(`MusicBrainz: Using official server - rate limit: 2000ms`);
    } else {
      // Custom servers: check env variable override
      if (process.env.MUSICBRAINZ_RATE_LIMIT !== undefined) {
        const rateLimitMs = parseInt(process.env.MUSICBRAINZ_RATE_LIMIT);
        if (rateLimitMs > 0) {
          rateLimit = { requests: 1, period: rateLimitMs };
          logger.info(`MusicBrainz: Using custom rate limit from env: ${rateLimitMs}ms`);
        } else {
          logger.info(`MusicBrainz: Rate limiting disabled via env variable`);
        }
      } else {
        // Default: no rate limit for custom servers
        logger.info(`MusicBrainz: Using custom server - rate limiting disabled`);
      }
    }
    
    const providerConfig = {
      ...config,
      baseUrl: baseUrl,
      rateLimit: rateLimit
    };
    
    super('MusicBrainz', providerConfig);
    this.customBaseUrl = config.baseUrl;
    this.useLocalServer = !isOfficialServer;
  }

  async initialize() {
    await super.initialize();
  }

  async searchArtist(query, limit = 10) {
    const cacheKey = `mb:artist:search:${query}:${limit}`;
    
    return this.cachedRequest(cacheKey, async () => {
      logger.info(`MusicBrainz: Searching for artist "${query}"`);
      
      const response = await this.client.get('/artist', {
        params: {
          query: query,
          limit: limit,
          fmt: 'json'
        }
      });

      return this.normalizeArtistSearchResults(response.data);
    });
  }

  async getArtist(mbid) {
    const cacheKey = `mb:artist:${mbid}`;
    
    return this.cachedRequest(cacheKey, async () => {
      logger.info(`MusicBrainz: Fetching artist ${mbid}`);
      
      const response = await this.client.get(`/artist/${mbid}`, {
        params: {
          inc: 'aliases+tags+ratings+genres+url-rels',
          fmt: 'json'
        }
      });

      return this.normalizeArtist(response.data);
    });
  }

  async getArtistAlbums(artistMbid) {
    const cacheKey = `mb:artist:${artistMbid}:albums`;
    
    return this.cachedRequest(cacheKey, async () => {
      logger.info(`MusicBrainz: Fetching all albums for artist ${artistMbid} (paginated)`);
      
      const allAlbums = [];
      let offset = 0;
      const limit = 100;
      let total = null;

      do {
        const response = await this.client.get('/release-group', {
          params: {
            artist: artistMbid,
            limit,
            offset,
            fmt: 'json'
          }
        });

        const data = response.data;
        if (total === null) total = data['release-group-count'] || 0;

        const page = this.normalizeAlbumSearchResults(data);
        allAlbums.push(...page);
        offset += limit;

        logger.info(`MusicBrainz: Fetched ${allAlbums.length}/${total} release groups for artist ${artistMbid}`);
      } while (offset < total);

      return allAlbums;
    });
  }

  async getReleaseGroup(mbid) {
    const cacheKey = `mb:release-group:${mbid}`;
    
    return this.cachedRequest(cacheKey, async () => {
      logger.info(`MusicBrainz: Fetching release group ${mbid}`);
      
      const response = await this.client.get(`/release-group/${mbid}`, {
        params: {
          inc: 'artists+releases+tags+genres+ratings+url-rels',
          fmt: 'json'
        }
      });

      return this.normalizeReleaseGroup(response.data);
    });
  }

  async getRelease(mbid) {
    const cacheKey = `mb:release:${mbid}`;
    
    return this.cachedRequest(cacheKey, async () => {
      logger.info(`MusicBrainz: Fetching release ${mbid}`);
      
      const response = await this.client.get(`/release/${mbid}`, {
        params: {
          inc: 'artist-credits+labels+recordings+release-groups+media',
          fmt: 'json'
        }
      });

      return this.normalizeRelease(response.data);
    });
  }

  async browseReleases(artistMbid, options = {}) {
    const { offset = 0, limit = 100, inc = 'artist-credits+labels+media' } = options;
    
    logger.info(`MusicBrainz: Browsing releases for artist ${artistMbid}, offset=${offset}, limit=${limit}`);
    
    const response = await this.client.get('/release', {
      params: {
        artist: artistMbid,
        limit,
        offset,
        inc,
        fmt: 'json'
      }
    });

    // Return the releases array
    return response.data.releases || [];
  }

  async getReleasesByReleaseGroup(releaseGroupMbid) {
    logger.info(`MusicBrainz: Fetching all releases for release group ${releaseGroupMbid} (paginated)`);

    const allReleases = [];
    let offset = 0;
    const limit = 100;
    let total = null;

    do {
      const response = await this.client.get('/release', {
        params: {
          'release-group': releaseGroupMbid,
          limit,
          offset,
          fmt: 'json'
        }
      });

      const data = response.data;
      if (total === null) total = data['release-count'] || 0;

      const releases = data.releases || [];
      allReleases.push(...releases.map(r => ({
        id: r.id,
        title: r.title,
        date: r.date,
        country: r.country,
        status: r.status
      })));
      offset += limit;

      logger.info(`MusicBrainz: Fetched ${allReleases.length}/${total} releases for release group ${releaseGroupMbid}`);
    } while (offset < total);

    return allReleases;
  }

  async searchAlbum(query, artist = null, limit = 10) {
    let searchQuery = query;
    if (artist) {
      searchQuery = `${query} AND artist:"${artist}"`;
    }

    const cacheKey = `mb:album:search:${searchQuery}:${limit}`;
    
    return this.cachedRequest(cacheKey, async () => {
      logger.info(`MusicBrainz: Searching for album "${query}"`);
      
      const response = await this.client.get('/release-group', {
        params: {
          query: searchQuery,
          limit: limit,
          fmt: 'json'
        }
      });

      return this.normalizeAlbumSearchResults(response.data);
    });
  }

  async getAlbum(mbid) {
    const cacheKey = `mb:album:${mbid}`;
    
    return this.cachedRequest(cacheKey, async () => {
      logger.info(`MusicBrainz: Fetching album ${mbid}`);
      
      const response = await this.client.get(`/release-group/${mbid}`, {
        params: {
          inc: 'artists+releases+aliases+tags+ratings+genres+url-rels',
          fmt: 'json'
        }
      });

      return this.normalizeAlbum(response.data);
    });
  }

  async getAlbumTracks(releaseId) {
    const cacheKey = `mb:tracks:${releaseId}`;
    
    return this.cachedRequest(cacheKey, async () => {
      logger.info(`MusicBrainz: Fetching tracks for release ${releaseId}`);
      
      const response = await this.client.get(`/release/${releaseId}`, {
        params: {
          inc: 'recordings+artist-credits',
          fmt: 'json'
        }
      });

      return this.normalizeTracks(response.data);
    });
  }

  // Normalization methods to convert MusicBrainz format to Lidarr-compatible format
  normalizeArtistSearchResults(data) {
    if (!data.artists) return [];
    
    return data.artists.map(artist => ({
      id: artist.id,
      name: artist.name,
      sortName: artist['sort-name'],
      disambiguation: artist.disambiguation || '',
      type: artist.type || 'Unknown',
      country: artist.country || null,
      score: artist.score || 0,
      provider: 'musicbrainz'
    }));
  }

  normalizeArtist(artist) {
    // Extract life-span dates
    const lifeSpan = artist['life-span'] || {};
    let beginDate = lifeSpan.begin || null;
    let endDate = lifeSpan.end || null;
    const ended = lifeSpan.ended || false;
    
    // Convert partial dates to full dates (Postgres needs YYYY-MM-DD)
    if (beginDate) {
      if (beginDate.length === 4) {
        beginDate = `${beginDate}-01-01`; // Year only
      } else if (beginDate.length === 7) {
        beginDate = `${beginDate}-01`; // Year-Month
      }
    }
    if (endDate) {
      if (endDate.length === 4) {
        endDate = `${endDate}-01-01`;
      } else if (endDate.length === 7) {
        endDate = `${endDate}-01`;
      }
    }
    
    // Determine status
    let status = null;
    if (artist.type === 'Person') {
      status = ended ? 'ended' : 'active';
    } else if (artist.type === 'Group') {
      status = ended ? 'ended' : 'active';
    }
    
    // Extract links
    const links = this.extractLinks(artist.relations || []);
    
    return {
      id: artist.id,
      name: artist.name,
      sortName: artist['sort-name'],
      disambiguation: artist.disambiguation || '',
      type: artist.type || 'Unknown',
      country: artist.country || null,
      gender: artist.gender || null,
      beginDate: beginDate,
      endDate: endDate,
      ended: ended,
      status: status,
      aliases: (artist.aliases || []).map(a => a.name || a['sort-name']),
      tags: (artist.tags || []).map(t => t.name),
      genres: (artist.genres || []).map(g => g.name),
      rating: artist.rating ? artist.rating.value : null,
      links: links,
      provider: 'musicbrainz'
    };
  }

  normalizeAlbumSearchResults(data) {
    if (!data['release-groups']) return [];
    
    return data['release-groups'].map(rg => ({
      id: rg.id,
      title: rg.title,
      disambiguation: rg.disambiguation || '',
      primaryType: rg['primary-type'] || 'Album',
      secondaryTypes: rg['secondary-types'] || [],
      firstReleaseDate: rg['first-release-date'] || null,
      artistCredit: this.formatArtistCredit(rg['artist-credit'] || []),
      score: rg.score || 0,
      provider: 'musicbrainz'
    }));
  }

  normalizeReleaseGroup(rg) {
    // Normalize dates
    let releaseDate = rg['first-release-date'] || null;
    if (releaseDate) {
      if (releaseDate.length === 4) releaseDate = `${releaseDate}-01-01`;
      else if (releaseDate.length === 7) releaseDate = `${releaseDate}-01`;
    }
    
    return {
      id: rg.id,
      title: rg.title,
      disambiguation: rg.disambiguation || '',
      primaryType: rg['primary-type'] || 'Album',
      secondaryTypes: rg['secondary-types'] || [],
      firstReleaseDate: releaseDate,
      artistCredit: this.formatArtistCredit(rg['artist-credit'] || []),
      aliases: (rg.aliases || []).map(a => ({
        name: a.name,
        sortName: a['sort-name'],
        locale: a.locale,
        primary: a.primary || false,
        type: a.type
      })),
      tags: (rg.tags || []).map(t => t.name),
      genres: (rg.genres || []).map(g => g.name),
      rating: rg.rating ? rg.rating.value : null,
      links: this.extractLinks(rg.relations || []),
      releases: (rg.releases || []).map(r => ({
        id: r.id,
        title: r.title,
        date: r.date,
        country: r.country,
        status: r.status
      })),
      provider: 'musicbrainz'
    };
  }

  normalizeRelease(release) {
    // Normalize date
    let releaseDate = release.date || null;
    if (releaseDate) {
      if (releaseDate.length === 4) releaseDate = `${releaseDate}-01-01`;
      else if (releaseDate.length === 7) releaseDate = `${releaseDate}-01`;
    }
    
    return {
      id: release.id,
      releaseGroupId: release['release-group']?.id || null,
      title: release.title,
      status: release.status || 'Official',
      date: releaseDate,
      country: release.country || null,
      barcode: release.barcode || null,
      disambiguation: release.disambiguation || '',
      'label-info': release['label-info'] || [],
      'artist-credit': release['artist-credit'] || [],
      media: release.media || [],
      provider: 'musicbrainz'
    };
  }

  normalizeAlbum(album) {
    // Normalize dates FIRST
    let releaseDate = album['first-release-date'] || null;
    if (releaseDate) {
      if (releaseDate.length === 4) releaseDate = `${releaseDate}-01-01`;
      else if (releaseDate.length === 7) releaseDate = `${releaseDate}-01`;
    }
    
    return {
      id: album.id,
      title: album.title,
      disambiguation: album.disambiguation || '',
      primaryType: album['primary-type'] || 'Album',
      secondaryTypes: album['secondary-types'] || [],
      firstReleaseDate: releaseDate,
      artistCredit: this.formatArtistCredit(album['artist-credit'] || []),
      aliases: (album.aliases || []).map(a => ({
        name: a.name,
        sortName: a['sort-name'],
        locale: a.locale,
        primary: a.primary || false,
        type: a.type
      })),
      tags: (album.tags || []).map(t => t.name),
      genres: (album.genres || []).map(g => g.name),
      rating: album.rating ? album.rating.value : null,
      links: this.extractLinks(album.relations || []),
      releases: (album.releases || []).map(r => ({
        id: r.id,
        title: r.title,
        date: r.date,
        country: r.country,
        status: r.status
      })),
      provider: 'musicbrainz'
    };
  }

  normalizeTracks(release) {
    const tracks = [];
    
    if (release.media) {
      release.media.forEach((medium, mediumIndex) => {
        if (medium.tracks) {
          medium.tracks.forEach(track => {
            tracks.push({
              id: track.id,
              position: track.position,
              number: track.number,
              title: track.title,
              length: track.length,
              recording: {
                id: track.recording.id,
                title: track.recording.title,
                length: track.recording.length
              },
              artistCredit: this.formatArtistCredit(track['artist-credit'] || []),
              mediumNumber: mediumIndex + 1
            });
          });
        }
      });
    }
    
    return tracks;
  }

  formatArtistCredit(artistCredit) {
    if (!Array.isArray(artistCredit)) return [];
    
    return artistCredit.map(ac => ({
      artist: {
        id: ac.artist ? ac.artist.id : null,
        name: ac.artist ? ac.artist.name : ac.name || '',
        disambiguation: ac.artist ? ac.artist.disambiguation || '' : ''
      },
      name: ac.name || (ac.artist ? ac.artist.name : ''),
      joinPhrase: ac.joinphrase || ''
    }));
  }

  formatArtistCreditString(artistCredit) {
    // Helper to get display string from artist credit
    if (!Array.isArray(artistCredit)) return '';
    
    return artistCredit.map(ac => {
      const name = ac.name || (ac.artist ? ac.artist.name : '');
      const joinPhrase = ac.joinphrase || '';
      return name + joinPhrase;
    }).join('');
  }

  extractLinks(relations) {
    const links = [];
    
    relations.forEach(rel => {
      if (rel.url) {
        links.push({
          type: rel.type || 'other',
          url: rel.url.resource
        });
      }
    });
    
    return links;
  }
}

module.exports = MusicBrainzProvider;
