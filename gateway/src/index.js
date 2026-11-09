'use strict';

const fs = require('fs');

const cfg = require('./config');
const { Store } = require('./store');
const { startJanitor } = require('./janitor');
const { processQueue } = require('./webhooks');
const { startServers } = require('./server');

/**
 * Point d'entrée de la passerelle.
 * Vérifie la configuration au démarrage (fail fast) puis démarre :
 *  - le serveur public (API + widget)
 *  - le serveur admin (localhost)
 *  - le janitor (expirations TTL + événements OneShot)
 *  - la boucle de livraison des webhooks
 */
function main() {
  if (!cfg.adminToken || cfg.adminToken.length < 32) {
    console.error(
      '[boot] ADMIN_TOKEN manquant ou trop court (min 32 caracteres). ' +
        'Generez-le avec : openssl rand -hex 32'
    );
    process.exit(1);
  }

  fs.mkdirSync(cfg.dataDir, { recursive: true });

  const store = new Store(cfg.dataDir);
  try {
    store.load();
  } catch (err) {
    console.error(`[boot] ${err.message}`);
    console.error('[boot] Corrigez ou deplacez le fichier avant de redemarrer.');
    process.exit(1);
  }

  const stopJanitor = startJanitor(store, new (require('./plik').PlikClient)(cfg.plikUrl));

  const webhookTimer = setInterval(() => {
    processQueue(store).catch((err) => console.error(`[webhook] ${err.message}`));
  }, 5000);

  const { publicServer, adminServer } = startServers(store);

  console.log(`[boot] Passerelle prete : public=${cfg.publicPort} admin=${cfg.adminPort}`);
  console.log(`[boot] Plik amont : ${cfg.plikUrl}`);
  console.log(`[boot] Base publique : ${cfg.publicBaseUrl}`);

  // Flush du store + arrêt propre.
  let stopping = false;
  function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    console.log(`\n[boot] ${signal} recu, arret en cours...`);
    stopJanitor();
    clearInterval(webhookTimer);
    try {
      store.flush();
      console.log('[boot] Store sauvegarde.');
    } catch (err) {
      console.error(`[boot] Echec sauvegarde store : ${err.message}`);
    }
    publicServer.close();
    adminServer.close();
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
