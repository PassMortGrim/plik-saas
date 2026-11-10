# Déploiement sur Oracle Cloud Always Free

Runbook de staging **gratuit** : instance ARM Ampere A1 (Always Free) + stockage S3 Scaleway.
Objectif : valider Plik-SaaS de bout en bout (API, quotas, OneShot, webhooks) avant tout client payant.

> ⚠️ Toujours Free ≠ toujours disponible : les capacités A1 sont parfois épuisées
> dans certaines régions. Réessayez à des heures creuses ou changez de région (Home Region non changeable ensuite, choisissez-en une proche de vos utilisateurs, ex. Paris `eu-paris-1` ou Marseille `eu-marseille-1`).

## 1. Ce que couvre le gratuit

| Ressource | Always Free | Recommandation |
|---|---|---|
| Compute ARM (VM.Standard.A1.Flex) | 4 OCPU + 24 Go RAM au total | 2 OCPU / 12 Go pour cette instance |
| Block storage | 200 Go au total (toutes instances) | Boot volume 100 Go |
| Egress réseau sortant | 10 To/mois | Largement suffisant |
| IP publique réservée | gratuite | Réservez-la (sinon éphémère, change au reboot) |

Le stockage fichiers reste chez Scaleway Object Storage (~0,01 €/Go/mois) : le S3
d'Oracle n'est pas dans le périmètre gratuit (quotas très limités).

## 2. Créer l'instance

1. Console OCI → Compute → Instances → Create instance.
2. Shape : **VM.Standard.A1.Flex**, 2 OCPU, 12 Go RAM (aarch64).
3. Image : **Ubuntu 24.04** ( Canonical Ubuntu 24.04, aarch64).
4. Boot volume : 100 Go (laissez les autres options par défaut).
5. SSH : ajoutez votre clé publique (`~/.ssh/id_ed25519.pub`).
6. Réseau : VCN par défaut avec sous-réseau public. Avant de lancer :
   - **Security List** du sous-réseau → Add Ingress Rules :
     - `22/tcp` — source : **votre IP personnelle uniquement** (`x.x.x.x/32`)
     - `80/tcp` — source `0.0.0.0/0`
     - `443/tcp` — source `0.0.0.0/0`
7. Une fois créée : réservez une **IP publique réservée** et associez-la
   (sinon elle changera au premier reboot).

## 3. Piège n°1 : le pare-feu iptables d'Oracle

Les images Oracle (Ubuntu incluses) embarquent des règles **iptables persistantes**
dans `/etc/iptables/rules.v4` qui bloquent tout sauf le 22, même si la Security
List est ouverte. Symptôme : le ping passe, `curl https://domaine` rien.

```bash
# Sur le VPS :
sudo iptables -L INPUT --line-numbers   # vous verrez des règles REJECT d'Oracle
sudo netfilter-persistent flush          # vide les tables
sudo rm -f /etc/iptables/rules.v4        # empêche la restauration au boot
sudo reboot
```

Ensuite, laissez **ufw** (posé par deploy.sh) gérer le pare-feu local.
Gardez la console série OCI en plan B : une erreur ici vous coupe le SSH.

## 4. Vérifier l'image Docker Plik en arm64

Le Dockerfile officiel de Plik cross-compile arm64 (`crossbuild-essential-arm64`),
l'image `rootgg/plik:latest` est donc normalement multi-arch. Vérifiez AVANT de déployer :

```bash
sudo docker manifest inspect rootgg/plik:latest | grep -A2 architecture
# attendu : "Architecture": "arm64" (et "amd64")
```

- Si `arm64` absent : deux options
  - utiliser une instance **AMD Always Free** (2 × VM.Standard.E2.1.Micro) : trop faible (1 Go RAM) pour du streaming 200 Go, déconseillé ;
  - compiler Plik depuis les sources sur l'instance ARM (`git clone https://github.com/root-gg/plik && cd plik && make docker`) et tagger l'image localement en `rootgg/plik:latest`.

## 5. Déploiement standard

Identique au runbook Hetzner (déploy.sh gère tout) :

```bash
sudo apt update && sudo apt -y upgrade
curl -fsSL https://get.docker.com | sudo sh

sudo mkdir -p /opt/plik-saas && cd /opt/plik-saas
sudo git clone https://github.com/PassMortGrim/plik-saas.git .   # (repo privé : auth GitHub requise)

sudo ./deploy.sh --domain plik.votre-domaine.fr --email vous@exemple.fr \
     --scw-key VOTRE_CLE --scw-secret VOTRE_SECRET --scw-bucket plik-saas-staging \
     --scw-region fr-par --ssh-harden
```

DNS : enregistrement `A` → IP réservée Oracle. Caddy obtient le TLS tout seul.

## 6. Exécuter la suite de tests automatisés

Sur le VPS (Node n'est pas requis sur l'hôte : utilisez le conteneur) :

```bash
cd /opt/plik-saas/gateway
sudo docker compose build gateway
sudo docker compose run --rm gateway node --test test/
```

Couvre : auth (clés, jetons widget, admin), quotas, OneShot (y compris
téléchargement interrompu), SSRF webhooks, persistance store.

## 7. Checklist de validation post-déploiement

```bash
# 1. Santé publique
curl -s https://plik.votre-domaine.fr/v1/health

# 2. Créer un tenant (depuis le VPS)
cd /opt/plik-saas && set -a && source .env && set +a
docker compose exec gateway node src/admin.js tenant-create "Staging" 1000000000

# 3. Upload complet avec la clé obtenue
KEY="pk_..._..."
UP=$(curl -s -X POST https://plik.votre-domaine.fr/v1/uploads \
     -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
     -d '{"filename":"essai.bin","size":11}')
curl -s -X POST "https://plik.votre-domaine.fr/v1/uploads/$(echo $UP | jq -r .uploadId)/files" \
     -H "Authorization: Bearer $KEY" -H "X-Filename: essai.bin" -H "X-File-Size: 11" \
     --data-binary "hello world"

# 4. Lien signé + téléchargement
#    (POST .../links avec le fileId, puis GET de l'URL renvoyée : 200)

# 5. Vérifier S3 : le bucket Scaleway contient l'objet
```

À cocher avant tout usage réel : tests `node --test` verts, upload 100 Mo OK,
OneShot : 2e téléchargement → 410, TTL expiré → 410, webhook de test reçu et
signature `X-Saas-Signature` vérifiée côté récepteur.

## 8. Limites connues du setup Oracle

- CPU A1 partagé (burst) : débit S3 ↔ clients correct, mais surveillance
  nécessaire pour un usage production.
- Une seule AZ, pas de haute dispo : c'est du **staging**, pas de la prod client.
- Le quota egress (10 To/mois) est compté sur le trafic VPS→clients ; le trafic
  S3→VPS transite par le réseau public Scaleway (voir tarifs egress Scaleway).
- Les Always Free sont suspendus si le compte passe en inactif prolongé ou si
  une ressource dépasse le quota : surveillez les emails OCI.
