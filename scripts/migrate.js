#!/usr/bin/env node

/**
 * Database migration script
 * Runs migrations when DATABASE_URL is present
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.log('[migrate] No DATABASE_URL found, skipping migrations');
  process.exit(0);
}

async function runMigrations() {
  const client = new Client({ connectionString: DATABASE_URL });
  
  try {
    await client.connect();
    console.log('[migrate] Connected to database');
    
    // Get list of migration files
    const migrationsDir = path.join(__dirname, '..', 'sql');
    const migrationFiles = fs.readdirSync(migrationsDir)
      .filter(file => file.endsWith('.sql'))
      .sort();
    
    console.log(`[migrate] Found ${migrationFiles.length} migration files`);
    
    for (const file of migrationFiles) {
      const migrationPath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(migrationPath, 'utf8');
      
      console.log(`[migrate] Running ${file}...`);
      await client.query(sql);
      console.log(`[migrate] ✓ ${file} completed`);
    }
    
    console.log('[migrate] All migrations completed successfully');
    
  } catch (error) {
    console.error('[migrate] Error running migrations:', error);
    process.exit(1);
  } finally {
    await client.end();
  }
}

runMigrations();