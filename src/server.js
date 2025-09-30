const express = require("express");
const morgan  = require("morgan");
const crypto  = require("crypto");
const fs      = require("fs");
const fetch   = require("node-fetch");
const { PubSub } = require('@google-cloud/pubsub');
const { sendTemplateViaBridge, sendTextViaBridge } = require("./lib/bridge");
const { query, withTxn } = require("./db");
const { requireString, optionalString, requireEnum, patterns, createValidationError } = require("./validate");
const { requestLogger } = require("./mw/log");
const { errorHandler } = require("./mw/error");
const { getPagination, paginateQuery } = require("./pagination");
const smsRoutes = require('./routes/sms');
const sendRoutes = require("./routes/send");
const { startRetryProcessor } = require("./lib/retryQueue");

const BRIDGE_BASE_URL = process.env.BRIDGE_BASE_URL || "https://wa.woosh.ai";
const BRIDGE_API_KEY  = process.env.BRIDGE_API_KEY || "";
const BRIDGE_TEMPLATE_NAME = process.env.BRIDGE_TEMPLATE_NAME || "growthpoint_testv1";
// Always default to "en" and normalize any provided code down to "en"
const BRIDGE_TEMPLATE_LANG = ((process.env.BRIDGE_TEMPLATE_LANG || "en").trim().split(/[_-]/)[0] || "en");
const REGISTRY_PATH   = process.env.REGISTRY_PATH || "./data/registry.csv";
const HMAC_SECRET     = process.env.SMSPORTAL_HMAC_SECRET || "";
const SMS_INBOUND_TOPIC = process.env.SMS_INBOUND_TOPIC || "sms-inbound";

// Initialize Pub/Sub
const pubsub = new PubSub();

// Migrations are now handled in root server.js

const app = express();
// no global express.json(); we need raw bytes for HMAC on specific routes
const jsonParser = express.json({ limit: '128kb' });
app.use(morgan("tiny"));
app.use(requestLogger);

// CORS for admin routes
app.use('/admin/*', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Authorization, X-Admin-Token, Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(204).send();
  }
  
  next();
});
// unified latest-inbound buffer for readers/writers
global.LAST_INBOUND = (typeof global.LAST_INBOUND !== "undefined") ? global.LAST_INBOUND : null;

// ---------- registry ----------
let REGISTRY = new Map();
function loadRegistry() {
  REGISTRY = new Map();
  if (!fs.existsSync(REGISTRY_PATH)) return;
  const rows = fs.readFileSync(REGISTRY_PATH, "utf8").split(/\r?\n/).filter(Boolean);
  rows.shift(); // header
  for (const line of rows) {
    const cells = line.split(",");
    if (cells.length < 6) continue;
    const [building, building_code, lift_id, msisdn, ...recips] = cells.map(s => s.trim());
    const recipients = recips.filter(Boolean);
    REGISTRY.set((msisdn || "").replace(/\D/g, ""), { building, building_code, lift_id, recipients });
  }
  console.log(`[registry] loaded ${REGISTRY.size} entries from ${REGISTRY_PATH}`);
}
loadRegistry();

app.get("/", (_req, res) => res.status(200).send("woosh-lifts: ok"));

// Mount SMS routes (core functionality only)
app.use('/sms', smsRoutes);

// Mount send routes
app.use('/send', sendRoutes);

// Template flow router (buttons: Test | Maintenance | Entrapment)
try {
  const templateFlow = require('./routes/templateFlow');
  app.use(templateFlow);
  console.log('[boot] templateFlow router mounted');
} catch (e) {
  console.warn('[boot] templateFlow router not mounted:', e.message);
}

// Admin status (enriched, no secrets)
app.get('/admin/status', async (req, res) => {
  try {
    const templateEnabled = Boolean(process.env.BRIDGE_TEMPLATE_NAME && process.env.BRIDGE_TEMPLATE_LANG);
    
    // Check database connectivity and get counts
    let dbStatus = { db: false, lifts_count: 0, contacts_count: 0, last_event_ts: null };
    try {
      // Use Promise.all for parallel queries
      const [liftsResult, contactsResult, lastEventResult] = await Promise.all([
        query('SELECT COUNT(*) as count FROM lifts'),
        query('SELECT COUNT(*) as count FROM contacts'),
        query('SELECT MAX(ts) as last_ts FROM events')
      ]);
      
      dbStatus = {
        db: true,
        lifts_count: parseInt(liftsResult.rows[0].count),
        contacts_count: parseInt(contactsResult.rows[0].count),
        last_event_ts: lastEventResult.rows[0].last_ts
      };
    } catch (dbError) {
      console.warn('[admin/status] database check failed:', dbError.message);
    }
    
    // Get build info
    const build = {
      node: process.version,
      commit: process.env.COMMIT_SHA || process.env.APP_BUILD || process.env.GIT_SHA || 'unknown'
    };
    
    res.json({
      ok: true,
      bridge: true,
      secrets: true,
      env: process.env.ENV || 'dev',
      templateEnabled,
      templateName: process.env.BRIDGE_TEMPLATE_NAME || null,
      templateLang: process.env.BRIDGE_TEMPLATE_LANG || null,
      ...dbStatus,
      build,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[admin/status] error:', error);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  }
});

// tiny helpers kept local to avoid dependency gaps
const logEvent = (event, extra = {}) =>
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...extra }));
const plus = d => (d ? `+${d}` : '');
const digits = v => (v ?? '').toString().replace(/\D+/g, '');
function normalize(body = {}) {
  const id = body.id ?? body.Id ?? body.messageId ?? body.reqId ?? `gen-${Date.now()}`;
  const phoneRaw = body.phone ?? body.phoneNumber ?? body.msisdn ?? body.to ?? body.from ?? '';
  const textRaw = body.text ?? body.incomingData ?? body.IncomingData ?? body.message ?? body.body ?? '';
  return {
    smsId: String(id).slice(0, 128),
    toDigits: digits(phoneRaw).slice(0, 20),
    incoming: String(textRaw || '').trim().slice(0, 1024)
  };
}

// --- Bridge template sender (raw) ---
async function sendTemplateRaw({ to, name, langCode, paramText }) {
  const payload = {
    to,
    type: "template",
    template: {
      name,
      language: { code: langCode },
      components: [
const http = require('http');

const PORT = process.env.PORT || 8080;
async function startServer() {
  try {
    // If `app` is an Express app or a Router/function, http.createServer(app) will work.
    const server = http.createServer(app);
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`[server] Listening on 0.0.0.0:${PORT}`);
    });
  } catch (err) {
    console.error('[server] Startup error:', err);
    process.exit(1);
  }
}

// Only start if this file is the entrypoint (Cloud Run default: `node server.js`)
if (require.main === module) {
  startServer();
}

module.exports = app;
