/**
 * Plik-SaaS Widget — SDK vanilla JS (aucune dépendance).
 *
 * Intégration iframe (recommandée, zéro CORS à gérer pour l'upload) :
 *   <iframe src="https://votre-domaine/widget?tenant=TENANT_ID" ...></iframe>
 *   window.addEventListener('message', (e) => {
 *     if (e.origin !== 'https://votre-domaine') return;
 *     if (e.data && e.data.type === 'plik-saas:done') console.log('Upload terminé', e.data.payload);
 *   });
 *
 * Intégration directe (SPA) :
 *   const w = new PlikSaasWidget({ baseUrl, apiKey });
 *   const { uploadId, widgetToken } = await w.createUpload({ ttl: 3600, filename: f.name, size: f.size });
 *   await w.uploadFile(uploadId, widgetToken, file, { onProgress: (p) => ... });
 *   const { url } = await w.createLink(uploadId, fileId);
 *
 * Note : en mode direct, l'origine de la page doit être déclarée dans
 * allowedOrigins du tenant (CORS restreint).
 */
(function () {
  'use strict';

  var DEFAULT_TTL = 3600;

  function PlikSaasWidget(opts) {
    this.baseUrl = String(opts.baseUrl || '').replace(/\/$/, '');
    this.apiKey = opts.apiKey || '';
    this.lastWidgetToken = '';
    this.onProgress = opts.onProgress || function () {};
  }

  /** Crée un upload et renvoie { uploadId, widgetToken, expiresAt }. */
  PlikSaasWidget.prototype.createUpload = function (params) {
    var self = this;
    params = params || {};
    var body = {
      ttl: params.ttl || DEFAULT_TTL,
      oneShot: !!params.oneShot,
      filename: params.filename || 'file',
      size: params.size || 0,
    };
    return fetch(this.baseUrl + '/v1/uploads', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + this.apiKey,
      },
      body: JSON.stringify(body),
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error(data.error || 'createUpload a échoué');
        self.lastWidgetToken = data.widgetToken || '';
        return data;
      });
    });
  };

  /**
   * Pousse le contenu du fichier en streaming (XHR pour la progression,
   * contrairement à fetch qui ne l'expose pas).
   */
  PlikSaasWidget.prototype.uploadFile = function (uploadId, widgetToken, file, options) {
    var self = this;
    options = options || {};
    var onProgress = options.onProgress || this.onProgress;

    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', self.baseUrl + '/v1/uploads/' + encodeURIComponent(uploadId) + '/files');
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      xhr.setRequestHeader('X-Widget-Token', widgetToken);
      try {
        xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
        xhr.setRequestHeader('X-File-Size', String(file.size));
      } catch (e) {
        /* certains navigateurs refusent des en-têtes custom : le serveur a des défauts sûrs */
      }

      if (xhr.upload) {
        xhr.upload.onprogress = function (ev) {
          if (ev.lengthComputable && onProgress) {
            onProgress({ loaded: ev.loaded, total: ev.total, percent: (ev.loaded / ev.total) * 100 });
          }
        };
      }

      xhr.onload = function () {
        var data = null;
        try {
          data = JSON.parse(xhr.responseText);
        } catch (e) {
          data = null;
        }
        if (xhr.status >= 200 && xhr.status < 300 && data) {
          resolve(data);
        } else {
          reject(new Error((data && data.error) || 'uploadFile a échoué (HTTP ' + xhr.status + ')'));
        }
      };
      xhr.onerror = function () {
        reject(new Error('Erreur réseau pendant l upload'));
      };
      xhr.onabort = function () {
        reject(new Error('Upload annulé'));
      };
      xhr.send(file);
    });
  };

  /** Crée un lien de partage signé (via le jeton widget du dernier upload). */
  PlikSaasWidget.prototype.createLink = function (uploadId, fileId, widgetToken) {
    return fetch(this.baseUrl + '/v1/uploads/' + encodeURIComponent(uploadId) + '/links', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Widget-Token': widgetToken || this.lastWidgetToken || '',
      },
      body: JSON.stringify({ fileId: fileId }),
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error(data.error || 'createLink a échoué');
        return data;
      });
    });
  };

  /** Statut d'un upload (via clé API serveur, pas depuis le navigateur). */
  PlikSaasWidget.prototype.getUpload = function (uploadId, widgetToken) {
    var headers = {};
    if (this.apiKey) headers.Authorization = 'Bearer ' + this.apiKey;
    else if (widgetToken) headers['X-Widget-Token'] = widgetToken;
    return fetch(this.baseUrl + '/v1/uploads/' + encodeURIComponent(uploadId), {
      method: 'GET',
      headers: headers,
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error(data.error || 'getUpload a échoué');
        return data;
      });
    });
  };

  window.PlikSaasWidget = PlikSaasWidget;
})();
