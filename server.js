// Single-service monolith for SMS -> WhatsApp with buttons
const express = require("express");
const fetch = require("node-fetch");
const path = require("path");

const app = express();
app.use(express.urlencoded({ extended: true })); // ensure form-encoded works
app.use(express.json({ limit: "256kb" }));       // ensure JSON works

// ---------- Env + health ----------
const PORT = process.env.PORT || 8080;
const BRIDGE_BASE_URL = process.env.BRIDGE_BASE_URL || "https://wa.woosh.ai";
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY;
const BRIDGE_TEMPLATE_NAME = process.env.BRIDGE_TEMPLATE_NAME || "";  // e.g., sms_echo
const BRIDGE_TEMPLATE_LANG = process.env.BRIDGE_TEMPLATE_LANG || "en";

// ---------- Logging helper ----------
function log(event, obj) {
  const payload = { ts: new Date().toISOString(), event, ...obj };
  // console.log stringifies consistently for Cloud Run textPayload
  console.log(JSON.stringify(payload));
}

// ---------- Bridge client ----------
const { sendTemplateViaBridge } = require("./src/lib/bridge");

// ---------- Template send endpoint ----------
// POST /wa/send-template
// body: { to, template: { name, languageCode?, components? }, id? }
app.post("/wa/send-template", async (req, res) => {
  try {
    if (!BRIDGE_API_KEY) {
      return res.status(401).json({ ok: false, error: "auth", note: "BRIDGE_API_KEY missing" });
    }
    const b = req.body || {};
    const id = String(b.id || `tpl-${Date.now()}`);
    const toRaw = String(b.to || "");
    const to = toRaw.replace(/[^\d]/g, ""); // numeric only for Bridge (E.164 without +)

    if (!to) {
      return res.status(400).json({ ok: false, error: "missing_to" });
    }

    const tpl = b.template || {};
    const name = (tpl.name || "").trim();
    const languageCode = (tpl.languageCode || tpl.language?.code || "en_US").trim();
    const components = Array.isArray(tpl.components) ? tpl.components : undefined;

    if (!name) {
      return res.status(400).json({ ok: false, error: "unsupported_payload", note: "template.name required" });
    }

    log("wa_template_attempt", { id, to, name, languageCode, hasComponents: Boolean(components) });

    const data = await sendTemplateViaBridge({
      baseUrl: BRIDGE_BASE_URL,
      apiKey: BRIDGE_API_KEY,
      to,
      name,
      languageCode,
      components,
    });

    const wa_id = data?.messages?.[0]?.id || null;
    log("wa_template_ok", { id, to, name, languageCode, wa_id });
    return res.status(200).json({ ok: true, type: "template", wa_id, graph: data });
  } catch (err) {
    // Bridge client throws with { code, status, body }
    if (err && err.code === "auth") {
      log("wa_template_fail", { reason: "auth", detail: err.body || String(err) });
      return res.status(401).json({ ok: false, error: "auth" });
    }
    if (err && err.code === "send_failed") {
      log("wa_template_fail", { reason: "send_failed", status: err.status, body: err.body });
      return res.status(502).json({ ok: false, error: "send_failed", status: err.status, body: err.body });
    }
    log("wa_template_fail", { reason: "unexpected", detail: String(err && err.stack || err) });
    return res.status(500).json({ ok: false, error: "unexpected" });
  }
});

// WhatsApp Bridge helpers
async function sendWaText(toE164Plus, text, context = {}) {
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
  const raw = await r.text();
  let body; try { body = JSON.parse(raw); } catch { body = { raw }; }
  if (!r.ok) {
    console.error(JSON.stringify({
      ts:new Date().toISOString(),
      svc:"woosh-lifts",
      env:process.env.ENV || "dev",
      event:"wa_send_fail",
      to, status:r.status, body,
      ...context
    }));
    throw new Error(`bridge ${r.status}`);
  }
  console.log(JSON.stringify({
    ts:new Date().toISOString(),
    svc:"woosh-lifts",
    env:process.env.ENV || "dev",
    event:"wa_send_ok",
    to,
    provider_id: body.id || body.messageId || "unknown",
    ...context
  }));
  return body;
}

