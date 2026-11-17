# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Administrateur système / réseau. Situation : poste de travail sur le réseau interne de l'entreprise, usage quotidien récurrent depuis un écran de bureau. Job : générer des rapports d'exploitation à partir des CDR du PBX 3CX, dépanner, et accéder aux données d'appels pour l'exploitation.

## Product Purpose

Produire des rapports CDR (Call Detail Records) du serveur 3CX, accessibles uniquement aux utilisateurs authentifiés (Microsoft Entra ID ou compte local), tournés dans un conteneur Docker sur Alpine Linux, et lisant directement la base PostgreSQL externe du 3CX (hôte 10.254.0.67). L'outil remplace un proxy MCP par une connexion directe et ajoute une authentification locale en plus d'Entra ID.

## Positioning

Connexion directe PostgreSQL aux CDR 3CX sans intermédiaire MCP ; authentification double (Entra ID via msal-node, et locale via SQLite sql.js) avec gestion des rôles utilisateur/admin ; rapports personnalisables avec export Excel/CSV et graphiques Chart.js ; déploiement Alpine Linux conteneurisé, port externe 3999.

## Operating Context

Réseau interne de l'entreprise ; poste de travail bureautique ; accès quotidien récurrent ; conteneur Docker sur Alpine Linux ; base PostgreSQL 3CX jointe directement sur 10.254.0.67:5432.

## Capabilities and Constraints

- Rapports CDR détaillés et personnalisés (filtres date, extension, numéro, direction, motif de terminaison ; groupements et agrégations).
- Export des résultats en CSV et Excel (.xlsx) ; graphiques barres/ligne/camembert via Chart.js.
- Authentification Entra ID (flux code d'autorisation, session cookie HttpOnly 8h).
- Authentification locale alternative, utilisateurs stockés en base SQLite (data/cdr_users.sqlite), hashage PBKDF2 100 000 itérations, premier compte créé = administrateur.
- Gestion des utilisateurs (création, modification, suppression, rôles) réservée aux administrateurs via /admin.html.
- Connexion directe à la base PostgreSQL 3CX via node-postgres (pg) pour les requêtes CDR uniquement.
- Accès restreint au PostgreSQL (réseau interne ; authentification renforcée attendue : MFA, logs d'accès).
- Déploiement Docker Alpine (node:20-alpine, utilisateur non-root, dépendances JavaScript pur), port externe 3999 mappé sur 3000 interne.
- Stockage des rapports personnalisés en localStorage du navigateur (non partagés entre utilisateurs ni entre navigateurs).
- Indécis : aucune exigence MFA ou logs d'audit formelle n'a encore été confirmée comme contrainte produit.

## Brand Commitments

Aucun nom de marque, charte graphique ou actif visuel n'a été déclaré contraignant pour ce produit.

## Evidence on Hand

Dépôt C:\temp\3cx-web-interface : server.js, public/ (index.html, login.html, cdr.html, admin.html), package.json, package-lock.json, Dockerfile, docker-compose.yml, .env.example, README.md, .gitignore. Aucune donnée de test ni capture d'écran n'a été fournie.

## Product Principles

- L'authentification précède tout accès aux rapports : aucune page CDR ni API de requête n'est atteignable sans session valide.
- La base PostgreSQL 3CX est l'unique source de vérité des CDR ; SQLite ne sert qu'à la gestion des comptes locaux.
- Aucun secret ni mot de passe n'est commis dans le dépôt (.env ignoré par git).
- Le produit reste un outil interne : pas d'exposition directe sur Internet sans reverse proxy et TLS.
- Fonctionnement sans compilation native sur Alpine (dépendances JavaScript pur).

## Accessibility & Inclusion

Aucune exigence d'accessibilité spécifique n'a été établie pour ce produit.
