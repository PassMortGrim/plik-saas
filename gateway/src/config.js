'use strict';

/**
 * Configuration de la passerelle, lue depuis l'environnement (.env).
 * Valeurs par défaut sûres ; le boot vérifie ADMIN_TOKEN (fail fast).
 */

function int(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function str(v, def) {
  const s = String(v || '').trim();
  return s.length > 0 ? s.replace(/\/+$/, '') : def;
}

const cfg = {
  // Serveur public (derrière Caddy) : API + widget + téléchargements.
  publicPort: int(process.env.PUBLIC_PORT, 8080),

  // Serveur admin : localhost UNIQUEMENT (CLI).
  adminPort: int(process.env.ADMIN_PORT, 8081),

  // Token admin : min 32 caractères, vérifié au boot et à temps constant.
  adminToken: String(process.env.ADMIN_TOKEN || ''),

  // Répertoire de données (store.json), monté en volume Docker.
  dataDir: String(process.env.DATA_DIR || 'data'),

  // Plik en amont (réseau Docker backend).
  plikUrl: str(process.env.PLIK_URL, 'http://plik:8080'),

  // Base des URLs publiques (liens signés générés par la passerelle).
  publicBaseUrl: str(process.env.PUBLIC_BASE_URL, 'http://localhost:8080'),

  // Limite des corps JSON (création d'upload, liens, admin).
  maxJsonBody: int(process.env.MAX_JSON_BODY, 64 * 1024),

  // Plafonds globaux : 200 Go/fichier, 30 jours de TTL max.
  maxFileBytes: int(process.env.MAX_FILE_BYTES, 214748364800),
  maxTtlSeconds: int(process.env.MAX_TTL_SECONDS, 2592000),

  // Webhooks : timeout de livraison et nombre max de tentatives.
  webhookTimeoutMs: int(process.env.WEBHOOK_TIMEOUT_MS, 5000),
  webhookMaxAttempts: int(process.env.WEBHOOK_MAX_ATTEMPTS, 5),
};

module.exports = cfg;