async function sendWaTemplate(toE164Plus, templateName, lang, params /* array of strings */, meta={}) {
  const to = toE164Plus.replace(/^\+/, "");
  const payload = {
    to,
    template: {
      name: templateName,
      language: lang,
      components: [
        { type: "body", parameters: params.map(p => ({ type:"text", text:String(p) })) }
      ]
    }
  };
  const r = await fetch(`${BRIDGE_BASE_URL}/api/messages/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": BRIDGE_API_KEY },
    body: JSON.stringify(payload)
  });
  const raw = await r.text(); let body; try { body = JSON.parse(raw); } catch { body = { raw }; }
  if (!r.ok) {
    log("wa_template_fail", { to, status:r.status, body, templateName, lang, ...meta });
    throw new Error(`bridge ${r.status}`);
  }
  log("wa_template_ok", { to, provider_id: body.id || body.messageId || "unknown", templateName, lang, ...meta });
  return body;
}

// quick root health (you already have "/" returning ok)
app.get("/", (_req, res) => res.status(200).send("woosh-lifts: ok"));
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// Debug: last inbound SMS seen by this instance
app.get("/api/inbound/latest", (_req, res) => {
  if (!global.LAST_INBOUND) {
    return res.status(404).json({ error: "no_inbound_yet" });
  }
  res.json(global.LAST_INBOUND);
});

// Clean admin status (no external calls)
app.get("/admin/status", (_req, res) => {
  res.json({ 
    bridge: !!BRIDGE_API_KEY, 
    secrets: !!BRIDGE_API_KEY,
    env: ENV,
    timestamp: new Date().toISOString()
  });
});

app.post("/sms/plain", async (req, res) => {
  try {
    const b = req.body || {};

    // id can be anything unique; fall back to Date.now()
    const sms_id = String(b.id ?? b.ID ?? b.messageId ?? b.MessageID ?? Date.now());

    // accept multiple from fields
    const fromRaw =
      b.phoneNumber ?? b.msisdn ?? b.MSISDN ?? b.number ?? b.Number ?? b.from ?? b.From;

    // accept multiple text fields + handle incomingData being a STRING or OBJECT
    const incoming = b.incomingData;
    const textRaw =
      (typeof incoming === "string" ? incoming : incoming?.text) ??
      b.text ?? b.message ?? b.Message ?? b["IncomingMessage"] ?? b["Incoming Message"];

    if (!fromRaw || !textRaw) {
      console.error("[plain] missing fields", JSON.stringify(b).slice(0, 500));
      return res.status(400).json({ ok: false, error: "missing phone/text" });
    }

    // normalize number to +E.164
    let from = String(fromRaw).trim();
    if (!from.startsWith("+")) from = `+${from}`;
    if (!/^\+\d{7,15}$/.test(from)) {
      console.error("[plain] bad msisdn", from);
      return res.status(400).json({ ok: false, error: "bad_msisdn" });
    }

    const text = String(textRaw).trim();

    // snapshot latest inbound for inspection endpoint
    global.LAST_INBOUND = {
      sms_id,
      from,
      text,
      received_at: new Date().toISOString()
    };

    log("sms_received", { sms_id, from, text_len: text.length });
    const meta = { sms_id, text_len: text.length };
    if (BRIDGE_TEMPLATE_NAME) {
      try {
        // Template with one {{1}} = the SMS text
        await sendWaTemplate(from, BRIDGE_TEMPLATE_NAME, BRIDGE_TEMPLATE_LANG, [text], meta);
      } catch (e) {
        // Fallback to session text if template blocked/invalid
        await sendWaText(from, `SMS received: "${text}"`, meta);
      }
    } else {
      await sendWaText(from, `SMS received: "${text}"`, meta);
    }
    return res.status(202).json({ ok: true, forwarded: true, sms_id });
  } catch (e) {
    console.error("[plain] error", String(e));
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

app.listen(PORT, "0.0.0.0", () => {
  log("listen", { port: Number(PORT) });
});