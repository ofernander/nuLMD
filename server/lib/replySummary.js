// What a reply to a client held, in a few words, for the dashboard's Responses card. Each function is given the payload
// that was actually sent, so the line cannot say more (or less) than Lidarr received.

const PLACEHOLDER = '/assets/placeholder.png';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Where the images in a payload point: at nuLMD (a cached file), at the placeholder (the cover is not there yet), or at the
 * provider's own URL (a download that failed: Lidarr is told to fetch it from the provider itself).
 */
function imageMix(images) {
  const list = Array.isArray(images) ? images : [];
  if (list.length === 0) return 'no images';
  const counts = { nuLMD: 0, placeholder: 0, 'provider URL': 0 };
  for (const image of list) {
    const url = String((image && (image.Url || image.url)) || '');
    if (url.endsWith(PLACEHOLDER)) counts.placeholder++;
    else if (url.includes('/api/images/')) counts.nuLMD++;
    else counts['provider URL']++;
  }
  return 'images: ' + Object.entries(counts).filter(([, n]) => n > 0).map(([kind, n]) => `${n} ${kind}`).join(', ');
}

/** A Lidarr artist reply. `catalogPending`: the catalog job has not finished, which is why an empty album list is sent. */
function describeArtist(payload, { catalogPending = false } = {}) {
  const albums = Array.isArray(payload && payload.Albums) ? payload.Albums.length : 0;
  const head = albums === 0 && catalogPending ? '0 albums (catalog still being fetched)' : plural(albums, 'album');
  return `${head} · ${imageMix(payload && payload.images)}`;
}

/** A Lidarr album reply. */
function describeAlbum(payload) {
  const releases = Array.isArray(payload && payload.releases) ? payload.releases : [];
  const tracks = releases.reduce((sum, release) => sum + (Array.isArray(release.tracks) ? release.tracks.length : 0), 0);
  return `${plural(releases.length, 'release')} · ${plural(tracks, 'track')} · ${imageMix(payload && payload.images)}`;
}

const nameOf = item => (item && (item.artistname || item.title
  || (item.artist && item.artist.artistname) || (item.album && item.album.title))) || null;

/** A Lidarr search reply: how many, and the top one. */
function describeSearch(results) {
  const list = Array.isArray(results) ? results : [];
  if (list.length === 0) return 'no results';
  const top = nameOf(list[0]);
  return `${plural(list.length, 'result')}${top ? ` · top: ${top}` : ''}`;
}

/** A /ws/2 list (browse) reply. */
function describeList(resource, body) {
  const count = body && body[`${resource}-count`];
  if (typeof count !== 'number') return null;
  const items = Object.values(body).find(Array.isArray);
  const shown = items ? items.length : 0;
  return `${shown} of ${count} ${resource}${count === 1 ? '' : 's'}${body[`${resource}-offset`] ? ` (from ${body[`${resource}-offset`]})` : ''}`;
}

module.exports = { imageMix, describeArtist, describeAlbum, describeSearch, describeList };
