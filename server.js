var http = require("http");
var app  = require("./src/server");
var PORT = process.env.PORT || 8080;

function start() {
  try {
    var srv = http.createServer(app);
    srv.listen(PORT, "0.0.0.0", function () {
      console.log("[server] Listening on 0.0.0.0:" + PORT);
    });
  } catch (err) {
    console.error("[server] Startup error:", err);
    process.exit(1);
  }
}

if (require.main === module) start();
module.exports = app;
