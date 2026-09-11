const crypto = require('crypto');

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value || '', 'utf8').digest('hex');
}

/**
 * Signature MADIS Gateway
 * payload = "{timestamp}.{nonce}.{METHOD}.{path}.{sha256(bodyRaw)}"
 */
function signRequest({ secret, method, path, bodyRaw, timestamp, nonce }) {
  const bodyHash = sha256Hex(bodyRaw || '');
  const payload = `${timestamp}.${nonce}.${method.toUpperCase()}.${path}.${bodyHash}`;
  return crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

function verifyWebhookSignature({
  secret,
  method,
  path,
  bodyRaw,
  timestamp,
  nonce,
  signature,
  maxAgeMs = 5 * 60 * 1000,
}) {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > maxAgeMs) {
    return { ok: false, reason: 'timestamp_expired' };
  }
  const expected = signRequest({
    secret,
    method,
    path,
    bodyRaw,
    timestamp: String(timestamp),
    nonce,
  });
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature || ''), 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad_signature' };
  }
  return { ok: true };
}

function newNonce() {
  return crypto.randomUUID().replace(/-/g, '');
}

module.exports = {
  sha256Hex,
  signRequest,
  verifyWebhookSignature,
  newNonce,
};
