const express = require("express");
const morgan  = require("morgan");
const crypto  = require("crypto");
const fs      = require("fs");
const fetch   = require("node-fetch");

const BRIDGE_BASE_URL = process.env.BRIDGE_BASE_URL || "https://wa.woosh.ai";
const BRIDGE_API_KEY  = process.env.BRIDGE_API_KEY || "";
const REGISTRY_PATH   = process.env.REGISTRY_PATH || "./data/registry.csv";
const HMAC_SECRET     = process.env.SMSPORTAL_HMAC_SECRET || "";

const app = express();
// no global express.json(); we need raw bytes for HMAC
app.use(morgan("tiny"));

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

    const msisdn = String(evt.from || "").replace(/\D/g, "");
    const entry = REGISTRY.get(msisdn);
    if (!entry) {
      console.warn(`[forwarder] no registry entry for msisdn=${msisdn}`);
      return res.status(200).json({ status: "ok", forwarded: false, reason: "no-registry" });
    }

    const text = `[Lift Alert] ${entry.building} • ${entry.lift_id}
Message: ${evt.message || "N/A"}
Reply: ✅ Taking / 🆘 Need help`;

    const recipients = entry.recipients.slice(0, 5);
    let delivered = 0;
    for (const to of recipients) {
      try {
        const r = await fetch(`${BRIDGE_BASE_URL}/api/messages/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Api-Key": BRIDGE_API_KEY },
          body: JSON.stringify({ to, text })
        });
        if (!r.ok) console.error("[forwarder] bridge error", r.status, await r.text());
        else delivered++;
      } catch (e) {
        console.error("[forwarder] fetch error", e);
      }
    }
    return res.status(200).json({ status: "ok", forwarded: true, delivered, recipients });
  } catch (e) {
    console.error("[inbound] error", e);
    return res.status(500).json({ error: "server_error" });
  }
});

app.post("/admin/registry/reload", (_req, res) => {
  loadRegistry();
  res.json({ status: "ok", size: REGISTRY.size });
});

const port = Number(process.env.PORT) || 8080;
app.listen(port, "0.0.0.0", () => console.log(`woosh-lifts listening on :${port}`));
