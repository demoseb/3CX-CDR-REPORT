FROM node:20-alpine

WORKDIR /app

# Dependances de production uniquement (pas de paquets de compilation nécessaires :
# toutes les dependances sont en JavaScript pur, compatibles avec musl/Alpine).
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# Copie le code source et les fichiers statiques
COPY server.js ./
COPY public ./public

# Execute en tant qu'utilisateur non-root (bonne pratique sur Alpine en production)
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

EXPOSE 3000

# Variables d'environnement par défaut (surchargeables via docker-compose / .env)
ENV PORT=3000
ENV NODE_ENV=production
ENV MCP_3CX_URL=https://capb-3cx.communaute-paysbasque.fr/mcp
ENV MCP_3CX_TOKEN=

# Authentification Entra ID (Microsoft Identity Platform)
ENV ENTRA_TENANT_ID=
ENV ENTRA_CLIENT_ID=
ENV ENTRA_CLIENT_SECRET=
ENV ENTRA_REDIRECT_URI=http://localhost:3000/auth/callback
ENV ENTRA_SCOPES=User.Read
ENV SESSION_SECRET=changez-moi-en-production

CMD ["node", "server.js"]
