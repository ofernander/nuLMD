/**
 * The one identity nuLMD gives every service it calls (MusicBrainz, Wikipedia, Cover Art Archive, Fanart, Deezer, image
 * hosts, upstream servers): the product, its version and where to reach the people behind it, in the
 * `Name/Version ( contact )` form MusicBrainz and Wikimedia ask for. Nothing else sets a User-Agent.
 */
const pkg = require('../../package.json');

const contact = pkg.homepage || (pkg.repository && pkg.repository.url) || '';
const USER_AGENT = contact ? `${pkg.name}/${pkg.version} ( ${contact} )` : `${pkg.name}/${pkg.version}`;

module.exports = { USER_AGENT };
