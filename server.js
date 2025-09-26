// Minimal, safe CommonJS Express entry for Cloud Run
const express = require("express");

const app = express();
app.use(express.json({ limit: "256kb" }));

// ---- Health (startup probe) ----
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// ---- Keep your existing routes below (re-add as needed) ----
// Example retained from your snippet:
app.get("/api/inbound/latest", (_req, res) => {
  if (!global.LAST_INBOUND) return res.status(404).json({ error: "no_inbound_yet" });
  res.json(global.LAST_INBOUND);
});

// TODO: re-attach your POST /sms/plain handler here, e.g.:
// app.post("/sms/plain", (req, res) => { ... });

// ---- Final listen (required by Cloud Run) ----
const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(JSON.stringify({ svc: "woosh-lifts", event: "listen", port }));
});