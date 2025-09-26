// Clean CommonJS Express app for Cloud Run + SMS -> WA Bridge
const express = require("express");
const fetch = require("node-fetch"); // v2 (CJS)

const app = express();
app.use(express.json({ limit: "256kb" }));

const ENV = process.env.ENV || "dev";
const BRIDGE_BASE_URL = process.env.BRIDGE_BASE_URL || "https://wa.woosh.ai";
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY; // from Secret Manager

function log(event, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), env: ENV, svc: "woosh-lifts", event, ...extra }));
}

// Health check for startup probe
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// Optional: peek last inbound SMS
app.get("/api/inbound/latest", (_req, res) => {
  if (!global.LAST_INBOUND) return res.status(404).json({ error: "no_inbound_yet" });
  res.json(global.LAST_INBOUND);
});

// Automation: When SMS arrives, send WhatsApp via Bridge
// Expected SMS JSON:
// { "id":"43922", "phoneNumber":"+27824537125", "incomingData": { "text":"Lift stuck" } }
app.post("/sms/plain", async (req, res) => {
  try {
    const b = req.body || {};
    const sms_id = String(b.id ?? "").trim();
    const from = String(b.phoneNumber ?? "").trim();
    const text = String(b.incomingData?.text ?? "").trim();

    if (!sms_id || !from || !text) {
      log("sms_reject", { reason: "missing_fields", sms_id, from, text_len: text.length || 0 });
      return res.status(400).json({ ok: false, error: "missing id/phoneNumber/incomingData.text" });
    }
    if (!/^\+\d{7,15}$/.test(from)) {
      log("sms_reject", { reason: "bad_msisdn", from });
      return res.status(400).json({ ok: false, error: "phoneNumber must be E.164 with +" });
    }

    global.LAST_INBOUND = { sms_id, from, text, received_at: new Date().toISOString() };
    log("sms_received", { sms_id, from, text_len: text.length });

    // Strip leading + for Bridge
    const to = from.replace(/^\+/, "");
    if (!BRIDGE_API_KEY) {
      log("wa_send_fail", { to, reason: "missing_BRIDGE_API_KEY" });
      return res.status(500).json({ ok: false, error: "bridge_api_key_missing" });
    }

    // Call Woosh WA Bridge
    const r = await fetch(`${BRIDGE_BASE_URL}/api/messages/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": BRIDGE_API_KEY
      },
      body: JSON.stringify({ to, text })
    });
    const raw = await r.text();
    let body;
    try { body = JSON.parse(raw); } catch { body = { raw }; }

    if (!r.ok) {
      log("wa_send_fail", { to, status: r.status, body });
      return res.status(502).json({ ok: false, error: "bridge_failed", status: r.status, body });
    }

    log("wa_send_ok", { to, provider_id: body.id || body.messageId || "unknown" });
    return res.status(202).json({ ok: true, forwarded: true, sms_id, bridge: body });
  } catch (e) {
    log("server_error", { err: String(e) });
    return res.status(500).json({ ok: false, error: "internal" });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => log("listen", { port }));