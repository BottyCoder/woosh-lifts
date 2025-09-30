'use strict';
const https = require('https');
const { URL } = require('url');

const BRIDGE_BASE_URL = process.env.BRIDGE_BASE_URL || 'https://wa.woosh.ai';
const BRIDGE_API_KEY  = process.env.BRIDGE_API_KEY  || '';

function post(path, payload) {
  return new Promise((resolve, reject) => {
    try {
      const base = new URL(BRIDGE_BASE_URL);
      const body = JSON.stringify(payload || {});
      const opts = {
        method: 'POST',
        hostname: base.hostname,
        port: base.port || 443,
        path,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-Api-Key': BRIDGE_API_KEY
        }
      };
      const req = https.request(opts, (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) { res.resume(); resolve(); }
        else {
          let buf = ''; res.on('data', c => buf += c); res.on('end', () => reject(new Error(`bridge ${res.statusCode}: ${buf}`)));
        }
      });
      req.on('error', reject);
      req.write(body); req.end();
    } catch (e) { reject(e); }
  });
}

// Common helpers other modules might call
async function send(to, text) { return post('/api/messages/send', { to, text }); }
async function health() { return post('/api/health', {}); } // best-effort; may not exist

module.exports = { send, health };
