'use strict';

const { emit } = require('./webhooks');

/**
 * Janitor : tâche de fond toutes les 30 s.
 *  1. Marque expirés les uploads dont le TTL est dépassé (+ purge Plik amont).
 *  2. Prome les uploads inactifs de plus de 7 jours (tenue du fichier).
 *
 * Note : la détection des téléchargements OneShot se fait dans server.js
 * (événement émis à la fermeture du flux, marqueur anti-doublon) car TOUS
 * les téléchargements passent par la passerelle (Plik n'est jamais exposé).
 * Sonder Plik avec GET déclencherait la consommation OneShot du fichier.
 */
async function sweepOnce(store, plik) {
  const now = Date.now();
  let dirty = false;

  for (const upload of store.listActiveUploads()) {
    if (new Date(upload.expiresAt).getTime() > now) continue;
    const tenant = store.getTenant(upload.tenantId);

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
  }

  // Tenue du fichier : purge des entrées inactives de plus de 7 jours.
  if (store.purgeOldUploads(7 * 24 * 3600 * 1000) > 0) dirty = true;

  if (dirty) store.touch();
}

function startJanitor(store, plik) {
  let sweeping = false;
  const timer = setInterval(async () => {
    if (sweeping) return; // pas de chevauchement
    sweeping = true;
    try {
      await sweepOnce(store, plik);
    } catch (err) {
      console.error(`[janitor] ${err.message}`);
    } finally {
      sweeping = false;
    }
  }, 30000);

  return function stopJanitor() {
    clearInterval(timer);
  };
}

module.exports = { startJanitor, sweepOnce };
