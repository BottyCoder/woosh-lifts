'use strict';
/**
 * Minimal SQL migration runner for Cloud Run Jobs.
 * - Reads .sql files in /app/sql in lexicographic order.
 * - Tracks applied files in public.schema_migrations(name primary key, applied_at).
 * - Uses DATABASE_URL if present (socket path recommended), otherwise env vars.
 * - Always closes DB handles and exits (so the Job completes).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

const SQL_DIR = path.resolve(__dirname, '..', 'sql');

function getDatabaseConfig() {
  const url = process.env.DATABASE_URL;
  if (url) return { connectionString: url, ssl: false };
  // Fallback if DATABASE_URL isn't set (kept for local runs)
  const host = process.env.DB_HOST || '127.0.0.1';
  const database = process.env.DB_NAME || 'postgres';
  const user = process.env.DB_USER || 'postgres';
  const password = process.env.DB_PASSWORD || '';
  return { host, database, user, password, ssl: false };
}

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      name TEXT PRIMARY KEY,
      sha1 TEXT,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

function listSqlFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.toLowerCase().endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b, 'en'));
}

function sha1(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

async function alreadyApplied(client, name) {
  const { rows } = await client.query('SELECT 1 FROM public.schema_migrations WHERE name = $1', [name]);
  return rows.length > 0;
}

async function applyFile(client, name, sqlText) {
  await client.query('BEGIN');
  try {
    await client.query(sqlText);
    await client.query('INSERT INTO public.schema_migrations(name, sha1) VALUES ($1, $2)', [name, sha1(sqlText)]);
    await client.query('COMMIT');
    console.log(`[migrate] applied: ${name}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw new Error(`Migration failed in ${name}: ${err.message}`);
  }
}

async function main() {
  const cfg = getDatabaseConfig();
  const client = new Client(cfg);
  try {
    console.log('[migrate] connecting…');
    await client.connect();
    await ensureMigrationsTable(client);

    const files = listSqlFiles(SQL_DIR);
    if (files.length === 0) {
      console.log('[migrate] no SQL files found, nothing to do.');
      return;
    }
    console.log('[migrate] found SQL files:', files.join(', '));

    for (const file of files) {
      const name = file;
      if (await alreadyApplied(client, name)) {
        console.log(`[migrate] skip (already applied): ${name}`);
        continue;
        }
      const full = path.join(SQL_DIR, file);
      const sqlText = fs.readFileSync(full, 'utf8');
      await applyFile(client, name, sqlText);
    }
    console.log('[migrate] all done.');
  } finally {
    try { await client.end(); console.log('[migrate] connection closed'); } catch {}
  }
}

main()
  .then(() => { setImmediate(() => process.exit(0)); })
  .catch(err => {
    console.error('[migrate] ERROR:', err && err.stack || err);
    setImmediate(() => process.exit(1));
  });