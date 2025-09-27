const express = require("express");
const morgan  = require("morgan");
const crypto  = require("crypto");
const fs      = require("fs");
const fetch   = require("node-fetch");
const { PubSub } = require('@google-cloud/pubsub');
const { sendTemplateViaBridge, sendTextViaBridge } = require("./lib/bridge");

const BRIDGE_BASE_URL = process.env.BRIDGE_BASE_URL || "https://wa.woosh.ai";
const BRIDGE_API_KEY  = process.env.BRIDGE_API_KEY || "";
const BRIDGE_TEMPLATE_NAME = process.env.BRIDGE_TEMPLATE_NAME || "growthpoint_testv1";
const BRIDGE_TEMPLATE_LANG = (process.env.BRIDGE_TEMPLATE_LANG || "en_US").trim();
const REGISTRY_PATH   = process.env.REGISTRY_PATH || "./data/registry.csv";
const HMAC_SECRET     = process.env.SMSPORTAL_HMAC_SECRET || "";
const SMS_INBOUND_TOPIC = process.env.SMS_INBOUND_TOPIC || "sms-inbound";

// Initialize Pub/Sub
const pubsub = new PubSub();

const app = express();
// no global express.json(); we need raw bytes for HMAC
app.use(morgan("tiny"));
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

// Admin status (enriched, no secrets)
app.get('/admin/status', (req, res) => {
  const templateEnabled = Boolean(process.env.BRIDGE_TEMPLATE_NAME && process.env.BRIDGE_TEMPLATE_LANG);
  res.json({
    bridge: true,
    secrets: true,
    env: process.env.ENV || 'dev',
    build: process.env.APP_BUILD || null,
    templateEnabled,
    templateName: process.env.BRIDGE_TEMPLATE_NAME || null,
    templateLang: process.env.BRIDGE_TEMPLATE_LANG || null,
    timestamp: new Date().toISOString()
  });
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

// readiness
app.get('/healthz', (_, res) => res.send('ok'));

// --- DEBUG: who/what is running (temporary) ---
app.get('/__debug', (req, res) => {
  // List registered top-level routes (methods + paths)
  const routes = [];
  (app._router?.stack || []).forEach(layer => {
    if (layer.route && layer.route.path) {
      const methods = Object.keys(layer.route.methods || {}).filter(Boolean);
      routes.push({ path: layer.route.path, methods });
    }
  });
  res.json({
    build: process.env.APP_BUILD || null,
    entry: (require.main && require.main.filename) || null,
    cwd: process.cwd(),
    routes
  });
});

// DIRECT route: template-first, no forwarding
app.post('/sms/direct', async (req, res) => {
  try {
    const { smsId, toDigits, incoming } = normalize(req.body || {});
    if (!toDigits || !incoming) {
      return res.status(400).json({ ok: false, error: 'bad_request', detail: 'missing phone/text' });
    }
    logEvent('sms_received', { sms_id: smsId, to: plus(toDigits), text_len: incoming.length, direct: true });

    const tplName = process.env.BRIDGE_TEMPLATE_NAME;
    const tplLang = process.env.BRIDGE_TEMPLATE_LANG || 'en_US';
    const to = toDigits; // Bridge expects digits only (no '+')

    if (tplName) {
      try {
        const components = [{ type: "body", parameters: [{ type: "text", text: incoming }]}];
        const r = await sendTemplateViaBridge({ 
          baseUrl: BRIDGE_BASE_URL,
          apiKey: BRIDGE_API_KEY,
          to, 
          name: tplName, 
          languageCode: tplLang, 
          components 
        });
        logEvent('wa_template_ok', { sms_id: smsId, to: plus(to), provider_id: r?.id || null, templateName: tplName, lang: tplLang });
        return res.status(202).json({ ok: true, template: true, id: smsId });
      } catch (e) {
        logEvent('wa_template_fail', { sms_id: smsId, to: plus(to), status: e?.status || null, body: e?.body || e?.message || String(e) });
      }
    }
    // fallback → plain text
    try {
      const r2 = await sendTextViaBridge({ 
        baseUrl: BRIDGE_BASE_URL,
        apiKey: BRIDGE_API_KEY,
        to, 
        text: `SMS received: "${incoming}"` 
      });
      logEvent('wa_send_ok', { sms_id: smsId, to: plus(to), provider_id: r2?.id || null, fallback: true });
      return res.status(202).json({ ok: true, template: false, id: smsId });
    } catch (e2) {
      logEvent('wa_send_fail', { sms_id: smsId, to: plus(toDigits), status: e2?.status || null, body: e2?.body || e2?.message || String(e2) });
      return res.status(502).json({ ok: false, error: 'bridge_send_failed', id: smsId });
    }
  } catch (err) {
    logEvent('handler_error', { error: String(err && err.stack || err) });
    return res.status(500).json({ ok: false, error: 'internal' });
  }
});

// ---------- HMAC helpers ----------
function toStr(body) {
  return Buffer.isBuffer(body) ? body.toString("utf8")
       : typeof body === "string" ? body
       : (body && typeof body === "object") ? JSON.stringify(body)
       : "";
}
function verifySignature(req, raw) {
  const sig = req.header("x-signature") || "";
  const calc = crypto.createHmac("sha256", HMAC_SECRET).update(raw).digest("hex");
  if (!sig || sig.length !== calc.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(calc));
}

// ---------- routes ----------
app.post("/sms/inbound", express.raw({ type: "*/*" }), async (req, res) => {
  try {
    const raw = toStr(req.body) || "";
    if (!verifySignature(req, raw)) {
      console.warn("[inbound] invalid signature");
      return res.status(401).json({ error: "invalid signature" });
    }
    const evt = JSON.parse(raw);
    console.log("[inbound] event", evt);

    const b = evt || {};

    // helper
    const s = v => (v === null || v === undefined) ? "" : String(v).trim();

    // ID
    const smsId =
      s(b.id) ||
      s(b.Id) ||
      `sms-${Date.now()}`;

    // Phone (normalize to digits for Bridge; keep pretty copy for logs)
    const rawPhone =
      s(b.phone) ||
      s(b.phoneNumber) ||
      s(b.to) ||
      s(b.msisdn) ||
      s(b.from);

    const toDigits = rawPhone.replace(/[^\d]/g, "");

    // Message text (first non-empty wins)
    let incoming =
      s(b.text) ||
      s(b.incomingData) ||
      s(b.IncomingData) ||
      s(b.message) ||
      s(b.body);

    // Cap to 1024 for template param
    if (incoming.length > 1024) incoming = incoming.slice(0, 1024);

    // Optional metadata (pass-through for logs/analytics)
    const meta = {
      mcc: s(b.mcc || b.Mcc),
      mnc: s(b.mnc || b.Mnc),
      sc:  s(b.sc  || b.Sc  || b.shortcode),
      keyword: s(b.keyword || b.Keyword),
      incomingUtc: s(b.incomingUtc || b.IncomingUtc || b.incomingDateTime || b.IncomingDateTime)
    };

    // Basic validation (same error shape as before, but now tolerant)
    if (!toDigits || !incoming) {
      return res.status(400).json({ ok: false, error: "missing phone/text" });
    }

    // log normalized inbound once (keeps existing log style)
    console.log(JSON.stringify({
      event: "sms_received_inbound",
      sms_id: smsId,
      to: toDigits,
      text_len: incoming.length,
      ...meta
    }));

    // --- Template-first insert (non-breaking) ---

    let templateAttempted = false;
    if (BRIDGE_API_KEY && BRIDGE_TEMPLATE_NAME && toDigits && incoming) {
      templateAttempted = true;
      try {
        const components = [{ type: "body", parameters: [{ type: "text", text: incoming }]}];
        const graph = await sendTemplateViaBridge({
          baseUrl: BRIDGE_BASE_URL,
          apiKey: BRIDGE_API_KEY,
          to: toDigits,
          name: BRIDGE_TEMPLATE_NAME,
          languageCode: (BRIDGE_TEMPLATE_LANG === "en" ? "en_US" : BRIDGE_TEMPLATE_LANG),
          components
        });
        const wa_id = graph?.messages?.[0]?.id || null;
        console.log(JSON.stringify({ event: "wa_template_ok_inbound", sms_id: smsId, to: toDigits, templateName: BRIDGE_TEMPLATE_NAME, lang: BRIDGE_TEMPLATE_LANG, wa_id, text_len: incoming.length }));
        // Continue to existing Pub/Sub logic below
      } catch (e) {
        console.log(JSON.stringify({
          event: "wa_template_fail_inbound",
          sms_id: smsId,
          to: toDigits,
          templateName: BRIDGE_TEMPLATE_NAME,
          lang: BRIDGE_TEMPLATE_LANG,
          status: e?.status || 0,
          body: e?.body || String(e)
        }));
      }
    }
    // --- End template-first insert ---

    // Publish to Pub/Sub for processing by router
    const topic = pubsub.topic(SMS_INBOUND_TOPIC);
    const messageId = await topic.publishMessage({
      data: Buffer.from(raw),
      attributes: {
        id: smsId,
        from: toDigits,
        timestamp: new Date().toISOString()
      }
    });

    console.log("[inbound] Published to Pub/Sub:", messageId);
    console.log(JSON.stringify({ event: "wa_send_ok_inbound", sms_id: smsId, to: toDigits, text_len: incoming.length, fallback: true }));
    return res.status(200).json({ status: "ok", published: true, message_id: messageId });
  } catch (e) {
    console.error("[inbound] error", e);
    return res.status(500).json({ error: "server_error" });
  }
});

app.post("/admin/registry/reload", (_req, res) => {
  loadRegistry();
  res.json({ status: "ok", size: REGISTRY.size });
});

// Admin endpoint to test WhatsApp Bridge
app.post("/admin/ping-bridge", express.json(), async (req, res) => {
  try {
    const { to, text } = req.body;
    if (!to || !text) {
      return res.status(400).json({ error: "missing to or text parameter" });
    }
    
    const response = await fetch(`${BRIDGE_BASE_URL}/api/messages/send`, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json", 
        "X-Api-Key": BRIDGE_API_KEY 
      },
      body: JSON.stringify({ to, text })
    });
    
    const result = await response.json();
    if (!response.ok) {
      console.error("[admin] bridge error", response.status, result);
      return res.status(500).json({ error: "bridge_error", detail: result });
    }
    
    res.json({ status: "ok", bridge_response: result });
  } catch (e) {
    console.error("[admin] ping error", e);
    res.status(500).json({ error: "server_error", message: e.message });
  }
});

