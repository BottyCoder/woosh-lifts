// Minimal Bridge client for WhatsApp template sends
// Contract: POST https://wa.woosh.ai/api/messages/send
// Headers: Content-Type: application/json, X-Api-Key: <BRIDGE_API_KEY>
// Request body:
// {
//   "to": "27824537125",
//   "type": "template",
//   "template": {
//     "name": "growthpoint_testv1",
//     "language": {"code": "en_US"},
//     "components": [ ... ]   // optional
//   }
// }

const DEFAULT_TIMEOUT_MS = 30_000;

async function sendTemplateViaBridge({ baseUrl, apiKey, to, name, languageCode = "en_US", components }) {
  if (!apiKey) {
    const err = new Error("missing BRIDGE_API_KEY");
    err.code = "auth";
    throw err;
  }
  const url = `${baseUrl.replace(/\/+$/,"")}/api/messages/send`;
  const tpl = { name, language: { code: languageCode } };
  if (components) tpl.components = components;
  const body = {
    to,
    type: "template",
    template: tpl,
  };

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort("timeout"), DEFAULT_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(t);
    const err = new Error(`bridge_fetch_failed: ${e && e.message || String(e)}`);
    err.code = "send_failed";
    throw err;
  }
  clearTimeout(t);

  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch (_) { json = { raw: text }; }

  if (res.status === 401 || res.status === 403) {
    const err = new Error("bridge_auth");
    err.code = "auth";
    err.status = res.status;
    err.body = json;
    throw err;
  }
  if (res.status < 200 || res.status >= 300) {
    const err = new Error(`bridge_non_2xx_${res.status}`);
    err.code = "send_failed";
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

module.exports = {
  sendTemplateViaBridge,
};
