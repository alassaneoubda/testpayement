/* Sonde Hub2 Wave : reproduit le flux payment-intent + payment et affiche
 * les réponses brutes pour trouver nextAction.data.url. Aucun débit tant
 * que le lien Wave n'est pas ouvert par un client. */
require('dotenv').config({ path: 'C:/Users/djama/Documents/Plateform_payement/.env' });

const BASE = process.env.HUB2_BASE_URL || 'https://api.hub2.io';
const HEADERS = {
  'Content-Type': 'application/json',
  ApiKey: process.env.HUB2_API_KEY,
  MerchantId: process.env.HUB2_MERCHANT_ID,
  Environment: process.env.HUB2_ENVIRONMENT || 'live',
};

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: HEADERS,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

(async () => {
  const ref = `probe_wave_${Date.now()}`;
  console.log('=== 1. POST /payment-intents ===');
  const intent = await call('POST', '/payment-intents', {
    reference: ref,
    customerReference: 'customer_probe',
    purchaseReference: `purchase_${Date.now()}`,
    amount: 100,
    currency: 'XOF',
    description: 'Probe Wave 100 XOF',
    successUrl: 'https://madisfinance.com/ok',
    cancelUrl: 'https://madisfinance.com/ko',
  });
  console.log('HTTP', intent.status);
  console.log(JSON.stringify(intent.json, null, 2).slice(0, 1500));
  if (intent.status >= 300) return;

  const intentId = intent.json.id;
  console.log('\n=== 2. POST /payment-intents/%s/payments (wave) ===', intentId);
  const payment = await call('POST', `/payment-intents/${intentId}/payments`, {
    token: intent.json.token,
    paymentMethod: 'mobile_money',
    country: 'CI',
    provider: 'wave',
    mobileMoney: {
      msisdn: '0143326669',
      onSuccessRedirectionUrl: 'https://madisfinance.com/ok',
      onFailedRedirectionUrl: 'https://madisfinance.com/ko',
      onCancelRedirectionUrl: 'https://madisfinance.com/ko',
      onFinishRedirectionUrl: 'https://madisfinance.com/ok',
    },
  });
  console.log('HTTP', payment.status);
  console.log(JSON.stringify(payment.json, null, 2).slice(0, 3000));

  console.log('\n=== 3. GET /payment-intents/%s (x8, 1s) ===', intentId);
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const detail = await call('GET', `/payment-intents/${intentId}`);
    console.log(`--- tentative ${i + 1} HTTP ${detail.status} ---`);
    const s = JSON.stringify(detail.json, null, 2);
    console.log(s.length > 2500 ? s.slice(0, 2500) + '…' : s);
    if (s.includes('nextAction') || s.includes('wave.com')) {
      console.log('>>> nextAction / wave.com trouvé ci-dessus');
      break;
    }
  }
})().catch((e) => console.error('ERREUR', e.message, e.cause?.message || ''));
