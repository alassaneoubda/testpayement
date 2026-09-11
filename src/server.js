const path = require('path');
const express = require('express');
const dotenv = require('dotenv');
const { MadisClient } = require('./madis-client');
const { verifyWebhookSignature } = require('./hmac');
const wallet = require('./wallet');
const store = require('./store');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const PORT = Number(process.env.PORT || 5055);
const BASE = process.env.MADIS_BASE_URL || 'https://api.madisfinance.com';
const API_KEY = process.env.MADIS_API_KEY || '';
const HMAC_SECRET = process.env.MADIS_HMAC_SECRET || '';
const ALLOW_WALLET_RESET = process.env.ALLOW_WALLET_RESET === 'true';

function resolvePublicWebhookUrl() {
  if (process.env.PUBLIC_WEBHOOK_URL?.trim()) {
    return process.env.PUBLIC_WEBHOOK_URL.trim();
  }
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}/webhook/madis`;
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}/webhook/madis`;
  }
  return `http://localhost:${PORT}/webhook/madis`;
}

const PUBLIC_WEBHOOK_URL = resolvePublicWebhookUrl();

const app = express();

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  }),
);
app.use(express.static(path.join(__dirname, '..', 'public')));

function clientOrThrow() {
  if (!API_KEY || !HMAC_SECRET || API_KEY.includes('REMPLACER')) {
    const err = new Error(
      'Configure MADIS_API_KEY et MADIS_HMAC_SECRET (Vercel env / .env)',
    );
    err.status = 400;
    throw err;
  }
  return new MadisClient({
    baseUrl: BASE,
    apiKey: API_KEY,
    hmacSecret: HMAC_SECRET,
  });
}

function sendError(res, err) {
  const cause = err.cause?.message || err.cause?.code || null;
  res.status(err.status || 500).json({
    ok: false,
    error: err.message,
    cause,
    details: err.body || null,
  });
}

app.get('/api/config', (_req, res) => {
  res.json({
    madisBaseUrl: BASE,
    apiKeyConfigured: Boolean(API_KEY && !API_KEY.includes('REMPLACER')),
    hmacConfigured: Boolean(HMAC_SECRET && !HMAC_SECRET.includes('REMPLACER')),
    publicWebhookUrl: PUBLIC_WEBHOOK_URL,
    storage: store.backendName(),
    upstashConfigured: store.hasUpstash(),
    hint:
      'Colle publicWebhookUrl dans Plateform_payement → Entreprise (paymentWebhookUrl) ou Portail → Webhook.',
  });
});

app.get('/api/wallet', async (_req, res) => {
  try {
    res.json({ ok: true, wallet: await wallet.snapshot() });
  } catch (err) {
    sendError(res, err);
  }
});

