import express from 'express';
import session from 'express-session';
import crypto from 'crypto';
import { createServer } from 'http';
import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';

// Charge le fichier .env (variables non definies dans l'environnement uniquement)
function loadEnv() {
  try {
    const envPath = path.join(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
      const lines = fs.readFileSync(envPath, 'utf8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
        if (key && process.env[key] === undefined) {
          process.env[key] = value;
        }
      }
    }
  } catch (e) {
    console.warn('Impossible de charger .env:', e.message);
  }
}
loadEnv();

const app = express();
const PORT = process.env.PORT || 3999;

// ============================================================================
// Configuration authentification locale (SQLite)
// ============================================================================
const LOCAL_AUTH_ENABLED = process.env.LOCAL_AUTH_ENABLED === 'true';
const SQLITE_DB_PATH = process.env.SQLITE_DB_PATH || path.join(process.cwd(), 'data', 'cdr_users.sqlite');
const SESSION_SECRET = process.env.SESSION_SECRET || 'changez-moi-en-production';

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

  const dbDir = path.dirname(SQLITE_DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

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
  stmt.bind([username]);
  let row = null;
  if (stmt.step()) {
    row = stmt.getAsObject();
  }
  stmt.free();
  return row || null;
}

// Verifie un mot de passe contre un utilisateur de la base SQLite.
// Le password_hash stocke au format "sel:hash".
function verifyLocalUser(username, password) {
  const user = findUserByUsername(username);
  if (!user) return null;
  if (!user.password_hash) return null;
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
await initSqlDb().catch((err) => {
  console.error('Erreur initialisation SQLite:', err.message);
});

// ============================================================================
// Configuration PostgreSQL (base PBX 3CX - rapports CDR directs uniquement)
// ============================================================================
const PG_HOST = process.env.PG_HOST || 'localhost';
const PG_PORT = parseInt(process.env.PG_PORT || '5432', 10);
const PG_USER = process.env.PG_USER || '';
const PG_PASSWORD = process.env.PG_PASSWORD || '';
const PG_DATABASE = process.env.PG_DATABASE || '3cx';
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
  if ((req.path === '/cdr.html' || req.path === '/admin.html' || req.path === '/agents.html') && !req.session.user) {
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
// Routes d'authentification locale
// ============================================================================

// Connexion avec un compte local (utilisateur/mot de passe confirmes cotes serveur)
app.post('/auth/local', async (req, res) => {
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

    const redirectUrl = returnTo || '/cdr.html';

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
  res.json({
    authenticated: Boolean(req.session.user),
    methods: {
      local: LOCAL_AUTH_ENABLED,
    },
    user: currentUser(req) ? { name: currentUser(req).name, email: currentUser(req).email, authProvider: currentUser(req).authProvider } : null,
  });
});

// Execution directe d'un rapport CDR sur PostgreSQL (protege)
app.post('/api/cdr/query', requireAuth, async (req, res) => {
  const { sql, params = [] } = req.body || {};
  if (!sql || typeof sql !== 'string') {
    return res.status(400).json({ error: 'Requete SQL manquante' });
  }
  try {
    const result = await pgPool.query(sql, params);
    res.json({
      rows: result.rows || [],
      rowCount: result.rowCount,
      fields: result.fields ? result.fields.map(f => ({ name: f.name, dataType: f.dataType })) : [],
    });
  } catch (err) {
    console.error('Erreur requete CDR PostgreSQL:', err);
    res.status(500).json({
      error: 'Erreur lors de l execution de la requete CDR',
      detail: String(err.message || err),
    });
  }
});

// Statistiques agregées pour le dashboard KPI (protege)
app.get('/api/cdr/stats', requireAuth, async (req, res) => {
  try {
    const { dateFrom, dateTo, extension, direction } = req.query;
    let whereClauses = [];
    let params = [];
    let paramIdx = 1;
    if (dateFrom) { whereClauses.push('c.cdr_started_at >= $' + paramIdx++); params.push(dateFrom); }
    if (dateTo) { whereClauses.push('c.cdr_started_at <= $' + paramIdx++); params.push(dateTo); }
    if (extension) {
      whereClauses.push('(c.source_dn_number ILIKE $' + paramIdx++ + ' OR c.destination_dn_number ILIKE $' + paramIdx++ + ')');
      params.push('%' + extension + '%');
      params.push('%' + extension + '%');
    }
    if (direction === 'incoming') whereClauses.push('c.source_participant_is_incoming = TRUE');
    else if (direction === 'outgoing') whereClauses.push('c.source_participant_is_incoming = FALSE AND c.destination_participant_is_incoming = FALSE');
    else if (direction === 'internal') whereClauses.push("c.source_entity_type = 'Extension' AND c.destination_entity_type = 'Extension'");
    const whereSql = whereClauses.length ? 'WHERE ' + whereClauses.join(' AND ') : '';

    const totalCalls = await pgPool.query(
      'SELECT COUNT(*) AS cnt FROM public.cdroutput c ' + whereSql, params);
    const totalDuration = await pgPool.query(
      'SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (c.cdr_ended_at - c.cdr_started_at)) / 60), 0) AS total_min FROM public.cdroutput c ' + whereSql, params);
    const byDirection = await pgPool.query(
      'SELECT CASE WHEN c.source_participant_is_incoming THEN \'Entrant\' WHEN c.destination_participant_is_incoming THEN \'Sortant\' ELSE \'Interne\' END AS direction, COUNT(*) AS cnt FROM public.cdroutput c ' + whereSql + ' GROUP BY 1', params);
    const byTermination = await pgPool.query(
      'SELECT c.termination_reason AS motif, COUNT(*) AS cnt FROM public.cdroutput c ' + whereSql + ' GROUP BY 1 ORDER BY 2 DESC LIMIT 8', params);
    const avgDuration = await pgPool.query(
      'SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (c.cdr_ended_at - c.cdr_started_at)) / 60), 0) AS avg_min FROM public.cdroutput c ' + whereSql, params);
    const lastCall = await pgPool.query(
      'SELECT c.cdr_started_at AS debut_appel, c.source_dn_number AS poste_appelant, c.destination_dn_number AS poste_appele FROM public.cdroutput c ' + (whereSql ? whereSql + ' AND ' : 'WHERE ') + 'c.cdr_ended_at IS NOT NULL ORDER BY c.cdr_ended_at DESC LIMIT 1', params);

    res.json({
      totalCalls: parseInt(totalCalls.rows[0].cnt, 10),
      totalDurationMinutes: parseFloat(totalDuration.rows[0].total_min),
      avgDurationMinutes: parseFloat(avgDuration.rows[0].avg_min),
      byDirection: byDirection.rows.map(r => ({ direction: r.direction, count: parseInt(r.cnt, 10) })),
      byTermination: byTermination.rows.map(r => ({ motif: r.motif, count: parseInt(r.cnt, 10) })),
      lastCall: lastCall.rows[0] || null,
    });
  } catch (err) {
    console.error('Erreur stats CDR:', err);
    res.status(500).json({ error: 'Erreur lors du calcul des statistiques CDR', detail: String(err.message || err) });
  }
});

// Indicateurs par agent (extension) - entree/sortie, reponses, durees (protege)
app.get('/api/cdr/agents', requireAuth, async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    let whereClauses = [];
    let params = [];
    let paramIdx = 1;
    if (dateFrom) { whereClauses.push('c.cdr_started_at >= $' + paramIdx++); params.push(dateFrom); }
    if (dateTo) { whereClauses.push('c.cdr_started_at <= $' + paramIdx++); params.push(dateTo); }
    const whereSql = whereClauses.length ? 'WHERE ' + whereClauses.join(' AND ') : '';

    const sql = `
WITH agent_calls AS (
  SELECT
    CASE
      WHEN c.source_participant_is_incoming THEN c.destination_dn_number
      ELSE c.source_dn_number
    END AS agent_extension,
    c.source_participant_is_incoming AS is_incoming,
    c.termination_reason,
    EXTRACT(EPOCH FROM (c.cdr_ended_at - c.cdr_started_at)) / 60 AS duration_min
  FROM public.cdroutput c
  ${whereSql}
)
SELECT *
FROM (
  SELECT
    agent_extension AS poste,
    COUNT(*) FILTER (WHERE is_incoming) AS appels_entrants,
    COUNT(*) FILTER (WHERE is_incoming AND c_termination_answered) AS entrants_repondus,
    COUNT(*) FILTER (WHERE is_incoming AND NOT c_termination_answered) AS entrants_non_repondus,
    COUNT(*) FILTER (WHERE NOT is_incoming) AS appels_sortants,
    COUNT(*) FILTER (WHERE NOT is_incoming AND c_termination_answered) AS sortants_repondus,
    COUNT(*) FILTER (WHERE NOT is_incoming AND NOT c_termination_answered) AS sortants_non_repondus,
    COALESCE(SUM(duration_min), 0) AS duree_totale_minutes,
    COALESCE(AVG(duration_min), 0) AS duree_moyenne_minutes
  FROM (
    SELECT *,
      (termination_reason IN ('dst_participant_terminated','src_participant_terminated')) AS c_termination_answered
    FROM agent_calls
    WHERE agent_extension IS NOT NULL AND agent_extension <> ''
  ) a
  GROUP BY agent_extension
) s
ORDER BY (appels_entrants + appels_sortants) DESC
LIMIT 50;
`;

    const result = await pgPool.query(sql, params);
    const rows = (result.rows || []).map(r => ({
      poste: r.poste,
      appels_entrants: parseInt(r.appels_entrants, 10) || 0,
      entrants_repondus: parseInt(r.entrants_repondus, 10) || 0,
      entrants_non_repondus: parseInt(r.entrants_non_repondus, 10) || 0,
      appels_sortants: parseInt(r.appels_sortants, 10) || 0,
      sortants_repondus: parseInt(r.sortants_repondus, 10) || 0,
      sortants_non_repondus: parseInt(r.sortants_non_repondus, 10) || 0,
      duree_totale_minutes: parseFloat(r.duree_totale_minutes) || 0,
      duree_moyenne_minutes: parseFloat(r.duree_moyenne_minutes) || 0,
    }));
    res.json(rows);
  } catch (err) {
    console.error('Erreur indicateurs agents:', err);
    res.status(500).json({ error: 'Erreur lors du calcul des indicateurs agents', detail: String(err.message || err) });
  }
});

