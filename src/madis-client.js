const { signRequest, newNonce } = require('./hmac');

class MadisClient {
  constructor({ baseUrl, apiKey, hmacSecret }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.hmacSecret = hmacSecret;
  }

  async request(method, path, bodyObj = null) {
    const bodyRaw =
      bodyObj == null ? '' : JSON.stringify(bodyObj);
    const timestamp = String(Date.now());
    const nonce = newNonce();
    const signature = signRequest({
      secret: this.hmacSecret,
      method,
      path,
      bodyRaw,
      timestamp,
      nonce,
    });

    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...(bodyObj != null ? { 'Content-Type': 'application/json' } : {}),
        'X-Gateway-Key': this.apiKey,
        'X-Gateway-Timestamp': timestamp,
        'X-Gateway-Nonce': nonce,
        'X-Gateway-Signature': signature,
      },
      body: bodyObj != null ? bodyRaw : undefined,
    });

    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }

    if (!res.ok) {
      const err = new Error(
        json?.error || json?.message || `HTTP ${res.status}`,
      );
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  }

  deposit(payload) {
    return this.request('POST', '/v1/payments/deposit', payload);
  }

  withdraw(payload) {
    return this.request('POST', '/v1/payments/withdraw', payload);
  }

  status(jobId, purpose = 'deposit') {
    const path = `/v1/payments/transactions/${encodeURIComponent(jobId)}/status?purpose=${encodeURIComponent(purpose)}`;
    return this.request('GET', path, null);
  }
}

module.exports = { MadisClient };
