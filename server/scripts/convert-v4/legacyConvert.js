/**
 * Converters for rows written before nuLMD stored MusicBrainz data in MusicBrainz's own form.
 * Old rows kept bare name strings for aliases/tags/genres; MB sends objects. Converting is lossless
 * for what we had; the fields we never stored (counts, IDs, locales...) stay absent until the row is
 * refreshed from MusicBrainz. Every function is idempotent: already-converted values pass through.
 */

const aliasToMb = a => (typeof a === 'string' ? { name: a, 'sort-name': a } : a);
const tagToMb = t => (typeof t === 'string' ? { name: t } : t);
const genreToMb = g => (typeof g === 'string' ? { name: g } : g);

function parse(value) {
  if (typeof value === 'string') { try { return JSON.parse(value); } catch (_) { return null; } }
  return value;
}

// True when the list still holds legacy bare strings
const needsConversion = list => Array.isArray(list) && list.some(x => typeof x === 'string');

function convertList(value, fn) {
  const list = parse(value);
  return Array.isArray(list) ? list.map(fn) : list;
}

// v4 release groups stored aliases as {name, sortName, locale, primary, type}; MusicBrainz says sort-name
function releaseGroupAliasToMb(a) {
  if (typeof a === 'string') return { name: a, 'sort-name': a };
  if (!a || typeof a !== 'object') return a;
  if (!('sortName' in a)) return a;
  const { sortName, ...rest } = a;
  return { ...rest, 'sort-name': sortName };
}

// v4 release-group credits used `joinPhrase`; MusicBrainz says `joinphrase`
function creditToMb(credit) {
  const list = parse(credit);
  if (!Array.isArray(list)) return [];
  return list.map(c => {
    if (!c || typeof c !== 'object' || !('joinPhrase' in c)) return c;
    const { joinPhrase, ...rest } = c;
    return { ...rest, joinphrase: joinPhrase };
  });
}

module.exports = {
  aliasToMb, tagToMb, genreToMb, needsConversion, releaseGroupAliasToMb, creditToMb,
  releaseGroupAliases: v => convertList(v, releaseGroupAliasToMb),
  aliases: v => convertList(v, aliasToMb),
  tags: v => convertList(v, tagToMb),
  genres: v => convertList(v, genreToMb),
  parse
};
