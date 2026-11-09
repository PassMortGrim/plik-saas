'use strict';

const { emit } = require('./webhooks');

/**
 * Janitor : tâche de fond toutes les 30 s.
 *  1. Marque expirés les uploads dont le TTL est dépassé (+ purge Plik).
 *  2. Détecte les fichiers OneShot déjà consommés (purgés par Plik alors
 *     que la passerelle n'a pas vu le téléchargement) et émet l'événement.
 *  3. Prome les uploads inactifs de plus de 7 jours (tenue du fichier).
 */
function startJanitor(store, plik) {
  let sweeping = false;

  async function sweep() {
    if (sweeping) return; // pas de chevauchement
    sweeping = true;
    try {
      const now = Date.now();
      let dirty = false;

      for (const upload of store.listActiveUploads()) {
        const tenant = store.getTenant(upload.tenantId);

        // 1. Expiration TTL
        if (new Date(upload.expiresAt).getTime() <= now) {
          upload.status = 'expired';
          try {
            await plik.removeUpload(upload.id, upload.plikToken);
          } catch (err) {
            if (err.status !== 404) {
              console.warn(`[janitor] purge Plik ${upload.id} : ${err.message}`);
            }
          }
          if (tenant) {
            emit(store, tenant, 'upload.expired', {
              uploadId: upload.id,
              bytesIn: upload.bytesIn,
              bytesOut: upload.bytesOut,
              expiresAt: upload.expiresAt,
            });
          }
          dirty = true;
          continue;
        }

        // 2. OneShot consommé hors de notre vue (lien partagé ouvert
        //    directement, téléchargement interrompu...) : Plik a purgé,
        //    on marque et on notifie une seule fois.
        if (upload.oneShot) {
          for (const file of Object.values(upload.files)) {
            if (!file.id || file.id === 'pending' || file.status !== 'uploaded') continue;
            const evtKey = `downloaded:${file.id}`;
            if (upload.notifiedEvents[evtKey]) continue;

            let gone = false;
            try {
              const head = await plik.getFile(upload.id, upload.plikToken, file.id, file.name);
              head.body.cancel();
            } catch (err) {
              if (err.status === 404 || err.status === 410) gone = true;
              else if (err.status !== 200) {
                console.warn(`[janitor] sonde ${upload.id}/${file.id} : ${err.message}`);
              }
            }

            if (gone) {
              file.status = 'missing';
              upload.bytesOut += file.size || 0;
              store.addUsage(upload.tenantId, 0, file.size || 0);
              upload.notifiedEvents[evtKey] = new Date().toISOString();
              if (tenant) {
                emit(store, tenant, 'file.downloaded', {
                  uploadId: upload.id,
                  fileId: file.id,
                  filename: file.name,
                  size: file.size || 0,
                  via: 'oneshot-sweep',
                });
              }
              dirty = true;
            }
          }
        }
      }

      // 3. Tenue du fichier : purge des entrées inactives de plus de 7 jours.
      const purged = store.purgeOldUploads(7 * 24 * 3600 * 1000);
      if (purged > 0) dirty = true;

      if (dirty) store.touch();
    } finally {
      sweeping = false;
    }
  }

  const timer = setInterval(() => {
    sweep().catch((err) => console.error(`[janitor] ${err.message}`));
  }, 30000);

  return function stopJanitor() {
    clearInterval(timer);
  };
}

module.exports = { startJanitor };
