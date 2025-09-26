// Single-service monolith for SMS -> WhatsApp with buttons
const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json({ limit: "256kb" }));

const ENV = process.env.ENV || "dev";
const BRIDGE_BASE_URL = process.env.BRIDGE_BASE_URL || "https://wa.woosh.ai";
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY;

function log(event, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), svc: "woosh-lifts", env: ENV, event, ...extra }));
}

// WhatsApp Bridge helpers
async function sendWaText(toE164Plus, text) {
  const to = toE164Plus.replace(/^\+/, "");
  const r = await fetch(`${BRIDGE_BASE_URL}/api/messages/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": BRIDGE_API_KEY },
    body: JSON.stringify({ to, text })
  });
  const raw = await r.text(); let body; try { body = JSON.parse(raw); } catch { body = { raw }; }
  if (!r.ok) { log("wa_send_fail", { to, status: r.status, body }); throw new Error(`bridge ${r.status}`); }
  log("wa_send_ok", { to, provider_id: body.id || body.messageId || "unknown" });
  return body;
}

async function sendWaButtons(toE164Plus, bodyText, buttons /* [{id,title}] */) {
  const to = toE164Plus.replace(/^\+/, "");
  const payload = {
    to,
    interactive: {
      type: "button",
      body: { text: bodyText },
      action: {
        buttons: buttons.map(b => ({ type: "reply", reply: { id: b.id, title: b.title } }))
      }
    }
  };
  const r = await fetch(`${BRIDGE_BASE_URL}/api/messages/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": BRIDGE_API_KEY },
    body: JSON.stringify(payload)
  });
  const raw = await r.text(); let body; try { body = JSON.parse(raw); } catch { body = { raw }; }
  if (!r.ok) { log("wa_send_fail", { to, interactive: true, status: r.status, body }); throw new Error(`bridge ${r.status}`); }
  log("wa_send_ok", { to, interactive: true, provider_id: body.id || body.messageId || "unknown" });
  return body;
}

// Health endpoints (mandatory)
app.get("/", (_req, res) => res.status(200).send("ok"));
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// SMS endpoint (send buttons)
app.post("/sms/plain", async (req, res) => {
  try {
    const b = req.body || {};
    const sms_id = String(b.id || "").trim();
    const from = String(b.phoneNumber || "").trim();
    const text = String(b.incomingData?.text || "").trim();

    if (!sms_id || !from || !text) return res.status(400).json({ ok: false, error: "missing id/phoneNumber/incomingData.text" });
    if (!/^\+\d{7,15}$/.test(from)) return res.status(400).json({ ok: false, error: "phoneNumber must be E.164 with +" });

    log("sms_received", { sms_id, from, text_len: text.length });

    const bodyText = `Msg from SMS: "${text}"\nChoose an action:`;
    const buttons = [
      { id: "ACK_HELP", title: "Send technician" },
      { id: "ACK_DONE", title: "All good" }
    ];

    await sendWaButtons(from, bodyText, buttons);
    return res.status(202).json({ ok: true, forwarded: true, sms_id });
  } catch (e) {
    log("server_error", { err: String(e) });
    return res.status(502).json({ ok: false, error: "bridge_failed" });
  }
});

// WhatsApp webhook (button taps -> follow-up)
app.post("/wa/webhook", async (req, res) => {
  try {
    const evt = req.body || {};
    let from, buttonId, buttonTitle;

    // WhatsApp Cloud style
    const msg = evt.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (msg) {
      from = msg.from || from;
      if (msg.interactive?.button_reply) {
        buttonId = msg.interactive.button_reply.id;
        buttonTitle = msg.interactive.button_reply.title;
      } else if (msg.button?.payload) {
        buttonId = msg.button.payload;
        buttonTitle = msg.button.text;
      }
    }
    // Flat fallback
    if (!from && evt.from) from = evt.from;
    if (!buttonId && evt.button?.id) buttonId = evt.button.id;
    if (!buttonTitle && evt.button?.title) buttonTitle = evt.button.title;

    if (!from || !buttonId) {
      log("wa_webhook_ignored", { reason: "no_button", sample: JSON.stringify(evt).slice(0, 300) });
      return res.status(200).json({ ok: true });
    }

    const toPlus = from.startsWith("+") ? from : `+${from}`;
    log("wa_button", { from, buttonId, buttonTitle });

    let reply;
    if (buttonId === "ACK_HELP") reply = "✅ Confirmed. Dispatching a technician. You'll get updates shortly.";
    else if (buttonId === "ACK_DONE") reply = "🎉 Great—glad it's sorted. If it happens again, reply here.";
    else reply = `Noted your selection: ${buttonTitle || buttonId}. We'll follow up.`;

    await sendWaText(toPlus, reply);
    return res.status(200).json({ ok: true });
  } catch (e) {
    log("wa_webhook_error", { err: String(e) });
    return res.status(200).json({ ok: true });
  }
});

// Start server
const port = process.env.PORT || 8080;
app.listen(port, () => log("listen", { port }));