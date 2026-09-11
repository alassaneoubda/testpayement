const crypto = require('crypto');
const store = require('./store');

function defaultState() {
  return {
    balance: 0,
    currency: 'XOF',
    pendingHold: 0,
    transactions: [],
    activity: [],
    updatedAt: new Date().toISOString(),
  };
}

async function load() {
  const state = await store.loadWallet(defaultState);
  return { ...defaultState(), ...state };
}

async function save(state) {
  state.updatedAt = new Date().toISOString();
  await store.saveWallet(state);
  return state;
}

function pushActivity(state, entry) {
  state.activity.unshift({
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    ...entry,
  });
  if (state.activity.length > 200) state.activity.length = 200;
}

function availableBalance(state) {
  return Math.max(0, Number(state.balance || 0) - Number(state.pendingHold || 0));
}

async function createPending({ type, amount, phone, operator, userId, jobId, reference }) {
  const state = await load();
  const tx = {
    id: crypto.randomUUID(),
    type, // recharge | transfer
    status: 'pending',
    amount: Number(amount),
    phone,
    operator,
    userId,
    jobId: jobId || null,
    reference: reference || null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  if (type === 'transfer') {
    const avail = availableBalance(state);
    if (tx.amount > avail) {
      const err = new Error(
        `Solde insuffisant (disponible ${avail} ${state.currency}, demandé ${tx.amount})`,
      );
      err.status = 400;
      throw err;
    }
    state.pendingHold = Number(state.pendingHold || 0) + tx.amount;
  }

  state.transactions.unshift(tx);
  if (state.transactions.length > 200) state.transactions.length = 200;

  pushActivity(state, {
    level: 'info',
    title: type === 'recharge' ? 'Recharge initiée' : 'Transfert initié',
    message:
      type === 'recharge'
        ? `Demande de +${tx.amount} ${state.currency} depuis ${operator.toUpperCase()} (${phone})`
        : `Demande de −${tx.amount} ${state.currency} vers ${operator.toUpperCase()} (${phone})`,
    jobId: jobId || null,
    txId: tx.id,
  });

  await save(state);
  return { state, tx };
}

async function attachJob(txId, jobId, extra = {}) {
  const state = await load();
  const tx = state.transactions.find((t) => t.id === txId);
  if (!tx) return state;
  tx.jobId = jobId;
  Object.assign(tx, extra);
  tx.updatedAt = new Date().toISOString();
  pushActivity(state, {
    level: 'info',
    title: 'Job MADIS créé',
    message: `jobId ${jobId} — en attente de confirmation Mobile Money`,
    jobId,
    txId,
  });
  return save(state);
}

async function markFailed(txId, reason) {
  const state = await load();
  const tx = state.transactions.find((t) => t.id === txId);
  if (!tx || tx.status !== 'pending') return state;

  if (tx.type === 'transfer') {
    state.pendingHold = Math.max(0, Number(state.pendingHold || 0) - Number(tx.amount));
  }
  tx.status = 'failed';
  tx.failReason = reason || 'failed';
  tx.updatedAt = new Date().toISOString();
  pushActivity(state, {
    level: 'error',
    title: tx.type === 'recharge' ? 'Recharge échouée' : 'Transfert échoué',
    message: reason || 'Échec côté passerelle',
    jobId: tx.jobId,
    txId: tx.id,
  });
  return save(state);
}

async function applyWebhook({ jobId, status, type, amount, body }) {
  const state = await load();
  let tx = jobId
    ? state.transactions.find((t) => t.jobId === jobId)
    : null;

  if (!tx && amount != null) {
    const wantType = String(type || '').includes('withdraw') ? 'transfer' : 'recharge';
    tx = state.transactions.find(
      (t) =>
        t.status === 'pending' &&
        t.type === wantType &&
        Number(t.amount) === Number(amount),
    );
  }

  const normalized = String(status || '').toLowerCase();
  const success = ['succeeded', 'success', 'completed', 'paid'].includes(normalized);
  const failed = ['failed', 'cancelled', 'canceled', 'expired', 'error'].includes(
    normalized,
  );

  pushActivity(state, {
    level: success ? 'success' : failed ? 'error' : 'info',
    title: 'Webhook MADIS reçu',
    message: `type=${body?.type || type || '?'} status=${status} jobId=${jobId || '—'}`,
    jobId: jobId || null,
    txId: tx?.id || null,
  });

  if (!tx) {
    pushActivity(state, {
      level: 'warn',
      title: 'Webhook sans transaction locale',
      message: 'Aucun pending trouvé pour ce job — solde non modifié automatiquement',
      jobId: jobId || null,
    });
    return save(state);
  }

  if (tx.status !== 'pending') {
    pushActivity(state, {
      level: 'warn',
      title: 'Transaction déjà finalisée',
      message: `tx ${tx.id} est déjà ${tx.status}`,
      jobId,
      txId: tx.id,
    });
    return save(state);
  }

  if (success) {
    if (tx.type === 'recharge') {
      state.balance = Number(state.balance || 0) + Number(tx.amount);
      tx.status = 'succeeded';
      pushActivity(state, {
        level: 'success',
        title: 'Portefeuille crédité',
        message: `+${tx.amount} ${state.currency} — nouveau solde ${state.balance}`,
        jobId,
        txId: tx.id,
      });
    } else {
      state.pendingHold = Math.max(0, Number(state.pendingHold || 0) - Number(tx.amount));
      state.balance = Math.max(0, Number(state.balance || 0) - Number(tx.amount));
      tx.status = 'succeeded';
      pushActivity(state, {
        level: 'success',
        title: 'Transfert confirmé',
        message: `−${tx.amount} ${state.currency} envoyés — nouveau solde ${state.balance}`,
        jobId,
        txId: tx.id,
      });
    }
  } else if (failed) {
    if (tx.type === 'transfer') {
      state.pendingHold = Math.max(0, Number(state.pendingHold || 0) - Number(tx.amount));
    }
    tx.status = 'failed';
    tx.failReason = status;
    pushActivity(state, {
      level: 'error',
      title: tx.type === 'recharge' ? 'Recharge refusée' : 'Transfert refusé',
      message: `Statut ${status} — fonds non crédités / hold libéré`,
      jobId,
      txId: tx.id,
    });
  } else {
    pushActivity(state, {
      level: 'info',
      title: 'Statut intermédiaire',
      message: `Toujours en cours (${status})`,
      jobId,
      txId: tx.id,
    });
  }

  tx.updatedAt = new Date().toISOString();
  return save(state);
}

async function snapshot() {
  const state = await load();
  return {
    balance: Number(state.balance || 0),
    pendingHold: Number(state.pendingHold || 0),
    available: availableBalance(state),
    currency: state.currency || 'XOF',
    updatedAt: state.updatedAt,
    storage: store.backendName(),
    transactions: (state.transactions || []).slice(0, 40),
    activity: (state.activity || []).slice(0, 60),
  };
}

async function resetDemo(balance = 0) {
  const state = defaultState();
  state.balance = Number(balance) || 0;
  pushActivity(state, {
    level: 'info',
    title: 'Portefeuille réinitialisé',
    message: `Solde démarré à ${state.balance} ${state.currency}`,
  });
  return save(state);
}

module.exports = {
  load,
  snapshot,
  createPending,
  attachJob,
  markFailed,
  applyWebhook,
  resetDemo,
  availableBalance,
};
