# Interface web MCP 3CX — Rapports CDR avec authentification Entra ID

Interface web simple pour interroger le serveur MCP 3CX distant et produire des rapports CDR (Call Detail Records), accessible uniquement aux utilisateurs authentifiés via **Microsoft Entra ID**. Le serveur tourne dans un conteneur **Docker**.

## Sommaire

- [Fonctionnement](#fonctionnement)
- [Architecture](#architecture)
- [Authentification Entra ID](#authentification-entra-id)
  - [1. Inscrire l'application dans Entra ID](#1-inscrire-lapplication-dans-entra-id)
  - [2. Configurer les variables d'environnement](#2-configurer-les-variables-denvironnement)
- [Installation et lancement](#installation-et-lancement)
- [Déploiement avec Docker](#deploiement-avec-docker)
- [Utilisation des rapports CDR](#utilisation-des-rapports-cdr)
- [Fichiers](#fichiers)
- [Sécurité](#securite)

## Fonctionnement

L'application est un serveur Express qui fait le pont entre votre navigateur et la base de données PBX 3CX.

- **Avant d'accéder aux rapports CDR**, l'utilisateur doit s'authentifier via son compte Microsoft Entra ID (flux Code d'autorisation OAuth 2.0). Une session est créée et protégée par un cookie `HttpOnly`.
- Une fois connecté, l'utilisateur peut générer une requête SQL sur les CDR (filtres par date, extension, numéro, direction, motif de terminaison) et l'exécuter **directement contre la base PostgreSQL** du 3CX via l'API protégée (`/api/cdr/query`).
- Les résultats s'affichent sous forme de tableau et peuvent être exportés en **CSV ou Excel (.xlsx)**.
- Les résultats peuvent être visualisés sous forme de **graphiques** (barres, ligne, camembert) via Chart.js.
- Un onglet **« Rapport personnalisé »** permet de choisir les colonnes, un groupement (jour, extension, direction, motif, numéro externe...), une agrégation (nombre d'appels, durée totale, durée moyenne) et d'enregistrer la configuration pour la réutiliser plus tard (stockage local du navigateur).
- **Gestion des utilisateurs** : plusieurs comptes peuvent être créés en base PostgreSQL avec un rôle (utilisateur ou administrateur). Le premier compte créé devient automatiquement administrateur. Une page d'administration (`/admin.html`) permet de créer, modifier et supprimer des comptes.
- L'accès aux outils MCP bruts a été retiré : le serveur ne fait plus que l'authentification et les rapports CDR directs sur PostgreSQL.

## Authentification Entra ID

L'accès à la page `/cdr.html` (rapports CDR) et à l'API protégée (`/api/tools`, `/api/call/*`) est réservé aux utilisateurs connectés via Entra ID. La page d'accueil `/index.html` (outils MCP bruts) reste accessible avec le jeton Bearer MCP historique.

### 1. Inscrire l'application dans Entra ID

Rendez-vous sur le portail Microsoft Entra : https://entra.microsoft.com

1. **Identités > Applications > Inscriptions d'applications** → **Nouvelle inscription**.
   - Nom : `3CX CDR Reports` (ou le nom de votre choix).
   - Types de comptes pris en charge : **Comptes dans cet annuaire organisationnel uniquement** (mono-locataire) ou **Comptes dans n'importe quel annuaire organisationnel** (multi-locataire), selon vos besoins.
   - URI de redirection : laissez vide pour l'instant, vous l'ajouterez après.
2. Une fois l'application créée, notez :
   - **ID de locataire (directory / tenant ID)** → `ENTRA_TENANT_ID`
   - **ID d'application (client ID)** → `ENTRA_CLIENT_ID`
3. **Certificats et secrets** → **Nouveau secret client** : créez un secret, notez sa valeur immédiatement → `ENTRA_CLIENT_SECRET`.
4. **Authentification** → **Ajouter une URI de redirection** :
   - Type : **Application web**
   - URI : `http://localhost:3000/auth/callback` (en développement) ou l'URL publique de votre serveur (en production).
5. **Exposition d'une API** (optionnel) : si vous limitez les scopes, ajoutez le scope `User.Read` et accordez le consentement administrateur si nécessaire.

### 2. Configurer les variables d'environnement

Copiez `.env.example` vers `.env` et renseignez les valeurs :

```bash
cp .env.example .env
# éditez .env et renseignez :
#   ENTRA_TENANT_ID, ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET
#   ENTRA_REDIRECT_URI (doit correspondre à celle déclarée dans Entra ID)
#   SESSION_SECRET (changez impérativement la valeur par défaut en production)
#   MCP_3CX_TOKEN (optionnel, pour l'accès historique aux outils bruts)
```

| Variable | Description | Exemple |
|---|---|---|
| `PG_HOST` | Hôte du serveur PostgreSQL 3CX | `localhost` ou `10.0.0.50` |
| `PG_PORT` | Port PostgreSQL | `5432` |
| `PG_USER` | Utilisateur de la base 3CX | `cdr_reader` |
| `PG_PASSWORD` | Mot de passe utilisateur PostgreSQL | `…` |
| `PG_DATABASE` | Nom de la base de données CDR | `cdrdb` |
| `PG_SSL` | Activer le TLS vers PostgreSQL | `false` (mettre `true` si requis) |
| `ENTRA_TENANT_ID` | ID du locataire Entra ID | `12345678-abcd-...` |
| `ENTRA_CLIENT_ID` | ID de l'application Entra ID | `87654321-...` |
| `ENTRA_CLIENT_SECRET` | Secret client généré | `valeur-du-secret` |
| `ENTRA_REDIRECT_URI` | URI de redirection OAuth | `http://localhost:3000/auth/callback` |
| `ENTRA_SCOPES` | Scopes demandés (séparés par des virgules) | `User.Read` |
| `LOCAL_AUTH_ENABLED` | Activer l'authentification locale | `false` (mettre `true` pour activer) |
| `LOCAL_USER` | Identifiant du compte local | `admin` |
| `LOCAL_PASSWORD` | Mot de passe du compte local | `…` |
| `SESSION_SECRET` | Secret de signature des sessions | chaîne longue et aléatoire |
| `MCP_3CX_URL` | URL du serveur MCP 3CX | `https://capb-3cx.../mcp` |
| `MCP_3CX_TOKEN` | Jeton Bearer MCP 3CX (historique) | optionnel |
| `PORT` | Port HTTP du conteneur | `3000` |

> ⚠️ L'URI de redirection configurée dans Entra ID **doit correspondre exactement** à `ENTRA_REDIRECT_URI`, sinon Microsoft rejette la connexion (« URI de redirection non correspondante »).

### Authentification locale (alternative à Entra ID)

Si vous ne souhaitez pas utiliser Microsoft Entra ID, vous pouvez activer une authentification locale simple (un seul compte utilisateur/mot de passe stocké côté serveur) :

1. Dans `.env`, définissez :
   ```
   LOCAL_AUTH_ENABLED=true
   LOCAL_USER=VOTRE_UTILISATEUR
   LOCAL_PASSWORD=VOTRE_MOT_DE_PASSE
   ```
2. Le mot de passe est haché (PBKDF2, 100 000 itérations) avec un sel aléatoire au démarrage du serveur.
3. La page de connexion (`/login.html`) propose alors le formulaire « Compte local » en plus (ou à la place) du bouton Microsoft Entra ID.

> ⚠️ L'authentification locale stocke l'identifiant et le mot de passe en clair dans `.env`. Changez `SESSION_SECRET` par une valeur secrète aléatoire en production et protégez l'accès à ce fichier.

## Installation et lancement (sans Docker)

```bash
cd C:\temp\3cx-web-interface

# 1. Installez les dépendances (y compris msal-node et express-session pour Entra ID)
npm install

# 2. Créez le fichier d'environnement
cp .env.example .env
# éditez .env avec vos valeurs Entra ID

# 3. Lancez le serveur
# PowerShell
$env:NODE_ENV="development"
node server.js

# Git Bash / WSL / Linux
export NODE_ENV=development
node server.js
```

Puis ouvrez votre navigateur sur : **http://localhost:3000**

- **Page d'accueil / outils MCP** : http://localhost:3000
- **Rapports CDR (nécessite Entra ID)** : http://localhost:3000/cdr.html

En mode développement (`NODE_ENV != production`), les cookies de session ne sont pas marqués `Secure`, ce qui permet le fonctionnement en HTTP pur sur localhost.

## Déploiement avec Docker

### 1. Construire et lancer

```bash
cd C:\temp\3cx-web-interface

# Copiez et éditez le fichier d'environnement
cp .env.example .env
# éditez .env (ENTRA_*, SESSION_SECRET, MCP_3CX_TOKEN...)

# Construire et démarrer le conteneur
docker-compose up --build -d
```

### 2. Accéder à l'interface

- Outils MCP : http://localhost:3000
- Rapports CDR : http://localhost:3000/cdr.html

### 3. Arrêter

```bash
docker-compose down
```

### Variables d'environnement

| Variable | Description | Défaut |
|---|---|---|
| `PORT` | Port HTTP du conteneur | `3000` |
| `NODE_ENV` | Environnement (`production` active les cookies `Secure`) | — |
| `MCP_3CX_URL` | URL du serveur MCP 3CX distant | `https://capb-3cx.communaute-paysbasque.fr/mcp` |
| `MCP_3CX_TOKEN` | Jeton Bearer d'authentification 3CX | (requis pour les outils bruts) |
| `ENTRA_TENANT_ID` | ID locataire Entra ID | (requis) |
| `ENTRA_CLIENT_ID` | ID application Entra ID | (requis) |
| `ENTRA_CLIENT_SECRET` | Secret client Entra ID | (requis) |
| `ENTRA_REDIRECT_URI` | URI de redirection OAuth | `http://localhost:3000/auth/callback` |
| `ENTRA_SCOPES` | Scopes OAuth | `User.Read` |
| `SESSION_SECRET` | Secret de signature des sessions | `changez-moi-en-production` |

> En production, définissez `NODE_ENV=production` et remplacez `SESSION_SECRET` par une chaîne aléatoire longue. Servez l'application derrière un reverse proxy TLS (HTTPS) et utilisez l'URI de redirection publique dans Entra ID.

## Configuration de la base PostgreSQL 3CX

Les rapports CDR lisent directement dans la base PostgreSQL du serveur 3CX. Vous devez donc :

1. Créer un utilisateur PostgreSQL dédié en lecture seule sur la base 3CX (ex: `cdr_reader`), avec un mot de passe fort.
2. Lui accorder l'accès en lecture aux tables `public.cdroutput` et `public.cdrbilling` (jointes par `cdr_id`).
3. Vous assurer que le conteneur/l'application peut joindre le serveur PostgreSQL sur l'hôte et le port configurés (`PG_HOST`, `PG_PORT`).
4. Si votre PostgreSQL exige le TLS (par exemple Azure Database for PostgreSQL), définissez `PG_SSL=true`.

Exemple de requête SQL exécutée par le rapport (générée automatiquement depuis l'interface) :

```sql
SELECT
  c.cdr_started_at AS debut_appel,
  c.cdr_answered_at AS heure_reponse,
  c.cdr_ended_at AS fin_appel,
  c.source_dn_number AS poste_appelant,
  c.destination_dn_number AS poste_appele,
  ...
FROM public.cdroutput c
LEFT JOIN public.cdrbilling b ON b.cdr_id = c.cdr_id
WHERE c.cdr_started_at >= $1
ORDER BY c.cdr_started_at DESC
LIMIT 100;
```

Les valeurs des filtres (dates, extension, numéro, etc.) sont passées en paramètres séparés, ce qui protège contre les injections SQL.

## Utilisation des rapports CDR

L'interface propose deux onglets :

### Onglet « Détail des appels »

1. Connectez-vous avec votre compte Entra ID (ou le compte local si l'authentification locale est activée).
2. Remplissez les critères de recherche (dates, extension, numéro externe, direction, motif de terminaison, limite).
3. La requête SQL se génère automatiquement dans l'encadré « Requête SQL générée ».
4. Cliquez sur **Exécuter le rapport** : la requête est envoyée directement à la base PostgreSQL du 3CX via l'API protégée (`/api/cdr/query`) et les résultats s'affichent en tableau.
5. Vous pouvez copier le SQL, ou exporter l'ensemble des résultats en **CSV** ou **Excel (.xlsx)**.

### Onglet « Rapport personnalisé »

Cet onglet vous permet de créer votre propre rapport :

1. Sélectionnez les **colonnes** à afficher.
2. Choisissez un **groupement** (aucun, par jour, par extension, par direction, par motif de fin, par numéro externe).
3. Choisissez l'**indicateur à agréger** (nombre d'appels, durée totale, durée moyenne) et le **type de graphique** (barres, ligne, camembert, aucun).
4. Ajoutez éventuellement des filtres (dates, extension, numéro externe, direction, motif de terminaison, limite).
5. La requête SQL s'affiche automatiquement. Cliquez sur **Générer le rapport** pour exécuter.
6. Les résultats s'affichent en tableau avec le graphique associé. Exportez en **CSV** ou **Excel (.xlsx)**.
7. Cliquez sur **Enregistrer le rapport** pour garder cette configuration dans votre navigateur (localStorage) et la recharger plus tard.

Les dates sont en heure locale du serveur 3CX. Si vous ne saisissez pas de dates, les 7 derniers jours sont utilisés par défaut.

> ⚠️ Les rapports enregistrés sont stockés **uniquement dans votre navigateur** (localStorage). Ils ne sont pas partagés entre utilisateurs ni entre navigateurs.

## Gestion des utilisateurs

L'authentification locale utilise une table `cdr_users` dans votre base PostgreSQL 3CX. Cette table est créée automatiquement au premier démarrage du serveur.

### Rôles

| Rôle | Droits |
|------|--------|
| `user` | Accès aux rapports CDR (`/cdr.html`) |
| `admin` | Accès aux rapports CDR + page d'administration (`/admin.html`) pour gérer les utilisateurs |

Le **premier compte créé devient automatiquement administrateur**. Les comptes suivants sont des utilisateurs standards, sauf si un administrateur les promeut via `/admin.html`.

### Activer l'authentification locale

Dans `.env` :

```
LOCAL_AUTH_ENABLED=true
```

Puis créez vos premiers comptes depuis `http://localhost:3000/admin.html` (une fois connecté avec le premier compte admin).

### Variables d'environnement pour l'authentification

| Variable | Description |
|----------|-------------|
| `LOCAL_AUTH_ENABLED` | Mettre `true` pour activer la connexion locale |
| `SESSION_SECRET` | Clé secrète pour signer les sessions de connexion (impératif en production) |

## Fichiers

| Fichier | Rôle |
|---|---|
| `server.js` | Serveur Express + authentification Entra ID (msal-node, express-session) + rapports CDR directs sur PostgreSQL |
| `public/index.html` | Page d'accueil avec liens vers les outils |
| `public/login.html` | Page de connexion (Entra ID et/ou compte local) |
| `public/cdr.html` | Interface Rapports CDR (protégée par authentification) |
| `public/admin.html` | Administration des utilisateurs (réservée aux administrateurs) |
| `package.json` / `package-lock.json` | Dépendances et scripts |
| `Dockerfile` | Image Docker du serveur |
| `docker-compose.yml` | Orchestration Docker |
| `.env.example` | Exemple de variables d'environnement |
| `README.md` | Ce document |

## Sécurité

- Les sessions d'authentification sont stockées dans des cookies `HttpOnly` (et `Secure` en production).
- Les mots de passe des utilisateurs locaux sont hashés (PBKDF2, 100 000 itérations) avec un sel unique par utilisateur dans la table `cdr_users`.
- Ce proxy est destiné à un usage interne. Ne l'exposez pas directement sur Internet sans ajout d'une authentification et de TLS appropriés (reverse proxy, WAF, etc.).
- La variable `SESSION_SECRET` doit être modifiée par une valeur secrète aléatoire en production.
- Le fichier `.env` contient des mots de passe : il est ignoré par git (`.gitignore`) et ne doit **jamais** être commité.
