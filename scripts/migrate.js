#!/usr/bin/env node

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// Database connection configuration
const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
});

// Ensure schema_migrations table exists
async function ensureMigrationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

// Get list of applied migrations
async function getAppliedMigrations() {
  const result = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
  return new Set(result.rows.map(row => row.version));
}

// Run a single migration file
async function runMigration(version, sql) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
    await client.query('COMMIT');
    console.log(`[migrate] applied ${version}`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Main migration function
async function migrate() {
  try {
    console.log('[migrate] starting migrations...');
    
    // Ensure migrations table exists
    await ensureMigrationsTable();
    
    // Get applied migrations
    const applied = await getAppliedMigrations();
    
    // Find all SQL files in sql/ directory
    const sqlDir = path.join(__dirname, '..', 'sql');
    if (!fs.existsSync(sqlDir)) {
      console.log('[migrate] no sql directory found, skipping');
      return;
    }
    
    const files = fs.readdirSync(sqlDir)
      .filter(file => file.endsWith('.sql'))
      .sort();
    
    for (const file of files) {
      const version = file.replace('.sql', '');
      
      if (applied.has(version)) {
        console.log(`[migrate] skipping ${file} (already applied)`);
        continue;
      }
      
      console.log(`[migrate] applying ${file}`);
      const sqlPath = path.join(sqlDir, file);
      const sql = fs.readFileSync(sqlPath, 'utf8');
      
      await runMigration(version, sql);
    }
    
    console.log('[migrate] migrations completed successfully');
  } catch (error) {
    console.error('[migrate] migration failed:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Handle process signals
process.on('SIGTERM', () => pool.end());
process.on('SIGINT', () => pool.end());

// Run migrations
migrate();
