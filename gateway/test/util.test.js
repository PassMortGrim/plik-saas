'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const {
  b62,
  parseToken,
  hashSecret,
  verifySecret,
  hmac,
  RateLimiter,
  readJson,
  sanitizeFilename,
} = require('../src/util');

test('b62 : longueur et alphabet', () => {
  const s = b62(40);
  assert.equal(s.length, 40);
  assert.match(s, /^[A-Za-z0-9]{40}$/);
  const a = b62(10);
  const b = b62(10);
  assert.notEqual(a, b, 'b62 doit être aléatoire');
});

test('parseToken : formats pk / wt / dl', () => {
  const dl = 'dl_upload123.file456_' + b62(40);
  const p = parseToken('dl', dl);
  assert.ok(p);
  assert.equal(p.id, 'upload123.file456');
  assert.equal(p.secret.length, 40);

  const pk = 'pk_kAbC123_' + b62(40);
  const p2 = parseToken('pk', pk);
  assert.ok(p2);
  assert.equal(p2.id, 'kAbC123');
});

test('parseToken : cas invalides', () => {
  assert.equal(parseToken('pk', null), null);
  assert.equal(parseToken('pk', 'wt_k1_' + b62(40)), null); // mauvais préfixe
  assert.equal(parseToken('pk', 'pk_k1_court'), null); // secret < 20 chars
  assert.equal(parseToken('pk', 'pk_k1'), null); // pas de secret
  assert.equal(parseToken('pk', 'pk_' + b62(40)), null); // pas d'id
  assert.equal(parseToken('pk', 'x'.repeat(600)), null); // trop long
});

test('hashSecret / verifySecret : aller-retour et échecs', () => {
  const secret = b62(40);
  const stored = hashSecret(secret);
  assert.match(stored, /^scrypt:[0-9a-f]{32}:[0-9a-f]{64}$/);
  assert.ok(verifySecret(secret, stored));
  assert.equal(verifySecret(b62(40), stored), false); // mauvais secret
  assert.equal(verifySecret(secret, 'scrypt:malformé'), false);
  assert.equal(verifySecret(secret, ''), false);
  assert.equal(verifySecret(secret, null), false);
  // Deux hash du même secret diffèrent (salt aléatoire)
  assert.notEqual(stored, hashSecret(secret));
});

test('hmac : déterministe et dépendant du secret', () => {
  const body = '{"type":"test"}';
  assert.equal(hmac('s1', body), hmac('s1', body));
  assert.notEqual(hmac('s1', body), hmac('s2', body));
  assert.equal(hmac('s1', body).length, 64);
});

test('sanitizeFilename : traversée, CRLF, guillemets, encodage', () => {
  assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
  const crlf = 'a' + String.fromCharCode(13, 10) + 'b';
  assert.equal(sanitizeFilename(crlf), 'a__b'); // pas de CRLF
  assert.equal(sanitizeFilename('fi"le;name.txt'), 'fi_le_name.txt');
  assert.equal(sanitizeFilename('%C3%A9t%C3%A9.txt'), 'été.txt'); // décodage URL
  assert.equal(sanitizeFilename(''), 'file');
  assert.equal(sanitizeFilename(null), 'file');
  assert.equal(sanitizeFilename('.env'), 'env'); // pas de fichier caché
  const long = 'a'.repeat(300);
  assert.equal(sanitizeFilename(long).length, 128); // tronqué
});

test('RateLimiter : burst puis refus', () => {
  const rl = new RateLimiter(0.001, 2); // remplissage quasi nul
  assert.equal(rl.allow('k'), true);
  assert.equal(rl.allow('k'), true);
  assert.equal(rl.allow('k'), false); // burst épuisé
  assert.equal(rl.allow('other'), true); // clé indépendante
});

test('readJson : corps vide, valide, trop gros, invalide', async () => {
  const fakeReq = (chunks) => ({
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  });

  assert.deepEqual(await readJson(fakeReq([]), 1024), {});
  assert.deepEqual(await readJson(fakeReq([Buffer.from('{"a":1}')]), 1024), { a: 1 });

  await assert.rejects(
    readJson(fakeReq([Buffer.alloc(2048)]), 1024),
    (err) => err.status === 400
  );
  await assert.rejects(
    readJson(fakeReq([Buffer.from('pas du json')]), 1024),
    (err) => err.status === 400
  );
});
