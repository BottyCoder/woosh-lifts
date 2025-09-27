const express = require('express');
const app = express();
const PORT = process.env.PORT || 8080;
const { sendTemplateViaBridge, sendTextViaBridge } = require('./src/lib/bridge');
const normalizeInbound = require('./src/lib/normalize');

app.use(express.json());

// tiny helpers
const logEvent = (event, extra={}) => console.log(JSON.stringify({event, ts:new Date().toISOString(), ...extra}));
const plus = d => d ? `+${d}` : '';

// Health
app.get('/', (_, res) => res.send('ok'));

// Admin status (extended, no secrets)
app.get('/admin/status', (req, res) => {
  const templateEnabled = Boolean(process.env.BRIDGE_TEMPLATE_NAME && process.env.BRIDGE_TEMPLATE_LANG);
  res.json({
    bridge: true,
    secrets: true,
    env: process.env.ENV || 'dev',
    templateEnabled,
    templateName: process.env.BRIDGE_TEMPLATE_NAME || null,
    templateLang: process.env.BRIDGE_TEMPLATE_LANG || null,
    timestamp: new Date().toISOString()
  });
});

// Existing /sms/plain likely forwards (router path) — leave intact.
// Add a DIRECT send endpoint that does template-first with fallback.
app.post('/sms/direct', async (req, res) => {
  try {
    const { smsId, toDigits, incoming, meta } = normalizeInbound(req.body || {});
    if (!toDigits || !incoming) {
      return res.status(400).json({ ok:false, error:'bad_request', detail:'missing phone/text' });
    }
    logEvent('sms_received', { sms_id:smsId, to: plus(toDigits), text_len: incoming.length, direct:true, meta });

    const tplName = process.env.BRIDGE_TEMPLATE_NAME;
    const tplLang = process.env.BRIDGE_TEMPLATE_LANG || 'en_US';
    const to = toDigits; // Bridge expects digits only

    if (tplName) {
      try {
        const components = [{ type: "body", parameters: [{ type: "text", text: incoming }]}];
        const r = await sendTemplateViaBridge({ 
          baseUrl: process.env.BRIDGE_BASE_URL || "https://wa.woosh.ai",
          apiKey: process.env.BRIDGE_API_KEY,
          to, 
          name: tplName, 
          languageCode: tplLang, 
          components 
        });
        logEvent('wa_template_ok', { sms_id:smsId, to:plus(to), provider_id:r?.id || null, templateName:tplName, lang:tplLang });
        return res.status(202).json({ ok:true, template:true, id:smsId });
      } catch (e) {
        logEvent('wa_template_fail', { sms_id:smsId, to:plus(to), status:e?.status || null, body:e?.body || e?.message || String(e), templateName:tplName, lang:tplLang });
      }
    }

    // fallback to plain text
    try {
      const r2 = await sendTextViaBridge({ 
        baseUrl: process.env.BRIDGE_BASE_URL || "https://wa.woosh.ai",
        apiKey: process.env.BRIDGE_API_KEY,
        to, 
        text: `SMS received: "${incoming}"` 
      });
      logEvent('wa_send_ok', { sms_id:smsId, to:plus(to), provider_id:r2?.id || null, fallback:true });
      return res.status(202).json({ ok:true, template:false, id:smsId });
    } catch (e2) {
      logEvent('wa_send_fail', { sms_id:smsId, to:plus(to), status:e2?.status || null, body:e2?.body || e2?.message || String(e2) });
      return res.status(502).json({ ok:false, error:'bridge_send_failed', id:smsId });
    }
  } catch (err) {
    logEvent('handler_error', { error:String(err && err.stack || err) });
    return res.status(500).json({ ok:false, error:'internal' });
  }
});

module.exports = app;