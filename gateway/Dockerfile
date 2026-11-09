FROM node:20-alpine

WORKDIR /app

# Aucune dépendance npm : uniquement la bibliothèque standard.
COPY src/ ./src/
COPY public/ ./public/

# Données persistantes (store.json) accessibles à l'utilisateur non-root.
RUN mkdir -p /app/data && chown -R node:node /app

USER node
ENV NODE_ENV=production

EXPOSE 8080 8081

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/v1/health || exit 1

CMD ["node", "src/index.js"]
