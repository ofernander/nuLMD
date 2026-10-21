/**
 * Copies a v4 nuLMD database into a v5 database. The v4 database is only ever read.
 *
 * `src` and `dst` are anything with `query(sql, params)` (a pg Pool or Client). `dst` is null for a dry run.
 * Rows move in batches through this process (Postgres can't copy between databases in one statement), keyed by
 * primary key so memory stays flat however many tracks there are.
 */
const transforms = require('./transforms');

// Order matters: parents before children
const TABLES = [
  { name: 'artists', to: 'artists', key: 'mbid', transform: transforms.artist, dates: ['begin_date', 'end_date'], batch: 1000 },
  { name: 'release_groups', to: 'release_groups', key: 'mbid', transform: transforms.releaseGroup, dates: ['first_release_date'], batch: 1000 },
  { name: 'artist_release_groups', to: 'artist_release_groups', order: ['artist_mbid', 'release_group_mbid'], transform: transforms.artistReleaseGroup, batch: 2000 },
  { name: 'releases', to: 'releases', key: 'mbid', transform: transforms.release, dates: ['release_date'], batch: 200 },
  { name: 'recordings', to: 'recordings', key: 'mbid', transform: transforms.recording, batch: 2000 },
  { name: 'tracks', to: 'tracks', key: 'mbid', transform: transforms.track, batch: 2000 },
  { name: 'links', to: 'relations', key: 'id', transform: transforms.relation, batch: 2000 },
  { name: 'images', to: 'images', key: 'id', transform: transforms.image, batch: 1000 },
  { name: 'mbid_redirects', to: 'mbid_redirects', key: 'old_mbid', transform: transforms.redirect, batch: 1000, optional: true },
  // Kept with their ids: completed fetch_artist_albums jobs decide whether Lidarr is sent an artist's album list
  { name: 'metadata_jobs', to: 'metadata_jobs', key: 'id', transform: transforms.job, batch: 1000, afterCopy: 'jobParents' }
];

const ident = name => {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Unexpected identifier ${name}`);
  return name;
};

async function columnsOf(db, table) {
  const r = await db.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1`, [table]);
  return r.rows.map(x => x.column_name);
}

async function tableExists(db, table) {
  return (await columnsOf(db, table)).length > 0;
}

// What v5 needs to find in a v4 database. Anything missing means it predates the last 0.4.x release.
const REQUIRED = {
  artists: ['mbid', 'name', 'aliases', 'tags', 'genres'],
  release_groups: ['mbid', 'title', 'artist_credit'],
  releases: ['mbid', 'release_group_mbid', 'media'],
  images: ['entity_mbid', 'cover_type', 'provider', 'user_uploaded'],
  metadata_jobs: ['id', 'job_type', 'parent_job_id', 'root_artist_mbid']
};

async function checkStepStone(src) {
  const problems = [];
  for (const [table, cols] of Object.entries(REQUIRED)) {
    const have = await columnsOf(src, table);
    if (have.length === 0) { problems.push(`table ${table} is missing`); continue; }
    const missing = cols.filter(c => !have.includes(c));
    if (missing.length) problems.push(`${table} lacks ${missing.join(', ')}`);
  }
  return problems;
}

function buildInsert(table, columns, rows) {
  const params = [];
  const tuples = rows.map(row => `(${columns.map(c => { params.push(row[c] === undefined ? null : row[c]); return `$${params.length}`; }).join(', ')})`);
  return { sql: `INSERT INTO ${ident(table)} (${columns.map(ident).join(', ')}) VALUES ${tuples.join(', ')} ON CONFLICT DO NOTHING`, params };
}

function selectList(available, spec) {
  // Dates leave as 'YYYY-MM-DD' text. to_char, unlike a plain ::text cast, doesn't depend on the server's DateStyle.
  return available.map(c => (spec.dates && spec.dates.includes(c) ? `to_char(${ident(c)}, 'YYYY-MM-DD') AS ${ident(c)}` : ident(c))).join(', ');
}

async function fetchPage(src, spec, select, last, offset) {
  const n = spec.batch;
  if (spec.key) {
    return last === undefined
      ? src.query(`SELECT ${select} FROM ${ident(spec.name)} ORDER BY ${ident(spec.key)} LIMIT ${n}`)
      : src.query(`SELECT ${select} FROM ${ident(spec.name)} WHERE ${ident(spec.key)} > $1 ORDER BY ${ident(spec.key)} LIMIT ${n}`, [last]);
  }
  // composite key: offset paging (these tables are small compared to tracks)
  return src.query(`SELECT ${select} FROM ${ident(spec.name)} ORDER BY ${spec.order.map(ident).join(', ')} LIMIT ${n} OFFSET ${offset}`);
}

