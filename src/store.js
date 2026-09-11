const fs = require('fs');
const path = require('path');

const WALLET_KEY = process.env.WALLET_STORE_KEY || 'madis:wallet:v1';
const WEBHOOKS_KEY = process.env.WEBHOOKS_STORE_KEY || 'madis:webhooks:v1';

const DATA_DIR = path.join(__dirname, '..', 'data');
const WALLET_FILE = path.join(DATA_DIR, 'wallet.json');
const WEBHOOKS_FILE = path.join(DATA_DIR, 'webhooks.json');

function hasUpstash() {
  return Boolean(
    process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN,
  );
}

function backendName() {
  return hasUpstash() ? 'upstash' : 'file';
}

let redisClient = null;

function getRedis() {
  if (!hasUpstash()) return null;
  if (redisClient) return redisClient;
  // Lazy require so local file mode works without the package installed issues
  const { Redis } = require('@upstash/redis');
  redisClient = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  return redisClient;
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

async function getJson(key, filePath, fallback) {
  if (hasUpstash()) {
    const redis = getRedis();
    const value = await redis.get(key);
    if (value == null) return fallback();
    if (typeof value === 'string') {
      try {
        return JSON.parse(value);
      } catch {
        return fallback();
      }
    }
    return value;
  }

  ensureDir();
  if (!fs.existsSync(filePath)) {
    const data = fallback();
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return data;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback();
  }
}

async function setJson(key, filePath, data) {
  if (hasUpstash()) {
    const redis = getRedis();
    await redis.set(key, data);
    return data;
  }
  ensureDir();
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
  return data;
}

async function loadWallet(fallback) {
  return getJson(WALLET_KEY, WALLET_FILE, fallback);
}

async function saveWallet(state) {
  return setJson(WALLET_KEY, WALLET_FILE, state);
}

async function loadWebhooks(fallback = () => []) {
  const data = await getJson(WEBHOOKS_KEY, WEBHOOKS_FILE, fallback);
  return Array.isArray(data) ? data : [];
}

async function saveWebhooks(items) {
  return setJson(WEBHOOKS_KEY, WEBHOOKS_FILE, items);
}

module.exports = {
  backendName,
  hasUpstash,
  loadWallet,
  saveWallet,
  loadWebhooks,
  saveWebhooks,
};
