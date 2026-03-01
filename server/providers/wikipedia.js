const BaseProvider = require('./base');
const { logger } = require('../lib/logger');

class WikipediaProvider extends BaseProvider {
  constructor(config) {
    const providerConfig = {
      ...config,
      baseUrl: 'https://en.wikipedia.org/w/api.php',
      rateLimit: {
        requests: 1,
        period: 1000  // 1 request per second (be nice to Wikipedia)
      }
    };
    
    super('Wikipedia', providerConfig);
  }

  async initialize() {
    await super.initialize();
  }

  /**
   * Get artist overview/biography from Wikipedia
   * @param {string} wikidataId - Wikidata ID (e.g., "Q224483")
   * @param {string} artistName - Artist name as fallback
   * @param {string} artistType - MusicBrainz artist type ("Group" or "Person")
   * @returns {Promise<string|null>} - Wikipedia intro text or null
   */
  async getArtistOverview(wikidataId = null, artistName = null, artistType = null) {
    const cacheKey = `wikipedia:overview:${wikidataId || artistName}`;
    
    return this.cachedRequest(cacheKey, async () => {
      let pageTitle = null;
      
      // 1. Try Wikidata ID (most reliable — links directly to correct article)
      if (wikidataId) {
        pageTitle = await this.getPageTitleFromWikidata(wikidataId);
      }
      
      // 2. Search by name with music-aware ranking
      if (!pageTitle && artistName) {
        pageTitle = await this.searchPageByName(artistName, true);
        
        if (pageTitle) {
          const intro = await this.getPageIntro(pageTitle);
          
          if (!intro) {
            // Disambiguation page — try type-based suffix
            const suffix = artistType === 'Group' ? ' (band)' : ' (musician)';
            logger.debug(`Wikipedia: Retrying search with suffix "${suffix}"`);
            pageTitle = await this.searchPageByName(artistName + suffix, false);
            if (!pageTitle) return null;
            return await this.getPageIntro(pageTitle);
          }
          
          // Got content — check if it's actually about music
          if (!this._looksLikeMusic(intro)) {
            logger.debug(`Wikipedia: "${pageTitle}" doesn't appear music-related, retrying with suffix`);
            const suffix = artistType === 'Group' ? ' (band)' : ' (musician)';
            const altTitle = await this.searchPageByName(artistName + suffix, false);
            if (altTitle) {
              const altIntro = await this.getPageIntro(altTitle);
              if (altIntro && this._looksLikeMusic(altIntro)) {
                return altIntro;
              }
            }
            // Suffixed search failed — return original (better than nothing)
            return intro;
          }
          
          return intro;
        }
      }
      
      if (!pageTitle) {
        logger.debug(`Wikipedia: No page found for ${wikidataId || artistName}`);
        return null;
      }
      
      // Fetch the intro text
      return await this.getPageIntro(pageTitle);
    }, 7 * 24 * 60 * 60); // Cache for 7 days (bios don't change often)
  }

  /**
   * Get Wikipedia page title from Wikidata ID
   * @param {string} wikidataId - Wikidata ID (e.g., "Q224483")
   * @returns {Promise<string|null>}
   */
  async getPageTitleFromWikidata(wikidataId) {
    try {
      logger.debug(`Wikipedia: Looking up page title for Wikidata ${wikidataId}`);
      
      // Query Wikidata for the English Wikipedia page
      const response = await this.client.get('', {
        params: {
          action: 'wbgetentities',
          ids: wikidataId,
          props: 'sitelinks',
          sitefilter: 'enwiki',
          format: 'json'
        },
        baseURL: 'https://www.wikidata.org/w/api.php'
      });
      
      const entity = response.data.entities[wikidataId];
      if (entity && entity.sitelinks && entity.sitelinks.enwiki) {
        const title = entity.sitelinks.enwiki.title;
        logger.debug(`Wikipedia: Found page title "${title}" for ${wikidataId}`);
        return title;
      }
      
      return null;
    } catch (error) {
      logger.error(`Wikipedia: Failed to get page title from Wikidata ${wikidataId}:`, error.message);
      return null;
    }
  }

  /**
   * Search for Wikipedia page by artist name
   * @param {string} artistName
   * @returns {Promise<string|null>}
   */
  async searchPageByName(artistName, preferMusic = false) {
    try {
      logger.debug(`Wikipedia: Searching for page by name "${artistName}"`);
      
      const response = await this.client.get('', {
        params: {
          action: 'opensearch',
          search: artistName,
          limit: 10,
          format: 'json'
        }
      });
      
      // OpenSearch returns: [query, [titles], [descriptions], [urls]]
      const titles = response.data[1];
      if (!titles?.length) return null;

      if (!preferMusic) {
        logger.debug(`Wikipedia: Found page "${titles[0]}" for "${artistName}"`);
        return titles[0];
      }

      // Score titles for music relevance — prefer pages with music-related suffixes
      const musicSuffixes = ['(band)', '(musician)', '(singer)', '(rapper)',
        '(songwriter)', '(artist)', '(group)', '(duo)', '(trio)',
        '(album)', '(ep)', '(song)', '(musical project)'];
      
      const lower = artistName.toLowerCase();
      for (const title of titles) {
        const titleLower = title.toLowerCase();
        if (musicSuffixes.some(s => titleLower === `${lower} ${s}`)) {
          logger.debug(`Wikipedia: Preferred music page "${title}" for "${artistName}"`);
          return title;
        }
      }

      // No music-suffixed match, return first result
      logger.debug(`Wikipedia: No music-specific page found, using "${titles[0]}" for "${artistName}"`);
      return titles[0];
    } catch (error) {
      logger.error(`Wikipedia: Failed to search for "${artistName}":`, error.message);
      return null;
    }
  }

