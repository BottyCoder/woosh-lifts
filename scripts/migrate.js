#!/usr/bin/env node

/**
 * Database migration script
 * Uses same DB connection logic as src/db.js
 * Tracks applied migrations in schema_migrations table
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// Build database connection configuration (same as src/db.js)
function buildDbConfig() {
  const config = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    application_name: 'woosh-lifts-migrate'
  };
  
  // Support both TCP and UNIX socket connections
  if (process.env.DB_SOCKET_DIR && process.env.DB_INSTANCE_CONNECTION_NAME) {
    // UNIX socket connection (Cloud SQL)
    config.host = `/cloudsql/${process.env.DB_INSTANCE_CONNECTION_NAME}`;
    config.ssl = false;
  } else {
    // TCP connection
    config.host = process.env.DB_HOST;
    config.port = parseInt(process.env.DB_PORT || '5432');
    config.ssl = process.env.DB_SSL !== 'false' ? { rejectUnauthorized: false } : false;
  }
  
  return config;
}

// Check if we have DB config
const hasDbConfig = process.env.DB_USER && process.env.DB_PASSWORD && process.env.DB_NAME;
const hasDatabaseUrl = process.env.DATABASE_URL;

if (!hasDbConfig && !hasDatabaseUrl) {
  console.log('[migrate] No database configuration found, skipping migrations');
  process.exit(0);
}

async function runMigrations() {
  let pool;
  
  try {
    if (hasDatabaseUrl) {
      // Fallback to DATABASE_URL if available
      pool = new Pool({ connectionString: process.env.DATABASE_URL });
    } else {
      // Use same config as src/db.js
      pool = new Pool(buildDbConfig());
    }
    
    const client = await pool.connect();
    console.log('[migrate] Connected to database');
    
    // Create schema_migrations table if it doesn't exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT NOW()
      )
    `);
    
    // Get list of migration files in lexical order
    const migrationsDir = path.join(__dirname, '..', 'sql');
    const migrationFiles = fs.readdirSync(migrationsDir)
      .filter(file => file.endsWith('.sql'))
      .sort();
    
    console.log(`[migrate] Found ${migrationFiles.length} migration files`);
    
    for (const file of migrationFiles) {
      // Check if migration already applied
      const result = await client.query(
        'SELECT 1 FROM schema_migrations WHERE version = $1',
        [file]
      );
      
      if (result.rows.length > 0) {
        console.log(`[migrate] Skipping ${file} (already applied)`);
        continue;
      }
      
      const migrationPath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(migrationPath, 'utf8');
      
      console.log(`[migrate] applying ${file}`);
      
      // Run migration in transaction
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (version) VALUES ($1)',
          [file]
        );
        await client.query('COMMIT');
        console.log(`[migrate] applied ${file}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    
    console.log('[migrate] All migrations completed successfully');
    
  } catch (error) {
    console.error('[migrate] Error running migrations:', error);
    process.exit(1);
  } finally {
    if (pool) {
      await pool.end();
    }
  }
}

runMigrations();