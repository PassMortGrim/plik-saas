'use strict';

const { Readable } = require('stream');

/**
 * Client REST minimal pour Plik (https://github.com/root-gg/plik).
 * Tout est streamé : la passerelle ne bufferise jamais un fichier entier.
 *
 * Note : les en-têtes/noms de champs (X-Upload-Auth, X-File-Name en base64,
 * ?stream=true) suivent l'API Plik 1.3.x — à valider sur le staging contre
 * la version exacte déployée.
 */
class PlikClient {
  constructor(baseUrl) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
  }

  headers(token, extra) {
    const h = { ...(extra || {}) };
    if (token) h['X-Upload-Auth'] = token;
    return h;
  }

  /** Convertit une réponse d'erreur Plik en Error avec .status (404, 413...). */
  async fail(res) {
    let msg = '';
    try {
      const j = await res.json();
      msg = j.error || j.message || '';
    } catch {
      /* corps non JSON */
    }
    const err = new Error(`Plik ${res.status} : ${msg || res.statusText}`);
    err.status = res.status;
    throw err;
  }

  /**
   * Crée un upload Plik. Retourne { id, token }.
   * opts : { ttl, oneShot, stream }
   */
  async createUpload(token, opts) {
    const body = JSON.stringify({
      OneShot: !!(opts && opts.oneShot),
      Removable: true,
      TTL: (opts && opts.ttl) || 3600,
      Stream: !!(opts && opts.stream),
      ProtectedByPassword: false,
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
   * Envoie un fichier en mode stream de Plik (?stream=true).
   * `stream` est un Readable Node (la requête HTTP entrante) : transfert
   * direct, mémoire constante. duplex:'half' est requis par undici pour
   * un corps streamé ; on ne définit JAMAIS Transfer-Encoding manuellement.
   */
  async addFileStream(uploadId, token, filename, type, stream) {
    const res = await fetch(
      `${this.baseUrl}/upload/${encodeURIComponent(uploadId)}/file?stream=true`,
      {
        method: 'POST',
        headers: this.headers(token, {
          'X-File-Name': Buffer.from(filename, 'utf8').toString('base64'),
          'X-File-Type': String(type || 'application/octet-stream').slice(0, 120),
          'Content-Type': String(type || 'application/octet-stream').slice(0, 120),
        }),
        body: stream,
        duplex: 'half',
      }
    );
    if (!res.ok) await this.fail(res);
    const data = await res.json();
    return { id: data.id, size: data.size || 0, status: data.status || 'uploaded' };
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
   * Récupère un fichier. body : { pipe(res), cancel() } pour le
   * streamer vers la réponse HTTP sortante (Range supporté).
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
