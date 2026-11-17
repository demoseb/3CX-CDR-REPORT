import express from 'express';
import session from 'express-session';
import crypto from 'crypto';
import { createServer } from 'http';
import { Pool } from 'pg';
import { ConfidentialClientApplication } from '@azure/msal-node';
import fs from 'fs';
import path from 'path';

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================================
// Configuration Entra ID (Microsoft Identity Platform)
// ============================================================================
const ENTRA_TENANT_ID = process.env.ENTRA_TENANT_ID || '';
const ENTRA_CLIENT_ID = process.env.ENTRA_CLIENT_ID || '';
const ENTRA_CLIENT_SECRET = process.env.ENTRA_CLIENT_SECRET || '';
const ENTRA_AUTHORITY = 'https://login.microsoftonline.com/' + ENTRA_TENANT_ID;
const ENTRA_REDIRECT_URI = process.env.ENTRA_REDIRECT_URI || 'http://localhost:' + PORT + '/auth/callback';
const ENTRA_SCOPES = (process.env.ENTRA_SCOPES || 'User.Read').split(',').map(s => s.trim()).filter(Boolean);
const SESSION_SECRET = process.env.SESSION_SECRET || 'changez-moi-en-production';

// ============================================================================
// Configuration authentification locale (complement d'Entra ID)
// Les utilisateurs sont stockees dans une base SQLite locale (fichier cdr_users.sqlite)
// ============================================================================
const LOCAL_AUTH_ENABLED = process.env.LOCAL_AUTH_ENABLED === 'true';
const SQLITE_DB_PATH = process.env.SQLITE_DB_PATH || path.join(process.cwd(), 'data', 'cdr_users.sqlite');

// Helpers de hashage PBKDF2 par utilisateur
function generateSalt() {
  return crypto.randomBytes(16).toString('hex');
}
function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
}

// Base SQLite pour les utilisateurs locaux (pure JavaScript/WASM, compatible Alpine sans compilation native)
let sqlDb = null;
let sqlInitialized = false;

