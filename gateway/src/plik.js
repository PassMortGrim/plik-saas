'use strict';

const crypto = require('crypto');
const { Readable } = require('stream');

/**
 * Client REST minimal pour Plik (https://github.com/root-gg/plik).
 * Points d'API validés contre le code source de Plik 1.4.x
 * (server/server/server.go, server/middleware, server/handlers) :
 *
 *   POST   /upload                              → création (JSON, tags exacts)
 *   POST   /file/{uploadID}                     → ajout de fichier (multipart, champ "file")
 *   GET    /file/{uploadID}/{fileID}/{filename} → téléchargement (OneShot consommé au GET)
 *   DELETE /upload/{uploadID}                   → suppression
 *   GET    /health                              → sonde
 *
 *   Auth "admin" d'upload : en-tête X-UploadToken (comparaison à temps constant côté Plik)
 *   Réponses fichier : id, fileName, fileSize, status, fileMd5, fileType...
 *
 * Tout est streamé : la passerelle ne bufferise jamais un fichier entier.
 */
class PlikClient {
  constructor(baseUrl) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
  }

  headers(token, extra) {
    const h = { ...(extra || {}) };
    if (token) h['X-UploadToken'] = token;
    return h;
  }

  /** Convertit une réponse d'erreur Plik en Error avec .status. */
  async fail(res) {
    let msg = '';
    try {
      const j = await res.json();
      msg = j.error || j.message || '';
    } catch {
      /* corps non JSON */
    }
    let status = res.status;
    // Plik renvoie 400 "file too big" : normalisé en 413 pour la passerelle.
    if (status === 400 && /too big/i.test(msg)) status = 413;
    const err = new Error(`Plik ${res.status} : ${msg || res.statusText}`);
    err.status = status;
    throw err;
  }

  /**
   * Crée un upload Plik. Retourne { id, token }.
   * opts : { ttl, oneShot, stream }
   */
  async createUpload(token, opts) {
    const body = JSON.stringify({
      ttl: (opts && opts.ttl) || 3600,
      oneShot: !!(opts && opts.oneShot),
      removable: true,
      stream: !!(opts && opts.stream),
      protectedByPassword: false,
    });
    const res = await fetch(`${this.baseUrl}/upload`, {
      method: 'POST',
      headers: this.headers(token, { 'Content-Type': 'application/json' }),
      body,
    });
    if (!res.ok) await this.fail(res);
    const data = await res.json();
    return { id: data.id, token: data.uploadToken };
  }

  /**
   * Ajoute un fichier en multipart (champ "file"), corps construit à la
   * volée depuis la requête HTTP entrante : mémoire constante.
   * duplex:'half' est requis par undici pour un corps streamé ; on ne
   * définit JAMAIS Transfer-Encoding manuellement.
   */
  async addFile(uploadId, token, filename, type, stream) {
    const boundary = 'pliksaas' + crypto.randomUUID().replace(/-/g, '');
    const safeName = String(filename || 'file').replace(/["\\\r\n]/g, '_');
    const preamble = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${safeName}"\r\n` +
        `Content-Type: ${String(type || 'application/octet-stream').slice(0, 120)}\r\n\r\n`
    );
    const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`);

    const body = Readable.from(
      (async function* () {
        yield preamble;
        for await (const chunk of stream) yield chunk;
        yield epilogue;
      })()
    );

    const res = await fetch(`${this.baseUrl}/file/${encodeURIComponent(uploadId)}`, {
      method: 'POST',
      headers: this.headers(token, {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      }),
      body,
      duplex: 'half',
    });
    if (!res.ok) await this.fail(res);
    // Réponse : common.File JSON → id, fileName, fileSize, status, ...
    const data = await res.json();
    return {
      id: data.id,
      size: data.fileSize || 0,
      status: data.status || 'uploaded',
      name: data.fileName || safeName,
    };
  }

  /** Supprime un upload (idempotent : 404 accepté silencieusement). */
  async removeUpload(uploadId, token) {
    const res = await fetch(`${this.baseUrl}/upload/${encodeURIComponent(uploadId)}`, {
      method: 'DELETE',
      headers: this.headers(token),
    });
    if (!res.ok && res.status !== 404) await this.fail(res);
    return true;
  }

  /**
   * Récupère un fichier. body : { pipe(res), cancel() } pour le streamer
   * vers la réponse HTTP sortante (Range supporté).
   * ATTENTION : sur un upload OneShot, ce GET CONSOMME le fichier
   * (comportement Plik). Jamais de sondage automatique avec cette méthode.
   */
  async getFile(uploadId, token, fileId, filename, range) {
    const res = await fetch(
      `${this.baseUrl}/file/${encodeURIComponent(uploadId)}/${encodeURIComponent(fileId)}/${encodeURIComponent(filename)}`,
      {
        headers: this.headers(token, range ? { Range: String(range).slice(0, 64) } : {}),
      }
    );
    if (!res.ok) await this.fail(res);
    const nodeStream = Readable.fromWeb(res.body);
    return {
      status: res.status,
      headers: res.headers,
      body: {
        pipe: nodeStream.pipe.bind(nodeStream),
        cancel: () => nodeStream.destroy(),
      },
    };
  }
}

module.exports = { PlikClient };
