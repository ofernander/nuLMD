/**
 * Where the database is, and making sure it exists.
 *
 * Environment variables win over config.yml: config.yml is written once at first run, so without this a
 * changed POSTGRES_DB in compose would be silently ignored on an existing install.
 */
const { Client } = require('pg');

function resolveSettings(fromConfig = {}, env = process.env) {
  const pick = (envName, key, fallback) => (env[envName] !== undefined && env[envName] !== '' ? env[envName] : (fromConfig[key] ?? fallback));
  return {
    host: pick('POSTGRES_HOST', 'host', 'nulmd-db'),
    port: Number(pick('POSTGRES_PORT', 'port', 5432)),
    database: pick('POSTGRES_DB', 'database', 'nulmd'),
    user: pick('POSTGRES_USER', 'user', 'nulmd'),
    password: pick('POSTGRES_PASSWORD', 'password', 'changeme')
  };
}

const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const quoteIdent = name => `"${name}"`;

/**
 * Create the configured database if the server doesn't have it yet (e.g. a new POSTGRES_DB after upgrading).
 * Returns true if it created one. Needs the CREATEDB right, which the official postgres image's user has.
 */
async function ensureDatabase(settings, { ClientClass = Client, log = () => {} } = {}) {
  const connect = async database => {
    const client = new ClientClass({ ...settings, database, connectionTimeoutMillis: 5000 });
    await client.connect();
    return client;
  };

  try {
    (await connect(settings.database)).end();
    return false;
  } catch (error) {
    if (error.code !== '3D000') throw error;   // anything but "database does not exist" is a real problem
  }

  if (!SAFE_NAME.test(settings.database)) {
    throw new Error(`Database "${settings.database}" does not exist, and its name has characters nuLMD won't create automatically. Create it yourself, then restart.`);
  }

  log(`Database "${settings.database}" does not exist, creating it`);
  const admin = await connect('postgres');
  try {
    await admin.query(`CREATE DATABASE ${quoteIdent(settings.database)}`);
    return true;
  } catch (error) {
    if (error.code === '42P04') return false;   // someone else created it first
    if (error.code === '42501') {
      throw new Error(`Database "${settings.database}" does not exist and user "${settings.user}" is not allowed to create it. Create it yourself (createdb ${settings.database}), then restart.`);
    }
    throw error;
  } finally {
    admin.end();
  }
}

module.exports = { resolveSettings, ensureDatabase, SAFE_NAME };
