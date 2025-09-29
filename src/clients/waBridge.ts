import fetch from "node-fetch";

const BASE = process.env.BRIDGE_BASE_URL || "https://wa.woosh.ai";
const API_KEY = process.env.BRIDGE_API_KEY || process.env.BRIDGE_API_KEY__FILE; // in case of secret mount

export async function sendText(to: string, text: string) {
  if (!to || !/^\+?\d{6,}$/.test(to)) {
    const err = new Error("missing_or_invalid_to");
    (err as any).code = 400;
    throw err;
  }
  const res = await fetch(`${BASE}/api/messages/send`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": API_KEY as string,
    },
    body: JSON.stringify({ to, text }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body?.ok !== true) {
    const err = new Error(body?.error || `bridge_${res.status}`);
    (err as any).code = res.status;
    (err as any).resp = body;
    throw err;
  }
  return body; // { ok: true, wa_id, accepted, ... }
}