app.get('/api/activity', async (_req, res) => {
  try {
    const snap = await wallet.snapshot();
    res.json({ ok: true, items: snap.activity });
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/wallet/reset', async (req, res) => {
  try {
    if (!ALLOW_WALLET_RESET) {
      const err = new Error(
        'Reset désactivé. Sur Vercel, mets ALLOW_WALLET_RESET=true seulement pour les tests.',
      );
      err.status = 403;
      throw err;
    }
    const balance = Number(req.body?.balance || 0);
    await wallet.resetDemo(balance);
    res.json({ ok: true, wallet: await wallet.snapshot() });
  } catch (err) {
    sendError(res, err);
  }
});

app.get('/api/webhooks', async (_req, res) => {
  try {
    const items = await store.loadWebhooks(() => []);
    res.json({ items: items.slice(0, 50) });
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/recharge', async (req, res) => {
  let txId = null;
  try {
    const amount = Number(req.body.amount);
    const userPhone = String(req.body.userPhone || '');
    const operator = String(req.body.operator || 'mtn').toLowerCase();
    const userId = String(req.body.userId || 'wallet-user');
    if (!Number.isFinite(amount) || amount <= 0) {
      const err = new Error('Montant invalide');
      err.status = 400;
      throw err;
    }
    if (!userPhone) {
      const err = new Error('Numéro Mobile Money requis');
      err.status = 400;
      throw err;
    }

    const { tx } = await wallet.createPending({
      type: 'recharge',
      amount,
      phone: userPhone,
      operator,
      userId,
      reference: req.body.reference || undefined,
    });
    txId = tx.id;

    const madis = clientOrThrow();
    const result = await madis.deposit({
      amount,
      userId,
      userPhone,
      operator,
      successUrl: req.body.successUrl || 'https://madisfinance.com/ok',
      cancelUrl: req.body.cancelUrl || 'https://madisfinance.com/ko',
      reference: req.body.reference || undefined,
      otp: req.body.otp || undefined,
    });

    const jobId = result?.jobId || result?.id || null;
    if (jobId) await wallet.attachJob(txId, jobId, { madis: result });
    else await wallet.markFailed(txId, 'Pas de jobId retourné');

    res.json({
      ok: true,
      action: 'recharge',
      txId,
      jobId,
      result,
      wallet: await wallet.snapshot(),
    });
  } catch (err) {
    if (txId) await wallet.markFailed(txId, err.message);
    sendError(res, err);
  }
});

app.post('/api/transfer', async (req, res) => {
  let txId = null;
  try {
    const amount = Number(req.body.amount);
    const userPhone = String(req.body.userPhone || '');
    const operator = String(req.body.operator || 'mtn').toLowerCase();
    const userId = String(req.body.userId || 'wallet-user');
    if (!Number.isFinite(amount) || amount <= 0) {
      const err = new Error('Montant invalide');
      err.status = 400;
      throw err;
    }
    if (!userPhone) {
      const err = new Error('Numéro Mobile Money requis');
      err.status = 400;
      throw err;
    }

    const { tx } = await wallet.createPending({
      type: 'transfer',
      amount,
      phone: userPhone,
      operator,
      userId,
      reference: req.body.reference || undefined,
    });
    txId = tx.id;

    const madis = clientOrThrow();
    const result = await madis.withdraw({
      amount,
      userId,
      userPhone,
      operator,
      reference: req.body.reference || undefined,
    });

    const jobId = result?.jobId || result?.id || null;
    if (jobId) await wallet.attachJob(txId, jobId, { madis: result });
    else await wallet.markFailed(txId, 'Pas de jobId retourné');

    res.json({
      ok: true,
      action: 'transfer',
      txId,
      jobId,
      result,
      wallet: await wallet.snapshot(),
    });
  } catch (err) {
    if (txId) {
      try {
        await wallet.markFailed(txId, err.message);
      } catch {
        /* ignore */
      }
    }
    sendError(res, err);
  }
});

app.get('/api/status/:jobId', async (req, res) => {
  try {
    const madis = clientOrThrow();
    const purpose = String(req.query.purpose || 'deposit');
    const result = await madis.status(req.params.jobId, purpose);
    const status = result?.status || result?.state || null;
    if (status) {
      await wallet.applyWebhook({
        jobId: req.params.jobId,
        status,
        type: purpose,
        amount: result?.amount,
        body: result,
      });
    }
    res.json({ ok: true, result, wallet: await wallet.snapshot() });
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/webhook/madis', async (req, res) => {
  try {
    const raw = req.rawBody || JSON.stringify(req.body || {});
    const timestamp = req.header('x-gateway-timestamp') || '';
    const nonce = req.header('x-gateway-nonce') || '';
    const signature = req.header('x-gateway-signature') || '';
    const key = req.header('x-gateway-key') || '';

    let verify = { ok: true, reason: 'skipped_no_secret' };
    if (HMAC_SECRET && !HMAC_SECRET.includes('REMPLACER')) {
      verify = verifyWebhookSignature({
        secret: HMAC_SECRET,
        method: 'POST',
        path: '/webhook/madis',
        bodyRaw: raw,
        timestamp,
        nonce,
        signature,
      });
    }

    const entry = {
      receivedAt: new Date().toISOString(),
      signatureValid: verify.ok,
      verifyReason: verify.reason || null,
      headers: {
        keyPrefix: key ? `${key.slice(0, 12)}…` : null,
        timestamp,
        nonce,
      },
      body: req.body,
    };

    const recent = await store.loadWebhooks(() => []);
    recent.unshift(entry);
    if (recent.length > 100) recent.length = 100;
    await store.saveWebhooks(recent);

    const body = req.body || {};
    const jobId = body.jobId || body.id || body.transactionId || null;
    const status = body.status || body.state || body.paymentStatus || null;
    const amount = body.amount ?? body.data?.amount ?? null;
    const type = body.type || body.purpose || body.event || null;

    await wallet.applyWebhook({ jobId, status, type, amount, body });

    console.log(
      `[webhook] type=${body?.type} jobId=${jobId} status=${status} sig=${verify.ok}`,
    );

    res.status(200).json({
      received: true,
      signatureValid: verify.ok,
      wallet: await wallet.snapshot(),
    });
  } catch (err) {
    console.error('[webhook] error', err);
    // Toujours 200 pour éviter les retries agressifs pendant les tests
    res.status(200).json({ received: true, error: err.message });
  }
});

app.get('/webhook/madis', (_req, res) => {
  res.json({
    ok: true,
    message: 'Endpoint webhook MADIS prêt (POST payment.status ici)',
    configureInPortal: PUBLIC_WEBHOOK_URL,
  });
});

module.exports = { app, PUBLIC_WEBHOOK_URL, PORT };

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Portefeuille demo sur http://localhost:${PORT}`);
    console.log(`Webhook : ${PUBLIC_WEBHOOK_URL}`);
    console.log(`Stockage : ${store.backendName()}`);
    console.log(`API MADIS : ${BASE}`);
  });
}
