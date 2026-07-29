'use strict';
const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const bcrypt   = require('bcryptjs');
const session  = require('express-session');
const multer   = require('multer');
const { v4: uuidv4 } = require('uuid');
const Database = require('better-sqlite3');

const app  = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR    = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
[DATA_DIR, UPLOADS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// Session secret
const SECRET_FILE = path.join(DATA_DIR, '.secret');
const sessionSecret = fs.existsSync(SECRET_FILE)
  ? fs.readFileSync(SECRET_FILE, 'utf8').trim()
  : (() => { const s = uuidv4()+uuidv4(); fs.writeFileSync(SECRET_FILE, s); return s; })();

// Database
const db = new Database(path.join(DATA_DIR, 'vault.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    username TEXT UNIQUE NOT NULL COLLATE NOCASE,
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
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)'); } catch {}

// Middleware
app.use(express.json());
app.use(session({
  secret: sessionSecret, resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 30*24*60*60*1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/pdfjs', express.static(path.join(__dirname, 'node_modules/pdfjs-dist/build')));

// Secure uploads route — only serves files belonging to the authenticated user
app.use('/uploads', (req, res, next) => {
  if (!req.session.userId) return res.sendStatus(401);
  const safe = path.normalize(req.path);
  if (safe.includes('..')) return res.sendStatus(403);
  const parts = safe.split('/').filter(Boolean);
  if (parts[0] !== req.session.userId) return res.sendStatus(403);
  res.setHeader('Content-Disposition', 'inline');
  next();
}, express.static(UPLOADS_DIR));

// Multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(UPLOADS_DIR, req.session.userId, req.params.memberId, req.params.folderId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

// ── Auth ────────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { email, username, password } = req.body || {};
  if (!email || !username || !password) return res.status(400).json({ error: 'Email, display name and password are required' });
  const emailRx = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRx.test(String(email).trim())) return res.status(400).json({ error: 'Please enter a valid email address' });
  if (String(username).trim().length < 2) return res.status(400).json({ error: 'Display name must be at least 2 characters' });
  if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  try {
    const hash = await bcrypt.hash(password, 12);
    const id = uuidv4();
    const emailNorm = String(email).trim().toLowerCase();
    db.prepare('INSERT INTO users (id, email, username, password_hash) VALUES (?, ?, ?, ?)').run(id, emailNorm, username.trim(), hash);
    req.session.userId = id; req.session.username = username.trim(); req.session.email = emailNorm;
    res.status(201).json({ id, username: username.trim(), email: emailNorm });
  } catch (e) {
    if (e.message?.includes('users.email')) return res.status(409).json({ error: 'An account with this email already exists' });
    if (e.message?.includes('UNIQUE')) return res.status(409).json({ error: 'Display name already taken' });
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).trim().toLowerCase());
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });
  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) return res.status(401).json({ error: 'Invalid email or password' });
  req.session.userId = user.id; req.session.username = user.username; req.session.email = user.email;
  res.json({ id: user.id, username: user.username, email: user.email });
});

app.post('/api/auth/logout', (req, res) => req.session.destroy(() => res.json({ success: true })));

app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ id: req.session.userId, username: req.session.username, email: req.session.email });
});

// ── Members ─────────────────────────────────────────────────────
app.get('/api/members', requireAuth, (req, res) => {
  const members = db.prepare(`
    SELECT m.*, COUNT(f.id) AS folder_count
    FROM members m LEFT JOIN folders f ON f.member_id = m.id
    WHERE m.user_id = ? GROUP BY m.id ORDER BY m.created_at ASC
  `).all(req.session.userId);
  res.json(members);
});

app.post('/api/members', requireAuth, (req, res) => {
  const { name, relation } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required' });
  const id = uuidv4();
  db.prepare('INSERT INTO members (id, user_id, name, relation) VALUES (?, ?, ?, ?)').run(id, req.session.userId, String(name).trim(), String(relation||'').trim());
  res.status(201).json({ id, name: String(name).trim(), relation: String(relation||'').trim(), folder_count: 0 });
});

