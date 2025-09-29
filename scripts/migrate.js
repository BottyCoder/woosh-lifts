'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

const SQL_DIR = path.resolve(__dirname, '..', 'sql');
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

function dbConfig() {
  const url = process.env.DATABASE_URL;
  if (url) return { connectionString: url, ssl: false };
  return {
    host: process.env.DB_HOST || '127.0.0.1',
    database: process.env.DB_NAME || 'postgres',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
    ssl: false,
  };
}

async function ensureTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      name TEXT PRIMARY KEY,
      sha1 TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

function listSql(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.sql')).sort();
}

async function applied(client, name) {
  const { rows } = await client.query('SELECT 1 FROM public.schema_migrations WHERE name = $1', [name]);
  return rows.length > 0;
}

async function apply(client, name, sqlText) {
  await client.query('BEGIN');
  try {
    await client.query(sqlText);
    await client.query('INSERT INTO public.schema_migrations(name, sha1) VALUES ($1,$2)', [name, sha1(sqlText)]);
    await client.query('COMMIT');
    console.log('[migrate] applied:', name);
  } catch (e) {
    await client.query('ROLLBACK');
    throw new Error(`Migration failed in ${name}: ${e.message}`);
  }
}

(async () => {
  const client = new Client(dbConfig());
  try {
    console.log('[migrate] connecting…');
    await client.connect();
    await ensureTable(client);
    const files = listSql(SQL_DIR);
    if (files.length === 0) { console.log('[migrate] no SQL files found.'); return; }
    console.log('[migrate] found:', files.join(', '));
    for (const f of files) {
      if (await applied(client, f)) { console.log('[migrate] skip:', f); continue; }
      const sql = fs.readFileSync(path.join(SQL_DIR, f), 'utf8');
      await apply(client, f, sql);
    }
    console.log('[migrate] all done.');
  } catch (err) {
    console.error('[migrate] ERROR:', err && err.stack || err);
    process.exitCode = 1;
  } finally {
    try { await client.end(); console.log('[migrate] connection closed'); } catch {}
    setImmediate(() => process.exit(process.exitCode ?? 0));
  }
})();