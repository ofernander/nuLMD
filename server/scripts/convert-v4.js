#!/usr/bin/env node
/**
 * Convert a nuLMD v4 database into a v5 database. The v4 database is never modified.
 *
 *   docker compose run --rm nulmd-server node server/scripts/convert-v4.js --from <old_name> --to <new_name>
 *
 *   --from <name>       the v4 database to read (stop nuLMD v4 first; leave PostgreSQL running)
 *   --to <name>         the NEW database to create and fill (must be a different name)
 *   --dry-run           read and check everything, write nothing
 *   --images-only       copy only the image records (your uploads), not the metadata
 *   --force             the target may hold an earlier, unfinished conversion: wipe it and start over
 *   --ignore-active     convert even though other connections are open on the v4 database
 *
 * Connection settings come from the same POSTGRES_* variables nuLMD uses.
 */
const { Pool } = require('pg');
const { resolveSettings, ensureDatabase, SAFE_NAME } = require('../sql/connection');
const { migrate, inspect } = require('../sql/migrate');
const { convert, verify, checkStepStone } = require('./convert-v4/convert');

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = { dryRun: false, imagesOnly: false, force: false, ignoreActive: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') opts.from = argv[++i];
    else if (a === '--to') opts.to = argv[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--images-only') opts.imagesOnly = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--ignore-active') opts.ignoreActive = true;
    else throw new UsageError(`Unknown option ${a}`);
  }
  if (!opts.from || !opts.to) throw new UsageError('Both --from <old_database> and --to <new_database> are required.');
  if (opts.from === opts.to) throw new UsageError('--to must be a NEW database name, different from --from. The old database is never modified.');
  for (const name of [opts.from, opts.to]) {
    if (!SAFE_NAME.test(name)) throw new UsageError(`"${name}" is not a plain database name (letters, digits and underscores).`);
  }
  return opts;
}

const defaultDeps = {
  createPool: (settings, database) => new Pool({ ...settings, database, max: 4, connectionTimeoutMillis: 5000 }),
  ensureDatabase,
  migrate,
  activeConnections: async (pool, database) =>
    Number((await pool.query('SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [database])).rows[0].n),
  resetSchema: async pool => { await pool.query('DROP SCHEMA public CASCADE'); await pool.query('CREATE SCHEMA public'); },
  fixSeq: undefined   // default: real sequence fix
};

/** Runs the conversion. Returns an exit code: 0 done, 1 problems found, 2 refused (nothing was changed). */
async function run(opts, { settings = resolveSettings({}, process.env), deps = {}, log = console.log } = {}) {
  const d = { ...defaultDeps, ...deps };
  const refuse = msg => { log(`\nStopped, nothing was changed:\n  ${msg.replace(/\n/g, '\n  ')}`); return 2; };
  const src = d.createPool(settings, opts.from);
  let dst = null;

  try {
    log(`nuLMD v4 -> v5 converter\n  reading:  ${opts.from}  (${settings.host}:${settings.port})\n  writing:  ${opts.dryRun ? '(dry run, nothing is written)' : opts.to}\n`);

    const info = await inspect(q => src.query(q));
    if (info.state === 'v5') return refuse(`"${opts.from}" is already a v5 database. Nothing to convert.`);
    if (info.state === 'empty') return refuse(`"${opts.from}" has no nuLMD tables. Check the name given to --from.`);

    const missing = await checkStepStone(src);
    if (missing.length) {
      return refuse(`"${opts.from}" is from an older nuLMD than the last 0.4.x release (${missing.join('; ')}).\n` +
        'Start the last 0.4.x release once against it (it updates its own schema), stop it, then run this again.');
    }

    if (!opts.ignoreActive) {
      const open = await d.activeConnections(src, opts.from);
      if (open > 0) {
        return refuse(`${open} other connection(s) are still open on "${opts.from}". Stop nuLMD v4 first (leave PostgreSQL running),\n` +
          'so the copy is consistent. To convert anyway, add --ignore-active.');
      }
    }

    if (!opts.dryRun) {
      await d.ensureDatabase({ ...settings, database: opts.to }, { log });
      dst = d.createPool(settings, opts.to);
      const target = await inspect(q => dst.query(q));
      if (target.state === 'v4') return refuse(`"${opts.to}" is a v4 database. Choose a new name; this tool never overwrites one.`);
      if (target.state !== 'empty') {
        if (!opts.force) {
          return refuse(`"${opts.to}" already has data (an earlier conversion?). Use a new name, or add --force to wipe "${opts.to}" and start over.\n` +
            `(--force only ever touches "${opts.to}", never "${opts.from}".)`);
        }
        log(`Wiping "${opts.to}" (--force)`);
        await d.resetSchema(dst);
      }
      const client = await dst.connect();
      try {
        const applied = await d.migrate({ query: (t, p) => client.query(t, p), database: opts.to, log });
        if (applied.applied.length) log(`Created the v5 schema (${applied.applied.join(', ')})`);
      } finally {
        client.release();
      }
    }

    const report = await convert({ src, dst, options: opts, log, fixSeq: d.fixSeq });

    log('\n  table                    read   copied  skipped');
    for (const r of report) {
      log(`  ${(r.name + (r.to !== r.name ? ' -> ' + r.to : '')).padEnd(24)}${String(r.total ?? r.read).padStart(6)}${String(r.written).padStart(9)}${String(r.skipped).padStart(9)}${r.missing ? '  (not in the v4 database)' : ''}`);
    }

    if (opts.dryRun) {
      log('\nDry run complete: every table was read and its first rows converted without errors. Nothing was written.');
      return 0;
    }

    log('\nChecking the copy...');
    const result = await verify({ src, dst, report, options: opts });
    if (result.problems.length) {
      log(`\n${result.problems.length} problem(s) found in ${result.checks} checks:`);
      result.problems.slice(0, 20).forEach(p => log(`  - ${p}`));
      log(`\nThe v4 database "${opts.from}" is untouched. Fix the cause, then re-run with --force to redo "${opts.to}".`);
      return 1;
    }
    log(`All ${result.checks} checks passed.`);
    log(`\nDone. Your v4 database "${opts.from}" was not modified.\nNext: set POSTGRES_DB=${opts.to} in your compose file and start nuLMD v5.`);
    if (!opts.imagesOnly) log('Converted rows are refreshed from MusicBrainz as their TTL expires; until then a few MusicBrainz-only fields (area, tag counts, ...) are empty.');
    return 0;
  } finally {
    await Promise.all([src && src.end && src.end(), dst && dst.end && dst.end()].filter(Boolean));
  }
}

if (require.main === module) {
  (async () => {
    let opts;
    try { opts = parseArgs(process.argv.slice(2)); } catch (e) {
      console.error(e.message + (e instanceof UsageError ? '\n\nUsage: convert-v4.js --from <old_database> --to <new_database> [--dry-run] [--images-only] [--force] [--ignore-active]' : ''));
      process.exit(2);
    }
    try { process.exit(await run(opts)); } catch (e) { console.error(`\nFailed: ${e.message}`); process.exit(1); }
  })();
}

module.exports = { parseArgs, run, UsageError };