// Vue generale entrante/sortante - evolution, horaire, journalier (protege)
app.get('/api/cdr/overview', requireAuth, async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    let whereClauses = [];
    let params = [];
    let paramIdx = 1;
    if (dateFrom) { whereClauses.push('c.cdr_started_at >= $' + paramIdx++); params.push(dateFrom); }
    if (dateTo) { whereClauses.push('c.cdr_started_at <= $' + paramIdx++); params.push(dateTo); }
    const whereSql = whereClauses.length ? 'WHERE ' + whereClauses.join(' AND ') : '';

    const totalCalls = await pgPool.query(
      'SELECT COUNT(*) AS cnt FROM public.cdroutput c ' + whereSql, params);
    const incomingCalls = await pgPool.query(
      'SELECT COUNT(*) AS cnt FROM public.cdroutput c ' + (whereSql ? whereSql + ' AND ' : 'WHERE ') + 'c.source_participant_is_incoming = TRUE', params);
    const outgoingCalls = await pgPool.query(
      'SELECT COUNT(*) AS cnt FROM public.cdroutput c ' + (whereSql ? whereSql + ' AND ' : 'WHERE ') + 'c.source_participant_is_incoming = FALSE AND c.destination_participant_is_incoming = FALSE', params);

    // Evolution quotidienne entrante/sortante
    const byDay = await pgPool.query(
      'SELECT DATE(c.cdr_started_at) AS jour, ' +
      'COUNT(*) FILTER (WHERE c.source_participant_is_incoming) AS entrants, ' +
      'COUNT(*) FILTER (WHERE NOT c.source_participant_is_incoming AND c.destination_participant_is_incoming = FALSE) AS sortants ' +
      'FROM public.cdroutput c ' + whereSql + ' GROUP BY 1 ORDER BY 1 ASC', params);

    // Répartition horaire (heure de debut)
    const byHour = await pgPool.query(
      'SELECT EXTRACT(HOUR FROM c.cdr_started_at) AS heure, ' +
      'COUNT(*) FILTER (WHERE c.source_participant_is_incoming) AS entrants, ' +
      'COUNT(*) FILTER (WHERE NOT c.source_participant_is_incoming AND c.destination_participant_is_incoming = FALSE) AS sortants ' +
      'FROM public.cdroutput c ' + whereSql + ' GROUP BY 1 ORDER BY 1 ASC', params);

    // Répartition par jour de la semaine
    const byWeekday = await pgPool.query(
      'SELECT EXTRACT(DOW FROM c.cdr_started_at) AS dow, ' +
      'COUNT(*) FILTER (WHERE c.source_participant_is_incoming) AS entrants, ' +
      'COUNT(*) FILTER (WHERE NOT c.source_participant_is_incoming AND c.destination_participant_is_incoming = FALSE) AS sortants ' +
      'FROM public.cdroutput c ' + whereSql + ' GROUP BY 1 ORDER BY 1 ASC', params);

    const total = parseInt(totalCalls.rows[0].cnt, 10) || 0;
    const incoming = parseInt(incomingCalls.rows[0].cnt, 10) || 0;
    const outgoing = parseInt(outgoingCalls.rows[0].cnt, 10) || 0;

    res.json({
      totalCalls: total,
      incomingCalls: incoming,
      outgoingCalls: outgoing,
      incomingPct: total > 0 ? Math.round(incoming / total * 1000) / 10 : 0,
      outgoingPct: total > 0 ? Math.round(outgoing / total * 1000) / 10 : 0,
      byDay: (byDay.rows || []).map(r => ({
        jour: r.jour,
        entrants: parseInt(r.entrants, 10) || 0,
        sortants: parseInt(r.sortants, 10) || 0,
      })),
      byHour: (byHour.rows || []).map(r => ({
        heure: parseInt(r.heure, 10) || 0,
        entrants: parseInt(r.entrants, 10) || 0,
        sortants: parseInt(r.sortants, 10) || 0,
      })),
      byWeekday: (byWeekday.rows || []).map(r => ({
        dow: parseInt(r.dow, 10) || 0,
        entrants: parseInt(r.entrants, 10) || 0,
        sortants: parseInt(r.sortants, 10) || 0,
      })),
    });
  } catch (err) {
    console.error('Erreur overview CDR:', err);
    res.status(500).json({ error: 'Erreur lors du calcul de la vue generale', detail: String(err.message || err) });
  }
});

