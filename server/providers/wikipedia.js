const BaseProvider = require('./base');
const { logger } = require('../lib/logger');

// Lookups asked for within a short window go out as ONE request: Wikidata answers up to 50 ids per call and the
// extracts API up to 20 pages per call, so a catalog's worth of overviews needs a handful of calls instead of two each.
const BATCH_WINDOW_MS = 150;
const WIKIDATA_BATCH = 50;
const EXTRACT_BATCH = 20;
// A failed overview lookup is retried a few times here, then the job fails (and the queue retries it after a pause)
const RETRIES = { maxRetries: 3, backoffMs: 2000 };

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
    this._batches = {};
  }

  /**
   * Collect the keys asked for within BATCH_WINDOW_MS (or until `max` are waiting) and answer them all with one call to
   * `fetchMany(keys)`, which returns a Map key -> value. The same key asked twice shares one answer; if the call fails,
   * every waiter gets the error (a failed lookup must never look like "nothing found").
   */
  _coalesce(kind, key, max, fetchMany) {
    const batch = this._batches[kind] || (this._batches[kind] = { waiting: new Map(), timer: null });
    let entry = batch.waiting.get(key);
    if (!entry) {
      entry = { waiters: [] };
      batch.waiting.set(key, entry);
    }
    const promise = new Promise((resolve, reject) => entry.waiters.push({ resolve, reject }));

    const flush = () => {
      clearTimeout(batch.timer);
      batch.timer = null;
      const taken = batch.waiting;
      batch.waiting = new Map();
      const keys = [...taken.keys()];
      fetchMany(keys).then(
        answers => { for (const [k, e] of taken) for (const w of e.waiters) w.resolve(answers.has(k) ? answers.get(k) : null); },
        error => { for (const e of taken.values()) for (const w of e.waiters) w.reject(error); }
      );
    };
    if (batch.waiting.size >= max) flush();
    else if (!batch.timer) batch.timer = setTimeout(flush, BATCH_WINDOW_MS);
    return promise;
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
    }, 7 * 24 * 60 * 60, RETRIES); // Cache for 7 days (bios don't change often)
  }

  /**
   * Get Wikipedia page title from Wikidata ID. Lookups asked for close together share one Wikidata call.
   * null = Wikidata has no English Wikipedia page for it; a failed request throws (it is not an answer).
   * @param {string} wikidataId - Wikidata ID (e.g., "Q224483")
   * @returns {Promise<string|null>}
   */
  async getPageTitleFromWikidata(wikidataId) {
    return this._coalesce('wikidata', wikidataId, WIKIDATA_BATCH, ids => this._fetchPageTitles(ids));
  }

  async _fetchPageTitles(ids) {
    logger.debug(`Wikipedia: Looking up page titles for ${ids.length} Wikidata id(s)`);
    const response = await this.client.get('', {
      params: {
        action: 'wbgetentities',
        ids: ids.join('|'),
        props: 'sitelinks',
        sitefilter: 'enwiki',
        format: 'json'
      },
      baseURL: 'https://www.wikidata.org/w/api.php'
    });

    const titles = new Map();
    for (const entity of Object.values(response.data.entities || {})) {
      const title = entity && entity.sitelinks && entity.sitelinks.enwiki && entity.sitelinks.enwiki.title;
      if (!title) continue;
      titles.set(entity.id, title);
      // an id that was merged into another comes back under the id it points to
      if (entity.redirects && entity.redirects.from) titles.set(entity.redirects.from, title);
    }
    return titles;
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
      throw error;
    }
  }

  /**
   * Get the intro/summary section of a Wikipedia page. Lookups asked for close together share one call (20 pages each).
   * null = the page is missing, a disambiguation page or empty; a failed request throws.
   * @param {string} pageTitle - Wikipedia page title
   * @returns {Promise<string|null>}
   */
  async getPageIntro(pageTitle) {
    return this._coalesce('extracts', pageTitle, EXTRACT_BATCH, titles => this._fetchIntros(titles));
  }

  async _fetchIntros(titles) {
    logger.debug(`Wikipedia: Fetching intros for ${titles.length} page(s)`);
    const response = await this.client.get('', {
      params: {
        action: 'query',
        prop: 'extracts|pageprops',
        exintro: true,           // Only intro section
        explaintext: true,       // Plain text (no HTML)
        exlimit: 'max',          // an extract for every page asked for, not just the first
        titles: titles.join('|'),
        format: 'json'
      }
    });

    const query = response.data.query || {};
    // MediaWiki tidies a title (underscores, first letter) before answering; map the title we asked for to the one it used
    const used = new Map((query.normalized || []).map(n => [n.from, n.to]));
    const byTitle = new Map(Object.values(query.pages || {}).map(page => [page.title, page]));

    const intros = new Map();
    for (const asked of titles) {
      intros.set(asked, this._introOf(asked, byTitle.get(used.get(asked) || asked)));
    }
    return intros;
  }

  _introOf(pageTitle, page) {
    if (!page || page.missing !== undefined) {
      logger.debug(`Wikipedia: Page "${pageTitle}" not found`);
      return null;
    }

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
  }

  /**
   * Overviews for several albums at once, from the Wikidata link MusicBrainz holds for each: the English Wikipedia titles
   * come 50 to a call and the intros of all the pages 20 to a call. An album is never searched for by name: on a real
   * library that found almost nothing (2 of 391 unlinked albums, one of them the wrong album) at one call each.
   *
   * @param {Array<{wikidataId: string}>} items
   * @returns {Promise<Array<{overview: ?string, answered: boolean, error: ?Error}>>} one result per item, in order.
   *   `answered` = Wikipedia was asked and replied (overview null then means there is none); `error` = a failure worth
   *   retrying later (network, 429, 5xx); neither = a failure that retrying would not fix.
   */
  async getAlbumOverviews(items) {
    const results = items.map(() => ({ overview: null, answered: true, error: null }));
    const titles = new Array(items.length).fill(null);
    const failed = (i, error) => {
      if (BaseProvider.isRetryableError(error)) results[i].error = error;
      else results[i].answered = false;
    };
    const live = i => results[i].answered && !results[i].error;
    const retried = (key, fn) => this.cachedRequest(key, fn, null, RETRIES);

    // 1. Page titles from Wikidata
    const linked = items.map((_, i) => i).filter(i => items[i].wikidataId);
    for (let n = 0; n < linked.length; n += WIKIDATA_BATCH) {
      const chunk = linked.slice(n, n + WIKIDATA_BATCH);
      try {
        const found = await retried(`wikidata:batch of ${chunk.length}`, () => this._fetchPageTitles([...new Set(chunk.map(i => items[i].wikidataId))]));
        for (const i of chunk) titles[i] = found.get(items[i].wikidataId) || null;
      } catch (error) {
        logger.warn(`Wikipedia: Wikidata lookup for ${chunk.length} album(s) failed: ${error.message}`);
        for (const i of chunk) failed(i, error);
      }
    }

    // 2. The intros
    const wanted = [...new Set(items.map((_, i) => i).filter(i => titles[i] && live(i)).map(i => titles[i]))];
    const intros = new Map();
    for (let n = 0; n < wanted.length; n += EXTRACT_BATCH) {
      const chunk = wanted.slice(n, n + EXTRACT_BATCH);
      try {
        for (const [title, intro] of await retried(`wikipedia:intros batch of ${chunk.length}`, () => this._fetchIntros(chunk))) intros.set(title, intro);
      } catch (error) {
        logger.warn(`Wikipedia: fetching ${chunk.length} intro(s) failed: ${error.message}`);
        items.forEach((_, i) => { if (live(i) && chunk.includes(titles[i])) failed(i, error); });
      }
    }

    items.forEach((_, i) => { if (live(i) && titles[i]) results[i].overview = intros.get(titles[i]) || null; });
    return results;
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
