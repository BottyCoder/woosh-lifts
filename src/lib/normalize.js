/**
 * Provider-agnostic SMS normalization library
 * Normalizes different provider payloads to a consistent internal shape
 */

/**
 * @typedef {Object} InboundSms
 * @property {'twilio'|'infobip'|'mtn'|'vodacom'|'generic'} provider
 * @property {string} provider_id - message SID / ID from provider (required)
 * @property {string} msisdn - E.164, e.g. +27824537125 (required)
 * @property {string} text - non-empty trimmed (required)
 * @property {string} ts - ISO timestamp; provider event time or server time
 * @property {Record<string, any>} [meta] - untouched original extras
 */

/**
 * Normalize inbound SMS from any provider to internal shape
 * @param {string} providerKey - Provider identifier
 * @param {Object} req - Express request object
 * @returns {InboundSms} Normalized SMS message
 */
function normalizeInbound(providerKey, req) {
  const body = req.body || {};
  
  switch (providerKey) {
    case 'twilio':
      return fromTwilio(body);
    case 'infobip':
      return fromInfobip(body);
    case 'mtn':
      return fromMtn(body);
    case 'vodacom':
      return fromVodacom(body);
    case 'generic':
      return fromGeneric(body);
    default:
      throw new Error(`Unknown provider: ${providerKey}`);
  }
}

/**
 * Helper to convert MSISDN to E.164 format
 * @param {string} msisdn - Raw phone number
 * @returns {string} E.164 formatted number
 */
function toE164(msisdn) {
  if (!msisdn) return '';
  
  // Remove all non-digits
  const digits = msisdn.replace(/\D/g, '');
  
  // Add + if not present and has digits
  if (digits && !msisdn.startsWith('+')) {
    return `+${digits}`;
  }
  
  return msisdn.startsWith('+') ? msisdn : `+${msisdn}`;
}

/**
 * Get current ISO timestamp
 * @returns {string} ISO timestamp
 */
function nowIso() {
  return new Date().toISOString();
}

/**
 * Require a field and throw if missing
 * @param {string} name - Field name
 * @param {any} value - Field value
 * @returns {any} The value if present
 */
function requireField(name, value) {
  if (value === null || value === undefined || value === '') {
    throw new Error(`Missing required field: ${name}`);
  }
  return value;
}

/**
 * Validate E.164 format
 * @param {string} msisdn - Phone number to validate
 * @returns {boolean} True if valid E.164
 */
function isValidE164(msisdn) {
  if (!msisdn) return false;
  
  // Must start with + and have 9-15 digits total
  const e164Regex = /^\+[1-9]\d{8,14}$/;
  return e164Regex.test(msisdn);
}

/**
 * Twilio provider adapter
 * @param {Object} body - Twilio webhook payload
 * @returns {InboundSms} Normalized message
 */
function fromTwilio(body) {
  const msisdn = toE164(requireField('From', body.From));
  const text = requireField('Body', body.Body).trim();
  const provider_id = requireField('MessageSid', body.MessageSid);
  
  if (!isValidE164(msisdn)) {
    throw new Error('Invalid E.164 format for msisdn');
  }
  
  if (!text) {
    throw new Error('Text cannot be empty');
  }
  
  return {
    provider: 'twilio',
    provider_id,
    msisdn,
    text,
    ts: body.SmsTimestamp || nowIso(),
    meta: {
      original: body,
      From: body.From,
      To: body.To,
      MessageSid: body.MessageSid,
      SmsStatus: body.SmsStatus,
      SmsSid: body.SmsSid
    }
  };
}

/**
 * Infobip provider adapter
 * @param {Object} body - Infobip webhook payload
 * @returns {InboundSms} Normalized message
 */
function fromInfobip(body) {
  // Infobip typically sends results array
  const results = body.results || body;
  const result = Array.isArray(results) ? results[0] : results;
  
  if (!result) {
    throw new Error('No results found in Infobip payload');
  }
  
  const msisdn = toE164(requireField('from', result.from));
  const text = requireField('text', result.text).trim();
  const provider_id = requireField('messageId', result.messageId);
  
  if (!isValidE164(msisdn)) {
    throw new Error('Invalid E.164 format for msisdn');
  }
  
  if (!text) {
    throw new Error('Text cannot be empty');
  }
  
  return {
    provider: 'infobip',
    provider_id,
    msisdn,
    text,
    ts: result.sentAt || nowIso(),
    meta: {
      original: body,
      from: result.from,
      to: result.to,
      messageId: result.messageId,
      status: result.status
    }
  };
}

/**
 * MTN provider adapter
 * @param {Object} body - MTN webhook payload
 * @returns {InboundSms} Normalized message
 */
function fromMtn(body) {
  const msisdn = toE164(requireField('msisdn', body.msisdn));
  const text = requireField('text', body.text).trim();
  const provider_id = requireField('id', body.id);
  
  if (!isValidE164(msisdn)) {
    throw new Error('Invalid E.164 format for msisdn');
  }
  
  if (!text) {
    throw new Error('Text cannot be empty');
  }
  
  return {
    provider: 'mtn',
    provider_id,
    msisdn,
    text,
    ts: body.timestamp || nowIso(),
    meta: {
      original: body,
      msisdn: body.msisdn,
      shortcode: body.shortcode,
      keyword: body.keyword
    }
  };
}

/**
 * Vodacom provider adapter
 * @param {Object} body - Vodacom webhook payload
 * @returns {InboundSms} Normalized message
 */
function fromVodacom(body) {
  const msisdn = toE164(requireField('msisdn', body.msisdn));
  const text = requireField('text', body.text).trim();
  const provider_id = requireField('id', body.id);
  
  if (!isValidE164(msisdn)) {
    throw new Error('Invalid E.164 format for msisdn');
  }
  
  if (!text) {
    throw new Error('Text cannot be empty');
  }
  
  return {
    provider: 'vodacom',
    provider_id,
    msisdn,
    text,
    ts: body.timestamp || nowIso(),
    meta: {
      original: body,
      msisdn: body.msisdn,
      shortcode: body.shortcode,
      keyword: body.keyword
    }
  };
}

/**
 * Generic provider adapter - accepts standard fields
 * @param {Object} body - Generic payload with standard fields
 * @returns {InboundSms} Normalized message
 */
function fromGeneric(body) {
  const msisdn = toE164(requireField('msisdn', body.msisdn));
  const text = requireField('text', body.text).trim();
  const provider_id = requireField('provider_id', body.provider_id);
  
  if (!isValidE164(msisdn)) {
    throw new Error('Invalid E.164 format for msisdn');
  }
  
  if (!text) {
    throw new Error('Text cannot be empty');
  }
  
  return {
    provider: 'generic',
    provider_id,
    msisdn,
    text,
    ts: body.ts || nowIso(),
    meta: {
      original: body
    }
  };
}

// Legacy function for backward compatibility
function normalizeInboundLegacy(body) {
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

module.exports = {
  normalizeInbound,
  fromTwilio,
  fromInfobip,
  fromMtn,
  fromVodacom,
  fromGeneric,
  toE164,
  nowIso,
  requireField,
  isValidE164,
  // Legacy export for backward compatibility
  normalizeInboundLegacy
};
