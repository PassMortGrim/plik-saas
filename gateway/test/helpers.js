'use strict';

/**
 * Helpers de test : stub Plik (API réelle 1.4.x) + démarrage passerelle.
 * node:test uniquement, zéro dépendance npm.
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Arrêt robuste d'un serveur HTTP : les connexions keep-alive d'undici
 * (fetch) empêchent server.close() de terminer. On ferme les connexions
 * inactives, avec filet de sécurité + timeout.
 */
function stopServer(server) {
  return new Promise((resolve) => {
    if (!server || server.listening === false) return resolve();
    server.close(() => resolve());
    if (server.closeIdleConnections) server.closeIdleConnections();
    const force = setTimeout(() => {
      if (server.closeAllConnections) server.closeAllConnections();
    }, 500);
    const hard = setTimeout(() => resolve(), 1500);
    force.unref();
    hard.unref();
  });
}

// ---------------------------------------------------------------------------
// Stub Plik : implémente exactement l'API utilisée par la passerelle
// (POST /upload, POST /file/{id} multipart, GET /file/{u}/{f}/{name},
//  DELETE /upload/{id}, GET /health).
// ---------------------------------------------------------------------------
class StubPlik {
  constructor(opts = {}) {
    this.uploads = new Map();
    this.maxFileSize = opts.maxFileSize || 0; // 0 = illimité
    this.server = null;
    this.port = 0;
  }

  async start() {
    this.server = http.createServer((req, res) => {
      Promise.resolve(this.handle(req, res)).catch(() => {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
        }
        res.end(JSON.stringify({ message: 'stub error' }));
      });
    });
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = this.server.address().port;
    return this;
  }

  async stop() {
    await stopServer(this.server);
  }

  json(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }

  collect(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  /** Parse minimal d'un multipart (champ "file"), suffisant pour les tests. */
  parseMultipart(body, contentType) {
    const m = /boundary=([^;]+)/i.exec(String(contentType || ''));
    if (!m) return null;
    const sep = Buffer.from('--' + m[1].trim());
    let idx = body.indexOf(sep);
    while (idx !== -1) {
      const next = body.indexOf(sep, idx + sep.length);
      if (next === -1) break;
      const part = body.slice(idx + sep.length, next);
      const hEnd = part.indexOf('\r\n\r\n');
      if (hEnd !== -1) {
        const headers = part.slice(0, hEnd).toString();
        const fn = /filename="([^"]*)"/.exec(headers);
        if (fn) {
          // contenu : après \r\n\r\n, sans le \r\n final précédant la frontière
          return { filename: fn[1], content: part.slice(hEnd + 4, part.length - 2) };
        }
      }
      idx = next;
    }
    return null;
  }

  async handle(req, res) {
    const u = new URL(req.url, 'http://stub');
    const parts = u.pathname.split('/').filter(Boolean);

    if (req.method === 'GET' && u.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK');
      return;
    }

    // POST /upload — création (mêmes champs JSON que Plik)
    if (req.method === 'POST' && u.pathname === '/upload') {
      const j = JSON.parse((await this.collect(req)).toString('utf8'));
      const id = 'u' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
      const upload = {
        id,
        uploadToken: 'tok_' + crypto.randomUUID().replace(/-/g, ''),
        oneShot: !!j.oneShot,
        ttl: j.ttl || 3600,
        stream: !!j.stream,
        files: new Map(),
      };
      this.uploads.set(id, upload);
      this.json(res, 200, {
        id,
        uploadToken: upload.uploadToken,
        oneShot: upload.oneShot,
        ttl: upload.ttl,
        stream: upload.stream,
        files: [],
      });
      return;
    }

    // POST /file/{uploadId} — ajout multipart champ "file"
    if (req.method === 'POST' && parts[0] === 'file' && parts.length === 2) {
      const upload = this.uploads.get(parts[1]);
      if (!upload) return this.json(res, 404, { message: `upload "${parts[1]}" not found` });
      const body = await this.collect(req);
      if (this.maxFileSize > 0 && body.length > this.maxFileSize) {
        // Plik renvoie 400 (et non 413) : "file too big (limit is set to X bytes)"
        return this.json(res, 400, {
          message: `file too big (limit is set to ${this.maxFileSize} bytes)`,
        });
      }
      const part = this.parseMultipart(body, req.headers['content-type']);
      if (!part) return this.json(res, 400, { message: 'multipart form invalid' });
      const fid = 'f' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
      upload.files.set(fid, {
        id: fid,
        fileName: part.filename,
        status: 'uploaded',
        size: part.content.length,
        content: part.content,
      });
      this.json(res, 200, {
        id: fid,
        fileName: part.filename,
        fileSize: part.content.length,
        status: 'uploaded',
        fileMd5: crypto.createHash('md5').update(part.content).digest('hex'),
        fileType: 'application/octet-stream',
        isText: false,
      });
      return;
    }

    // GET /file/{uploadId}/{fileId}/{filename} — téléchargement.
    // OneShot : le GET consomme le fichier DÈS LE DÉBUT de la requête,
    // même si le client interrompt ensuite. C'est le comportement réel de
    // Plik (server/handlers/get_file.go : UpdateFileStatus → FileRemoved
    // AVANT d'écrire le corps ; la purge suit l'envoi, interruption ou non).
    if ((req.method === 'GET' || req.method === 'HEAD') && parts[0] === 'file' && parts.length === 4) {
      const upload = this.uploads.get(parts[1]);
      const file = upload && upload.files.get(parts[2]);
      if (!upload || !file) {
        return this.json(res, 404, { message: `file "${parts[2]}" not found` });
      }
      if (decodeURIComponent(parts[3]) !== file.fileName) {
        return this.json(res, 404, { message: `file "${parts[3]}" not found` });
      }
      if (req.method === 'GET' && upload.oneShot) {
        upload.files.delete(parts[2]);
        if (upload.files.size === 0) this.uploads.delete(upload.id);
      }
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': file.content.length,
      });
      res.end(file.content);
      return;
    }

    // DELETE /upload/{id}
    if (req.method === 'DELETE' && parts[0] === 'upload' && parts.length === 2) {
      if (this.uploads.delete(parts[1])) {
        return this.json(res, 200, { ok: true });
      }
      return this.json(res, 404, { message: `upload "${parts[1]}" not found` });
    }

    this.json(res, 404, { message: 'not found' });
  }
}

