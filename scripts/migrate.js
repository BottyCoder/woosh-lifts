'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

const SQL_DIR = path.resolve(__dirname, '..', 'sql');
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

function dbConfig() {
  const url = process.env.DATABASE_URL;
  const looksTemplated = typeof url === 'string' && url.includes('$');
  if (url && !looksTemplated) return { connectionString: url, ssl: false };
  return {
    host: process.env.DB_HOST || '127.0.0.1',
    database: process.env.DB_NAME || 'postgres',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  };
}

// Use our own tracker table to avoid legacy collisions
const MIG_TABLE = 'public.sql_migrations';

async function ensureTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${MIG_TABLE} (
      id SERIAL PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      sha1 TEXT,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // Optional visibility: log presence of legacy table
  try {
    const { rowCount } = await client.query(`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema='public' AND table_name='schema_migrations'
    `);
    if (rowCount > 0) console.log('[migrate] legacy table public.schema_migrations present (ignored)');
  } catch { /* ignore */ }
}

function listSql(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.sql')).sort();
}

async function applied(client, filename) {
  const { rows } = await client.query(`SELECT 1 FROM ${MIG_TABLE} WHERE filename = $1`, [filename]);
  return rows.length > 0;
}

async function apply(client, filename, sqlText) {
  await client.query('BEGIN');
  try {
    await client.query(sqlText);
    await client.query(`INSERT INTO ${MIG_TABLE}(filename, sha1) VALUES ($1,$2)`, [filename, sha1(sqlText)]);
    await client.query('COMMIT');
    console.log('[migrate] applied:', filename);
  } catch (e) {
    await client.query('ROLLBACK');
    throw new Error(`Migration failed in ${filename}: ${e.message}`);
  }
}

(async () => {
  const client = new Client(dbConfig());
  try {
    await client.connect();
    console.log('[migrate] connected as %s to %s', process.env.DB_USER, process.env.DB_NAME);
    // Eliminate search_path surprises
    await client.query('SET search_path TO public');
    await ensureTable(client);
    const files = listSql(SQL_DIR);
    if (files.length === 0) { console.log('[migrate] no SQL files found.'); return; }
    console.log('[migrate] found:', files.join(', '));
    for (const f of files) {
      const sql = fs.readFileSync(path.join(SQL_DIR, f), 'utf8');
      if (await applied(client, f)) { console.log('[migrate] skip:', f); continue; }
      await apply(client, f, sql);
    }
    console.log('[migrate] all done.');
  } catch (err) {
    process.exitCode = 1;
    console.error('[migrate] ERROR:', err && err.stack || err);
  } finally {
    try { await client.end(); console.log('[migrate] connection closed'); } catch {}
    setImmediate(() => process.exit(process.exitCode ?? 0));
  }
})();