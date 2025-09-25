const express = require('express');
const morgan = require('morgan');
const cors = require('cors');
const helmet = require('helmet');
const crypto = require('crypto');

const app = express();
app.use(helmet());
app.use(cors());
// capture raw body for HMAC
app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; }}));
app.use(morgan('tiny'));

const PORT = process.env.PORT || 8080;

app.get('/', (_req, res) => res.status(200).send('woosh-lifts: ok'));

function safeEqual(a, b) {
  const A = Buffer.from(a || '', 'utf8');
  const B = Buffer.from(b || '', 'utf8');
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

app.post('/sms/inbound', async (req, res) => {
  try {
    const provider   = req.header('x-provider')   || 'smsportal';
    const signature  = req.header('x-signature')  || '';
    const requestId  = req.header('x-request-id') || '';
    const secret     = process.env.SMSPORTAL_HMAC_SECRET || '';

    // Compute expected HMAC over the raw body
    const expected = crypto
      .createHmac('sha256', secret)
      .update(req.rawBody || Buffer.alloc(0))
      .digest('hex');

    if (!secret || !safeEqual(signature, expected)) {
      console.warn('[inbound.smsportal] signature_mismatch', { requestId, provider, got: signature, expected });
      // Still 200 to avoid provider retry storm; we log for investigation.
      return res.status(200).json({ status: 'ok' });
    }

    console.log('[inbound.smsportal]', {
      ok: true,
      headers: { provider, signature, requestId },
      body: req.body
    });

    // TODO: enqueue -> map MSISDN -> recipients -> send WhatsApp via Bridge
    return res.status(200).json({ status: 'ok' });
  } catch (e) {
    console.error('inbound error', e);
    return res.status(500).json({ status: 'error' });
  }
});

app.listen(PORT, () => console.log(`woosh-lifts listening on :${PORT}`));

