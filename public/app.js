const balanceEl = document.getElementById('balance');
const holdLine = document.getElementById('holdLine');
const activityList = document.getElementById('activityList');
const txList = document.getElementById('txList');
const out = document.getElementById('out');
const webhookUrl = document.getElementById('webhookUrl');
const configStatus = document.getElementById('configStatus');
const configChip = document.getElementById('configChip');

function money(n, currency = 'XOF') {
  const v = Number(n || 0);
  return `${v.toLocaleString('fr-FR')} ${currency}`;
}

function showRaw(obj) {
  out.textContent = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
}

function formToJson(form) {
  const fd = new FormData(form);
  const obj = {};
  for (const [k, v] of fd.entries()) {
    if (v !== '') obj[k] = v;
  }
  return obj;
}

function setBusy(form, busy) {
  const btn = form.querySelector('button[type=submit]');
  if (btn) {
    btn.disabled = busy;
    btn.dataset.label = btn.dataset.label || btn.textContent;
    btn.textContent = busy ? 'Traitement…' : btn.dataset.label;
  }
}

function renderWallet(wallet) {
  if (!wallet) return;
  balanceEl.textContent = money(wallet.available ?? wallet.balance, wallet.currency);
  if (wallet.pendingHold > 0) {
    holdLine.textContent = `${money(wallet.pendingHold, wallet.currency)} en cours de transfert (réservés)`;
  } else {
    holdLine.textContent = `Solde brut ${money(wallet.balance, wallet.currency)}`;
  }
  renderActivity(wallet.activity || []);
  renderTx(wallet.transactions || [], wallet.currency);
}

function renderActivity(items) {
  if (!items.length) {
    activityList.innerHTML = '<p class="empty">En attente d’activité…</p>';
    return;
  }
  activityList.innerHTML = items
    .map((a) => {
      const level = a.level || 'info';
      const when = a.at ? new Date(a.at).toLocaleString('fr-FR') : '';
      const meta = [a.jobId ? `job ${a.jobId}` : null, when].filter(Boolean).join(' · ');
      return `<article class="activity-item ${level}">
        <p class="title">${escapeHtml(a.title || 'Événement')}</p>
        <p class="msg">${escapeHtml(a.message || '')}</p>
        ${meta ? `<p class="meta">${escapeHtml(meta)}</p>` : ''}
      </article>`;
    })
    .join('');
}

function renderTx(items, currency = 'XOF') {
  if (!items.length) {
    txList.innerHTML = '<p class="empty">Aucune opération pour le moment.</p>';
    return;
  }
  txList.innerHTML = items
    .map((t) => {
      const plus = t.type === 'recharge';
      const label = plus ? 'Recharge' : 'Transfert';
      const sign = plus ? '+' : '−';
      const when = t.createdAt ? new Date(t.createdAt).toLocaleString('fr-FR') : '';
      return `<article class="tx-item">
        <div class="kind">${label} <span class="badge ${t.status}">${t.status}</span></div>
        <div class="amount ${plus ? 'plus' : 'minus'}">${sign}${money(t.amount, currency)}</div>
        <div class="sub">${escapeHtml((t.operator || '').toUpperCase())} · ${escapeHtml(t.phone || '')} · ${escapeHtml(when)}${t.jobId ? ` · ${escapeHtml(t.jobId)}` : ''}</div>
      </article>`;
    })
    .join('');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    webhookUrl.textContent = cfg.publicWebhookUrl;
    const ok = cfg.apiKeyConfigured && cfg.hmacConfigured;
    configStatus.innerHTML = ok
      ? '<span style="color:var(--ok)">Clés API configurées</span> — prêt à appeler MADIS.'
      : '<span style="color:var(--danger)">Clés manquantes</span> — renseigne MADIS_API_KEY et MADIS_HMAC_SECRET.';
    const storage = cfg.storage || 'file';
    const storageOk = storage === 'upstash' || storage === 'file';
    configChip.textContent = ok
      ? `MADIS · stock ${storage}`
      : 'Clés manquantes';
    configChip.className = `topbar-meta ${ok && storageOk ? 'ok' : 'err'}`;
    if (storage === 'file' && typeof location !== 'undefined' && location.hostname.includes('vercel')) {
      configStatus.innerHTML +=
        ' <span style="color:var(--danger)">Attention : sans Upstash sur Vercel le solde peut disparaître.</span>';
    }
    const storageHint = document.getElementById('storageHint');
    if (storageHint) {
      storageHint.textContent =
        storage === 'upstash'
          ? 'Stockage : Upstash Redis (persistant sur Vercel).'
          : 'Stockage : fichier local (OK en local ; sur Vercel configure UPSTASH_REDIS_*).';
    }
  } catch (err) {
    configStatus.textContent = `Erreur config : ${err.message}`;
    configChip.textContent = 'Hors ligne';
    configChip.className = 'topbar-meta err';
  }
}