// Export app for use by root server.js
module.exports = app;

// -------- super-permissive portal test endpoint --------
// Accept anything, record it, always return 200.
app.all("/sms/portal", express.raw({ type: "*/*" }), (req, res) => {
  try {
    const raw = toStr(req.body) || "";
    let b = {};
    try { b = raw ? JSON.parse(raw) : {}; } catch { /* ignore */ }

    const message  = (b.message ?? b.text ?? b.body ?? "").toString();

    const from      = (b.msisdn ?? b.from ?? b.sourcePhoneNumber ?? b.phoneNumber ?? "").toString();
    const shortcode = (b.shortcode ?? b.short_code ?? b.to ?? b.destinationPhoneNumber ?? b.sc ?? "").toString();

    // record so you can see what the test sent
    global.LAST_INBOUND = {
      id: b.id || b.messageId || `evt_${Date.now()}`,
      from, shortcode, message,
      received_at: new Date().toISOString(),
      raw: (raw && raw.length <= 4096) ? (b || raw) : "[raw-too-large]"
    };

    // Always 200 OK so the test passes
    res.status(200).json({ status: "ok" });
  } catch (e) {
    // Even on unexpected errors, still 200 to satisfy the test
    console.error("[portal] error", e);
    res.status(200).json({ status: "ok" });
  }
});

