// src/lib/normalize.js
function normalizeInbound(body) {
  // helper
  const s = v => (v === null || v === undefined) ? "" : String(v).trim();

  // ID
  const smsId =
    s(body.id) ||
    s(body.Id) ||
    `sms-${Date.now()}`;

  // Phone (normalize to digits for Bridge; keep pretty copy for logs)
  const rawPhone =
    s(body.phone) ||
    s(body.phoneNumber) ||
    s(body.to) ||
    s(body.msisdn);

  const toDigits = rawPhone.replace(/[^\d]/g, "");

  // Message text (first non-empty wins)
  let incoming =
    s(body.text) ||
    s(body.incomingData) ||
    s(body.IncomingData) ||
    s(body.message) ||
    s(body.body);

  // Cap to 1024 for template param
  if (incoming.length > 1024) incoming = incoming.slice(0, 1024);

  // Optional metadata (pass-through for logs/analytics)
  const meta = {
    mcc: s(body.mcc || body.Mcc),
    mnc: s(body.mnc || body.Mnc),
    sc:  s(body.sc  || body.Sc  || body.shortcode),
    keyword: s(body.keyword || body.Keyword),
    incomingUtc: s(body.incomingUtc || body.IncomingUtc || body.incomingDateTime || body.IncomingDateTime)
  };

  return { smsId, toDigits, incoming, meta };
}

module.exports = normalizeInbound;