async function loadWallet() {
  try {
    const res = await fetch('/api/wallet');
    const data = await res.json();
    if (data.wallet) renderWallet(data.wallet);
  } catch (err) {
    showRaw({ ok: false, error: err.message });
  }
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`panel-${tab.dataset.tab}`)?.classList.add('active');
  });
});

document.getElementById('rechargeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  setBusy(e.target, true);
  showRaw('Recharge en cours…');
  try {
    const res = await fetch('/api/recharge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(formToJson(e.target)),
    });
    const data = await res.json();
    showRaw(data);
    if (data.wallet) renderWallet(data.wallet);
    else await loadWallet();
    if (data.result?.redirectUrl) {
      const open = confirm('Lien de paiement Wave disponible. Ouvrir maintenant ?');
      if (open) window.open(data.result.redirectUrl, '_blank', 'noopener');
    }
  } catch (err) {
    showRaw({ ok: false, error: err.message });
  } finally {
    setBusy(e.target, false);
  }
});

document.getElementById('transferForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  setBusy(e.target, true);
  showRaw('Transfert en cours…');
  try {
    const res = await fetch('/api/transfer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(formToJson(e.target)),
    });
    const data = await res.json();
    showRaw(data);
    if (data.wallet) renderWallet(data.wallet);
    else await loadWallet();
  } catch (err) {
    showRaw({ ok: false, error: err.message });
  } finally {
    setBusy(e.target, false);
  }
});

document.getElementById('statusForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = formToJson(e.target);
  showRaw('Vérification statut…');
  try {
    const q = new URLSearchParams({ purpose: data.purpose || 'deposit' });
    const res = await fetch(`/api/status/${encodeURIComponent(data.jobId)}?${q}`);
    const json = await res.json();
    showRaw(json);
    if (json.wallet) renderWallet(json.wallet);
    else await loadWallet();
  } catch (err) {
    showRaw({ ok: false, error: err.message });
  }
});

document.getElementById('refreshWallet').addEventListener('click', () => void loadWallet());
document.getElementById('refreshHistory').addEventListener('click', () => void loadWallet());
document.getElementById('refreshActivity').addEventListener('click', () => void loadWallet());

document.getElementById('copyWebhook').addEventListener('click', async () => {
  const text = webhookUrl.textContent || '';
  try {
    await navigator.clipboard.writeText(text);
    configStatus.textContent = 'URL webhook copiée.';
  } catch {
    configStatus.textContent = 'Copie impossible — sélectionne l’URL manuellement.';
  }
});

document.getElementById('resetWallet').addEventListener('click', async () => {
  if (!confirm('Remettre le solde à 0 et vider l’historique local ?')) return;
  const res = await fetch('/api/wallet/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ balance: 0 }),
  });
  const data = await res.json();
  showRaw(data);
  if (data.wallet) renderWallet(data.wallet);
});

void loadConfig();
void loadWallet();
setInterval(() => void loadWallet(), 5000);
