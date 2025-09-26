const express = require("express");
const morgan = require("morgan");
const crypto = require("crypto");
const fs = require("fs");
const fetch = require("node-fetch");
const { PubSub } = require('@google-cloud/pubsub');

const BRIDGE_BASE_URL = process.env.BRIDGE_BASE_URL || "https://wa.woosh.ai";
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY || "";
const REGISTRY_PATH = process.env.REGISTRY_PATH || "./data/registry.csv";
const HMAC_SECRET = process.env.SMSPORTAL_HMAC_SECRET || "";
const SMS_INBOUND_TOPIC = process.env.SMS_INBOUND_TOPIC || "sms-inbound";

const pubsub = new PubSub();
const app = express();

app.use(morgan("tiny"));
global.LAST_INBOUND = null;

let REGISTRY = new Map();

function loadRegistry() {
  REGISTRY = new Map();
  if (!fs.existsSync(REGISTRY_PATH)) return;
  const rows = fs.readFileSync(REGISTRY_PATH, "utf8").split(/\r?\n/).filter(Boolean);
  rows.shift();
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

app.post("/sms/inbound", express.raw({ type: "*/*" }), async (req, res) => {
  try {
    const raw = toStr(req.body) || "";
    if (!verifySignature(req, raw)) {
      console.warn("[inbound] invalid signature");
      return res.status(401).json({ error: "invalid signature" });
    }
    const evt = JSON.parse(raw);
    console.log("[inbound] event", evt);

    const topic = pubsub.topic(SMS_INBOUND_TOPIC);
    const messageId = await topic.publishMessage({
      data: Buffer.from(raw),
      attributes: {
        id: evt.id || `sms_${Date.now()}`,
        from: evt.from || '',
        timestamp: new Date().toISOString()
      }
    });

    console.log("[inbound] Published to Pub/Sub:", messageId);
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

const port = Number(process.env.PORT) || 8080;
app.listen(port, "0.0.0.0", () => console.log(`woosh-lifts listening on :${port}`));

app.all("/sms/portal", express.raw({ type: "*/*" }), (req, res) => {
  try {
    const raw = toStr(req.body) || "";
    let b = {};
    try { b = raw ? JSON.parse(raw) : {}; } catch { /* ignore */ }

    const message = (b.message ?? b.text ?? b.body ?? "").toString();
    const from = (b.msisdn ?? b.from ?? b.sourcePhoneNumber ?? b.phoneNumber ?? "").toString();
    const shortcode = (b.shortcode ?? b.short_code ?? b.to ?? b.destinationPhoneNumber ?? b.sc ?? "").toString();

    global.LAST_INBOUND = {
      id: b.id || b.messageId || `evt_${Date.now()}`,
      from, shortcode, message,
      received_at: new Date().toISOString(),
      raw: (raw && raw.length <= 4096) ? (b || raw) : "[raw-too-large]"
    };

    res.status(200).json({ status: "ok" });
  } catch (e) {
    console.error("[portal] error", e);
    res.status(200).json({ status: "ok" });
  }
});

const urlencoded = require("express").urlencoded;
const json = require("express").json;

app.post("/sms/plain", urlencoded({ extended: false }), json({ type: ["application/json", "application/*+json"] }), async (req, res) => {
  try {
    const b = req.body || {};

    const message = (b.message ?? b.text ?? b.body ?? b.incomingData ?? "").toString();
    const from = (b.msisdn ?? b.from ?? b.sourcePhoneNumber ?? "").toString();
    const shortcode = (b.shortcode ?? b.short_code ?? b.to ?? b.destinationPhoneNumber ?? "").toString();
    const id = (b.id ?? b.messageId ?? b.message_id ?? b.incomingId ?? b.eventId ?? `evt_${Date.now()}`).toString();

    const smsEvent = {
      id,
      from,
      shortcode,
      message,
      received_at: new Date().toISOString(),
      raw: b
    };

    global.LAST_INBOUND = smsEvent;

    const topic = pubsub.topic(SMS_INBOUND_TOPIC);
    const messageId = await topic.publishMessage({
      data: Buffer.from(JSON.stringify(smsEvent)),
      attributes: {
        id: id,
        from: from,
        timestamp: new Date().toISOString()
      }
    });

    console.log("[plain] Published to Pub/Sub:", messageId);
    
    return res.status(200).json({ status: "ok", published: true, message_id: messageId });
  } catch (e) {
    console.error("[plain] error", e);
    return res.status(500).json({ error: "server_error" });
  }
});

app.get("/api/inbound/latest", (_req, res) => {
  if (!global.LAST_INBOUND) return res.status(404).json({ error: "no_inbound_yet" });
  res.json(global.LAST_INBOUND);
});
