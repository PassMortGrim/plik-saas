'use strict';

/**
 * Tests d'intégration : passerelle réelle + stub Plik (API 1.4.x).
 * Couvre : AUTH (clés API, jetons widget, admin), QUOTA, ONESHOT, janitor.
 *
 * NB : uploadLimiter = 2/s, burst 4 par tenant → chaque test utilise un
 * tenant frais et reste sous 4 créations d'upload.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const { StubPlik, bootGateway, jsonFetch, sleep } = require('./helpers');

// ⚠️ NE JAMAIS require('../src/*') au niveau du fichier ici :
// config.js lit process.env au chargement du module, or l'environnement
// de test (PLIK_URL, ADMIN_TOKEN, ports éphémères) n'est fixé que dans
// bootGateway(). Un require prématuré verrouillerait les valeurs par
// défaut (plik:8080) et chaque appel amont échouerait lentement en DNS.
// → les modules src sont require() au besoin DANS les tests (janitor).

let stub;
let gw;

// Filet de sécurité CI : si une promesse attendue ne résout jamais
// (socket zombie, flux non terminé, handler muet), abandonner après
// 60 s avec un message clair plutôt que laisser le job expirer (10 min).
const watchdog = setTimeout(() => {
  console.error('\n[WATCHDOG] Suite bloquée depuis 60 s. Handles actifs :');
  try {
    for (const h of process._getActiveHandles()) {
      const name = h.constructor && h.constructor.name ? h.constructor.name : typeof h;
      const extra = [
        h.fd !== undefined ? 'fd=' + h.fd : '',
        h.remoteAddress ? 'vers ' + h.remoteAddress + ':' + h.remotePort : '',
      ].filter(Boolean).join(' ');
      let addr = '';
      try {
        if (h.address && h.listening) addr = 'ecoute ' + JSON.stringify(h.address());
      } catch { /* best effort */ }
      console.error('  - ' + name + (extra ? ' (' + extra + ')' : '') + (addr ? ' [' + addr + ']' : ''));
    }
  } catch { /* best effort */ }
  process.exit(1);
}, 60000);

before(async () => {
  stub = new StubPlik();
  await stub.start();
  gw = await bootGateway(stub.port);
});

after(async () => {
  await gw.stop();
  await stub.stop();
  clearTimeout(watchdog);
});

// --- helpers --------------------------------------------------------------

function newTenant(opts = {}) {
  const name = 'T-' + Math.random().toString(36).slice(2, 9);
  const tenant = gw.store.createTenant(Object.assign({ name }, opts));
  const key = gw.store.addKey(tenant.id, 'test');
  return { tenant, apiKey: key.full, keyId: key.key.id };
}

async function createUpload(apiKey, body) {
  return jsonFetch(gw.baseUrl + '/v1/uploads', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body || { filename: 'test.txt', size: 16, ttl: 3600 }),
  });
}

async function addFile(headers, uploadId, content) {
  return jsonFetch(gw.baseUrl + '/v1/uploads/' + uploadId + '/files', {
    method: 'POST',
    headers: Object.assign(
      {
        'X-Filename': 'data.bin',
        'X-File-Size': String(content.length),
        'Content-Type': 'application/octet-stream',
      },
      headers
    ),
    body: content,
  });
}

async function createLink(headers, uploadId, fileId) {
  return jsonFetch(gw.baseUrl + '/v1/uploads/' + uploadId + '/links', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
    body: JSON.stringify({ fileId }),
  });
}

// ===========================================================================
// AUTH
// ===========================================================================

test('AUTH : 401 sans Authorization', async () => {
  const r = await createUpload('', {});
  assert.equal(r.status, 401);
});

test('AUTH : 401 format invalide', async () => {
  const r = await createUpload('pasuneclé', {});
  assert.equal(r.status, 401);
  const r2 = await createUpload('pk_mauvais_format', {});
  assert.equal(r2.status, 401);
});

test('AUTH : 401 mauvais secret (clé existante)', async () => {
  const { apiKey } = newTenant();
  const parts = apiKey.split('_');
  const forged = parts[0] + '_' + parts[1] + '_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const r = await createUpload(forged, {});
  assert.equal(r.status, 401);
});

test('AUTH : 401 clé révoquée', async () => {
  const t = newTenant();
  gw.store.revokeKey(t.tenant.id, t.keyId);
  const r = await createUpload(t.apiKey, {});
  assert.equal(r.status, 401);
});

test('AUTH : clé valide → 201 + widgetToken au format wt_', async () => {
  const t = newTenant();
  const r = await createUpload(t.apiKey, { filename: 'ok.txt', size: 10, ttl: 3600 });
  assert.equal(r.status, 201);
  assert.ok(r.body.uploadId);
  assert.match(r.body.widgetToken, /^wt_[A-Za-z0-9]+_[A-Za-z0-9]{40}$/);
  assert.ok(r.body.expiresAt);
});

