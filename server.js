// Single entry point: delegate everything to src/server.js
const { spawn } = require('child_process');

async function startServer() {
  try {
    // Run migrations first
    console.log('[server] Running database migrations...');
    const migrate = spawn('node', ['scripts/migrate.js'], { stdio: 'inherit' });
    
    await new Promise((resolve, reject) => {
      migrate.on('close', (code) => {
        if (code !== 0) {
          console.error('[server] Migration failed, exiting');
          reject(new Error('Migration failed'));
        } else {
          console.log('[server] Migrations completed successfully');
          resolve();
        }
      });
    });
    
    // Start the server
    const app = require('./src/server');
    const PORT = process.env.PORT || 8080;
    app.listen(PORT, () => {
      console.log(JSON.stringify({ event: 'server_listen', port: PORT, build: process.env.APP_BUILD || null }));
    });
    
  } catch (error) {
    console.error('[server] Startup error:', error);
    process.exit(1);
  }
}

startServer();