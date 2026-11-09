'use strict';

const fs = require('fs');
const path = require('path');

const { hashSecret, b62 } = require('./util');

/**
 * Persistance JSON atomique (écriture tmp + rename : jamais de fichier
 * à moitié écrit en cas de crash).
 *
 * Structure de store.json :
 * {
 *   version: 1,
 *   tenants: { [id]: { ..., keys: { [keyId]: key } } },
 *   uploads: { [id]: upload },
 *   usage:   { [tenantId]: { [YYYY-MM]: { bytesIn, bytesOut } } },
 *   webhookQueue: [ events ]
 * }
 *
 * Adapté au lancement (MVP, ~10k uploads actifs) ; migration PostgreSQL
 * prévue (voir SECURITY.md §9).
 */
class Store {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'store.json');
    this.data = null;
  }

  load() {
    if (fs.existsSync(this.file)) {
      let raw;
      let parsed;
      try {
        raw = fs.readFileSync(this.file, 'utf8');
      } catch (err) {
        throw new Error(`store.json illisible : ${err.message}`);
      }
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error('store.json corrompu (JSON invalide)');
      }
      if (!parsed || typeof parsed !== 'object' || typeof parsed.tenants !== 'object') {
        throw new Error('store.json : structure invalide');
      }
      this.data = parsed;
    } else {
      this.data = { version: 1, tenants: {}, uploads: {}, usage: {}, webhookQueue: [] };
      this.save();
    }
    if (!this.data.uploads || typeof this.data.uploads !== 'object') this.data.uploads = {};
    if (!this.data.usage || typeof this.data.usage !== 'object') this.data.usage = {};
    if (!Array.isArray(this.data.webhookQueue)) this.data.webhookQueue = [];
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }

  /** Sauvegarde immédiate (appelée après chaque mutation). */
  touch() {
    this.save();
  }

  flush() {
    this.save();
  }

  initWebhookQueue() {
    if (!Array.isArray(this.data.webhookQueue)) this.data.webhookQueue = [];
    return this.data.webhookQueue;
  }

  // --- tenants ---------------------------------------------------------------

  createTenant(opts) {
    const name = String((opts && opts.name) || '').trim().slice(0, 64);
    if (name.length < 2) throw new Error('Nom de tenant invalide (min 2 caractères)');
    const tenant = {
      id: b62(10),
      name,
      createdAt: new Date().toISOString(),
      // 0 = illimité
      quotaBytesPerMonth: Math.max(0, parseInt(opts.quotaBytesPerMonth, 10) || 0),
      webhookUrl: String((opts && opts.webhookUrl) || '').slice(0, 255),
      webhookSecret: String((opts && opts.webhookSecret) || '') || 'wh_' + b62(32),
      allowedOrigins: (Array.isArray(opts.allowedOrigins) ? opts.allowedOrigins : [])
        .filter((o) => typeof o === 'string' && o.length > 0)
        .map((o) => o.slice(0, 255))
        .slice(0, 20),
      keys: {},
    };
    this.data.tenants[tenant.id] = tenant;
    this.save();
    return tenant;
  }

  getTenant(id) {
    return this.data.tenants[id] || null;
  }

  listTenants() {
    return Object.values(this.data.tenants);
  }

  // --- clés API ----------------------------------------------------------------

  addKey(tenantId, name) {
    const tenant = this.getTenant(tenantId);
    if (!tenant) throw new Error('Tenant introuvable');
    const secret = b62(40);
    const key = {
      id: 'k' + b62(10),
      name: String(name || 'default').slice(0, 64),
      createdAt: new Date().toISOString(),
      revokedAt: null,
      hash: hashSecret(secret),
    };
    tenant.keys[key.id] = key;
    this.save();
    // Le secret complet n'est affiché qu'ici, jamais re-stocké en clair.
    return { key, full: `pk_${key.id}_${secret}` };
  }

  tenantByApiKeyId(keyId) {
    for (const tenant of Object.values(this.data.tenants)) {
      const key = tenant.keys ? tenant.keys[keyId] : null;
      if (key) return { tenant, key };
    }
    return null;
  }

  revokeKey(tenantId, keyId) {
    const tenant = this.getTenant(tenantId);
    const key = tenant && tenant.keys ? tenant.keys[keyId] : null;
    if (!key) return false;
    key.revokedAt = new Date().toISOString();
    this.save();
    return true;
  }

  listKeys(tenantId) {
    const tenant = this.getTenant(tenantId);
    if (!tenant || !tenant.keys) return [];
    return Object.values(tenant.keys).map((k) => ({
      id: k.id,
      name: k.name,
      createdAt: k.createdAt,
      revokedAt: k.revokedAt,
    }));
  }

  // --- uploads -----------------------------------------------------------------

  createUpload(tenantId, plikUpload, expiresAt, ttl, oneShot) {
    const upload = {
      id: plikUpload.id,
      tenantId,
      plikToken: plikUpload.token,
      status: 'active',
      createdAt: new Date().toISOString(),
      expiresAt,
      ttl,
      oneShot: !!oneShot,
      files: {},
      share: {},
      bytesIn: 0,
      bytesOut: 0,
      widgetTokenHash: null,
      notifiedEvents: {},
    };
    this.data.uploads[upload.id] = upload;
    this.save();
    return upload;
  }

  getUpload(id) {
    return this.data.uploads[id] || null;
  }

  listActiveUploads() {
    return Object.values(this.data.uploads).filter((u) => u.status === 'active');
  }

  /** Purge des uploads inactifs de plus de 7 jours (tenue du fichier). */
  purgeOldUploads(maxAgeMs) {
    const cutoff = Date.now() - maxAgeMs;
    let n = 0;
    for (const [id, u] of Object.entries(this.data.uploads)) {
      if (u.status !== 'active' && new Date(u.expiresAt).getTime() < cutoff) {
        delete this.data.uploads[id];
        n++;
      }
    }
    if (n > 0) this.save();
    return n;
  }

  // --- usage mensuel --------------------------------------------------------------

  usage(tenantId) {
    const month = new Date().toISOString().slice(0, 7);
    const u = (this.data.usage[tenantId] || {})[month];
    return {
      bytesIn: (u && u.bytesIn) || 0,
      bytesOut: (u && u.bytesOut) || 0,
    };
  }

  addUsage(tenantId, bytesIn, bytesOut) {
    const month = new Date().toISOString().slice(0, 7);
    if (!this.data.usage[tenantId]) this.data.usage[tenantId] = {};
    if (!this.data.usage[tenantId][month]) {
      this.data.usage[tenantId][month] = { bytesIn: 0, bytesOut: 0 };
    }
    this.data.usage[tenantId][month].bytesIn += bytesIn || 0;
    this.data.usage[tenantId][month].bytesOut += bytesOut || 0;
  }
}

module.exports = { Store };
