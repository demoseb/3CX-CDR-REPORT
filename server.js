import express from 'express';
import session from 'express-session';
import crypto from 'crypto';
import { createServer } from 'http';
import { Pool } from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ConfidentialClientApplication } from '@azure/msal-node';

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
// ============================================================================
const LOCAL_AUTH_ENABLED = process.env.LOCAL_AUTH_ENABLED === 'true';
const LOCAL_USER = process.env.LOCAL_USER || 'admin';
const LOCAL_PASSWORD = process.env.LOCAL_PASSWORD || '';

// Hash PBKDF2 du mot de passe local (pre-calcule au demarrage si auth locale activee)
let localPasswordHash = null;
let localPasswordSalt = null;
if (LOCAL_AUTH_ENABLED && LOCAL_PASSWORD) {
  localPasswordSalt = crypto.randomBytes(16).toString('hex');
  localPasswordHash = crypto.pbkdf2Sync(LOCAL_PASSWORD, localPasswordSalt, 100000, 64, 'sha512').toString('hex');
}

function verifyLocalPassword(password) {
  if (!localPasswordHash || !localPasswordSalt) return false;
  const hash = crypto.pbkdf2Sync(password, localPasswordSalt, 100000, 64, 'sha512').toString('hex');
  return hash === localPasswordHash;
}

const MCP_URL = process.env.MCP_3CX_URL || 'https://capb-3cx.communaute-paysbasque.fr/mcp';
const MCP_TOKEN_ENV = process.env.MCP_3CX_TOKEN || '';

// ============================================================================
// Configuration PostgreSQL (base PBX 3CX - rapports CDR directs)
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
// Instancie uniquement si les credentials Entra ID sont presentes, afin de
// permettre le demarrage du serveur meme sans configuration Entra ID.
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

// Sert les fichiers statiques, mais protege /cdr.html par authentification.
app.use((req, res, next) => {
  if (req.path === '/cdr.html' && !req.session.user) {
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

// Retourne l'utilisateur connecte (ou null)
function currentUser(req) {
  return req.session.user || null;
}

// ============================================================================
// Resolution du token MCP (priorite header X-MCP-Token, sinon variable d'env)
// ============================================================================
function resolveToken(req) {
  const header = req && req.headers && req.headers['x-mcp-token'];
  if (header) return String(header);
  return MCP_TOKEN_ENV;
}

async function getMcpClient(token) {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: {
      headers: token ? { Authorization: 'Bearer ' + token } : {},
    },
  });
  const client = new Client(
    { name: '3cx-cdr-reports', version: '1.0.0' },
    { capabilities: {} }
  );
  await client.connect(transport);
  return client;
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
app.post('/auth/local', express.json(), (req, res) => {
  try {
    if (!LOCAL_AUTH_ENABLED) {
      return res.status(403).json({ error: 'Authentification locale desactivee.' });
    }
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Utilisateur et mot de passe requis.' });
    }
    if (username !== LOCAL_USER || !verifyLocalPassword(password)) {
      return res.status(401).json({ error: 'Identifiant ou mot de passe invalide.' });
    }

    req.session.user = {
      id: 'local:' + LOCAL_USER,
      name: LOCAL_USER,
      email: LOCAL_USER + '@local',
      username: LOCAL_USER,
      authProvider: 'local',
    };
    req.session.authState = undefined;
    req.session.authReturnTo = undefined;

    const returnTo = req.session.authReturnTo || '/cdr.html';
    req.session.authReturnTo = undefined;
    res.json({ ok: true, redirect: returnTo });
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
// Routes API (protegees par authentification Entra ID)
// ============================================================================

// Indique si un utilisateur est connecte (et si le token MCP est configure)
app.get('/api/config', (req, res) => {
  const entraConfigured = Boolean(ENTRA_CLIENT_ID && ENTRA_TENANT_ID && ENTRA_CLIENT_SECRET);
  res.json({
    authenticated: Boolean(req.session.user),
    tokenConfigured: Boolean(MCP_TOKEN_ENV),
    methods: {
      entra: entraConfigured,
      local: LOCAL_AUTH_ENABLED,
    },
    user: currentUser(req) ? { name: currentUser(req).name, email: currentUser(req).email, authProvider: currentUser(req).authProvider } : null,
  });
});

// Liste des outils exposes par le MCP 3CX (protege)
app.get('/api/tools', requireAuth, async (req, res) => {
  try {
    const client = await getMcpClient(resolveToken(req));
    const result = await client.listTools();
    await client.close();
    res.json(result.tools);
  } catch (err) {
    console.error('Erreur listTools:', err);
    res.status(502).json({ error: 'Impossible de contacter le MCP 3CX', detail: String(err.message || err) });
  }
});

// Appel d'un outil du MCP 3CX (protege)
app.post('/api/call/:toolName', requireAuth, async (req, res) => {
  const { toolName } = req.params;
  const { arguments: args = {} } = req.body || {};
  try {
    const client = await getMcpClient(resolveToken(req));
    const result = await client.callTool({ name: toolName, arguments: args });
    await client.close();
    res.json(result);
  } catch (err) {
    console.error('Erreur callTool ' + toolName + ':', err);
    res.status(502).json({
      error: 'Erreur lors de l appel de l outil "' + toolName + '"',
      detail: String(err.message || err),
    });
  }
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
  res.json({ status: 'ok', mcpUrl: MCP_URL, authenticated: Boolean(req.session.user) });
});

const server = createServer(app);
server.listen(PORT, () => {
  console.log('Serveur rapports CDR 3CX demarre sur http://localhost:' + PORT);
  console.log('Entra ID configure : ' + Boolean(ENTRA_CLIENT_ID && ENTRA_TENANT_ID && ENTRA_CLIENT_SECRET));
  console.log('Redirect URI Entra ID : ' + ENTRA_REDIRECT_URI);
  console.log('Token Bearer MCP 3CX configure : ' + Boolean(MCP_TOKEN_ENV));
});