/** Copy one table. Returns { name, to, read, written, skipped } (skipped = rows v5 does not keep, or duplicates). */
async function copyTable({ src, dst, spec, log, dryRun }) {
  const available = await columnsOf(src, spec.name);
  if (available.length === 0) {
    if (spec.optional) return { name: spec.name, to: spec.to, read: 0, written: 0, skipped: 0, missing: true };
    throw new Error(`The v4 database has no ${spec.name} table`);
  }
  const total = Number((await src.query(`SELECT COUNT(*)::int AS n FROM ${ident(spec.name)}`)).rows[0].n);
  const select = selectList(available, spec);
  const result = { name: spec.name, to: spec.to, total, read: 0, written: 0, skipped: 0 };

  let last;
  let offset = 0;
  for (;;) {
    const page = (await fetchPage(src, spec, select, last, offset)).rows;
    if (page.length === 0) break;
    if (spec.key) last = page[page.length - 1][spec.key];
    offset += page.length;
    result.read += page.length;

    const rows = page.map(spec.transform).filter(Boolean);
    result.skipped += page.length - rows.length;

    if (rows.length > 0 && !dryRun) {
      const columns = Object.keys(rows[0]);
      const { sql, params } = buildInsert(spec.to, columns, rows);
      const inserted = (await dst.query(sql, params)).rowCount;
      result.written += inserted;
      result.skipped += rows.length - inserted;
    } else {
      result.written += rows.length;
    }
    if (dryRun) break;                       // a dry run only proves the first page transforms cleanly
    if (result.read % (spec.batch * 10) < spec.batch) log(`  ${spec.name}: ${result.read}/${total}`);
  }
  if (dryRun) result.written = 0;
  return result;
}

// Parent links need the parents to exist first, so they are filled in after every job is copied
async function copyJobParents(src, dst) {
  const rows = (await src.query('SELECT id, parent_job_id FROM metadata_jobs WHERE parent_job_id IS NOT NULL')).rows;
  for (const r of rows) {
    await dst.query(
      'UPDATE metadata_jobs SET parent_job_id = $2 WHERE id = $1 AND EXISTS (SELECT 1 FROM metadata_jobs WHERE id = $2)',
      [r.id, r.parent_job_id]);
  }
  return rows.length;
}

// Jobs keep their ids, so the id sequence must continue after the highest one
async function fixSequences(dst) {
  await dst.query(`SELECT setval(pg_get_serial_sequence('metadata_jobs', 'id'), COALESCE((SELECT MAX(id) FROM metadata_jobs), 0) + 1, false)`);
}

// The migration that adds the catalog markers runs before this copy, when the tables are empty, so its backfill had
// nothing to mark. Same statements as server/sql/migrations/0004_catalog_state.sql and 0007 (the third).
async function markCatalogState(dst) {
  await dst.query(`
    UPDATE artists a SET catalog_complete_at = j.at
    FROM (SELECT entity_mbid, MAX(COALESCE(completed_at, NOW())) AS at
          FROM metadata_jobs WHERE job_type = 'fetch_artist_albums' AND status = 'completed' GROUP BY entity_mbid) j
    WHERE a.mbid = j.entity_mbid`);
  await dst.query(`
    UPDATE release_groups rg SET releases_complete_at = NOW()
    WHERE EXISTS (SELECT 1 FROM releases r WHERE r.release_group_mbid = rg.mbid)`);
  await dst.query(`
    UPDATE artists a SET catalog_complete_at = NOW()
    WHERE a.catalog_complete_at IS NULL
      AND EXISTS (SELECT 1 FROM artist_release_groups arg WHERE arg.artist_mbid = a.mbid)
      AND NOT EXISTS (SELECT 1 FROM artist_release_groups arg JOIN release_groups rg ON rg.mbid = arg.release_group_mbid
                      WHERE arg.artist_mbid = a.mbid AND rg.mb_version <> 1)`);
}

async function convert({ src, dst, options = {}, log = () => {}, fixSeq = fixSequences }) {
  const dryRun = !dst;
  const tables = options.imagesOnly ? TABLES.filter(t => t.name === 'images') : TABLES;
  const report = [];
  for (const spec of tables) {
    const started = Date.now();
    log(`${dryRun ? 'Checking' : 'Copying'} ${spec.name}${spec.to !== spec.name ? ` -> ${spec.to}` : ''}`);
    const r = await copyTable({ src, dst, spec, log, dryRun });
    r.ms = Date.now() - started;
    if (!dryRun && spec.afterCopy === 'jobParents') await copyJobParents(src, dst);
    report.push(r);
  }
  if (!dryRun && !options.imagesOnly) {
    await fixSeq(dst);
    await markCatalogState(dst);
  }
  return report;
}

