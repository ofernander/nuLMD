/**
 * Versioned schema migrations.
 *
 * Every file in ./migrations (NNNN_name.sql) runs once, in order, and is recorded in `schema_migrations`.
 * 0001_baseline.sql is the whole v5 schema. A later change is a new numbered file, never an edit to an old one
 * and never an `IF NOT EXISTS` loop at startup.
 *
 * A v4 database (tables but no schema_migrations) is refused, not upgraded: v5 is a clean break and
 * v4 data moves over with the converter (server/scripts/convert-v4.js) into a brand new database.
 */
const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const FILE_RE = /^(\d{4})_[a-z0-9_]+\.sql$/;

class LegacyDatabaseError extends Error {
  constructor(database) {
    super([
      `The database "${database || 'configured'}" was created by nuLMD v4 and cannot be used by v5 directly.`,
      '',
      'To keep your data (recommended):',
      '  1. Stop nuLMD v4. Leave the PostgreSQL container running.',
      '  2. Run the converter from the v5 image, with a NEW database name:',
      '       docker compose run --rm nulmd-server node server/scripts/convert-v4.js --from <old_name> --to <new_name>',
      '  3. Set POSTGRES_DB to <new_name> in your compose file and start v5.',
      'To start fresh instead: set POSTGRES_DB to a new name; v5 creates it automatically.',
      'Your old database is never modified. Full steps: see the v5 upgrade notes in the README.'
    ].join('\n'));
    this.name = 'LegacyDatabaseError';
    this.code = 'NULMD_LEGACY_DB';
  }
}

function listMigrations(dir = MIGRATIONS_DIR) {
  const names = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  const bad = names.filter(f => !FILE_RE.test(f));
  if (bad.length) throw new Error(`Migration files must be named NNNN_name.sql: ${bad.join(', ')}`);
  const numbers = names.map(f => Number(f.slice(0, 4)));
  numbers.forEach((n, i) => {
    if (n !== i + 1) throw new Error(`Migration numbers must run 0001, 0002, ... without gaps or repeats (found ${names[i]} at position ${i + 1})`);
  });
  return names.map(f => ({ name: f.replace(/\.sql$/, ''), file: path.join(dir, f) }));
}

/** Which state is this database in? 'empty', 'v4' (legacy) or 'v5' (with the list of applied migrations). */
async function inspect(query) {
  const tables = (await query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()`
  )).rows.map(r => r.table_name);
  if (tables.includes('schema_migrations')) {
    const applied = (await query('SELECT name FROM schema_migrations ORDER BY name')).rows.map(r => r.name);
    return { state: 'v5', applied };
  }
  if (tables.includes('artists')) return { state: 'v4', applied: [] };
  return { state: 'empty', applied: [] };
}

/**
 * Bring the database up to date. `exec(sql)` runs a multi-statement script; `query(sql, params)` runs one
 * statement. With a node-pg client both are client.query. Each migration and its record run as one transaction.
 */
async function migrate({ query, exec = query, dir = MIGRATIONS_DIR, database, log = () => {} }) {
  const info = await inspect(query);
  if (info.state === 'v4') throw new LegacyDatabaseError(database);

  const migrations = listMigrations(dir);
  const known = new Set(migrations.map(m => m.name));
  const unknown = info.applied.filter(n => !known.has(n));
  if (unknown.length) {
    throw new Error(`This database was migrated by a newer nuLMD (${unknown.join(', ')}). Upgrade nuLMD, or restore a database made by this version.`);
  }

  const pending = migrations.filter(m => !info.applied.includes(m.name));
  for (const m of pending) {
    log(`Applying migration ${m.name}`);
    const sql = fs.readFileSync(m.file, 'utf8');
    try {
      await exec(`BEGIN;\n${sql}\nINSERT INTO schema_migrations (name) VALUES ('${m.name}');\nCOMMIT;`);
    } catch (error) {
      try { await query('ROLLBACK'); } catch (_) { /* nothing open */ }
      error.message = `Migration ${m.name} failed: ${error.message}`;
      throw error;
    }
  }
  return { state: info.state, applied: pending.map(m => m.name) };
}

module.exports = { migrate, inspect, listMigrations, LegacyDatabaseError, MIGRATIONS_DIR };