// Test de connexion à la base PostgreSQL (protege)
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
app.post('/api/admin/users', async (req, res) => {
  try {
    if (!sqlInitialized) {
      return res.status(503).json({ error: 'Base de donnees utilisateurs pas encore prete.' });
    }
    const { username, password, role } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Utilisateur et mot de passe requis.' });
    }

    // Si c'est le premier utilisateur, on le fait admin automatiquement
    // et on autorise sa creation sans authentification prealable (amorçage).
    const countStmt = sqlDb.prepare('SELECT COUNT(*) AS cnt FROM cdr_users');
    countStmt.step();
    const cnt = countStmt.getAsObject().cnt;
    const isFirstUser = cnt === 0;
    countStmt.free();
    if (!isFirstUser) {
      if (!req.session.user || req.session.user.role !== 'admin') {
        return res.status(403).json({ error: 'Accès réservé aux administrateurs' });
      }
    }

    const existing = findUserByUsername(username);
    if (existing) {
      return res.status(409).json({ error: 'Cet utilisateur existe deja.' });
    }

    const userRole = isFirstUser ? 'admin' : (role || 'user');

    const salt = generateSalt();
    const passwordHash = salt + ':' + hashPassword(password, salt);

    const insertStmt = sqlDb.prepare(
      'INSERT INTO cdr_users (username, password_hash, role) VALUES (?, ?, ?)'
    );
    insertStmt.run([username, passwordHash, userRole]);
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

    const checkStmt = sqlDb.prepare('SELECT id FROM cdr_users WHERE id = ?');
    checkStmt.bind([id]);
    if (!checkStmt.step()) {
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
    updateStmt.run(values);
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
    delStmt.run([id]);
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
  console.log('Authentification locale : ' + LOCAL_AUTH_ENABLED);
  console.log('Base SQLite utilisateurs : ' + SQLITE_DB_PATH);
  console.log('PostgreSQL CDR : ' + PG_HOST + ':' + PG_PORT + '/' + PG_DATABASE);
});
