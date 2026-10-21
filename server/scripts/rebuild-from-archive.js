#!/usr/bin/env node
/**
 * Refill the artist / release-group / release tables from the raw MusicBrainz archive, without calling
 * MusicBrainz. Use it after a fix to how replies are mapped, or after an update that stores more fields.
 * TTLs, overviews and timestamps are left as they are.
 *
 *   node server/scripts/rebuild-from-archive.js [--type artist,release_group,release] [--dry-run]
 */
const config = require('../lib/config');
const database = require('../sql/database');
const metaHandler = require('../lib/metaHandler');

const ALL = ['artist', 'release_group', 'release'];

function parseArgs(argv) {
  const opts = { types: ALL, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') opts.dryRun = true;
    else if (argv[i] === '--type') opts.types = String(argv[++i] || '').split(',').filter(Boolean);
    else throw new Error(`Unknown option ${argv[i]}`);
  }
  const bad = opts.types.filter(t => !ALL.includes(t));
  if (bad.length || opts.types.length === 0) throw new Error(`--type must be some of: ${ALL.join(', ')}`);
  // parents before children, whatever order was typed
  opts.types = ALL.filter(t => opts.types.includes(t));
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  await config.load();
  await database.initialize();
  const stats = await metaHandler.replayFromArchive({
    ...opts,
    onProgress: (type, s) => process.stdout.write(`\r${type}: ${s.replayed} done${s.failed ? `, ${s.failed} failed` : ''}   `)
  });
  process.stdout.write('\n');
  for (const [type, s] of Object.entries(stats)) {
    console.log(`${opts.dryRun ? 'would replay' : 'replayed'} ${s.replayed} ${type} reply(ies)${s.failed ? `, ${s.failed} failed (see the log)` : ''}`);
  }
  await database.close();
  process.exit(Object.values(stats).some(s => s.failed) ? 1 : 0);
}

if (require.main === module) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}

module.exports = { parseArgs };
