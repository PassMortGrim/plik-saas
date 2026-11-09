# Documentation API Plik-SaaS

API multi-tenant de transfert de gros fichiers (jusqu'à 200 Go par fichier), construite sur Plik.
Base URL : `https://votre-domaine` (derrière Caddy/TLS).

## Sommaire

1. [Authentification](#authentification)
2. [Créer un upload](#créer-un-upload)
3. [Envoyer un fichier](#envoyer-un-fichier)
4. [Consulter un upload](#consulter-un-upload)
5. [Créer un lien de partage](#créer-un-lien-de-partage)
6. [Supprimer un upload](#supprimer-un-upload)
7. [Webhooks](#webhooks)
8. [Quotas et facturation](#quotas-et-facturation)
9. [Widget JS](#widget-js)
10. [Codes d'erreur](#codes-derreur)

---

## Authentification

Chaque éditeur (tenant) reçoit une ou plusieurs clés API au format
`pk_<id>_<secret>`. La clé s'utilise en en-tête `Authorization: Bearer` :

```bash
curl -H "Authorization: Bearer pk_AbC123...xyz" https://votre-domaine/v1/health
```

Règles :
- Le secret n'est affiché **qu'une fois** à la création (hash scrypt côté serveur).
- Une clé compromise se révoque instantanément (`POST /revoke` côté opérateur).
- Rotations recommandées : tous les 90 jours.

---

## Créer un upload

```bash
curl -X POST https://votre-domaine/v1/uploads \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "ttl": 3600,
    "oneShot": true,
    "filename": "sauvegarde.sql.gz",
    "size": 53687091200
  }'
```

Réponse `201 Created` :

```json
{
  "uploadId": "u1a2b3c4d5e6",
  "widgetToken": "wt_u1a2b3c4d5e6_<secret>",
  "uploadUrl": "/v1/uploads/u1a2b3c4d5e6/files",
  "expiresAt": "2026-11-09T15:30:00.000Z",
  "ttl": 3600,
  "oneShot": true
}
```

Champ | Type | Défaut | Description
---|---|---|---
`ttl` | int (s) | 3600 | Durée de vie, min 60 s, max 30 jours (config serveur)
`oneShot` | bool | false | Chaque fichier disparaît après le 1er téléchargement
`filename` | string | "file" | Nom de fichier (assaini côté serveur)
`size` | int | 0 | Taille annoncée, vérifiée contre le quota AVANT l'envoi

Le `widgetToken` permet d'envoyer le fichier **depuis un navigateur** sans
exposer la clé API (usage widget). Il n'est lié qu'à cet upload.

---

## Envoyer un fichier

Le contenu est streamé (mémoire constante côté serveur). Deux auth :

- **Serveur à serveur** : clé API du tenant propriétaire.
- **Navigateur (widget)** : en-tête `X-Widget-Token: <widgetToken>`.

```bash
curl -X POST https://votre-domaine/v1/uploads/u1a2b3c4d5e6/files \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-Filename: sauvegarde.sql.gz" \
  -H "X-File-Size: 53687091200" \
  -H "Content-Type: application/gzip" \
  --data-binary @sauvegarde.sql.gz
```

Réponse `201 Created` :

```json
{ "fileId": "f8g9h0", "filename": "sauvegarde.sql.gz", "size": 53687091200 }
```

Un upload accepte plusieurs fichiers (appel répété).

---

## Consulter un upload

```bash
curl -H "Authorization: Bearer $API_KEY" \
  https://votre-domaine/v1/uploads/u1a2b3c4d5e6
```

Réponse `200` :

```json
{
  "uploadId": "u1a2b3c4d5e6",
  "status": "active",
  "createdAt": "2026-11-09T14:30:00.000Z",
  "expiresAt": "2026-11-09T15:30:00.000Z",
  "ttl": 3600,
  "oneShot": true,
  "bytesIn": 53687091200,
  "bytesOut": 0,
  "files": [{ "id": "f8g9h0", "name": "sauvegarde.sql.gz", "size": 53687091200, "status": "uploaded" }]
}
```

Liste des fichiers seule : `GET /v1/uploads/{id}/files` (widget ou clé API propriétaire).

---

## Créer un lien de partage

```bash
curl -X POST https://votre-domaine/v1/uploads/u1a2b3c4d5e6/links \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"fileId": "f8g9h0"}'
```

Réponse `201` :

```json
{
  "url": "https://votre-domaine/d/u1a2b3c4d5e6/f8g9h0/sauvegarde.sql.gz?t=dl_...",
  "expiresAt": "2026-11-09T15:30:00.000Z",
  "oneShot": true
}
```

Le lien est signé (jeton `dl_`, hashé côté serveur) : impossible à deviner ni à
forger. Toute consultation hors TTL renvoie `410 Gone`.

---

## Supprimer un upload

```bash
curl -X DELETE -H "Authorization: Bearer $API_KEY" \
  https://votre-domaine/v1/uploads/u1a2b3c4d5e6
```

Supprime immédiatement les fichiers côté stockage et émet `upload.deleted`.

---

## Webhooks

Chaque tenant configure une URL HTTPS de callback (console opérateur).
La passerelle livre les événements avec 5 tentatives (backoff 30 s → 1 h).

Événements :

Type | Déclencheur
---|---
`file.uploaded` | Fichier reçu intégralement
`file.downloaded` | Premier téléchargement complet d'un fichier OneShot
`upload.expired` | TTL écoulé (ou purge amont)
`upload.deleted` | Suppression volontaire (API ou widget)
`quota.exceeded` | Quota mensuel atteint
`webhook.test` | Test de configuration

Format de la requête POST :

```json
{
  "id": "evt_XyZ...",
  "type": "file.uploaded",
  "createdAt": "2026-11-09T14:31:00.000Z",
  "tenantId": "t7k8m9",
  "data": { "uploadId": "u1a2b3c4d5e6", "fileId": "f8g9h0", "filename": "sauvegarde.sql.gz", "size": 53687091200 }
}
```

### Vérification de la signature (Node.js)

Chaque livraison porte `X-Saas-Signature: sha256=<hmac>` (HMAC-SHA256 du
corps brut avec le secret webhook du tenant) :

```js
const crypto = require('crypto');

app.post('/webhooks/plik-saas', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.header('X-Saas-Signature') || '';
  const expected = 'sha256=' + crypto
    .createHmac('sha256', process.env.PLIK_SAAS_WEBHOOK_SECRET)
    .update(req.body)
    .digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).end();
  }
  const event = JSON.parse(req.body);
  // ... traiter l'événement puis répondre 2xx SOUS 5 secondes
  res.json({ ok: true });
});
```

Répondez `2xx` sous 5 secondes ; sinon l'événement sera rejoué.

---

## Quotas et facturation

- Quota mensuel par tenant en octets **entrants** (`quotaBytesPerMonth`, 0 = illimité).
- Dépassement : `402 Payment Required` + événement `quota.exceeded`, AVANT tout transfert.
- Compteurs lisibles : `GET /admin/tenants` (opérateur) inclut `usage.bytesIn/bytesOut`.
- Modèle économique cible : coût marginal ~0,01 €/Go, revente 0,03-0,05 €/Go.

---

## Widget JS

### Mode iframe (recommandé)

```html
<iframe src="https://votre-domaine/widget?tenant=TENANT_ID"
        style="width:420px;height:420px;border:0" title="Transfert de fichiers"></iframe>

<script>
  // Côté serveur : créez l'upload avec votre clé API, puis transmettez
  // uploadId + widgetToken à l'iframe :
  iframe.contentWindow.postMessage({
    type: 'plik-saas:init',
    uploadId: 'u1a2b3c4d5e6',
    widgetToken: 'wt_u1a2b3c4d5e6_...'
  }, 'https://votre-domaine');

  window.addEventListener('message', (e) => {
    if (e.origin !== 'https://votre-domaine') return;
    if (e.data?.type === 'plik-saas:done') console.log('Fichier prêt :', e.data.payload.url);
  });
</script>
```

La clé API ne quitte jamais votre serveur : le navigateur ne voit que le
`widgetToken` lié à un seul upload.

### Mode direct (SPA)

```html
<script src="https://votre-domaine/widget.js"></script>
<script>
  const w = new PlikSaasWidget({ baseUrl: 'https://votre-domaine' /*, apiKey: côté serveur seulement */ });
  // Créez l'upload côté serveur (ttl, filename, size), récupérez
  // uploadId + widgetToken, puis :
  w.uploadFile(uploadId, widgetToken, file, {
    onProgress: (p) => console.log(`${p.percent.toFixed(1)} %`)
  }).then((meta) => w.createLink(uploadId, meta.fileId).then((l) => console.log(l.url)));
</script>
```

En mode direct, déclarez l'origine de votre page dans `allowedOrigins` du
tenant (CORS restreint par origine).

---

## Codes d'erreur

Code | Signification
---|---
400 | Corps JSON invalide
401 | Clé API absente/invalide, ou jeton widget requis
402 | Quota mensuel dépassé
403 | Origine non autorisée, jeton invalide, upload d'un autre tenant
404 | Upload introuvable
410 | Upload ou lien expiré (TTL écoulé, OneShot consommé)
413 | Fichier trop volumineux
429 | Trop de requêtes (rate limiting)
502 | Erreur du stockage en amont (retentir)

Toute erreur est JSON : `{"error": "message lisible"}`.
