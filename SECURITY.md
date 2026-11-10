# Security Policy — Plik-SaaS

## 1. Modèle de menace

Actif protégé | Menace | Mesure
---|---|---
Fichiers clients | Accès non autorisé | Liens signés (`dl_*`, secrets 40 chars, hash scrypt), refus hors TTL (410)
Clés API | Vol / bruteforce | Hash scrypt + salt, affichage unique, révocation instantanée, rate limiting
Jeton widget | Réutilisation croisée | Lié à **un seul** upload (`wt_<uploadId>_<secret>`), hash côté serveur
Webhooks | Faux événements | HMAC-SHA256 (`X-Saas-Signature`) vérifiable par l'éditeur
Passerelle | SSRF via webhookUrl | HTTPS obligatoire, résolution DNS, IP publiques uniquement
Stockage | Indisponibilité | Plik multi-backend (S3 Scaleway), purge automatique TTL
VPS | Compromission | Durcissement ufw/ssh, containers non-root, secrets en `.env` (0600)

## 2. Réseau

- Exposition publique unique : Caddy (443/TLS auto, HSTS).
- Réseau Docker `frontend` : Caddy ↔ gateway. `backend` : gateway ↔ plik (aucune exposition).
- API admin : `127.0.0.1:8081` **uniquement** (inaccessible de l'extérieur même si ufw est mal réglé).
- ufw : entrées limitées à 22 (rate limit) et 443 ; sorties 80/443 (MAJ, DNS, webhooks).
- `deploy.sh --ssh-harden` : auth par clé seulement (PasswordAuthentication no), fail2ban.

## 3. Jetons et secrets

Format | Portée | Stockage
---|---|---
`pk_<id>_<secret40>` | Tout le tenant | Secret : jamais stocké (scrypt:salt:hash)
`wt_<uploadId>_<secret40>` | Un seul upload | Idem
`dl_<uploadId>.<fileId>_<secret40>` | Un seul fichier | Idem
`ADMIN_TOKEN` | Opérations admin | `.env` (0600), ≥ 32 caractères, vérifié à temps constant

Génération : `crypto.randomInt` (CSPRNG). Comparaisons : `crypto.timingSafeEqual`.
Rotation recommandée des clés API : 90 jours (double clé pendant la transition).

## 4. Données personnelles (RGPD)

- Contenu des fichiers : **jamais** stocké côté passerelle (flux vers Plik/S3).
- Métadonnées conservées : noms de fichiers, tailles, horodatages, IDs tenant (store.json).
- TTL courts par défaut (1 h) : minimisation des données.
- Suppression : `DELETE /v1/uploads/{id}` (immédiate, amont inclus).
- Sous-traitant stockage : Scaleway (UE, France) ; DPA à signer avec chaque client final.
- Le nom de fichier est assaini (contrôles CRLF/traversée supprimés) avant tout en-tête HTTP.

## 5. Gestion des secrets

- Aucun secret dans le dépôt : `.env.example` contient uniquement des placeholders.
- `.gitignore` exclut `.env`, `plikd.cfg`, `store.json`, `data/`.
- Sur le VPS : `.env` en `chmod 600`, propriétaire root ; jamais dans les images Docker.
- Rotation S3 : clés dédiées par environnement, principe du moindre privilège (lecture/écriture bucket uniquement).

## 6. Exploitation au quotidien

- Rate limiting applicatif (RateLimiter) sur auth, API, création d'uploads + purge mémoire.
- Comptabilité d'un téléchargement **réel** uniquement (fermeture de flux terminée), anti-doublon OneShot.
- Webhooks : file persistante (survit aux redémarrages), 5 tentatives, abandon journalisé.
- Janitor : purge des expirés toutes les 30 s ; Plik applique aussi son propre TTL (défense en profondeur). Le janitor ne fait **jamais** de GET sur les fichiers OneShot (un GET consomme le OneShot côté Plik) : le comptage des téléchargements se fait uniquement via les événements de la passerelle, qui est le seul point d'entrée public.

## 7. Playbook incident

1. **Containment** : `docker compose down` ; si clé compromise : `node admin.js key-revoke <tenantId> <keyId>`.
2. **Éradication** : analyser `docker logs gateway`, journaux Caddy, `store.json` (horodatages).
3. **Restauration** : recréer le VPS depuis `deploy.sh` + secrets sauvegardés (S3 est la source de vérité des fichiers restants).
4. **Notification** : clients affectés < 72 h (RGPD si données personnelles) ; rapport post-mortem sous 7 jours.

## 8. Signalement de vulnérabilités

Contact : security@votre-domaine (à configurer). Réponse visée < 48 h.
Merci de NE PAS ouvrir d'issue publique pour une faille de sécurité.

## 9. Améliorations prévues (roadmap sécurité)

- [ ] Migration store JSON → PostgreSQL (contrôle d'accès, sauvegardes PITR).
- [ ] Chiffrement côté client optionnel (mot de passe du lien, style Firefox Send).
- [x] Suite de tests automatisés (auth, quotas, SSRF, OneShot) : `gateway/test/` (`node --test`).
- [x] CI GitHub Actions : `.github/workflows/test.yml`, exécution à chaque push/PR (Node 20, zéro dépendance) — suite verte.
- [ ] Scan continue des images Docker (Trivy) + audit dépendances (npm audit).
- [ ] Détection d'intrusion (fail2ban avancé ou Wazuh, coût RAM à évaluer).

## 10. Checklist avant mise en production

- [ ] ADMIN_TOKEN généré par `openssl rand -hex 32` (32+ chars) et jamais commité.
- [ ] `.env` en 0600, secrets S3 dédiés au bucket de production.
- [ ] TLS actif (Caddy) + HSTS vérifiés (SSL Labs grade A visé).
- [ ] ufw actif, port 22 limité, `--ssh-harden` appliqué si administration à distance.
- [ ] Sauvegardes : export quotidien chiffré de store.json vers S3 (autre région).
- [ ] Comptes Scaleway/Hetzner protégés par 2FA.
- [ ] Test de restauration effectué au moins une fois.

## 11. Limites connues assumées (MVP)

- Vérification DNS anti-SSRF au moment de l'URL : un rebinding DNS reste
  théoriquement possible ; mitigé par le filtrage egress ufw (sorties 443
  uniquement vers IP publiques) et l'abandon après 5 tentatives.
- Store JSON adapté à ~10k uploads actifs ; migration PostgreSQL planifiée.
- Pas de chiffrement au repos côté S3 (Scaleway gère la durabilité) ; le
  chiffrement applicatif côté client est en roadmap.
