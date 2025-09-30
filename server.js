"use strict";
const http = require("http");
const app  = require("./src/server");
const PORT = process.env.PORT || 8080;

function start() {
  try {
    const srv = http.createServer(app);
    srv.listen(PORT, "0.0.0.0", () => {
      console.log(`[server] Listening on 0.0.0.0:${PORT}`);
    });
  } catch (err) {
    console.error("[server] Startup error:", err);
    process.exit(1);
  }
}

if (require.main === module) start();
module.exports = app;