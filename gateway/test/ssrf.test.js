'use strict';

/**
 * Tests SSRF + livraison webhooks :
 *  - validateWebhookUrl (lookup DNS injecté, sans réseau)
 *  - postWebhook / deliver : signature HMAC, tentatives et abandon
 * Aucune dépendance npm : node:test + serveur HTTP local.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { validateWebhookUrl, postWebhook, deliver } = require('../src/webhooks');
const { Store } = require('../src/store');
const { hmac } = require('../src/util');

// lookup factice : résout selon une table locale, sans réseau.
// dns.lookup(host, {all:true}) retourne un tableau d'adresses.
function fakeLookup(table) {
  return async (host) => [{ address: table[host] || '1.2.3.4', family: 4 }];
}

const PUB = fakeLookup({ 'ok.example.com': '93.184.216.34' });

test('validateWebhookUrl : HTTPS obligatoire', async () => {
  const r = await validateWebhookUrl('http://ok.example.com/hook', PUB);
  assert.match(r, /HTTPS/i);
});

test('validateWebhookUrl : IP littérale refusée', async () => {
  assert.match(await validateWebhookUrl('https://127.0.0.1/hook', PUB), /IP|litterale/i);
  assert.match(await validateWebhookUrl('https://10.0.0.5/hook', PUB), /IP|litterale/i);
});

test('validateWebhookUrl : localhost et domaines internes refusés', async () => {
  assert.match(await validateWebhookUrl('https://localhost/hook', fakeLookup({ localhost: '127.0.0.1' })), /interdit|privee/i);
  assert.match(await validateWebhookUrl('https://svc.internal/hook', PUB), /interdit/i);
  assert.match(await validateWebhookUrl('https://nas.local/hook', PUB), /interdit/i);
});

test('validateWebhookUrl : port non-443 refusé', async () => {
  assert.match(await validateWebhookUrl('https://ok.example.com:8443/hook', PUB), /port/i);
});

test('validateWebhookUrl : domaine résolvant en IP privée refusé (SSRF DNS)', async () => {
  const r = await validateWebhookUrl('https://rebind.example.com/hook', fakeLookup({ 'rebind.example.com': '192.168.1.10' }));
  assert.match(r, /privee|interdite/i);
});

test('validateWebhookUrl : URL valide acceptée', async () => {
  assert.equal(await validateWebhookUrl('https://ok.example.com/hook', PUB), null);
  assert.equal(await validateWebhookUrl('https://ok.example.com/hook', PUB), null);
});

test('validateWebhookUrl : URL invalide', async () => {
  assert.match(await validateWebhookUrl('pas une url', PUB), /invalide/i);
});

// ---------------------------------------------------------------------------
// Livraison : serveur récepteur local + validate injecté (no-op)
// ---------------------------------------------------------------------------

function startReceiver() {
  const received = [];
  let failNext = false;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      received.push({
        path: req.url,
        eventId: req.headers['x-saas-event-id'],
        signature: req.headers['x-saas-signature'],
        body,
      });
      if (failNext) {
        res.writeHead(500);
        res.end('ko');
      } else {
        res.writeHead(200);
        res.end('ok');
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        received,
        failOnce() {
          failNext = true;
        },
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function tmpStoreWithWebhookTenant(url) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pliksaas-wh-'));
  const store = new Store(dir);
  store.load();
  const tenant = store.createTenant({ name: 'WH', webhookUrl: url });
  return { store, tenant, dir };
}

const noopValidate = async () => null; // bypass validation (test local http)

test('deliver : POST signé HMAC correct côté récepteur', async () => {
  const rcv = await startReceiver();
  const { store, tenant } = tmpStoreWithWebhookTenant('http://127.0.0.1:' + rcv.port + '/hook');

  const entry = {
    id: 'evt_sig1',
    type: 'file.uploaded',
    tenantId: tenant.id,
    body: JSON.stringify({ type: 'file.uploaded', data: { ok: true } }),
    attempts: 0,
    nextAttemptAt: 0,
  };

  const ok = await deliver(store, entry, { validate: noopValidate });
  assert.equal(ok, true, 'la livraison doit réussir');

  assert.equal(rcv.received.length, 1);
  const r = rcv.received[0];
  assert.equal(r.eventId, 'evt_sig1');
  // La signature doit être le HMAC-SHA256 du corps avec le secret du tenant
  const expected = 'sha256=' + hmac(tenant.webhookSecret, r.body.toString('utf8'));
  assert.equal(r.signature, expected);

  await rcv.close();
});

test('deliver : échec 500 → false (retentative prévue par la file)', async () => {
  const rcv = await startReceiver();
  const { store, tenant } = tmpStoreWithWebhookTenant('http://127.0.0.1:' + rcv.port + '/hook');

  rcv.failOnce();
  const entry = {
    id: 'evt_err1',
    type: 'file.downloaded',
    tenantId: tenant.id,
    body: '{}',
    attempts: 0,
    nextAttemptAt: 0,
  };
  const ok = await deliver(store, entry, { validate: noopValidate });
  assert.equal(ok, false, 'un 500 doit déclencher une retentative');
  assert.equal(rcv.received.length, 1);
  await rcv.close();
});

test('deliver : tenant sans webhook → abandon silencieux', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pliksaas-wh2-'));
  const store = new Store(dir);
  store.load();
  const tenant = store.createTenant({ name: 'NoWH' }); // pas de webhookUrl
  const ok = await deliver(store, { id: 'e', tenantId: tenant.id, body: '{}', attempts: 0, nextAttemptAt: 0 });
  assert.equal(ok, true); // abandon sans erreur
});

test('postWebhook : timeout court → false (pas de blocage)', async () => {
  const server = http.createServer(() => {
    // ne répond jamais
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const ok = await postWebhook('http://127.0.0.1:' + port + '/hook', 'secret', 'evt_x', '{}', 300);
  assert.equal(ok, false);
  server.close();
});

test('isPrivateIp : plages connues', () => {
  const { isPrivateIp } = require('../src/webhooks');
  assert.equal(isPrivateIp('127.0.0.1'), true);
  assert.equal(isPrivateIp('10.1.2.3'), true);
  assert.equal(isPrivateIp('192.168.0.1'), true);
  assert.equal(isPrivateIp('169.254.1.1'), true); // metadata cloud
  assert.equal(isPrivateIp('::1'), true);
  assert.equal(isPrivateIp('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateIp('93.184.216.34'), false);
  assert.equal(isPrivateIp('8.8.8.8'), false);
});
