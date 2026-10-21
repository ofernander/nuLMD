/**
 * MusicBrainz web-service XML (mmd-2.0), the format musicbrainz.org has always defaulted to.
 *
 * Takes the ws/2 JSON objects built by render.js, so XML and JSON can never disagree about what an entity
 * contains. The element layout follows MusicBrainz's own replies: scalar fields become child elements, ids and
 * types become attributes, lists get a wrapper (`alias-list`, `tag-list`, ...), and empty values are left out.
 */

const NS = 'http://musicbrainz.org/ns/mmd-2.0#';

const has = v => v !== undefined && v !== null && v !== '';
// Characters XML 1.0 cannot carry are dropped rather than producing a document no parser accepts
const esc = s => String(s)
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const attrs = o => Object.entries(o || {}).filter(([, v]) => has(v)).map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
const node = (name, a, inner) => (inner === '' ? `<${name}${attrs(a)}/>` : `<${name}${attrs(a)}>${inner}</${name}>`);
const text = (name, value, a) => (has(value) ? node(name, a, esc(value)) : '');
// A wrapper element holding items; nothing at all when there are none
const list = (name, items, a, { count = false } = {}) => {
  const inner = (items || []).join('');
  return inner ? node(name, count ? { count: items.length, ...a } : a, inner) : '';
};

function area(tag, a) {
  if (!a) return '';
  return node(tag, { id: a.id }, [
    text('name', a.name), text('sort-name', a['sort-name']), text('disambiguation', a.disambiguation),
    list('iso-3166-1-code-list', (a['iso-3166-1-codes'] || []).map(c => text('iso-3166-1-code', c))),
    list('iso-3166-2-code-list', (a['iso-3166-2-codes'] || []).map(c => text('iso-3166-2-code', c))),
    list('iso-3166-3-code-list', (a['iso-3166-3-codes'] || []).map(c => text('iso-3166-3-code', c)))
  ].join(''));
}

const lifeSpan = l => {
  if (!l) return '';
  const inner = [text('begin', l.begin), text('end', l.end), l.ended ? text('ended', 'true') : ''].join('');
  return inner ? node('life-span', {}, inner) : '';
};

const alias = a => node('alias', {
  locale: a.locale, 'sort-name': a['sort-name'], type: a.type, 'type-id': a['type-id'],
  primary: a.primary ? 'primary' : undefined, 'begin-date': a.begin, 'end-date': a.end
}, esc(a.name || ''));

const tag = t => node('tag', { count: t.count }, text('name', t.name));
const genre = g => node('genre', { id: g.id, count: g.count }, text('name', g.name) + text('disambiguation', g.disambiguation));
const rating = r => (r && has(r.value) ? node('rating', { 'votes-count': r['votes-count'] }, esc(r.value)) : '');

function relation(r) {
  return node('relation', { type: r.type, 'type-id': r['type-id'] }, [
    r.url ? node('target', { id: r.url.id }, esc(r.url.resource || '')) : '',
    text('direction', r.direction),
    list('attribute-list', (r.attributes || []).map(x => text('attribute', x))),
    text('begin', r.begin), text('end', r.end), r.ended ? text('ended', 'true') : ''
  ].join(''));
}
// Relations are grouped by what they point at; ours are all URLs
const relationList = rels => {
  const byTarget = {};
  for (const r of rels || []) (byTarget[r['target-type'] || 'url'] ||= []).push(relation(r));
  return Object.entries(byTarget).map(([t, items]) => list('relation-list', items, { 'target-type': t })).join('');
};

function nameCredit(c) {
  const a = c.artist || {};
  return node('name-credit', { joinphrase: c.joinphrase }, (c.name && c.name !== a.name ? text('name', c.name) : '') + (c.artist ? artist(c.artist) : ''));
}
const artistCredit = credit => list('artist-credit', (credit || []).map(nameCredit));

function artist(a) {
  return node('artist', { id: a.id, type: a.type, 'type-id': a['type-id'] }, [
    text('name', a.name), text('sort-name', a['sort-name']),
    text('gender', a.gender, { id: a['gender-id'] }),
    text('country', a.country),
    area('area', a.area), area('begin-area', a['begin-area']), area('end-area', a['end-area']),
    text('disambiguation', a.disambiguation),
    // MusicBrainz sends the first IPI on its own as well as in the list
    has((a.ipis || [])[0]) ? text('ipi', a.ipis[0]) : '',
    list('ipi-list', (a.ipis || []).map(x => text('ipi', x))),
    list('isni-list', (a.isnis || []).map(x => text('isni', x))),
    lifeSpan(a['life-span']),
    list('alias-list', (a.aliases || []).map(alias), {}, { count: true }),
    relationList(a.relations),
    list('tag-list', (a.tags || []).map(tag)),
    list('genre-list', (a.genres || []).map(genre)),
    rating(a.rating)
  ].join(''));
}

