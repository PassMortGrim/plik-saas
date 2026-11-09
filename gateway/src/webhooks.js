'use strict';

const dns = require('dns');
const { promisify } = require('util');

const cfg = require('./config');
const { hmac, b62 } = require('./util');

const dnsLookup = promisify(dns.lookup);

/**
 * Webhooks sortants : file persistante (store.json) + livraison signée HMAC.
 *
 * Anti-SSRF : URL HTTPS obligatoire, nom de domaine public uniquement
 * (pas d'IP littérale), résolution DNS vérifiée contre les plages privées.
 */

const BACKOFF_MS = [30e3, 120e3, 600e3, 3600e3]; // 30 s → 2 min → 10 min → 1 h

function isPrivateIp(ip) {
  if (ip.includes(':')) {
    const lower = ip.toLowerCase();
    return (
      lower === '::1' ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      lower.startsWith('fe80') ||
      lower.startsWith('::ffff:127.')
    );
  }
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
  const [a, b] = parts;
  return (
    a === 127 || // loopback
    a === 10 || // privé
    a === 0 ||
    (a === 172 && b >= 16 && b <= 31) || // privé
    (a === 192 && b === 168) || // privé
    (a === 169 && b === 254) || // link-local (metadata cloud)
    a >= 224 // multicast / réservé
  );
}

/** Retourne null si l'URL est acceptable, sinon la raison du refus. */
async function validateWebhookUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return 'URL invalide';
  }
  if (u.protocol !== 'https:') return 'HTTPS obligatoire';
  if (u.username || u.password) return 'Identifiants dans l URL interdits';
  if (u.port && u.port !== '443') return 'Seul le port 443 est autorisé';
  const host = u.hostname.toLowerCase();
  if (/^[0-9.]+$/.test(host)) return 'Nom de domaine requis (pas d IP litterale)';
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    return 'Hote local interdit';
  }
  let records;
  try {
    records = await dnsLookup(host, { all: true });
  } catch {
    return 'Nom de domaine non resoluble';
  }
  if (records.length === 0) return 'Nom de domaine non resoluble';
  for (const r of records) {
    if (isPrivateIp(r.address)) return `IP privee interdite (${r.address})`;
  }
  return null;
}

/**
 * Empile un événement pour le tenant (silencieux si pas de webhookUrl).
 * Retourne l'entrée de file ou null.
 */
function emit(store, tenant, type, data) {
  if (!tenant || !tenant.webhookUrl) return null;
  const queue = store.initWebhookQueue();
  const id = 'evt_' + b62(16);
  const body = JSON.stringify({
    id,
    type,
    createdAt: new Date().toISOString(),
    tenantId: tenant.id,
    data,
  });
  const entry = {
    id,
    type,
    tenantId: tenant.id,
    body,
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: new Date().toISOString(),
  };
  queue.push(entry);
  store.touch();
  return entry;
}

/** Livre un événement. true = succès (ou abandon définitif), false = retenter. */
async function deliver(store, entry) {
  const tenant = store.getTenant(entry.tenantId);
  if (!tenant || !tenant.webhookUrl || !tenant.webhookSecret) {
    return true; // tenant supprimé / webhook retiré : abandon silencieux
  }
  const reason = await validateWebhookUrl(tenant.webhookUrl);
  if (reason) {
    console.warn(`[webhook] ${tenant.id} : URL refusee (${reason}) — abandon de ${entry.id}`);
    return true; // configuration invalide : inutile de retenter
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.webhookTimeoutMs);
  try {
    const res = await fetch(tenant.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Saas-Event-Id': entry.id,
        'X-Saas-Signature': 'sha256=' + hmac(tenant.webhookSecret, entry.body),
      },
      body: entry.body,
      signal: controller.signal,
    });
    return res.ok; // 2xx = livré
  } catch {
    return false; // timeout / réseau : retenter
  } finally {
    clearTimeout(timer);
  }
}

/** Boucle de traitement (appelée toutes les 5 s par index.js). */
async function processQueue(store) {
  const queue = store.initWebhookQueue();
  if (queue.length === 0) return;
  const now = Date.now();
  const remaining = [];

  for (const entry of queue) {
    if (entry.nextAttemptAt > now) {
      remaining.push(entry);
      continue;
    }
    let ok;
    try {
      ok = await deliver(store, entry);
    } catch (err) {
      console.error(`[webhook] ${entry.id} : ${err.message}`);
      ok = false;
    }
    if (ok) continue; // livré ou abandonné : retiré de la file

    entry.attempts = (entry.attempts || 0) + 1;
    if (entry.attempts >= cfg.webhookMaxAttempts) {
      console.error(
        `[webhook] Abandon de ${entry.id} (${entry.type}) apres ${entry.attempts} tentatives`
      );
      continue;
    }
    entry.nextAttemptAt =
      now + BACKOFF_MS[Math.min(entry.attempts - 1, BACKOFF_MS.length - 1)];
    remaining.push(entry);
  }

  if (remaining.length !== queue.length) {
    store.data.webhookQueue = remaining;
    store.touch();
  }
}

module.exports = { emit, processQueue, validateWebhookUrl };