app.delete('/api/members/:id', requireAuth, (req, res) => {
  const m = db.prepare('SELECT * FROM members WHERE id=? AND user_id=?').get(req.params.id, req.session.userId);
  if (!m) return res.status(404).json({ error: 'Member not found' });
  // Remove uploaded files
  const memberDir = path.join(UPLOADS_DIR, req.session.userId, req.params.id);
  if (fs.existsSync(memberDir)) fs.rmSync(memberDir, { recursive: true });
  db.prepare('DELETE FROM members WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ── Folders ─────────────────────────────────────────────────────
function checkMember(req, res) {
  const m = db.prepare('SELECT * FROM members WHERE id=? AND user_id=?').get(req.params.memberId, req.session.userId);
  if (!m) { res.status(404).json({ error: 'Member not found' }); return null; }
  return m;
}

app.get('/api/members/:memberId/folders', requireAuth, (req, res) => {
  if (!checkMember(req, res)) return;
  const folders = db.prepare(`
    SELECT f.*, COUNT(fi.id) AS file_count
    FROM folders f LEFT JOIN files fi ON fi.folder_id = f.id
    WHERE f.member_id=? AND f.user_id=? GROUP BY f.id ORDER BY f.created_at ASC
  `).all(req.params.memberId, req.session.userId);
  res.json(folders);
});

app.post('/api/members/:memberId/folders', requireAuth, (req, res) => {
  if (!checkMember(req, res)) return;
  const { name } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Folder name is required' });
  const id = uuidv4();
  db.prepare('INSERT INTO folders (id, member_id, user_id, name) VALUES (?, ?, ?, ?)').run(id, req.params.memberId, req.session.userId, String(name).trim());
  res.status(201).json({ id, name: String(name).trim(), file_count: 0 });
});

app.delete('/api/members/:memberId/folders/:folderId', requireAuth, (req, res) => {
  if (!checkMember(req, res)) return;
  const folder = db.prepare('SELECT * FROM folders WHERE id=? AND member_id=? AND user_id=?').get(req.params.folderId, req.params.memberId, req.session.userId);
  if (!folder) return res.status(404).json({ error: 'Folder not found' });
  const folderDir = path.join(UPLOADS_DIR, req.session.userId, req.params.memberId, req.params.folderId);
  if (fs.existsSync(folderDir)) fs.rmSync(folderDir, { recursive: true });
  db.prepare('DELETE FROM folders WHERE id=?').run(req.params.folderId);
  res.json({ success: true });
});

// ── Files ────────────────────────────────────────────────────────
function checkFolder(req, res) {
  const m = checkMember(req, res);
  if (!m) return null;
  const f = db.prepare('SELECT * FROM folders WHERE id=? AND member_id=? AND user_id=?').get(req.params.folderId, req.params.memberId, req.session.userId);
  if (!f) { res.status(404).json({ error: 'Folder not found' }); return null; }
  return f;
}

app.get('/api/members/:memberId/folders/:folderId/files', requireAuth, (req, res) => {
  if (!checkFolder(req, res)) return;
  const files = db.prepare('SELECT * FROM files WHERE folder_id=? AND user_id=? ORDER BY uploaded_at DESC').all(req.params.folderId, req.session.userId);
  const result = files.map(f => ({
    ...f,
    url: `/uploads/${req.session.userId}/${req.params.memberId}/${req.params.folderId}/${f.stored_name}`
  }));
  res.json(result);
});

app.post('/api/members/:memberId/folders/:folderId/upload', requireAuth, upload.single('file'), (req, res) => {
  if (!checkFolder(req, res)) return;
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const id = uuidv4();
  db.prepare('INSERT INTO files (id, folder_id, user_id, original_name, stored_name, mime_type, size, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, req.params.folderId, req.session.userId, req.file.originalname, req.file.filename, req.file.mimetype, req.file.size, String(req.body.note||'').trim());
  res.status(201).json({ id, original_name: req.file.originalname, mime_type: req.file.mimetype, size: req.file.size,
    url: `/uploads/${req.session.userId}/${req.params.memberId}/${req.params.folderId}/${req.file.filename}` });
});

app.delete('/api/members/:memberId/folders/:folderId/files/:fileId', requireAuth, (req, res) => {
  if (!checkFolder(req, res)) return;
  const file = db.prepare('SELECT * FROM files WHERE id=? AND folder_id=? AND user_id=?').get(req.params.fileId, req.params.folderId, req.session.userId);
  if (!file) return res.status(404).json({ error: 'File not found' });
  const filePath = path.join(UPLOADS_DIR, req.session.userId, req.params.memberId, req.params.folderId, file.stored_name);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  db.prepare('DELETE FROM files WHERE id=?').run(req.params.fileId);
  res.json({ success: true });
});

app.listen(PORT, () => console.log(`\n  Family Space running at: http://localhost:${PORT}\n`));