  /**
   * Get the intro/summary section of a Wikipedia page
   * @param {string} pageTitle - Wikipedia page title
   * @returns {Promise<string|null>}
   */
  async getPageIntro(pageTitle) {
    try {
      logger.debug(`Wikipedia: Fetching intro for "${pageTitle}"`);
      
      const response = await this.client.get('', {
        params: {
          action: 'query',
          prop: 'extracts|pageprops',
          exintro: true,           // Only intro section
          explaintext: true,       // Plain text (no HTML)
          titles: pageTitle,
          format: 'json'
        }
      });
      
      const pages = response.data.query.pages;
      const pageId = Object.keys(pages)[0];
      
      if (pageId === '-1') {
        logger.debug(`Wikipedia: Page "${pageTitle}" not found`);
        return null;
      }
      
      const page = pages[pageId];
      
      // Check if this is a disambiguation page
      if (page.pageprops && page.pageprops.disambiguation !== undefined) {
        logger.debug(`Wikipedia: "${pageTitle}" is a disambiguation page, skipping`);
        return null;
      }
      
      const extract = page.extract;
      
      if (!extract || extract.trim() === '') {
        logger.debug(`Wikipedia: No extract found for "${pageTitle}"`);
        return null;
      }
      
      // Additional check: if extract starts with "X may refer to:" it's likely disambiguation
      if (extract.match(/^.+ may refer to:/i)) {
        logger.debug(`Wikipedia: "${pageTitle}" appears to be disambiguation (text pattern), skipping`);
        return null;
      }
      
      logger.info(`Wikipedia: Successfully fetched overview for "${pageTitle}" (${extract.length} chars)`);
      return extract.trim();
      
    } catch (error) {
      logger.error(`Wikipedia: Failed to fetch intro for "${pageTitle}":`, error.message);
      return null;
    }
  }

  /**
   * Get album overview/description from Wikipedia
   * @param {string} wikidataId - Wikidata ID (e.g., "Q163807")
   * @param {string} albumTitle - Album title as fallback
   * @param {string} artistName - Artist name to disambiguate
   * @returns {Promise<string|null>} - Wikipedia intro text or null
   */
  async getAlbumOverview(wikidataId = null, albumTitle = null, artistName = null) {
    const cacheKey = `wikipedia:album:${wikidataId || `${albumTitle}-${artistName}`}`;
    
    return this.cachedRequest(cacheKey, async () => {
      let pageTitle = null;
      
      // Try to get Wikipedia page title from Wikidata ID
      if (wikidataId) {
        pageTitle = await this.getPageTitleFromWikidata(wikidataId);
      }
      
      // Fallback: Search by album title + artist name
      if (!pageTitle && albumTitle) {
        const searchQuery = artistName ? `${albumTitle} ${artistName} album` : albumTitle;
        pageTitle = await this.searchPageByName(searchQuery);
      }
      
      if (!pageTitle) {
        logger.debug(`Wikipedia: No page found for album ${wikidataId || albumTitle}`);
        return null;
      }
      
      // Fetch the intro text
      return await this.getPageIntro(pageTitle);
    }, 7 * 24 * 60 * 60); // Cache for 7 days
  }

  /**
   * Extract Wikidata ID from MusicBrainz relations
   * @param {Array} relations - MusicBrainz relations array
   * @returns {string|null}
   */
  /**
   * Check if text appears to be about music (artist/band/album)
   * @param {string} text
   * @returns {boolean}
   */
  _looksLikeMusic(text) {
    if (!text) return false;
    const sample = text.substring(0, 500).toLowerCase();
    const musicTerms = [
      'band', 'musician', 'singer', 'songwriter', 'rapper', 'vocalist',
      'album', 'song', 'record', 'music', 'genre', 'rock', 'pop', 'hip hop',
      'metal', 'jazz', 'punk', 'electronic', 'folk', 'country', 'blues',
      'guitar', 'bass', 'drums', 'vocals', 'label', 'tour', 'concert',
      'ep', 'single', 'track', 'studio', 'debut', 'discography',
      'formed in', 'formed by', 'solo artist', 'musical'
    ];
    return musicTerms.some(term => sample.includes(term));
  }

  static extractWikidataId(relations) {
    if (!Array.isArray(relations)) return null;
    
    const wikidataRel = relations.find(rel => 
      rel.type === 'wikidata' && rel.url
    );
    
    if (!wikidataRel) return null;
    
    // Extract Wikidata ID from URL like https://www.wikidata.org/wiki/Q224483
    const match = wikidataRel.url.resource.match(/\/wiki\/(Q\d+)/);
    return match ? match[1] : null;
  }
}

module.exports = WikipediaProvider;
