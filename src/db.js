const { Pool } = require('pg');

// Build database connection configuration
function buildDbConfig() {
  const config = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    application_name: 'woosh-lifts'
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

// Database connection configuration
const pool = new Pool(buildDbConfig());

// Handle pool errors
pool.on('error', (err) => {
  console.error('[db] unexpected error on idle client', err);
});

// Query helper
async function query(text, params) {
  try {
    const result = await pool.query(text, params);
    return result;
  } catch (error) {
    console.error('[db] query error:', error.message, { text, params });
    throw error;
  }
}

// Transaction helper
async function withTxn(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Graceful shutdown
async function close() {
  await pool.end();
}

// Handle process signals for graceful shutdown
process.on('SIGTERM', close);
process.on('SIGINT', close);

module.exports = {
  pool,
  query,
  withTxn,
  close
};