// ---------------------------------------------------------------------------------------------------
// Verification: counts must add up, and a sample of rows must read back the same
// ---------------------------------------------------------------------------------------------------

const count = async (db, table) => Number((await db.query(`SELECT COUNT(*)::int AS n FROM ${ident(table)}`)).rows[0].n);
const names = list => (Array.isArray(list) ? list : []).map(x => (typeof x === 'string' ? x : x && x.name)).filter(Boolean);
const sampleOf = (keys, n) => { const step = Math.max(1, Math.floor(keys.length / n)); return keys.filter((_, i) => i % step === 0).slice(0, n); };
const jsonOf = v => JSON.stringify(typeof v === 'string' ? JSON.parse(v) : v);

async function verify({ src, dst, report, options = {}, sampleSize = 25 }) {
  const problems = [];
  let checks = 0;

  for (const r of report) {
    checks++;
    if (r.written !== r.total - r.skipped) problems.push(`${r.name}: read ${r.total}, wrote ${r.written}, skipped ${r.skipped} (these don't add up)`);
    const inDst = await count(dst, r.to);
    if (inDst < r.written) problems.push(`${r.to}: expected at least ${r.written} rows in the new database, found ${inDst}`);
  }
  if (options.imagesOnly) return { problems, checks };

  const compare = async (label, table, key, columns, text = {}) => {
    const keys = (await src.query(`SELECT ${ident(key)} FROM ${ident(table)} ORDER BY ${ident(key)}`)).rows.map(r => r[key]);
    for (const id of sampleOf(keys, sampleSize)) {
      checks++;
      // v4 stored these as DATE (read as 'YYYY-MM-DD' text); in v5 they are already text
      const selSrc = columns.map(c => (text[c] === true ? `to_char(${ident(c)}, 'YYYY-MM-DD') AS ${ident(c)}` : ident(c))).join(', ');
      const selDst = columns.map(ident).join(', ');
      const a = (await src.query(`SELECT ${selSrc} FROM ${ident(table)} WHERE ${ident(key)} = $1`, [id])).rows[0];
      const b = (await dst.query(`SELECT ${selDst} FROM ${ident(table)} WHERE ${ident(key)} = $1`, [id])).rows[0];
      if (!b) { problems.push(`${label} ${id}: missing in the new database`); continue; }
      for (const c of columns) {
        const same = text[c] === 'json' ? jsonOf(a[c]) === jsonOf(b[c]) : String(a[c]) === String(b[c]);
        if (!same) problems.push(`${label} ${id}: ${c} differs (${String(a[c]).slice(0, 40)} -> ${String(b[c]).slice(0, 40)})`);
      }
    }
  };

  await compare('artist', 'artists', 'mbid', ['name', 'sort_name', 'type', 'country', 'ended', 'begin_date', 'end_date', 'rating'], { begin_date: true, end_date: true });
  await compare('release group', 'release_groups', 'mbid', ['title', 'primary_type', 'first_release_date', 'rating'], { first_release_date: true });
  await compare('release', 'releases', 'mbid', ['title', 'status', 'country', 'barcode', 'release_date', 'track_count', 'media', 'labels'], { release_date: true, media: 'json', labels: 'json' });

  // lists that were reshaped: same names, same order
  for (const [table, cols] of [['artists', ['aliases', 'tags', 'genres']], ['release_groups', ['aliases', 'tags', 'genres']]]) {
    const keys = (await src.query(`SELECT mbid FROM ${table} ORDER BY mbid`)).rows.map(r => r.mbid);
    for (const id of sampleOf(keys, sampleSize)) {
      checks++;
      const a = (await src.query(`SELECT ${cols.join(', ')} FROM ${table} WHERE mbid = $1`, [id])).rows[0];
      const b = (await dst.query(`SELECT ${cols.join(', ')} FROM ${table} WHERE mbid = $1`, [id])).rows[0];
      for (const c of cols) {
        const x = names(typeof a[c] === 'string' ? JSON.parse(a[c]) : a[c]).join('|');
        const y = names(typeof b[c] === 'string' ? JSON.parse(b[c]) : b[c]).join('|');
        if (x !== y) problems.push(`${table} ${id}: ${c} names differ`);
      }
    }
  }
  return { problems, checks };
}

module.exports = { convert, verify, checkStepStone, columnsOf, tableExists, buildInsert, TABLES, REQUIRED, fixSequences };
