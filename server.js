// Single entry point: delegate everything to src/server.js
const app = require('./src/server');
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(JSON.stringify({ event: 'server_listen', port: PORT, build: process.env.APP_BUILD || null }));
});