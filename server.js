'use strict';
const express       = require('express');
const path          = require('path');
const fs            = require('fs');
const bcrypt        = require('bcryptjs');
const cookieSession = require('cookie-session');
const multer        = require('multer');
const { v4: uuidv4 } = require('uuid');
const { createClient } = require('@libsql/client');
const cloudinary    = require('cloudinary').v2;

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Cloudinary ──────────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});
const USE_CLOUDINARY = !!process.env.CLOUDINARY_CLOUD_NAME;

// ── Local fallback dirs (only needed without Cloudinary / Turso) ─
const DATA_DIR    = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!USE_CLOUDINARY) {
  fs.mkdirSync(DATA_DIR,    { recursive: true });
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// ── Database (Turso cloud OR local SQLite file) ─────────────────
const db = createClient({
  url:       process.env.TURSO_DATABASE_URL || `file:${path.join(DATA_DIR, 'vault.db')}`,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

let _dbReady = false;
async function ensureDB() {
  if (_dbReady) return;
  await db.executeMultiple(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      username TEXT NOT NULL COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS members (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      relation TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY,
      member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      note TEXT DEFAULT '',
      uploaded_at TEXT DEFAULT (datetime('now'))
    );
  `);
  _dbReady = true;
}

// ── DB helpers ──────────────────────────────────────────────────
async function q(sql, args = []) { return db.execute({ sql, args }); }
function row(result)  { return result.rows[0]  || null; }
function rows(result) { return result.rows; }

// stored_name encodes resource_type for Cloudinary: "image:public/id" or "raw:public/id"
function makeStoredName(resourceType, publicId) { return `${resourceType}:${publicId}`; }
function parseStoredName(stored) {
  const i = stored.indexOf(':');
  return { resourceType: stored.slice(0, i), publicId: stored.slice(i + 1) };
}

function getFileUrl(storedName, userId, memberId, folderId) {
  if (USE_CLOUDINARY) {
    const { resourceType, publicId } = parseStoredName(storedName);
    return cloudinary.url(publicId, { secure: true, resource_type: resourceType });
  }
  return `/uploads/${userId}/${memberId}/${folderId}/${storedName}`;
}

async function deleteCloudinaryFile(storedName) {
  if (!USE_CLOUDINARY) return;
  try {
    const { resourceType, publicId } = parseStoredName(storedName);
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
  } catch (e) { console.error('Cloudinary delete error:', e.message); }
}

// ── Session (cookie-based — works on serverless) ────────────────
const SESSION_SECRET = process.env.SESSION_SECRET || uuidv4();

// ── Multer ──────────────────────────────────────────────────────
const upload = multer({
  storage: USE_CLOUDINARY
    ? multer.memoryStorage()
    : multer.diskStorage({
        destination: (req, file, cb) => {
          const dir = path.join(UPLOADS_DIR, req.session.userId, req.params.memberId, req.params.folderId);
          fs.mkdirSync(dir, { recursive: true });
          cb(null, dir);
        },
        filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname)),
      }),
  limits: { fileSize: 100 * 1024 * 1024 },
});

// ── Middleware ──────────────────────────────────────────────────
app.use(express.json());
app.use(cookieSession({
  name:     'fs_sess',
  keys:     [SESSION_SECRET],
  maxAge:   30 * 24 * 60 * 60 * 1000,
  httpOnly: true,
  sameSite: 'lax',
  secure:   process.env.NODE_ENV === 'production',
}));
// Initialize DB before every request
app.use(async (_req, _res, next) => { try { await ensureDB(); next(); } catch (e) { next(e); } });

app.use(express.static(path.join(__dirname, 'public')));
app.use('/pdfjs', express.static(path.join(__dirname, 'node_modules/pdfjs-dist/build')));

// Secure uploads route (local mode only)
if (!USE_CLOUDINARY) {
  app.use('/uploads', (req, res, next) => {
    if (!req.session?.userId) return res.sendStatus(401);
    const safe = path.normalize(req.path);
    if (safe.includes('..')) return res.sendStatus(403);
    const parts = safe.split('/').filter(Boolean);
    if (parts[0] !== req.session.userId) return res.sendStatus(403);
    res.setHeader('Content-Disposition', 'inline');
    next();
  }, express.static(UPLOADS_DIR));
}

function requireAuth(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

// ── Auth ────────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { email, username, password } = req.body || {};
  if (!email || !username || !password)
    return res.status(400).json({ error: 'Email, display name and password are required' });
  const emailRx = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRx.test(String(email).trim()))
    return res.status(400).json({ error: 'Please enter a valid email address' });
  if (String(username).trim().length < 2)
    return res.status(400).json({ error: 'Display name must be at least 2 characters' });
  if (String(password).length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  try {
    const hash      = await bcrypt.hash(password, 12);
    const id        = uuidv4();
    const emailNorm = String(email).trim().toLowerCase();
    await q('INSERT INTO users (id, email, username, password_hash) VALUES (?, ?, ?, ?)',
            [id, emailNorm, username.trim(), hash]);
    req.session.userId   = id;
    req.session.username = username.trim();
    req.session.email    = emailNorm;
    res.status(201).json({ id, username: username.trim(), email: emailNorm });
  } catch (e) {
    if (e.message?.includes('UNIQUE') && e.message?.includes('email'))
      return res.status(409).json({ error: 'An account with this email already exists' });
    if (e.message?.includes('UNIQUE'))
      return res.status(409).json({ error: 'Display name already taken' });
    console.error('Register error:', e);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  const user = row(await q('SELECT * FROM users WHERE email = ?', [String(email).trim().toLowerCase()]));
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });
  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) return res.status(401).json({ error: 'Invalid email or password' });
  req.session.userId   = user.id;
  req.session.username = user.username;
  req.session.email    = user.email;
  res.json({ id: user.id, username: user.username, email: user.email });
});

app.post('/api/auth/logout', (req, res) => {
  req.session = null;
  res.json({ success: true });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ id: req.session.userId, username: req.session.username, email: req.session.email });
});

// ── Members ─────────────────────────────────────────────────────
app.get('/api/members', requireAuth, async (req, res) => {
  const result = rows(await q(`
    SELECT m.id, m.name, m.relation, m.created_at, COUNT(f.id) AS folder_count
    FROM members m LEFT JOIN folders f ON f.member_id = m.id
    WHERE m.user_id = ? GROUP BY m.id ORDER BY m.created_at ASC
  `, [req.session.userId]));
  res.json(result.map(m => ({
    id: m.id, name: m.name, relation: m.relation, created_at: m.created_at,
    folder_count: Number(m.folder_count || 0)
  })));
});

app.post('/api/members', requireAuth, async (req, res) => {
  const { name, relation } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required' });
  const id = uuidv4();
  await q('INSERT INTO members (id, user_id, name, relation) VALUES (?, ?, ?, ?)',
          [id, req.session.userId, String(name).trim(), String(relation||'').trim()]);
  res.status(201).json({ id, name: String(name).trim(), relation: String(relation||'').trim(), folder_count: 0 });
});

app.delete('/api/members/:id', requireAuth, async (req, res) => {
  const m = row(await q('SELECT id FROM members WHERE id=? AND user_id=?', [req.params.id, req.session.userId]));
  if (!m) return res.status(404).json({ error: 'Member not found' });
  if (USE_CLOUDINARY) {
    // Delete each file from Cloudinary before DB cascade removes records
    const memberFiles = rows(await q(
      'SELECT fi.stored_name FROM files fi JOIN folders f ON fi.folder_id=f.id WHERE f.member_id=? AND fi.user_id=?',
      [req.params.id, req.session.userId]
    ));
    await Promise.all(memberFiles.map(f => deleteCloudinaryFile(f.stored_name)));
  } else {
    const memberDir = path.join(UPLOADS_DIR, req.session.userId, req.params.id);
    if (fs.existsSync(memberDir)) fs.rmSync(memberDir, { recursive: true });
  }
  await q('DELETE FROM members WHERE id=?', [req.params.id]);
  res.json({ success: true });
});

// ── Folders ─────────────────────────────────────────────────────
async function checkMember(req, res) {
  const m = row(await q('SELECT id FROM members WHERE id=? AND user_id=?',
                         [req.params.memberId, req.session.userId]));
  if (!m) { res.status(404).json({ error: 'Member not found' }); return null; }
  return m;
}

app.get('/api/members/:memberId/folders', requireAuth, async (req, res) => {
  if (!await checkMember(req, res)) return;
  const result = rows(await q(`
    SELECT f.id, f.name, f.created_at, COUNT(fi.id) AS file_count
    FROM folders f LEFT JOIN files fi ON fi.folder_id = f.id
    WHERE f.member_id=? AND f.user_id=? GROUP BY f.id ORDER BY f.created_at ASC
  `, [req.params.memberId, req.session.userId]));
  res.json(result.map(f => ({
    id: f.id, name: f.name, created_at: f.created_at,
    file_count: Number(f.file_count || 0)
  })));
});

app.post('/api/members/:memberId/folders', requireAuth, async (req, res) => {
  if (!await checkMember(req, res)) return;
  const { name } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Folder name is required' });
  const id = uuidv4();
  await q('INSERT INTO folders (id, member_id, user_id, name) VALUES (?, ?, ?, ?)',
          [id, req.params.memberId, req.session.userId, String(name).trim()]);
  res.status(201).json({ id, name: String(name).trim(), file_count: 0 });
});

app.delete('/api/members/:memberId/folders/:folderId', requireAuth, async (req, res) => {
  if (!await checkMember(req, res)) return;
  const folder = row(await q('SELECT id FROM folders WHERE id=? AND member_id=? AND user_id=?',
                              [req.params.folderId, req.params.memberId, req.session.userId]));
  if (!folder) return res.status(404).json({ error: 'Folder not found' });
  if (USE_CLOUDINARY) {
    const folderFiles = rows(await q(
      'SELECT stored_name FROM files WHERE folder_id=? AND user_id=?',
      [req.params.folderId, req.session.userId]
    ));
    await Promise.all(folderFiles.map(f => deleteCloudinaryFile(f.stored_name)));
  } else {
    const folderDir = path.join(UPLOADS_DIR, req.session.userId, req.params.memberId, req.params.folderId);
    if (fs.existsSync(folderDir)) fs.rmSync(folderDir, { recursive: true });
  }
  await q('DELETE FROM folders WHERE id=?', [req.params.folderId]);
  res.json({ success: true });
});

// ── Files ────────────────────────────────────────────────────────
async function checkFolder(req, res) {
  const m = await checkMember(req, res);
  if (!m) return null;
  const f = row(await q('SELECT id FROM folders WHERE id=? AND member_id=? AND user_id=?',
                          [req.params.folderId, req.params.memberId, req.session.userId]));
  if (!f) { res.status(404).json({ error: 'Folder not found' }); return null; }
  return f;
}

app.get('/api/members/:memberId/folders/:folderId/files', requireAuth, async (req, res) => {
  if (!await checkFolder(req, res)) return;
  const fileRows = rows(await q(
    'SELECT id, original_name, stored_name, mime_type, size, note, uploaded_at FROM files WHERE folder_id=? AND user_id=? ORDER BY uploaded_at DESC',
    [req.params.folderId, req.session.userId]
  ));
  res.json(fileRows.map(f => ({
    id: f.id,
    original_name: f.original_name,
    mime_type: f.mime_type,
    size: Number(f.size),
    note: f.note,
    uploaded_at: f.uploaded_at,
    url: getFileUrl(f.stored_name, req.session.userId, req.params.memberId, req.params.folderId),
  })));
});

app.post('/api/members/:memberId/folders/:folderId/upload', requireAuth, upload.single('file'), async (req, res) => {
  if (!await checkFolder(req, res)) return;
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    let storedName, fileUrl;
    if (USE_CLOUDINARY) {
      const publicId = `family-space/${req.session.userId}/${req.params.memberId}/${req.params.folderId}/${uuidv4()}`;
      const result = await new Promise((resolve, reject) => {
        cloudinary.uploader.upload_stream(
          { public_id: publicId, resource_type: 'auto', overwrite: false },
          (err, r) => err ? reject(err) : resolve(r)
        ).end(req.file.buffer);
      });
      storedName = makeStoredName(result.resource_type, result.public_id);
      fileUrl    = result.secure_url;
    } else {
      storedName = req.file.filename;
      fileUrl    = `/uploads/${req.session.userId}/${req.params.memberId}/${req.params.folderId}/${req.file.filename}`;
    }
    const id = uuidv4();
    await q(
      'INSERT INTO files (id, folder_id, user_id, original_name, stored_name, mime_type, size, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, req.params.folderId, req.session.userId, req.file.originalname, storedName,
       req.file.mimetype, req.file.size, String(req.body.note||'').trim()]
    );
    res.status(201).json({ id, original_name: req.file.originalname, mime_type: req.file.mimetype,
                           size: req.file.size, url: fileUrl });
  } catch (e) {
    console.error('Upload error:', e);
    res.status(500).json({ error: 'Upload failed' });
  }
});

app.delete('/api/members/:memberId/folders/:folderId/files/:fileId', requireAuth, async (req, res) => {
  if (!await checkFolder(req, res)) return;
  const file = row(await q('SELECT id, stored_name FROM files WHERE id=? AND folder_id=? AND user_id=?',
                             [req.params.fileId, req.params.folderId, req.session.userId]));
  if (!file) return res.status(404).json({ error: 'File not found' });
  if (USE_CLOUDINARY) {
    await deleteCloudinaryFile(file.stored_name);
  } else {
    const filePath = path.join(UPLOADS_DIR, req.session.userId, req.params.memberId, req.params.folderId, file.stored_name);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  await q('DELETE FROM files WHERE id=?', [req.params.fileId]);
  res.json({ success: true });
});

// ── Error handler ───────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start (local dev only — Vercel imports this as a module) ────
if (require.main === module) {
  app.listen(PORT, () => console.log(`\n  Family Space running at: http://localhost:${PORT}\n`));
}

module.exports = app;
