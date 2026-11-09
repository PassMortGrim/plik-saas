#!/usr/bin/env bash
#
# deploy.sh — Installation et déploiement idempotent de Plik-SaaS.
#
# Usage :
#   sudo ./deploy.sh --domain plik.exemple.fr --email admin@exemple.fr \
#        --scw-key XXX --scw-secret YYY --scw-bucket plik-saas --scw-region fr-par \
#        [--ssh-harden] [--api-url http://127.0.0.1:8080] [--public-url https://plik.exemple.fr]
#
# Le script :
#   1. vérifie les dépendances (docker, openssl, curl)
#   2. prépare .env et plikd.cfg avec des secrets générés
#   3. construit et démarre les containers
#   4. vérifie la santé de l'ensemble
# Idempotent : relançable sans casser une installation saine.

set -euo pipefail

DOMAIN=""
EMAIL=""
SCW_KEY=""
SCW_SECRET=""
SCW_BUCKET="plik-saas"
SCW_REGION="fr-par"
SSH_HARDEN="false"
API_URL="http://127.0.0.1:8080"
PUBLIC_URL=""

log()  { printf '\033[1;32m[deploy]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[deploy]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[deploy]\033[0m ERREUR : %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)      DOMAIN="$2"; shift 2 ;;
    --email)       EMAIL="$2"; shift 2 ;;
    --scw-key)     SCW_KEY="$2"; shift 2 ;;
    --scw-secret)  SCW_SECRET="$2"; shift 2 ;;
    --scw-bucket)  SCW_BUCKET="$2"; shift 2 ;;
    --scw-region)  SCW_REGION="$2"; shift 2 ;;
    --ssh-harden)  SSH_HARDEN="true"; shift ;;
    --api-url)     API_URL="$2"; shift 2 ;;
    --public-url)  PUBLIC_URL="$2"; shift 2 ;;
    *) die "Argument inconnu : $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "Lancez avec sudo (écriture dans /opt et systemctl)."
[[ -n "$DOMAIN" && -n "$EMAIL" && -n "$SCW_KEY" && -n "$SCW_SECRET" ]] || \
  die "Arguments requis : --domain --email --scw-key --scw-secret (voir en-tête du script)."

APP_DIR="/opt/plik-saas"
PUBLIC_URL="${PUBLIC_URL:-https://${DOMAIN}}"

# ---------------------------------------------------------------------------
# 1. Dépendances (curl et openssl sont vérifiés explicitement)
# ---------------------------------------------------------------------------
if ! command -v curl >/dev/null 2>&1; then
  log "Installation de curl..."
  apt-get update -qq && apt-get install -y -qq curl
fi
if ! command -v openssl >/dev/null 2>&1; then
  log "Installation d'openssl..."
  apt-get install -y -qq openssl
fi

if ! command -v docker >/dev/null 2>&1; then
  log "Installation de Docker..."
  curl -fsSL https://get.docker.com | sh
fi
if ! docker compose version >/dev/null 2>&1; then
  die "Docker Compose v2 requis (plugin 'docker compose'). Installez docker-compose-plugin."
fi
log "Docker $(docker --version | cut -d' ' -f3 | tr -d ',') et Compose OK."

# ---------------------------------------------------------------------------
# 2. Fichiers applicatifs
# ---------------------------------------------------------------------------
log "Déploiement des fichiers dans ${APP_DIR}..."
mkdir -p "${APP_DIR}/data"
if [[ "$(dirname "$(readlink -f "$0")")" != "${APP_DIR}" ]]; then
  cp -r "$(dirname "$(readlink -f "$0")")/." "${APP_DIR}/"
fi
cd "${APP_DIR}"

# ---------------------------------------------------------------------------
# 3. Secrets : générés une seule fois, préservés aux relances
# ---------------------------------------------------------------------------
if [[ ! -f .env ]]; then
  log "Génération de .env (secrets aléatoires)..."
  ADMIN_TOKEN="$(openssl rand -hex 32)"
  cat > .env <<EOF
# Généré par deploy.sh — chmod 600, ne jamais commiter.
ADMIN_TOKEN=${ADMIN_TOKEN}
DOMAIN=${DOMAIN}
PLIK_URL=http://plik:8080
PUBLIC_BASE_URL=${PUBLIC_URL}
API_URL=${API_URL}
MAX_FILE_BYTES=214748364800
MAX_TTL_SECONDS=2592000
SCW_ACCESS_KEY=${SCW_KEY}
SCW_SECRET_KEY=${SCW_SECRET}
SCW_BUCKET=${SCW_BUCKET}
SCW_REGION=${SCW_REGION}
EOF
  chmod 600 .env
  log "ADMIN_TOKEN généré : conservez-le hors du serveur (gestionnaire de secrets)."