function releaseGroup(rg) {
  // The `type` attribute is the most specific type: the first secondary type if there is one, else the primary
  const sec = (rg['secondary-types'] || [])[0];
  const type = has(sec) ? { type: sec, 'type-id': (rg['secondary-type-ids'] || [])[0] } : { type: rg['primary-type'], 'type-id': rg['primary-type-id'] };
  return node('release-group', { id: rg.id, ...type }, [
    text('title', rg.title), text('disambiguation', rg.disambiguation), text('first-release-date', rg['first-release-date']),
    text('primary-type', rg['primary-type'], { id: rg['primary-type-id'] }),
    list('secondary-type-list', (rg['secondary-types'] || []).map((t, i) => text('secondary-type', t, { id: (rg['secondary-type-ids'] || [])[i] }))),
    artistCredit(rg['artist-credit']),
    list('alias-list', (rg.aliases || []).map(alias), {}, { count: true }),
    relationList(rg.relations),
    list('tag-list', (rg.tags || []).map(tag)),
    list('genre-list', (rg.genres || []).map(genre)),
    rating(rg.rating)
  ].join(''));
}

function track(t) {
  const rec = t.recording;
  const who = c => JSON.stringify((c || []).map(x => [x.name, x.joinphrase || '', x.artist && x.artist.id]));
  const sameCredit = rec && who(rec['artist-credit']) === who(t['artist-credit']);
  return node('track', { id: t.id }, [
    // Track-level title and credit only when they differ from the recording's
    !rec || t.title !== rec.title ? text('title', t.title) : '',
    text('position', t.position), text('number', t.number), text('length', t.length),
    rec ? recording(rec) : '',
    !rec || (!sameCredit && t['artist-credit']) ? artistCredit(t['artist-credit']) : ''
  ].join(''));
}

function medium(m) {
  return node('medium', { id: m.id }, [
    text('title', m.title), text('position', m.position), text('format', m.format, { id: m['format-id'] }),
    has(m['track-count']) ? node('track-list', { count: m['track-count'], offset: m['track-offset'] }, (m.tracks || []).map(track).join('')) : ''
  ].join(''));
}

function release(r) {
  const cover = r['cover-art-archive'];
  return node('release', { id: r.id }, [
    text('title', r.title), text('status', r.status, { id: r['status-id'] }), text('quality', r.quality),
    text('disambiguation', r.disambiguation), text('packaging', r.packaging, { id: r['packaging-id'] }),
    r['text-representation'] && (has(r['text-representation'].language) || has(r['text-representation'].script))
      ? node('text-representation', {}, text('language', r['text-representation'].language) + text('script', r['text-representation'].script)) : '',
    artistCredit(r['artist-credit']),
    r['release-group'] ? releaseGroup(r['release-group']) : '',
    text('date', r.date), text('country', r.country),
    list('release-event-list', (r['release-events'] || []).map(e => node('release-event', {}, text('date', e.date) + area('area', e.area))), {}, { count: true }),
    text('barcode', r.barcode), text('asin', r.asin),
    cover ? node('cover-art-archive', {}, text('artwork', String(!!cover.artwork)) + text('count', cover.count) + text('front', String(!!cover.front)) + text('back', String(!!cover.back))) : '',
    list('label-info-list', (r['label-info'] || []).map(li => node('label-info', {}, text('catalog-number', li['catalog-number']) + (li.label ? label(li.label) : ''))), {}, { count: true }),
    list('medium-list', (r.media || []).map(medium), {}, { count: true })
  ].join(''));
}

const label = l => node('label', { id: l.id, type: l.type, 'type-id': l['type-id'] },
  text('name', l.name) + text('sort-name', l['sort-name']) + text('label-code', l['label-code']) + text('disambiguation', l.disambiguation));

function recording(r) {
  return node('recording', { id: r.id }, [
    text('title', r.title), text('disambiguation', r.disambiguation), text('length', r.length),
    r.video ? text('video', 'true') : '',
    artistCredit(r['artist-credit']), text('first-release-date', r['first-release-date']),
    list('isrc-list', (r.isrcs || []).map(i => node('isrc', { id: i }, '')), {}, { count: true })
  ].join(''));
}

const BUILDERS = { artist, 'release-group': releaseGroup, release, recording };
const wrap = inner => `<?xml version="1.0" encoding="UTF-8"?>\n<metadata xmlns="${NS}">${inner}</metadata>`;

const toXml = (resource, obj) => wrap(BUILDERS[resource](obj));
// A browse or search result: <release-group-list count=".." offset="..">, offset only once past the first page
function toXmlList(resource, reply) {
  const items = reply[`${resource}s`] || [];
  const count = has(reply[`${resource}-count`]) ? reply[`${resource}-count`] : items.length;
  const offset = reply[`${resource}-offset`] || 0;
  return wrap(node(`${resource}-list`, { count, offset: offset > 0 ? offset : undefined }, items.map(BUILDERS[resource]).join('')));
}
// MusicBrainz's XML error body: the message, then the usage pointer
const errorXml = (message, help) => `<?xml version="1.0" encoding="UTF-8"?>\n<error><text>${esc(message)}</text><text>${esc(help)}</text></error>`;

module.exports = { toXml, toXmlList, errorXml, NS };
