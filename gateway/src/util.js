'use strict';

const crypto = require('crypto');

/**
 * Utilitaires communs : jetons, scrypt, HMAC, rate limiting, JSON, assainissement.
 *
 * Formats de jetons (secrets 40 chars base62, CSPRNG) :
 *   pk_<keyId>_<secret>              clé API (tenant)
 *   wt_<uploadId>_<secret>           jeton widget (un seul upload)
 *   dl_<uploadId>.<fileId>_<secret>   lien de téléchargement signé
 *   wh_<secret>                      secret webhook (interne tenant)
 */

const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Chaîne aléatoire base62 (crypto.randomInt = CSPRNG). */
function b62(len) {
  let out = '';
  for (let i = 0; i < len; i++) out += B62[crypto.randomInt(B62.length)];
  return out;
}

/**
 * Parse "prefix_<id>_<secret>". L'id peut contenir des points (jetons dl),
 * le secret jamais de underscore. Retourne { id, secret } ou null.
 */
function parseToken(prefix, raw) {
  if (typeof raw !== 'string' || raw.length > 512) return null;
  const p = prefix + '_';
  if (!raw.startsWith(p)) return null;
  const rest = raw.slice(p.length);
  const idx = rest.lastIndexOf('_');
  if (idx < 1) return null;
  const id = rest.slice(0, idx);
  const secret = rest.slice(idx + 1);
  if (!id || secret.length < 20) return null;
  return { id, secret };
}

// --- scrypt (clés et jetons) ------------------------------------------------

const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 };
const KEY_LEN = 32;

/** Hash stocké au format "scrypt:<salt>:<hash>" (jamais le secret en clair). */
function hashSecret(secret) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(secret), salt, KEY_LEN, SCRYPT_OPTS).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function timingSafeEqualHex(a, b) {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && ba.length > 0 && crypto.timingSafeEqual(ba, bb);
}

/** Vérifie un secret contre son hash scrypt (comparaison à temps constant). */
function verifySecret(secret, stored) {
  if (typeof stored !== 'string' || !stored) return false;
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const calc = crypto.scryptSync(String(secret), parts[1], KEY_LEN, SCRYPT_OPTS).toString('hex');
  return timingSafeEqualHex(calc, parts[2]);
}

/** HMAC-SHA256 hex (signature des webhooks). */
function hmac(secret, data) {
  return crypto.createHmac('sha256', String(secret)).update(String(data)).digest('hex');
}

// --- rate limiting (token bucket par clé) -----------------------------------

class RateLimiter {
  constructor(ratePerSecond, burst) {
    this.rate = ratePerSecond;
    this.burst = burst;
    this.buckets = new Map();
  }

  allow(key) {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size > 10000) this.prune(now);
      b = { tokens: this.burst, ts: now };
      this.buckets.set(key, b);
    }
    const refill = ((now - b.ts) / 1000) * this.rate;
    b.tokens = Math.min(this.burst, b.tokens + refill);
    b.ts = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return true;
    }
    return false;
  }

  prune(now) {
    for (const [k, b] of this.buckets) {
      if (now - b.ts > 600000) this.buckets.delete(k);
    }
  }
}

// --- corps JSON ------------------------------------------------------------

/** Lit et parse un corps JSON avec limite de taille. {} si corps vide. */
async function readJson(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const err = new Error('Corps trop volumineux');
      err.status = 400;
      throw err;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const err = new Error('JSON invalide');
    err.status = 400;
    throw err;
  }
}

// --- assainissement ----------------------------------------------------------

/**
 * Nom de fichier sûr : décode l'URL-encoding, supprime les chemins,
 * les caractères de contrôle et les séparateurs d'en-tête (CRLF).
 */
function sanitizeFilename(name) {
  let n = String(name || 'file');
  try {
    if (/%[0-9A-Fa-f]{2}/.test(n)) n = decodeURIComponent(n);
  } catch {
    /* encodage invalide : on continue sur la valeur brute assainie */
  }
  n = n.replace(/[\r\n\x00-\x1f\x7f]/g, '_'); // contrôle + CRLF
  n = n.split(/[\\/]/).pop() || 'file'; // traversée de répertoire
  n = n.replace(/["';]/g, '_'); // injection d'en-tête
  n = n.replace(/^\.+/, ''); // fichiers cachés .git etc.
  n = n.trim().slice(0, 128);
  return n.length > 0 ? n : 'file';
}

// --- divers ------------------------------------------------------------------

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.length > 0) {
    return xf.split(',')[0].trim().slice(0, 45); // Caddy ajoute l'IP réelle
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function fmtBytes(n) {
  const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let v = Number(n) || 0;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

module.exports = {
  b62,
  parseToken,
  hashSecret,
  verifySecret,
  hmac,
  RateLimiter,
  readJson,
  sanitizeFilename,
  clientIp,
  fmtBytes,
};
