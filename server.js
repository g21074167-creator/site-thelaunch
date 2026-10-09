require("dotenv").config();

const express = require("express");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcryptjs");
const multer = require("multer");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new sqlite3.Database(path.join(DATA_DIR, "site-thelaunch.sqlite"));
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK(source_type IN ('upload','git')),
    source_url TEXT,
    original_filename TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);
});

app.disable("x-powered-by");
app.use(helmet({
  // The dashboard uses a small inline script/style for the prototype UI.
  contentSecurityPolicy: false
}));
app.use(express.json({ limit: "20kb" }));
app.use(express.urlencoded({ extended: false, limit: "20kb" }));

const isProduction = process.env.NODE_ENV === "production";
if (!process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET is missing from the environment");
}
app.use(session({
  name: "thelaunch.sid",
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: new SQLiteStore({ db: "sessions.sqlite", dir: DATA_DIR }),
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction,
    maxAge: 1000 * 60 * 60 * 8
  }
}));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
app.use("/api/auth", authLimiter);

function run(sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, function (err) {
    if (err) reject(err); else resolve({ id: this.lastID, changes: this.changes });
  }));
}
function get(sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
}
function all(sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));
}
function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "Please sign in to continue." });
  next();
}
function safeUser(user) {
  return { id: user.id, name: user.name, email: user.email };
}
function cleanName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 48);
}
function validProjectName(name) {
  return /^[a-zA-Z0-9][a-zA-Z0-9 _-]{1,47}$/.test(name);
}
function validGitUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && (u.hostname === "github.com" || u.hostname === "gitlab.com") &&
      /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(u.pathname);
  } catch { return false; }
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${crypto.randomUUID()}${ext === ".zip" ? ".zip" : ".upload"}`);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() !== ".zip") {
      return cb(new Error("Please upload a .zip file containing your static website."));
    }
    cb(null, true);
  }
});

app.get("/api/config", (_req, res) => {
  res.json({ publishingGuideUrl: process.env.PUBLISHING_GUIDE_URL || "https://developers.cloudflare.com/pages/get-started/" });
});

app.post("/api/auth/register", async (req, res, next) => {
  try {
    const name = cleanName(req.body.name);
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    if (name.length < 2) return res.status(400).json({ error: "Enter a name with at least 2 characters." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 190) return res.status(400).json({ error: "Enter a valid email address." });
    if (password.length < 10 || password.length > 72) return res.status(400).json({ error: "Use a password between 10 and 72 characters." });
    const existing = await get("SELECT id FROM users WHERE email = ?", [email]);
    if (existing) return res.status(409).json({ error: "An account with this email already exists." });
    const hash = await bcrypt.hash(password, 12);
    const result = await run("INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)", [name, email, hash]);
    req.session.user = { id: result.id, name, email };
    res.status(201).json({ user: req.session.user });
  } catch (err) { next(err); }
});

app.post("/api/auth/login", async (req, res, next) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const user = await get("SELECT * FROM users WHERE email = ?", [email]);
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: "Email or password is incorrect." });
    }
    req.session.regenerate(err => {
      if (err) return next(err);
      req.session.user = safeUser(user);
      res.json({ user: req.session.user });
    });
  } catch (err) { next(err); }
});

app.post("/api/auth/logout", (req, res, next) => {
  req.session.destroy(err => {
    if (err) return next(err);
    res.clearCookie("thelaunch.sid");
    res.json({ ok: true });
  });
});

app.get("/api/me", (req, res) => res.json({ user: req.session.user || null }));

app.get("/api/projects", requireAuth, async (req, res, next) => {
  try {
    const projects = await all(
      "SELECT id, name, source_type, source_url, original_filename, status, created_at FROM projects WHERE user_id = ? ORDER BY created_at DESC",
      [req.session.user.id]
    );
    res.json({ projects });
  } catch (err) { next(err); }
});

app.post("/api/projects/upload", requireAuth, (req, res, next) => {
  upload.single("siteZip")(req, res, async err => {
    if (err) return res.status(400).json({ error: err.message || "Upload failed." });
    if (!req.file) return res.status(400).json({ error: "Choose a ZIP file first." });
    try {
      const name = cleanName(req.body.name);
      if (!validProjectName(name)) {
        fs.unlink(req.file.path, () => { });
        return res.status(400).json({ error: "Project name must be 2–48 characters and use letters, numbers, spaces, hyphens or underscores." });
      }
      const id = crypto.randomUUID();
      await run(
        "INSERT INTO projects (id, user_id, name, source_type, original_filename, status) VALUES (?, ?, ?, 'upload', ?, 'uploaded - not deployed')",
        [id, req.session.user.id, name, path.basename(req.file.originalname).slice(0, 180)]
      );
      // This starter stores the archive privately. It deliberately does not execute or serve uploaded files.
      res.status(201).json({ message: "ZIP stored. Connect a publishing provider to deploy it publicly.", project: { id, name, source_type: "upload", status: "uploaded - not deployed" } });
    } catch (e) {
      fs.unlink(req.file.path, () => { });
      next(e);
    }
  });
});

app.post("/api/projects/git", requireAuth, async (req, res, next) => {
  try {
    const name = cleanName(req.body.name);
    const sourceUrl = String(req.body.sourceUrl || "").trim();
    if (!validProjectName(name)) return res.status(400).json({ error: "Project name must be 2–48 characters and use letters, numbers, spaces, hyphens or underscores." });
    if (!validGitUrl(sourceUrl)) return res.status(400).json({ error: "Enter a valid HTTPS GitHub or GitLab repository URL, such as https://github.com/owner/repository." });
    const id = crypto.randomUUID();
    await run(
      "INSERT INTO projects (id, user_id, name, source_type, source_url, status) VALUES (?, ?, ?, 'git', ?, 'repository saved - not connected')",
      [id, req.session.user.id, name, sourceUrl.replace(/\.git$/, "")]
    );
    res.status(201).json({ message: "Repository saved. Connect it to your hosting provider to enable automatic deployments.", project: { id, name, source_type: "git", source_url: sourceUrl, status: "repository saved - not connected" } });
  } catch (err) { next(err); }
});

app.delete("/api/projects/:id", requireAuth, async (req, res, next) => {
  try {
    const result = await run("DELETE FROM projects WHERE id = ? AND user_id = ?", [req.params.id, req.session.user.id]);
    if (!result.changes) return res.status(404).json({ error: "Project not found." });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.use(express.static(path.join(ROOT, "public"), { extensions: ["html"] }));
app.get("*", (_req, res) => res.sendFile(path.join(ROOT, "public", "index.html")));

app.use((err, _req, res, _next) => {
  console.error(err);
  if (res.headersSent) return;
  res.status(500).json({ error: "Something went wrong. Check the server terminal for details." });
});

app.listen(PORT, () => {
  console.log(`Site theLaunch is running at http://localhost:${PORT}`);
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === "development-only-change-this-secret") {
    console.warn("WARNING: Set SESSION_SECRET in .env before deploying publicly.");
  }
});