// ---------------------------------------------------------------------------
// Démarrage de la passerelle en environnement de test.
// IMPORTANT : fixe process.env AVANT tout require('../src/...') car
// config.js lit l'environnement au chargement du module.
// ---------------------------------------------------------------------------

/**
 * Attend qu'un serveur écoute, SANS course sur l'événement 'listening' :
 * startServers() appelle listen() sur les deux serveurs d'un coup, et
 * pendant qu'on await le premier 'listening', le second a déjà émis le
 * sien — un once('listening') attaché après coup ne le voit jamais.
 * D'où la vérification server.listening AVANT l'attachement.
 */
function waitForListening(server) {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
}

async function bootGateway(plikPort) {
  process.env.ADMIN_TOKEN = crypto.randomBytes(24).toString('hex');
  process.env.PUBLIC_PORT = '0';
  process.env.ADMIN_PORT = '0';
  process.env.PLIK_URL = 'http://127.0.0.1:' + plikPort;
  process.env.PUBLIC_BASE_URL = 'https://test.local';
  process.env.WEBHOOK_TIMEOUT_MS = '2000';
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pliksaas-gw-'));

  const { Store } = require('../src/store');
  const { startServers } = require('../src/server');

  const store = new Store(dataDir);
  store.load();
  const { publicServer, adminServer } = startServers(store);

  // Le binding est asynchrone : attendre l'écoute effective des deux serveurs.
  await waitForListening(publicServer);
  await waitForListening(adminServer);
  const publicPort = publicServer.address().port;
  const adminPort = adminServer.address().port;

  return {
    store,
    dataDir,
    publicPort,
    adminPort,
    adminToken: process.env.ADMIN_TOKEN,
    baseUrl: 'http://127.0.0.1:' + publicPort,
    adminUrl: 'http://127.0.0.1:' + adminPort,
    async stop() {
      await stopServer(publicServer);
      await stopServer(adminServer);
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** Petit client HTTP JSON pour les tests. */
async function jsonFetch(url, opts = {}) {
  const res = await fetch(url, opts);
  let body = null;
  const text = await res.text();
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, res };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { StubPlik, bootGateway, jsonFetch, sleep };