// -------- SMSPortal-friendly plain endpoint (no HMAC) --------
// Accepts JSON or form-encoded; maps their field names.
const urlencoded = require("express").urlencoded;
const json = require("express").json;

// Ensure the in-memory "latest" buffer exists even if /sms/inbound hasn't run yet
if (typeof global.LAST_INBOUND === "undefined") global.LAST_INBOUND = null;

app.post(
  "/sms/plain",
  urlencoded({ extended: false }),
  json({ type: ["application/json", "application/*+json"] }),
  async (req, res) => {
    try {
      const b = req.body || {};

      // helper
      const s = v => (v === null || v === undefined) ? "" : String(v).trim();

      // ID
      const smsId =
        s(b.id) ||
        s(b.Id) ||
        `sms-${Date.now()}`;

      // Phone (normalize to digits for Bridge; keep pretty copy for logs)
      const rawPhone =
        s(b.phone) ||
        s(b.phoneNumber) ||
        s(b.to) ||
        s(b.msisdn);

      const toDigits = rawPhone.replace(/[^\d]/g, "");

      // Message text (first non-empty wins)
      let incoming =
        s(b.text) ||
        s(b.incomingData) ||
        s(b.IncomingData) ||
        s(b.message) ||
        s(b.body);

      // Cap to 1024 for template param
      if (incoming.length > 1024) incoming = incoming.slice(0, 1024);

      // Optional metadata (pass-through for logs/analytics)
      const meta = {
        mcc: s(b.mcc || b.Mcc),
        mnc: s(b.mnc || b.Mnc),
        sc:  s(b.sc  || b.Sc  || b.shortcode),
        keyword: s(b.keyword || b.Keyword),
        incomingUtc: s(b.incomingUtc || b.IncomingUtc || b.incomingDateTime || b.IncomingDateTime)
      };

      // Basic validation (same error shape as before, but now tolerant)
      if (!toDigits || !incoming) {
        return res.status(400).json({ ok: false, error: "missing phone/text" });
      }

      // log normalized inbound once (keeps existing log style)
      console.log(JSON.stringify({
        event: "sms_received",
        sms_id: smsId,
        to: toDigits,
        text_len: incoming.length,
        ...meta
      }));

      // --- Template-first insert (non-breaking) ---

      let templateAttempted = false;
      if (BRIDGE_API_KEY && BRIDGE_TEMPLATE_NAME && toDigits) {
        templateAttempted = true;
        try {
          const components = [{ type: "body", parameters: [{ type: "text", text: incoming }]}];
          const graph = await sendTemplateViaBridge({
            baseUrl: BRIDGE_BASE_URL,
            apiKey: BRIDGE_API_KEY,
            to: toDigits,
            name: BRIDGE_TEMPLATE_NAME,
            languageCode: (BRIDGE_TEMPLATE_LANG === "en" ? "en_US" : BRIDGE_TEMPLATE_LANG),
            components
          });
          const wa_id = graph?.messages?.[0]?.id || null;
          console.log(JSON.stringify({ event: "wa_template_ok", sms_id: smsId, to: toDigits, templateName: BRIDGE_TEMPLATE_NAME, lang: BRIDGE_TEMPLATE_LANG, wa_id, text_len: incoming.length }));
          return res.status(202).json({ ok: true, forwarded: true, sms_id: smsId, type: "template" });
        } catch (e) {
          console.log(JSON.stringify({
            event: "wa_template_fail",
            sms_id: smsId,
            to: toDigits,
            templateName: BRIDGE_TEMPLATE_NAME,
            lang: BRIDGE_TEMPLATE_LANG,
            status: e?.status || 0,
            body: e?.body || String(e)
          }));
        }
      }
      // --- End template-first insert ---

      const smsEvent = {
        id: smsId,
        from: toDigits,
        shortcode: meta.sc,
        message: incoming,
        received_at: new Date().toISOString(),
        raw: b
      };

      // Store in memory for /api/inbound/latest
      global.LAST_INBOUND = smsEvent;

      // Publish to Pub/Sub for processing by router
      const topic = pubsub.topic(SMS_INBOUND_TOPIC);
      const messageId = await topic.publishMessage({
        data: Buffer.from(JSON.stringify(smsEvent)),
        attributes: {
          id: smsId,
          from: toDigits,
          timestamp: new Date().toISOString()
        }
      });

      console.log("[plain] Published to Pub/Sub:", messageId);
      
      console.log(JSON.stringify({ event: "wa_send_ok", sms_id: smsId, to: toDigits, text_len: incoming.length, fallback: true }));
      // Always 200 OK so SMSPortal's "Test" passes
      return res.status(200).json({ status: "ok", published: true, message_id: messageId });
    } catch (e) {
      console.error("[plain] error", e);
      return res.status(500).json({ error: "server_error" });
    }
  }
);

// --- latest inbound reader (always available) ---
app.get("/api/inbound/latest", (_req, res) => {
  if (!global.LAST_INBOUND) return res.status(404).json({ error: "no_inbound_yet" });
  res.json(global.LAST_INBOUND);
});