test('AUTH : cross-tenant → 403', async () => {
  const a = newTenant();
  const b = newTenant();
  const up = await createUpload(a.apiKey, { filename: 'a.txt', size: 10 });
  assert.equal(up.status, 201);
  const r = await jsonFetch(gw.baseUrl + '/v1/uploads/' + up.body.uploadId, {
    headers: { Authorization: 'Bearer ' + b.apiKey },
  });
  assert.equal(r.status, 403);
});

test('AUTH : jeton widget valide → 200 ; jeton d un autre upload → 401', async () => {
  const t = newTenant();
  const u1 = await createUpload(t.apiKey, { filename: 'u1.txt', size: 10 });
  const u2 = await createUpload(t.apiKey, { filename: 'u2.txt', size: 10 });
  assert.equal(u1.status, 201);
  assert.equal(u2.status, 201);

  // wt de u1 sur u1 → 200
  const ok = await jsonFetch(gw.baseUrl + '/v1/uploads/' + u1.body.uploadId, {
    headers: { 'X-Widget-Token': u1.body.widgetToken },
  });
  assert.equal(ok.status, 200);

  // wt de u2 utilisé sur u1 → 401 (jeton lié à l'upload)
  const ko = await jsonFetch(gw.baseUrl + '/v1/uploads/' + u1.body.uploadId, {
    headers: { 'X-Widget-Token': u2.body.widgetToken },
  });
  assert.equal(ko.status, 401);
});

