FROM node:20-alpine

WORKDIR /app

# Dependances de production uniquement (pas de paquets de compilation nécessaires :
# toutes les dependances sont en JavaScript pur, compatibles avec musl/Alpine).
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# Copie le code source et les fichiers statiques
COPY server.js ./
COPY public ./public

# Crée le repertoire pour la base SQLite (utilisateur non-root doit pouvoir ecrire)
RUN mkdir -p /app/data

# Execute en tant qu'utilisateur non-root (bonne pratique sur Alpine en production)
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
RUN chown -R appuser:appgroup /app/data
USER appuser

EXPOSE 3999

# Variables d'environnement par défaut (surchargeables via docker-compose / .env)
ENV PORT=3999
ENV NODE_ENV=production
ENV LOCAL_AUTH_ENABLED=true
ENV SQLITE_DB_PATH=/app/data/cdr_users.sqlite
ENV SESSION_SECRET=changez-moi-en-production-une-chaine-longue-et-aleatoire

CMD ["node", "server.js"]
