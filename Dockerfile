# Image de production — Carnet de comptes (100% gratuit à héberger)
FROM node:22-alpine

WORKDIR /app

# Dépendances (seulement Express)
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# Code
COPY . .

ENV NODE_ENV=production
ENV PORT=3000
# Les données (base SQLite, photos, récaps) vivent sur le disque persistant.
ENV DATA_DIR=/data

EXPOSE 3000
CMD ["node", "server/index.js"]