async function initSqlDb() {
  if (sqlInitialized) return;
  const initSqlJs = (await import('sql.js')).default;
  const SQL = await initSqlJs({
    locateFile: (file) => {
      return new URL('file:///' + process.cwd() + '/node_modules/sql.js/dist/' + file).href;
    },
  });

  // S'assurer que le dossier existe
  const dbDir = path.dirname(SQLITE_DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  // Ouvrir ou creer la base SQLite
  if (fs.existsSync(SQLITE_DB_PATH)) {
    const filebuffer = fs.readFileSync(SQLITE_DB_PATH);
    sqlDb = new SQL.Database(filebuffer);
  } else {
    sqlDb = new SQL.Database();
    sqlDb.run(`
      CREATE TABLE IF NOT EXISTS cdr_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(20) DEFAULT 'user',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    fs.writeFileSync(SQLITE_DB_PATH, sqlDb.export());
  }
  sqlInitialized = true;
  console.log('Base SQLite utilisateurs initialisee : ' + SQLITE_DB_PATH);
}

function findUserByUsername(username) {
  if (!sqlDb) return null;
  const stmt = sqlDb.prepare('SELECT id, username, password_hash, role, created_at FROM cdr_users WHERE username = ?');
  const row = stmt.get(username);
  stmt.free();
  return row || null;
}

// Verifie un mot de passe contre un utilisateur de la base SQLite.
// Le password_hash stocke au format "sel:hash".
function verifyLocalUser(username, password) {
  const user = findUserByUsername(username);
  if (!user) return null;
  const parts = user.password_hash.split(':');
  if (parts.length !== 2) return null;
  const hash = hashPassword(password, parts[0]);
  if (hash !== parts[1]) return null;
  return user;
}

function saveSqlDb() {
  if (sqlDb && sqlInitialized) {
    try {
      fs.writeFileSync(SQLITE_DB_PATH, sqlDb.export());
    } catch (err) {
      console.error('Erreur sauvegarde SQLite:', err.message);
    }
  }
}

// Initialiser SQLite au demarrage
initSqlDb().catch((err) => {
  console.error('Erreur initialisation SQLite:', err.message);
});

// ============================================================================
// Configuration PostgreSQL (base PBX 3CX - rapports CDR directs uniquement)
// ============================================================================
const PG_HOST = process.env.PG_HOST || 'localhost';
const PG_PORT = parseInt(process.env.PG_PORT || '5432', 10);
const PG_USER = process.env.PG_USER || '';
const PG_PASSWORD = process.env.PG_PASSWORD || '';
const PG_DATABASE = process.env.PG_DATABASE || 'cdrdb';
const PG_SSL = process.env.PG_SSL === 'true';

// Pool de connexions PostgreSQL (pur JavaScript, compatible Alpine/musl)
const pgPool = new Pool({
  host: PG_HOST,
  port: PG_PORT,
  user: PG_USER,
  password: PG_PASSWORD,
  database: PG_DATABASE,
  ssl: PG_SSL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pgPool.on('error', (err) => {
  console.error('Erreur inattendue du pool PostgreSQL:', err.message);
});

// ============================================================================
// Client MSAL (Confidential Client Application - flow Code d'autorisation)
// ============================================================================
let msalClient = null;
if (ENTRA_CLIENT_ID && ENTRA_CLIENT_SECRET && ENTRA_TENANT_ID) {
  msalClient = new ConfidentialClientApplication({
    auth: {
      clientId: ENTRA_CLIENT_ID,
      authority: ENTRA_AUTHORITY,
      clientSecret: ENTRA_CLIENT_SECRET,
    },
  });
}

// ============================================================================
// Middlewares
// ============================================================================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  name: '3cx_cdr_session',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 8, // 8 heures
  },
}));

// Sert les fichiers statiques, mais protege /cdr.html et /admin.html par authentification.
app.use((req, res, next) => {
  if ((req.path === '/cdr.html' || req.path === '/admin.html') && !req.session.user) {
    return res.redirect('/login.html?return=' + encodeURIComponent(req.originalUrl));
  }
  next();
});
app.use(express.static('public'));

// Middleware : exige un utilisateur connecte (routes API protegees)
function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Non authentifie', loginUrl: '/login.html' });
  }
  next();
}

// Middleware : exige un administrateur (routes d'administration)
function requireAdmin(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Non authentifie', loginUrl: '/login.html' });
  }
  if (req.session.user.role !== 'admin') {
    return res.status(403).json({ error: 'Accès réservé aux administrateurs' });
  }
  next();
}

// Retourne l'utilisateur connecte (ou null)
function currentUser(req) {
  return req.session.user || null;
}

// ============================================================================
// Routes d'authentification Entra ID
// ============================================================================

// Demarre le flux de connexion Microsoft (redirection vers login.microsoftonline.com)
app.get('/auth/login', async (req, res) => {
  try {
    if (!ENTRA_CLIENT_ID || !ENTRA_TENANT_ID || !ENTRA_CLIENT_SECRET) {
      return res.status(500).json({ error: 'Authentification Entra ID non configuree cote serveur.' });
    }
    const state = Math.random().toString(36).substring(2);
    req.session.authState = state;
    const returnTo = req.query.return || '/cdr.html';
    req.session.authReturnTo = returnTo;

    const authCodeUrlRequest = {
      redirectUri: ENTRA_REDIRECT_URI,
      scopes: ENTRA_SCOPES,
      state,
    };

    const url = await msalClient.getAuthCodeUrl(authCodeUrlRequest);
    res.redirect(url);
  } catch (err) {
    console.error('Erreur getAuthCodeUrl:', err);
    res.status(500).json({ error: 'Impossible d initialiser la connexion Entra ID.' });
  }
});

// Connexion avec un compte local (utilisateur/mot de passe confirmes cotes serveur)
app.post('/auth/local', express.json(), async (req, res) => {
  try {
    if (!LOCAL_AUTH_ENABLED) {
      return res.status(403).json({ error: 'Authentification locale desactivee.' });
    }
    if (!sqlInitialized) {
      return res.status(503).json({ error: 'Base de donnees utilisateurs pas encore prete, reessayez.' });
    }
    const { username, password, returnTo } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Utilisateur et mot de passe requis.' });
    }

    const user = verifyLocalUser(username, password);
    if (!user) {
      return res.status(401).json({ error: 'Identifiant ou mot de passe invalide.' });
    }

    req.session.user = {
      id: 'local:' + user.id,
      name: user.username,
      email: user.username + '@local',
      username: user.username,
      authProvider: 'local',
      role: user.role,
    };
    req.session.authState = undefined;
    req.session.authReturnTo = undefined;

    const redirectUrl = returnTo || req.session.authReturnTo || '/cdr.html';
    req.session.authReturnTo = undefined;

    req.session.save((err) => {
      if (err) {
        console.error('Erreur sauvegarde session locale:', err);
        return res.status(500).json({ error: 'Erreur lors de la sauvegarde de la session.' });
      }
      res.json({ ok: true, redirect: redirectUrl });
    });
  } catch (err) {
    console.error('Erreur /auth/local:', err);
    res.status(500).json({ error: 'Erreur lors de la connexion locale.' });
  }
});

// Callback Microsoft : echange le code d'autorisation contre des tokens.
app.get('/auth/callback', async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;

    if (error) {
      console.error('Erreur Entra ID:', error, error_description);
      return res.redirect('/login.html?error=' + encodeURIComponent(error_description || error));
    }

    if (!code || !state || state !== req.session.authState) {
      return res.status(400).redirect('/login.html?error=Etat+de+connexion+invalide');
    }

    const tokenRequest = {
      code,
      redirectUri: ENTRA_REDIRECT_URI,
      scopes: ENTRA_SCOPES,
    };

    const response = await msalClient.acquireTokenByCode(tokenRequest);
    const account = response.account;
    if (!account) {
      return res.status(500).redirect('/login.html?error=Compte+introuvable');
    }

    // Recupere le profil utilisateur via Microsoft Graph pour avoir le nom/email.
    let displayName = account.username || account.userPrincipalName || 'Utilisateur';
    let email = account.userPrincipalName || '';
    try {
      const graphRes = await fetch('https://graph.microsoft.com/v1.0/me', {
        headers: { Authorization: 'Bearer ' + response.accessToken },
      });
      if (graphRes.ok) {
        const profile = await graphRes.json();
        displayName = profile.displayName || displayName;
        email = profile.userPrincipalName || profile.mail || email;
      }
    } catch (e) {
      console.warn('Impossible de lire le profil Graph:', e.message);
    }

    req.session.user = {
      id: account.homeAccountId,
      name: displayName,
      email: email,
      username: account.username,
      accessToken: response.accessToken,
    };
    req.session.authState = undefined;
    req.session.authReturnTo = undefined;

    const returnTo = req.session.authReturnTo || '/cdr.html';
    res.redirect(returnTo);
  } catch (err) {
    console.error('Erreur /auth/callback:', err);
    res.redirect('/login.html?error=' + encodeURIComponent(err.message || 'Erreur inconnue'));
  }
});

// Infos utilisateur connecte
app.get('/api/auth/me', (req, res) => {
  const user = currentUser(req);
  if (!user) {
    return res.status(401).json({ authenticated: false });
  }
  res.json({
    authenticated: true,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      username: user.username,
      role: user.role || 'user',
      authProvider: user.authProvider,
    },
  });
});

// Deconnexion
app.post('/auth/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Erreur destruction session:', err);
      return res.status(500).json({ error: 'Impossible de se deconnecter.' });
    }
    res.clearCookie('3cx_cdr_session');
    res.json({ ok: true, redirect: '/login.html' });
  });
});

// ============================================================================
// Routes API
// ============================================================================

// Indique si un utilisateur est connecte
app.get('/api/config', (req, res) => {
  const entraConfigured = Boolean(ENTRA_CLIENT_ID && ENTRA_TENANT_ID && ENTRA_CLIENT_SECRET);
  res.json({
    authenticated: Boolean(req.session.user),
    methods: {
      entra: entraConfigured,
      local: LOCAL_AUTH_ENABLED,
    },
    user: currentUser(req) ? { name: currentUser(req).name, email: currentUser(req).email, authProvider: currentUser(req).authProvider } : null,
  });
});

// Exécution directe d'un rapport CDR sur PostgreSQL (protégé)
app.post('/api/cdr/query', requireAuth, async (req, res) => {
  const { sql, params = [] } = req.body || {};
  if (!sql || typeof sql !== 'string') {
    return res.status(400).json({ error: 'Requête SQL manquante' });
  }
  try {
    const result = await pgPool.query(sql, params);
    res.json({
      rows: result.rows || [],
      rowCount: result.rowCount,
      fields: result.fields ? result.fields.map(f => ({ name: f.name, dataType: f.dataType })) : [],
    });
  } catch (err) {
    console.error('Erreur requête CDR PostgreSQL:', err);
    res.status(500).json({
      error: 'Erreur lors de l execution de la requete CDR',
      detail: String(err.message || err),
    });
  }
});

// Test de connexion à la base PostgreSQL (protégé)
app.get('/api/cdr/health', requireAuth, async (req, res) => {
  try {
    const result = await pgPool.query('SELECT 1 AS ok, now() AS server_time');
    res.json({
      status: 'ok',
      database: PG_DATABASE,
      host: PG_HOST + ':' + PG_PORT,
      serverTime: result.rows[0].server_time,
    });
  } catch (err) {
    console.error('Erreur test connexion PostgreSQL:', err);
    res.status(502).json({
      status: 'error',
      database: PG_DATABASE,
      host: PG_HOST + ':' + PG_PORT,
      error: String(err.message || err),
    });
  }
});

// Sante
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', authenticated: Boolean(req.session.user) });
});

// ============================================================================
// Routes d'administration des utilisateurs (admin uniquement, base SQLite)
// ============================================================================

// Liste des utilisateurs
app.get('/api/admin/users', requireAdmin, (req, res) => {
  try {
    if (!sqlInitialized) {
      return res.status(503).json({ error: 'Base de donnees utilisateurs pas encore prete.' });
    }
    const stmt = sqlDb.prepare('SELECT id, username, role, created_at FROM cdr_users ORDER BY username');
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    res.json(rows);
  } catch (err) {
    console.error('Erreur liste utilisateurs:', err);
    res.status(500).json({ error: 'Erreur lors de la recuperation des utilisateurs' });
  }
});

// Creer un utilisateur
app.post('/api/admin/users', requireAdmin, (req, res) => {
  try {
    if (!sqlInitialized) {
      return res.status(503).json({ error: 'Base de donnees utilisateurs pas encore prete.' });
    }
    const { username, password, role } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Utilisateur et mot de passe requis.' });
    }

    const existing = findUserByUsername(username);
    if (existing) {
      return res.status(409).json({ error: 'Cet utilisateur existe deja.' });
    }

    // Si c'est le premier utilisateur, on le fait admin automatiquement
    const countStmt = sqlDb.prepare('SELECT COUNT(*) AS cnt FROM cdr_users');
    countStmt.step();
    const isFirstUser = countStmt.getAsObject().cnt === 0;
    countStmt.free();
    const userRole = isFirstUser ? 'admin' : (role || 'user');

    const salt = generateSalt();
    const passwordHash = salt + ':' + hashPassword(password, salt);

    const insertStmt = sqlDb.prepare(
      'INSERT INTO cdr_users (username, password_hash, role) VALUES (?, ?, ?)'
    );
    insertStmt.run(username, passwordHash, userRole);
    insertStmt.free();

    // Recupere l'utilisateur cree
    const newUser = findUserByUsername(username);
    saveSqlDb();
    res.status(201).json({ id: newUser.id, username: newUser.username, role: newUser.role });
  } catch (err) {
    console.error('Erreur creation utilisateur:', err);
    res.status(500).json({ error: 'Erreur lors de la creation de l utilisateur' });
  }
});

// Modifier un utilisateur (mot de passe et/ou role)
app.put('/api/admin/users/:id', requireAdmin, (req, res) => {
  try {
    if (!sqlInitialized) {
      return res.status(503).json({ error: 'Base de donnees utilisateurs pas encore prete.' });
    }
    const { id } = req.params;
    const { password, role } = req.body || {};

    const existing = findUserByUsername(''); // placeholder, on verifie par id ci-dessous
    const checkStmt = sqlDb.prepare('SELECT id FROM cdr_users WHERE id = ?');
    checkStmt.step(id);
    if (!checkStmt.getAsObject()) {
      checkStmt.free();
      return res.status(404).json({ error: 'Utilisateur introuvable.' });
    }
    checkStmt.free();

    const updates = [];
    const values = [];

    if (password) {
      const salt = generateSalt();
      updates.push('password_hash = ?');
      values.push(salt + ':' + hashPassword(password, salt));
    }
    if (role !== undefined) {
      updates.push('role = ?');
      values.push(role);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'Aucune modification fournie.' });
    }

    values.push(id);
    const updateStmt = sqlDb.prepare('UPDATE cdr_users SET ' + updates.join(', ') + ' WHERE id = ?');
    updateStmt.run(...values);
    updateStmt.free();

    saveSqlDb();
    res.json({ ok: true });
  } catch (err) {
    console.error('Erreur modification utilisateur:', err);
    res.status(500).json({ error: 'Erreur lors de la modification de l utilisateur' });
  }
});

// Supprimer un utilisateur
app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  try {
    if (!sqlInitialized) {
      return res.status(503).json({ error: 'Base de donnees utilisateurs pas encore prete.' });
    }
    const { id } = req.params;
    // Empêcher l'auto-suppression
    if (req.session.user && req.session.user.id && ('local:' + id) === req.session.user.id) {
      return res.status(400).json({ error: 'Impossible de supprimer votre propre compte.' });
    }
    const delStmt = sqlDb.prepare('DELETE FROM cdr_users WHERE id = ?');
    delStmt.run(id);
    const changes = delStmt.changes();
    delStmt.free();

    if (changes === 0) {
      return res.status(404).json({ error: 'Utilisateur introuvable.' });
    }

    saveSqlDb();
    res.json({ ok: true });
  } catch (err) {
    console.error('Erreur suppression utilisateur:', err);
    res.status(500).json({ error: 'Erreur lors de la suppression de l utilisateur' });
  }
});

const server = createServer(app);
server.listen(PORT, () => {
  console.log('Serveur rapports CDR 3CX demarre sur http://localhost:' + PORT);
  console.log('Entra ID configure : ' + Boolean(ENTRA_CLIENT_ID && ENTRA_TENANT_ID && ENTRA_CLIENT_SECRET));
  console.log('Redirect URI Entra ID : ' + ENTRA_REDIRECT_URI);
  console.log('Authentification locale : ' + LOCAL_AUTH_ENABLED);
  console.log('Base SQLite utilisateurs : ' + SQLITE_DB_PATH);
});
