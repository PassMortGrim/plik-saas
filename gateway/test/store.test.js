'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Store } = require('../src/store');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pliksaas-store-'));
  const store = new Store(dir);
  store.load();
  return { store, dir };
}

test('createTenant + addKey : formats et isolation', () => {
  const { store } = tmpStore();
  const t1 = store.createTenant({ name: 'Client A', quotaBytesPerMonth: 1000 });
  const t2 = store.createTenant({ name: 'Client B' });

  assert.equal(t1.id.length, 10);
  assert.equal(t1.quotaBytesPerMonth, 1000);
  assert.equal(t2.quotaBytesPerMonth, 0); // 0 = illimité

  const k1 = store.addKey(t1.id, 'prod');
  assert.match(k1.full, /^pk_k[A-Za-z0-9]{10}_[A-Za-z0-9]{40}$/);

  const found = store.tenantByApiKeyId(k1.key.id);
  assert.ok(found);
  assert.equal(found.tenant.id, t1.id);
  assert.equal(found.key.revokedAt, null);
});

test('revokeKey : révoquée puis introuvable côté auth', () => {
  const { store } = tmpStore();
  const t = store.createTenant({ name: 'Rev' });
  const k = store.addKey(t.id);
  assert.equal(store.revokeKey(t.id, k.key.id), true);
  const found = store.tenantByApiKeyId(k.key.id);
  assert.ok(found.key.revokedAt, 'la clé doit être marquée révoquée');
  assert.equal(store.revokeKey(t.id, 'kinconnu'), false);
});

test('usage mensuel : cumul par tenant, isolé', () => {
  const { store } = tmpStore();
  const t1 = store.createTenant({ name: 'U1' });
  const t2 = store.createTenant({ name: 'U2' });
  store.addUsage(t1.id, 500, 100);
  store.addUsage(t1.id, 200, 50);
  store.addUsage(t2.id, 10, 0);
  assert.equal(store.usage(t1.id).bytesIn, 700);
  assert.equal(store.usage(t1.id).bytesOut, 150);
  assert.equal(store.usage(t2.id).bytesIn, 10);
});

test('uploads : création, liste active, purge des anciens', () => {
  const { store } = tmpStore();
  const t = store.createTenant({ name: 'Up' });

  const u1 = store.createUpload(t.id, { id: 'up1', token: 'tok1' }, new Date(Date.now() + 3600e3).toISOString(), 3600, false);
  assert.equal(store.getUpload('up1').id, 'up1');
  assert.equal(store.listActiveUploads().length, 1);

  // expiré depuis longtemps, inactif → purgé
  store.createUpload(t.id, { id: 'up2', token: 'tok2' }, new Date(Date.now() - 30 * 24 * 3600e3).toISOString(), 3600, false);
  store.getUpload('up2').status = 'expired';
  const purged = store.purgeOldUploads(7 * 24 * 3600 * 1000);
  assert.equal(purged, 1);
  assert.equal(store.getUpload('up2'), null);
  assert.equal(store.getUpload('up1').id, 'up1'); // actif conservé
  assert.equal(u1.status, 'active');
});

test('webhookQueue + persistance save/load', () => {
  const { store, dir } = tmpStore();
  const t = store.createTenant({ name: 'W', webhookUrl: 'https://example.com/hook' });
  store.addKey(t.id);

  // simuler un événement en file
  const q = store.initWebhookQueue();
  q.push({ id: 'evt_x', type: 'file.uploaded', tenantId: t.id, body: '{}', attempts: 0, nextAttemptAt: 0 });
  store.touch();
  assert.equal(store.data.webhookQueue.length, 1);

  // rechargement depuis le disque
  const store2 = new Store(dir);
  store2.load();
  assert.equal(store2.listTenants().length, 1);
  assert.equal(store2.listTenants()[0].name, 'W');
  assert.equal(store2.data.webhookQueue.length, 1);
  assert.equal(store2.data.webhookQueue[0].type, 'file.uploaded');
  assert.ok(store2.tenantByApiKeyId(Object.keys(store2.getTenant(t.id).keys)[0]));
});