test('AUTH : admin localhost — 401 sans token, 401 mauvais, 200 bon', async () => {
  const no = await jsonFetch(gw.adminUrl + '/health');
  assert.equal(no.status, 401);
  const bad = await jsonFetch(gw.adminUrl + '/health', {
    headers: { 'X-Admin-Token': 'x'.repeat(48) },
  });
  assert.equal(bad.status, 401);
  const ok = await jsonFetch(gw.adminUrl + '/health', {
    headers: { 'X-Admin-Token': gw.adminToken },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'ok');
});

// ===========================================================================
// QUOTA
// ===========================================================================

test('QUOTA : taille > quota → 402 + événement quota.exceeded en file', async () => {
  const t = newTenant({
    quotaBytesPerMonth: 1000,
    webhookUrl: 'https://example.com/hook',
  });
  const r = await createUpload(t.apiKey, { filename: 'big.bin', size: 2000 });
  assert.equal(r.status, 402);
  assert.equal(r.body.quotaBytesPerMonth, 1000);

  const q = gw.store.data.webhookQueue;
  const evt = q.find((e) => e.type === 'quota.exceeded');
  assert.ok(evt, 'quota.exceeded doit être empilé');
  assert.equal(evt.tenantId, t.tenant.id);
});

test('QUOTA : usage cumulé puis blocage au dépassement', async () => {
  const t = newTenant({ quotaBytesPerMonth: 250 });
  const u1 = await createUpload(t.apiKey, { filename: 'a.bin', size: 100 });
  assert.equal(u1.status, 201);
  const f = await addFile({ Authorization: 'Bearer ' + t.apiKey }, u1.body.uploadId, 'x'.repeat(100));
  assert.equal(f.status, 201);
  assert.equal(gw.store.usage(t.tenant.id).bytesIn, 100);

  // reste 150 : une demande de 200 → 402
  const u2 = await createUpload(t.apiKey, { filename: 'b.bin', size: 200 });
  assert.equal(u2.status, 402);
});

// ===========================================================================
// ONESHOT
// ===========================================================================

test('ONESHOT : 1er téléchargement 200 compté, 2e → 410, event unique', async () => {
  const t = newTenant({ webhookUrl: 'https://example.com/hook' });
  const up = await createUpload(t.apiKey, {
    filename: 'secret.bin',
    size: 1024,
    ttl: 3600,
    oneShot: true,
  });
  assert.equal(up.status, 201);
  assert.equal(up.body.oneShot, true);

  const content = 'S'.repeat(1024);
  const f = await addFile({ Authorization: 'Bearer ' + t.apiKey }, up.body.uploadId, content);
  assert.equal(f.status, 201);
  const fileId = f.body.fileId;

  const link = await createLink({ Authorization: 'Bearer ' + t.apiKey }, up.body.uploadId, fileId);
  assert.equal(link.status, 201);

  // Path+query du lien signé, rappelés sur le serveur de test
  const u = new URL(link.body.url);
  const local = gw.baseUrl + u.pathname + u.search;

  // 1er GET : 200, contenu intact
  const d1 = await fetch(local);
  assert.equal(d1.status, 200);
  const body = await d1.text();
  assert.equal(body, content);
  await sleep(150); // laisser le close-handler compter

  const upload = gw.store.getUpload(up.body.uploadId);
  assert.equal(upload.bytesOut, 1024);
  assert.ok(upload.notifiedEvents['downloaded:' + fileId], 'marqueur anti-doublon posé');

  const q = gw.store.data.webhookQueue;
  const events = q.filter((e) => e.type === 'file.downloaded' && e.tenantId === t.tenant.id);
  assert.equal(events.length, 1, 'exactement un événement file.downloaded');

  // 2e GET : OneShot consommé côté Plik (404 amont) → 410 passerelle
  const d2 = await fetch(local);
  assert.equal(d2.status, 410);
});

test('ONESHOT : interrompu non compté en facturation, mais consommé en amont (Plik réel)', async () => {
  const t = newTenant();
  const up = await createUpload(t.apiKey, {
    filename: 'large.bin',
    size: 8 * 1024 * 1024,
    ttl: 3600,
    oneShot: true,
  });
  const content = 'L'.repeat(8 * 1024 * 1024);
  const f = await addFile({ Authorization: 'Bearer ' + t.apiKey }, up.body.uploadId, content);
  const link = await createLink({ Authorization: 'Bearer ' + t.apiKey }, up.body.uploadId, f.body.fileId);
  const u = new URL(link.body.url);
  const local = gw.baseUrl + u.pathname + u.search;

  // Client qui interrompt juste après les en-têtes
  await new Promise((resolve, reject) => {
    const req = http.get(local, (res) => {
      assert.equal(res.statusCode, 200);
      res.destroy(); // interruption immédiate
      resolve();
    });
    req.on('error', () => resolve());
  });
  await sleep(300);

  // Facturation : un flux interrompu n'est PAS compté côté passerelle
  const upload = gw.store.getUpload(up.body.uploadId);
  assert.equal(upload.bytesOut, 0, 'un flux interrompu ne doit pas être compté');
  assert.equal(upload.notifiedEvents['downloaded:' + f.body.fileId], undefined);

  // Sémantique Plik réelle (server/handlers/get_file.go) : le GET marque
  // le fichier OneShot Removed DÈS LE DÉBUT de la requête, interruption
  // ou pas → le 2e GET renvoie 404 amont → 410 passerelle. Une
  // interruption ne peut pas « préserver » un OneShot.
  const d = await fetch(local);
  assert.equal(d.status, 410);
});

// ===========================================================================
// JANITOR
// ===========================================================================

test('JANITOR : TTL écoulé → expired + purge Plik + event ; 404 amont toléré', async () => {
  // require() tardifs : l'environnement (PLIK_URL, ADMIN_TOKEN...) est
  // déjà fixé par bootGateway() → config.js est chargée avec les bonnes valeurs.
  const { sweepOnce } = require('../src/janitor');
  const { PlikClient } = require('../src/plik');

  const t = newTenant({ webhookUrl: 'https://example.com/hook' });
  const plik = new PlikClient('http://127.0.0.1:' + stub.port);

  // Upload présent côté Plik
  stub.uploads.set('jan1', {
    id: 'jan1',
    uploadToken: 'tok_jan1',
    oneShot: false,
    files: new Map(),
  });
  gw.store.createUpload(
    t.tenant.id,
    { id: 'jan1', token: 'tok_jan1' },
    new Date(Date.now() - 1000).toISOString(), // déjà expiré
    60,
    false
  );

  await sweepOnce(gw.store, plik);

  assert.equal(gw.store.getUpload('jan1').status, 'expired');
  assert.equal(stub.uploads.has('jan1'), false, 'upload purgé côté Plik');
  assert.ok(
    gw.store.data.webhookQueue.some((e) => e.type === 'upload.expired'),
    'event upload.expired émis'
  );

  // Upload absent côté Plik (404) : sweep ne doit pas lever
  gw.store.createUpload(
    t.tenant.id,
    { id: 'jan_ghost', token: 'tok_ghost' },
    new Date(Date.now() - 2000).toISOString(),
    60,
    false
  );
  await sweepOnce(gw.store, plik);
  assert.equal(gw.store.getUpload('jan_ghost').status, 'expired');
});

// ===========================================================================
// SANITY : health public + upload complet bout-en-bout (non oneShot)
// ===========================================================================

test('SANITY : flux complet — upload, fichier, lien, téléchargement', async () => {
  const h = await jsonFetch(gw.baseUrl + '/v1/health');
  assert.equal(h.status, 200);

  const t = newTenant();
  const up = await createUpload(t.apiKey, { filename: 'rapport.zip', size: 64 });
  const f = await addFile({ Authorization: 'Bearer ' + t.apiKey }, up.body.uploadId, 'Z'.repeat(64));
  assert.equal(f.status, 201);
  const link = await createLink({ Authorization: 'Bearer ' + t.apiKey }, up.body.uploadId, f.body.fileId);
  const u = new URL(link.body.url);
  const d = await fetch(gw.baseUrl + u.pathname + u.search);
  assert.equal(d.status, 200);
  assert.equal(await d.text(), 'Z'.repeat(64));
  assert.equal(gw.store.usage(t.tenant.id).bytesIn, 64);
});
