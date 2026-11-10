'use strict';

const crypto = require('crypto');
const http = require('http');

const cfg = require('./config');
const {
  parseToken,
  verifySecret,
  hmac,
  RateLimiter,
  readJson,
  sanitizeFilename,
  clientIp,
  fmtBytes,
  b62,
} = require('./util');
const { PlikClient } = require('./plik');
const { emit } = require('./webhooks');

/**
 * Serveurs HTTP de la passerelle :
 *  - port public  (8080) : API éditeurs + widget (derrière Caddy/TLS)
 *  - port admin   (8081) : CLI admin (localhost uniquement)
 */

const authLimiter = new RateLimiter(5, 10); // 5 req/s par IP sur l'admin
const apiLimiter = new RateLimiter(20, 40); // 20 req/s par clé/IP sur l'API
const uploadLimiter = new RateLimiter(2, 4); // création d'uploads

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** Comparaison à temps constant pour les secrets ADMIN. */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function startServers(store) {
  const plik = new PlikClient(cfg.plikUrl);

  // ----------------------------------------------------------------
  // Auth API éditeur : Authorization: Bearer pk_<id>_<secret>
  // ----------------------------------------------------------------
  function authenticate(req, res) {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) {
      send(res, 401, { error: 'Authorization Bearer requis' });
      return null;
    }
    const parsed = parseToken('pk', auth.slice(7).trim());
    if (!parsed) {
      send(res, 401, { error: 'Format de clé API invalide' });
      return null;
    }
    const found = store.tenantByApiKeyId(parsed.id);
    if (!found || !verifySecret(parsed.secret, found.key.hash)) {
      send(res, 401, { error: 'Clé API invalide ou révoquée' });
      return null;
    }
    if (found.key.revokedAt) {
      send(res, 401, { error: 'Clé API révoquée' });
      return null;
    }
    if (!apiLimiter.allow(`k:${found.key.id}`)) {
      send(res, 429, { error: 'Trop de requêtes' });
      return null;
    }
    return found.tenant;
  }

  /**
   * Résout un upload SOIT par le tenant propriétaire (clé API),
   * SOIT par un jeton widget valide lié à cet upload.
   * Corrige la faille "accès upload avec simple clé API".
   */
  function resolveUpload(req, res, uploadId) {
    const upload = store.getUpload(uploadId);
    if (!upload) {
      send(res, 404, { error: 'Upload introuvable ou expiré' });
      return null;
    }
    const auth = req.headers.authorization || '';
    if (auth.startsWith('Bearer ')) {
      const parsed = parseToken('pk', auth.slice(7).trim());
      if (parsed) {
        const found = store.tenantByApiKeyId(parsed.id);
        if (found && !found.key.revokedAt && verifySecret(parsed.secret, found.key.hash)) {
          if (found.tenant.id !== upload.tenantId) {
            send(res, 403, { error: 'Cet upload n appartient pas à ce tenant' });
            return null;
          }
          return { upload, tenant: found.tenant, via: 'api' };
        }
      }
    }
    // Jeton widget : X-Widget-Token: wt_<uploadId>_<secret>
    const wt = req.headers['x-widget-token'];
    const parsedWt = parseToken('wt', wt);
    if (
      parsedWt &&
      parsedWt.id === upload.id &&
      upload.widgetTokenHash &&
      verifySecret(parsedWt.secret, upload.widgetTokenHash)
    ) {
      const tenant = store.getTenant(upload.tenantId);
      return { upload, tenant, via: 'widget' };
    }
    send(res, 401, { error: 'Jeton widget ou clé API propriétaire requis' });
    return null;
  }

  /** Origine autorisée pour le widget (CORS restreint par tenant). */
  function checkWidgetOrigin(req, res, tenant) {
    const origin = req.headers.origin;
    if (!origin) return true; // même origine / curl
    const allowed = (tenant && tenant.allowedOrigins) || [];
    if (!allowed.includes(origin)) {
      send(res, 403, { error: 'Origine non autorisée pour ce tenant' });
      return false;
    }
    return true;
  }

  function corsHeaders(tenant, origin) {
    const allowed = (tenant && tenant.allowedOrigins) || [];
    if (!origin || !allowed.includes(origin)) return {};
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Widget-Token, X-Filename, X-File-Size',
      'Access-Control-Expose-Headers': 'X-Upload-Id, X-Widget-Token, X-File-Id',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    };
  }

  // ----------------------------------------------------------------
  // Handlers métier
  // ----------------------------------------------------------------
  async function handleCreateUpload(req, res, tenant) {
    if (!uploadLimiter.allow(`t:${tenant.id}`)) {
      send(res, 429, { error: 'Trop d uploads créés, patientez' });
      return;
    }
    const body = await readJson(req, cfg.maxJsonBody);
    const ttl = Math.min(Math.max(parseInt(body.ttl, 10) || 3600, 60), cfg.maxTtlSeconds);
    const oneShot = body.oneShot === true;
    const filename = sanitizeFilename(body.filename || 'file');
    const size = parseInt(body.size, 10) || 0;

    // Quota mensuel du tenant (octets entrants).
    const u = store.usage(tenant.id);
    const remaining = tenant.quotaBytesPerMonth - u.bytesIn;
    if (tenant.quotaBytesPerMonth > 0 && (remaining <= 0 || size > remaining)) {
      emit(store, tenant, 'quota.exceeded', {
        quotaBytesPerMonth: tenant.quotaBytesPerMonth,
        bytesInMonth: u.bytesIn,
        requested: size,
      });
      send(res, 402, { error: 'Quota mensuel dépassé', quotaBytesPerMonth: tenant.quotaBytesPerMonth });
      return;
    }
    if (cfg.maxFileBytes > 0 && size > cfg.maxFileBytes) {
      send(res, 413, { error: `Fichier trop volumineux (max ${fmtBytes(cfg.maxFileBytes)})` });
      return;
    }

    const plikUpload = await plik.createUpload(null, { ttl, oneShot, stream: false });
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    const upload = store.createUpload(tenant.id, plikUpload, expiresAt, ttl, oneShot);

    // Jeton widget : wt_<uploadId>_<secret>, hashé côté serveur.
    const secret = b62(40);
    upload.widgetTokenHash = require('./util').hashSecret(secret);
    const widgetToken = `wt_${upload.id}_${secret}`;
    store.touch();

    // Fichier à venir (le client poussera le contenu ensuite).
    upload.files.pending = {
      id: 'pending',
      name: filename,
      size,
      status: 'pending',
    };
    store.touch();

    send(res, 201, {
      uploadId: upload.id,
      widgetToken,
      uploadUrl: `/v1/uploads/${upload.id}/files`,
      expiresAt,
      ttl,
      oneShot,
    });
  }

  async function handleAddFile(req, res, tenant, uploadId) {
    const resolved = resolveUpload(req, res, uploadId);
    if (!resolved) return;
    const { upload, via } = resolved;
    if (upload.status !== 'active') {
      send(res, 410, { error: 'Upload expiré' });
      return;
    }
    if (via === 'widget' && !checkWidgetOrigin(req, res, resolved.tenant)) return;

    const filename = sanitizeFilename(req.headers['x-filename'] || 'file');
    const declared = parseInt(req.headers['x-file-size'] || '0', 10) || 0;
    if (cfg.maxFileBytes > 0 && declared > cfg.maxFileBytes) {
      send(res, 413, { error: `Fichier trop volumineux (max ${fmtBytes(cfg.maxFileBytes)})` });
      return;
    }

    const type = (req.headers['content-type'] || 'application/octet-stream').slice(0, 120);
    try {
      // Streaming direct de la requête entrante vers Plik : mémoire constante.
      const fileMeta = await plik.addFile(upload.id, upload.plikToken, filename, type, req);
      delete upload.files.pending;
      upload.files[fileMeta.id] = {
        id: fileMeta.id,
        name: filename,
        size: fileMeta.size || declared,
        status: fileMeta.status || 'uploaded',
      };
      const bytesIn = fileMeta.size || declared || 0;
      upload.bytesIn += bytesIn;
      store.addUsage(upload.tenantId, bytesIn, 0);
      store.touch();
      emit(store, resolved.tenant, 'file.uploaded', {
        uploadId: upload.id,
        fileId: fileMeta.id,
        filename,
        size: bytesIn,
      });
      send(res, 201, { fileId: fileMeta.id, filename, size: bytesIn });
    } catch (err) {
      if (err.status === 413) {
        send(res, 413, { error: 'Fichier trop volumineux' });
      } else if (err.status === 404) {
        upload.status = 'expired';
        store.touch();
        send(res, 410, { error: 'Upload expiré côté stockage' });
      } else {
        console.error(`[api] addFile upload=${upload.id} : ${err.message}`);
        send(res, 502, { error: 'Erreur du stockage en amont' });
      }
    }
  }

  async function handleGetUpload(req, res, uploadId) {
    const resolved = resolveUpload(req, res, uploadId);
    if (!resolved) return;
    const { upload } = resolved;
    send(res, 200, {
      uploadId: upload.id,
      status: upload.status,
      createdAt: upload.createdAt,
      expiresAt: upload.expiresAt,
      ttl: upload.ttl,
      oneShot: upload.oneShot,
      bytesIn: upload.bytesIn,
      bytesOut: upload.bytesOut,
      files: Object.values(upload.files)
        .filter((f) => f.id !== 'pending')
        .map((f) => ({ id: f.id, name: f.name, size: f.size, status: f.status })),
    });
  }

  async function handleListFiles(req, res, uploadId) {
    const resolved = resolveUpload(req, res, uploadId);
    if (!resolved) return;
    const { upload } = resolved;
    const files = Object.values(upload.files)
      .filter((f) => f.id !== 'pending')
      .map((f) => ({ id: f.id, name: f.name, size: f.size, status: f.status }));
    send(res, 200, { uploadId: upload.id, status: upload.status, files });
  }

  async function handleDeleteUpload(req, res, uploadId) {
    const resolved = resolveUpload(req, res, uploadId);
    if (!resolved) return;
    const { upload, tenant, via } = resolved;
    if (via === 'widget' && !checkWidgetOrigin(req, res, tenant)) return;
    try {
      await plik.removeUpload(upload.id, upload.plikToken);
    } catch (err) {
      if (err.status !== 404) {
        console.warn(`[api] delete upload=${upload.id} : ${err.message}`);
      }
    }
    upload.status = 'deleted';
    store.touch();
    if (tenant) {
      emit(store, tenant, 'upload.deleted', { uploadId: upload.id, via });
    }
    send(res, 200, { deleted: true, uploadId: upload.id });
  }

  /** Page de téléchargement/tunnel : GET /d/<uploadId>/<fileId>/<name>?t=<dl_token> */
  async function handleDownload(req, res, uploadId, fileId, name, token, isHead) {
    const upload = store.getUpload(uploadId);
    if (!upload) {
      send(res, 404, { error: 'Lien introuvable' });
      return;
    }
    const parsed = parseToken('dl', token);
    const file = upload.files[fileId];
    if (
      !parsed ||
      !file ||
      parsed.id !== `${upload.id}.${fileId}` ||
      !upload.share[fileId] ||
      !verifySecret(parsed.secret, upload.share[fileId])
    ) {
      send(res, 403, { error: 'Jeton de téléchargement invalide' });
      return;
    }
    if (upload.status !== 'active') {
      send(res, 410, { error: 'Lien expiré' });
      return;
    }

    // Marqueur anti-doublon : on ne compte/notifie qu'une fois.
    const evtKey = `downloaded:${fileId}`;
    let notified = false;

    try {
      const upstream = await plik.getFile(
        upload.id,
        upload.plikToken,
        fileId,
        file.name,
        req.headers.range
      );
      const headers = {
        'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="${file.name.replace(/["\\]/g, '_')}"`,
      };
      for (const h of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
        const v = upstream.headers.get(h);
        if (v) headers[h] = v;
      }
      res.writeHead(upstream.status, headers);

      if (isHead) {
        res.end();
        upstream.body.cancel();
        return;
      }

      // Comptabilité à la fermeture : compte un transfert réellement
      // terminé par le client (un flux interrompu n'est pas compté).
      res.on('close', () => {
        try {
          if (!res.writableEnded) {
            const seen = res.getHeader('content-range');
            const done = seen && String(seen).startsWith('bytes 0-');
            if (!done) {
              // Interrompu par le client : couper AUSSI le flux amont,
              // sinon la réponse fetch reste ouverte à jamais (fuite
              // socket + mémoire tampon chez le stockage).
              try {
                upstream.body.cancel();
              } catch {
                /* déjà fermé */
              }
              return; // interrompu : pas compté comme téléchargé
            }
          }
          const bytesOut = file.size || 0;
          upload.bytesOut += bytesOut;
          store.addUsage(upload.tenantId, 0, bytesOut);
          if (upload.oneShot && !upload.notifiedEvents[evtKey]) {
            upload.notifiedEvents[evtKey] = new Date().toISOString();
            notified = true;
          }
          store.touch();
          if (notified) {
            const tenant = store.getTenant(upload.tenantId);
            if (tenant) {
              emit(store, tenant, 'file.downloaded', {
                uploadId: upload.id,
                fileId,
                filename: file.name,
                size: bytesOut,
                via: 'download',
              });
            }
          }
        } catch {
          /* comptabilité best effort */
        }
      });

      upstream.body.pipe(res);
    } catch (err) {
      // Plik a purgé le fichier (TTL/OneShot déjà consommé) : 410, pas 404.
      if (err.status === 404 || err.status === 410) {
        send(res, 410, { error: 'Lien expiré ou déjà consommé' });
      } else {
        console.error(`[api] download upload=${upload.id} file=${fileId} : ${err.message}`);
        if (!res.headersSent) send(res, 502, { error: 'Erreur du stockage en amont' });
        else res.end();
      }
    }
  }

  /** POST /v1/uploads/{id}/links : crée un lien de partage signé. */
  async function handleCreateLink(req, res, uploadId) {
    const resolved = resolveUpload(req, res, uploadId);
    if (!resolved) return;
    const { upload, tenant, via } = resolved;
    if (via === 'widget' && !checkWidgetOrigin(req, res, tenant)) return;
    const body = await readJson(req, cfg.maxJsonBody);
    const fileId = String(body.fileId || '').slice(0, 64);
    const file = upload.files[fileId];
    if (!file || fileId === 'pending') {
      send(res, 404, { error: 'Fichier introuvable dans cet upload' });
      return;
    }
    const secret = b62(40);
    upload.share[fileId] = require('./util').hashSecret(secret);
    store.touch();
    const token = `dl_${upload.id}.${fileId}_${secret}`;
    send(res, 201, {
      url: `${cfg.publicBaseUrl}/d/${upload.id}/${fileId}/${encodeURIComponent(file.name)}?t=${encodeURIComponent(token)}`,
      expiresAt: upload.expiresAt,
      oneShot: upload.oneShot,
    });
  }

  // ----------------------------------------------------------------
  // Serveur public (API + widget + téléchargements)
  // ----------------------------------------------------------------
  const publicServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://internal');
    const parts = url.pathname.split('/').filter(Boolean);

    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

    (async () => {
      const method = req.method;

      // OPTIONS : preflight CORS — validé contre les origines du tenant
      // via le paramètre ?tenant= OU l'origin elle-même.
      if (method === 'OPTIONS') {
        const origin = req.headers.origin;
        const tenantParam = url.searchParams.get('tenant');
        let tenant = null;
        if (tenantParam) {
          tenant = store.getTenant(String(tenantParam).slice(0, 32));
        } else if (origin) {
          tenant = store.listTenants().find((t) => (t.allowedOrigins || []).includes(origin));
        }
        const ch = corsHeaders(tenant, origin);
        res.writeHead(204, ch);
        res.end();
        return;
      }

      // --- Routes publiques de téléchargement ---
      if (parts[0] === 'd' && parts.length >= 4 && (method === 'GET' || method === 'HEAD')) {
        const name = decodeURIComponent(parts[3]);
        const token = url.searchParams.get('t') || '';
        await handleDownload(req, res, parts[1], parts[2], name, token, method === 'HEAD');
        return;
      }

      // --- API éditeur ---
      if (parts[0] === 'v1') {
        if (parts[1] === 'uploads') {
          if (parts.length === 2 && method === 'POST') {
            const tenant = authenticate(req, res);
            if (tenant) await handleCreateUpload(req, res, tenant);
            return;
          }
          const uploadId = parts[2];
          if (!uploadId) {
            send(res, 404, { error: 'Route inconnue' });
            return;
          }
          if (parts.length === 3 && method === 'GET') {
            await handleGetUpload(req, res, uploadId);
            return;
          }
          if (parts.length === 3 && method === 'DELETE') {
            await handleDeleteUpload(req, res, uploadId);
            return;
          }
          if (parts.length === 4 && parts[3] === 'files' && method === 'POST') {
            const tenant = authenticate(req, res);
            if (tenant) await handleAddFile(req, res, tenant, uploadId);
            return;
          }
          if (parts.length === 4 && parts[3] === 'files' && method === 'GET') {
            await handleListFiles(req, res, uploadId);
            return;
          }
          if (parts.length === 4 && parts[3] === 'links' && method === 'POST') {
            await handleCreateLink(req, res, uploadId);
            return;
          }
        }
        if (parts[1] === 'health' && method === 'GET') {
          send(res, 200, { status: 'ok', version: '1.0.0' });
          return;
        }
        send(res, 404, { error: 'Route inconnue' });
        return;
      }

      // --- Widget statique (démonstration) ---
      if (parts[0] === 'widget.js' && method === 'GET') {
        const fs = require('fs');
        const path = require('path');
        try {
          const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'widget.js'));
          res.writeHead(200, {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'public, max-age=300',
          });
          res.end(js);
        } catch {
          send(res, 500, { error: 'widget indisponible' });
        }
        return;
      }
      if (parts[0] === 'widget' && method === 'GET') {
        const fs = require('fs');
        const path = require('path');
        try {
          const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'widget-page.html'));
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'public, max-age=300',
            'X-Frame-Options': 'ALLOWALL',
          });
          res.end(html);
        } catch {
          send(res, 500, { error: 'widget indisponible' });
        }
        return;
      }

      send(res, 404, { error: 'Route inconnue' });
    })().catch((err) => {
      console.error(`[public] ${req.method} ${url.pathname} : ${err.message}`);
      if (!res.headersSent) send(res, 500, { error: 'Erreur interne' });
      else res.end();
    });
  });

  // ----------------------------------------------------------------
  // Serveur admin (localhost)
  // ----------------------------------------------------------------
  const adminServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://internal');
    const parts = url.pathname.split('/').filter(Boolean);

    if (!authLimiter.allow(`ip:${clientIp(req)}`)) {
      send(res, 429, { error: 'Trop de requêtes' });
      return;
    }

    const token = req.headers['x-admin-token'] || '';
    if (!token || !safeEqual(token, cfg.adminToken)) {
      send(res, 401, { error: 'Token admin invalide' });
      return;
    }

    (async () => {
      const method = req.method;

      if (method === 'GET' && parts[0] === 'tenants') {
        send(res, 200, {
          tenants: store.listTenants().map((t) => ({
            id: t.id,
            name: t.name,
            quotaBytesPerMonth: t.quotaBytesPerMonth,
            allowedOrigins: t.allowedOrigins,
            webhookUrl: t.webhookUrl,
            keys: store.listKeys(t.id),
            usage: store.usage(t.id),
          })),
        });
        return;
      }

      if (method === 'POST' && parts[0] === 'tenants') {
        const body = await readJson(req, cfg.maxJsonBody);
        if (!body.name || String(body.name).length < 2) {
          send(res, 400, { error: 'name requis (min 2 caractères)' });
          return;
        }
        const tenant = store.createTenant({
          name: body.name,
          quotaBytesPerMonth: body.quotaBytesPerMonth,
          webhookUrl: body.webhookUrl,
          webhookSecret: body.webhookSecret,
          allowedOrigins: body.allowedOrigins,
        });
        const created = store.addKey(tenant.id, 'default');
        send(res, 201, { tenant: { id: tenant.id, name: tenant.name }, apiKey: created.full });
        return;
      }

      if (method === 'POST' && parts[0] === 'keys') {
        const body = await readJson(req, cfg.maxJsonBody);
        if (!body.tenantId || !store.getTenant(body.tenantId)) {
          send(res, 404, { error: 'tenantId invalide' });
          return;
        }
        const created = store.addKey(body.tenantId, body.name);
        send(res, 201, { apiKey: created.full, key: { id: created.key.id, name: created.key.name } });
        return;
      }

      if (method === 'POST' && parts[0] === 'revoke') {
        const body = await readJson(req, cfg.maxJsonBody);
        const ok = store.revokeKey(body.tenantId, body.keyId);
        send(res, ok ? 200 : 404, { revoked: ok });
        return;
      }

      if (method === 'POST' && parts[0] === 'webhook-test') {
        const body = await readJson(req, cfg.maxJsonBody);
        const tenant = store.getTenant(body.tenantId);
        if (!tenant) {
          send(res, 404, { error: 'tenantId invalide' });
          return;
        }
        const entry = emit(store, tenant, 'webhook.test', { message: 'Test de webhook Plik-SaaS' });
        send(res, 202, { queued: !!entry, eventId: entry ? entry.id : null });
        return;
      }

      if (method === 'GET' && parts[0] === 'health') {
        const q = store.initWebhookQueue();
        send(res, 200, {
          status: 'ok',
          tenants: store.listTenants().length,
          activeUploads: store.listActiveUploads().length,
          webhookQueue: q.length,
          uptimeS: Math.round(process.uptime()),
        });
        return;
      }

      send(res, 404, { error: 'Route admin inconnue' });
    })().catch((err) => {
      console.error(`[admin] ${req.method} ${url.pathname} : ${err.message}`);
      if (!res.headersSent) send(res, 500, { error: 'Erreur interne' });
    });
  });

  publicServer.listen(cfg.publicPort, '0.0.0.0');
  adminServer.listen(cfg.adminPort, '127.0.0.1'); // localhost uniquement

  return { publicServer, adminServer };
}

module.exports = { startServers, safeEqual };
