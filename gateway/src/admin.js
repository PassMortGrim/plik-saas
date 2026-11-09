#!/usr/bin/env node
'use strict';

/**
 * CLI d'administration de la passerelle Plik-SaaS.
 * Cible l'API admin locale (http://127.0.0.1:8081) avec le token admin.
 *
 * Usage :
 *   node admin.js tenant-create <nom> [quotaGo] [webhookUrl] [origines=virgules]
 *   node admin.js tenant-list
 *   node admin.js key-create <tenantId> [nom]
 *   node admin.js key-revoke <tenantId> <keyId>
 *   node admin.js webhook-test <tenantId>
 *   node admin.js health
 *
 * Le token admin vient de la variable d'environnement ADMIN_TOKEN
 * (chargez d'abord le .env du serveur).
 */

const ADMIN_URL = process.env.ADMIN_URL || 'http://127.0.0.1:8081';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

if (!ADMIN_TOKEN) {
  console.error('ADMIN_TOKEN manquant : sourcez .env ou exportez la variable.');
  process.exit(1);
}

async function call(method, route, body) {
  const res = await fetch(`${ADMIN_URL}${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Token': ADMIN_TOKEN,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`Erreur HTTP ${res.status} : ${data.error || res.statusText}`);
    process.exit(1);
  }
  return data;
}

const [cmd, ...args] = process.argv.slice(2);

async function main() {
  switch (cmd) {
    case 'tenant-create': {
      const [name, quotaGo, webhookUrl, origins] = args;
      if (!name) {
        console.error('Usage : tenant-create <nom> [quotaGo] [webhookUrl] [origines virgules]');
        process.exit(1);
      }
      const data = await call('POST', '/tenants', {
        name,
        quotaBytesPerMonth: quotaGo ? Math.round(parseFloat(quotaGo) * 1024 ** 3) : 0,
        webhookUrl: webhookUrl || '',
        webhookSecret: undefined, // genere par le serveur si absent
        allowedOrigins: origins ? origins.split(',').map((s) => s.trim()) : [],
      });
      console.log('Tenant cree :');
      console.log(`  id     : ${data.tenant.id}`);
      console.log(`  nom    : ${data.tenant.name}`);
      console.log('\nCle API (a conserver precieusement, affichee une seule fois) :');
      console.log(`  ${data.apiKey}\n`);
      break;
    }
    case 'tenant-list': {
      const data = await call('GET', '/tenants');
      for (const t of data.tenants) {
        console.log(`- ${t.name} (${t.id})`);
        console.log(`  quota : ${(t.quotaBytesPerMonth / 1024 ** 3).toFixed(1)} Go/mois`);
        console.log(`  usage : in ${(t.usage.bytesIn / 1024 ** 3).toFixed(2)} Go / out ${(t.usage.bytesOut / 1024 ** 3).toFixed(2)} Go`);
        console.log(`  webhook : ${t.webhookUrl || '(aucun)'}`);
        console.log(`  cles : ${t.keys.length}`);
        for (const k of t.keys) {
          console.log(`    - ${k.name} (${k.id})${k.revokedAt ? ' [REVOQUEE]' : ''}`);
        }
      }
      break;
    }
    case 'key-create': {
      const [tenantId, name] = args;
      if (!tenantId) {
        console.error('Usage : key-create <tenantId> [nom]');
        process.exit(1);
      }
      const data = await call('POST', '/keys', { tenantId, name: name || 'cli' });
      console.log(`Nouvelle cle API (affichee une seule fois) :\n  ${data.apiKey}\n`);
      break;
    }
    case 'key-revoke': {
      const [tenantId, keyId] = args;
      if (!tenantId || !keyId) {
        console.error('Usage : key-revoke <tenantId> <keyId>');
        process.exit(1);
      }
      const data = await call('POST', '/revoke', { tenantId, keyId });
      console.log(data.revoked ? 'Cle revoquee.' : 'Cle introuvable.');
      break;
    }
    case 'webhook-test': {
      const [tenantId] = args;
      if (!tenantId) {
        console.error('Usage : webhook-test <tenantId>');
        process.exit(1);
      }
      const data = await call('POST', '/webhook-test', { tenantId });
      console.log(data.queued ? `Evenement de test empile (${data.eventId}).` : 'Aucun webhook configure.');
      break;
    }
    case 'health': {
      const data = await call('GET', '/health');
      console.log(JSON.stringify(data, null, 2));
      break;
    }
    default:
      console.log(
        [
          'Commandes :',
          '  tenant-create <nom> [quotaGo] [webhookUrl] [origines]',
          '  tenant-list',
          '  key-create <tenantId> [nom]',
          '  key-revoke <tenantId> <keyId>',
          '  webhook-test <tenantId>',
          '  health',
        ].join('\n')
      );
  }
}

main().catch((err) => {
  console.error(`Echec : ${err.message}`);
  process.exit(1);
});
