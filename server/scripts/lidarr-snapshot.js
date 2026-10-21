#!/usr/bin/env node
/**
 * Proves a storage refactor doesn't change what Lidarr sees.
 *
 *   node server/scripts/lidarr-snapshot.js capture <file> [artists=40] [albums=60]
 *   node server/scripts/lidarr-snapshot.js compare <file> [--ignore-counts]
 *
 * --ignore-counts skips the dashboard counts, for a live system whose data is still growing.
 *
 * Samples cached artists/albums deterministically (md5 order), records what lidarr.formatArtist,
 * lidarr.formatAlbum and the dashboard queries return for them, and later re-runs the same MBIDs
 * and diffs the result. Read-only apart from the snapshot file it writes.
 *
 * Exit code: 0 = identical and everything was captured; 1 = differences found;
 * 3 = no differences, but some entries could not be built (so they were not really tested).
 */
const fs = require('fs');
const crypto = require('crypto');
const config = require('../lib/config');
const database = require('../sql/database');
const lidarr = require('../lib/lidarr');

// Key-sorted copy, so property order alone never shows up as a difference
const stable = v => Array.isArray(v) ? v.map(stable)
  : v instanceof Date ? v.toISOString()
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])]))
  : v;

// What a comparison should not care about. Lists whose order Lidarr doesn't use come back in any order when an
// ORDER BY has ties, so they're compared as sets. A DATE column that is now text reads "2026-09-25" instead of
// "2026-09-25T00:00:00.000Z". The database size moves with every write.
const SORT_KEYS = {
  links: x => `${x.type}\u0000${x.target}`,
  Albums: x => x.Id,
  releases: x => x.id,
  artists: x => x.id,
  images: x => `${x.CoverType}\u0000${x.Url}`
};
const VOLATILE_KEYS = new Set(['db_size_bytes']);
const MIDNIGHT = /^(\d{4}-\d{2}-\d{2})T00:00:00\.000Z$/;

function normalize(v, key) {
  if (Array.isArray(v)) {
    const items = v.map(x => normalize(x));
    const by = SORT_KEYS[key];
    return by ? items.sort((a, b) => { const x = String(by(a) ?? ''), y = String(by(b) ?? ''); return x < y ? -1 : x > y ? 1 : 0; }) : items;
  }
  if (typeof v === 'string') { const m = MIDNIGHT.exec(v); return m ? m[1] : v; }
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).filter(k => !VOLATILE_KEYS.has(k)).sort().map(k => [k, normalize(v[k], k)]));
  }
  return v;
}

// First differences between two values, as "path: before -> after"
function diff(a, b, path = '', out = []) {
  if (out.length >= 25 || JSON.stringify(a) === JSON.stringify(b)) return out;
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[k], b[k], `${path}/${k}`, out);
  } else {
    out.push(`${path}: ${String(JSON.stringify(a)).slice(0, 80)} -> ${String(JSON.stringify(b)).slice(0, 80)}`);
  }
  return out;
}

// Deterministic pseudo-random order: the same database always yields the same sample
const byHash = (a, b) => {
  const ha = crypto.createHash('md5').update(a).digest('hex');
  const hb = crypto.createHash('md5').update(b).digest('hex');
  return ha < hb ? -1 : ha > hb ? 1 : 0;
};

async function sample(nArtists, nAlbums) {
  const artistRows = (await database.query('SELECT mbid FROM artists')).rows;
  const albumRows = (await database.query('SELECT DISTINCT release_group_mbid AS mbid FROM releases')).rows;
  return {
    artists: artistRows.map(r => r.mbid).sort(byHash).slice(0, nArtists),
    albums: albumRows.map(r => r.mbid).sort(byHash).slice(0, nAlbums)
  };
}

async function record(fn) {
  try { return stable(await fn()); } catch (e) { return { error: e.message }; }
}

async function collect({ artists, albums }) {
  const out = { sample: { artists, albums }, artist: {}, album: {}, browser: {} };
  for (const id of artists) {
    out.artist[id] = await record(() => lidarr.formatArtist(id));
    out.browser[id] = await record(() => database.getArtistAlbums(id));
  }
  for (const id of albums) out.album[id] = await record(() => lidarr.formatAlbum(id));
  out.stats = await record(() => database.getStats());
  out.counts = await record(async () =>
    (await database.getAllArtistsWithCounts()).sort((a, b) => (a.mbid < b.mbid ? -1 : 1)));
  return out;
}

// Entries that errored instead of producing output: "section/id: message"
function errorsIn(snap) {
  const found = [];
  for (const section of ['artist', 'album', 'browser']) {
    for (const [id, v] of Object.entries(snap[section])) {
      if (v && v.error) found.push(`${section}/${id}: ${String(v.error).split('\n')[0]}`);
    }
  }
  for (const section of ['stats', 'counts']) {
    if (snap[section] && snap[section].error) found.push(`${section}: ${String(snap[section].error).split('\n')[0]}`);
  }
  return found;
}

function reportErrors(prefix, errors) {
  if (!errors.length) return;
  console.log(`WARNING: ${errors.length} ${prefix} could not be built, so they are NOT covered by this check:`);
  errors.slice(0, 5).forEach(e => console.log(`  ${e.slice(0, 160)}`));
  if (errors.length > 5) console.log(`  ... and ${errors.length - 5} more`);
}

async function capture(file, nArtists = 40, nAlbums = 60) {
  const snap = await collect(await sample(nArtists, nAlbums));
  fs.writeFileSync(file, JSON.stringify(snap));
  console.log(`captured ${snap.sample.artists.length} artists, ${snap.sample.albums.length} albums -> ${file}`);
  const errors = errorsIn(snap);
  reportErrors('entries', errors);
  return errors.length ? 3 : 0;
}

async function compare(file, { ignoreCounts = false } = {}) {
  const before = JSON.parse(fs.readFileSync(file, 'utf8'));
  const after = await collect(before.sample);
  let same = 0, total = 0, code = 0;
  const check = (label, a, b) => {
    total++;
    const d = diff(normalize(a), normalize(b), label);
    if (d.length) { code = 1; console.log(d.join('\n')); } else same++;
  };
  for (const section of ['artist', 'album', 'browser']) {
    for (const id of Object.keys(before[section])) check(`${section}/${id}`, before[section][id], after[section][id]);
  }
  if (!ignoreCounts) for (const section of ['stats', 'counts']) check(section, before[section], after[section]);
  else console.log('(dashboard counts skipped: --ignore-counts)');
  console.log(`${same}/${total} identical${code ? ' - DIFFERENCES FOUND' : ''}`);
  const errors = [...new Set([...errorsIn(before), ...errorsIn(after)])];
  reportErrors('entries', errors);
  return code || (errors.length ? 3 : 0);
}

async function main() {
  const args = process.argv.slice(2);
  const ignoreCounts = args.includes('--ignore-counts');
  const [mode, file, a, b] = args.filter(x => !x.startsWith('--'));
  if (!['capture', 'compare'].includes(mode) || !file) {
    console.error('usage: lidarr-snapshot.js capture <file> [artists] [albums]\n       lidarr-snapshot.js compare <file> [--ignore-counts]');
    process.exit(2);
  }
  await config.load();
  await database.initialize();
  const code = mode === 'capture' ? await capture(file, parseInt(a, 10) || 40, parseInt(b, 10) || 60) : await compare(file, { ignoreCounts });
  await database.close();
  process.exit(code);
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { stable, normalize, diff, sample, collect, capture, compare };