else
  log ".env existant : préservé (les secrets ne sont pas régénérés)."
  # Applique quand même le domaine si changé.
  sed -i "s#^PUBLIC_BASE_URL=.*#PUBLIC_BASE_URL=${PUBLIC_URL}#" .env || true
  sed -i "s#^DOMAIN=.*#DOMAIN=${DOMAIN}#" .env || true
  chmod 600 .env
fi

if [[ ! -f plikd.cfg ]]; then
  log "Génération de plikd.cfg depuis le template..."
  SCW_ENDPOINT="s3.${SCW_REGION}.scw.cloud"
  sed -e "s#__SCW_ENDPOINT__#${SCW_ENDPOINT}#" \
      -e "s#__SCW_ACCESS_KEY__#${SCW_KEY}#" \
      -e "s#__SCW_SECRET_KEY__#${SCW_SECRET}#" \
      -e "s#__SCW_BUCKET__#${SCW_BUCKET}#" \
      -e "s#__SCW_REGION__#${SCW_REGION}#" \
      plikd.cfg.template > plikd.cfg
  chmod 600 plikd.cfg
else
  log "plikd.cfg existant : préservé."
fi

# ---------------------------------------------------------------------------
# 4. Pare-feu (ufw) — sécurité des biens et des personnes d'abord
# ---------------------------------------------------------------------------
if command -v ufw >/dev/null 2>&1; then
  log "Configuration ufw (SSH limité, 80/443 ouverts)..."
  ufw default deny incoming
  ufw default allow outgoing
  ufw limit 22/tcp   >/dev/null 2>&1 || true
  ufw allow 80/tcp  >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  ufw --force enable >/dev/null 2>&1 || true
else
  warn "ufw absent : installez-le (apt install ufw) et relancez."
fi

if [[ "$SSH_HARDEN" == "true" ]]; then
  log "Durcissement SSH : authentification par clé uniquement."
  # refuse les connexions par mot de passe
  if grep -qE '^#?PasswordAuthentication' /etc/ssh/sshd_config; then
    sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
  else
    echo 'PasswordAuthentication no' >> /etc/ssh/sshd_config
  fi
  if grep -qE '^#?PermitRootLogin' /etc/ssh/sshd_config; then
    sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
  fi
  sshd -t && systemctl reload ssh || warn "sshd_config non rechargé : vérifiez manuellement."
  command -v fail2ban-client >/dev/null 2>&1 || apt-get install -y -qq fail2ban || true
  warn "Durcissement SSH appliqué : assurez-vous d'avoir une clé valide AVANT de vous déconnecter."
fi

# ---------------------------------------------------------------------------
# 5. Build et démarrage
# ---------------------------------------------------------------------------
log "Construction et démarrage des containers..."
docker compose build --pull
docker compose up -d

# ---------------------------------------------------------------------------
# 6. Vérifications de santé
# ---------------------------------------------------------------------------
log "Attente du démarrage (30 s max)..."
HEALTH_OK="false"
for _ in $(seq 1 30); do
  if docker compose exec -T gateway wget -q -O- http://plik:8080/health >/dev/null 2>&1; then
    HEALTH_OK="true"; break
  fi
  sleep 1
done
[[ "$HEALTH_OK" == "true" ]] || die "Plik ne répond pas dans le réseau interne. Logs : docker compose logs plik"

if curl -fsS "http://127.0.0.1:8080/v1/health" >/dev/null 2>&1; then
  log "Passerelle saine sur http://127.0.0.1:8080/v1/health"
else
  die "Passerelle injoignable en local. Logs : docker compose logs gateway"
fi

log "Déploiement terminé."
log "Prochaines étapes :"
log "  1. Créez un tenant : docker compose exec gateway node src/admin.js tenant-create \"Client\" 500"
log "     (avec ADMIN_TOKEN chargé depuis .env : set -a; source .env; set +a)"
log "  2. DNS : A record ${DOMAIN} -> IP du serveur (Caddy obtient le TLS automatiquement)."
log "  3. Documentation : docs/index.md — sécurité : SECURITY.md"
