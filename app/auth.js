// app/auth.js — App authentication routes
// Handles: email/password login, browser-login polling, token verify, logout
// App sessions are persisted in data/app.json  { sessions: { appId: { userId, token, createdAt } } }

import crypto  from 'crypto';
import fs      from 'fs';
import path    from 'path';
import { Router } from 'express';
import { getWebUser, saveWebUser, isBanned, verifyLogin, DATA_DIR } from '../store.js';

// Async Supabase sync — fire-and-forget, never blocks the request
async function syncAppJsonToSupabase() {
  try {
    const { uploadDataFile } = await import('../utils/supabase-data.js');
    await uploadDataFile('app.json');
  } catch (e) {
    console.warn('[app/auth] Supabase sync error:', e.message);
  }
}

const router   = Router();
const APP_FILE = path.join(DATA_DIR, 'app.json');

const SESSION_TTL     = 30 * 24 * 3600 * 1000; // 30 days
const PENDING_TTL     =  5 * 60 * 1000;         // 5 min browser-login window

// ── Persistence helpers ────────────────────────────────────────────────────
function readApp() {
  try { if (fs.existsSync(APP_FILE)) return JSON.parse(fs.readFileSync(APP_FILE, 'utf8')); } catch {}
  return { sessions: {}, pending: {} };
}
function writeApp(data) {
  try { fs.writeFileSync(APP_FILE, JSON.stringify(data, null, 2)); } catch (e) {
    console.error('[app/auth] write error:', e.message);
  }
}

// ── Internal helpers ───────────────────────────────────────────────────────
function purge(data) {
  const now = Date.now();
  for (const [appId, s] of Object.entries(data.sessions)) {
    if (now - s.createdAt > SESSION_TTL) delete data.sessions[appId];
  }
  for (const [id, p] of Object.entries(data.pending)) {
    if (now - p.createdAt > PENDING_TTL) delete data.pending[id];
  }
}

export function createAppSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const appId = crypto.randomBytes(16).toString('hex');
  const data  = readApp();
  purge(data);
  data.sessions[appId] = { userId, token, createdAt: Date.now() };
  writeApp(data);
  syncAppJsonToSupabase(); // persist to Supabase
  return { token, appId };
}

export function getAppSessionUser(token) {
  if (!token) return null;
  const data = readApp();
  for (const s of Object.values(data.sessions)) {
    if (s.token === token) {
      if (Date.now() - s.createdAt > SESSION_TTL) return null;
      return getWebUser(s.userId);
    }
  }
  return null;
}

export function destroyAppSession(token) {
  const data = readApp();
  for (const [appId, s] of Object.entries(data.sessions)) {
    if (s.token === token) { delete data.sessions[appId]; break; }
  }
  writeApp(data);
  syncAppJsonToSupabase(); // persist to Supabase
}

// ── App auth middleware ────────────────────────────────────────────────────
export function requireAppAuth(req, res, next) {
  const token = req.headers['x-session-token'] || req.query?.token;
  const user  = getAppSessionUser(token);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  if (isBanned(user.id)) return res.status(403).json({ error: 'Account suspended', code: 'BANNED' });
  if (!user.onboarded)   return res.status(403).json({ error: 'Onboarding required', code: 'ONBOARDING_REQUIRED' });
  req.user  = user;
  req.token = token;
  next();
}

function sanitize(user) {
  if (!user) return null;
  const { passwordHash, pendingToken, pendingOtp, otpCreatedAt, ...safe } = user;
  return safe;
}

// ── POST /api/app/auth/login — email/password ──────────────────────────────
router.post('/login', (req, res) => {
  const { email, phone, password } = req.body || {};
  if (!password)          return res.status(400).json({ error: 'Password required' });
  if (!email && !phone)   return res.status(400).json({ error: 'Email or phone required' });

  const user = verifyLogin({
    email: email?.trim().toLowerCase(),
    phone: phone?.trim(),
    password,
  });
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  if (isBanned(user.id)) return res.status(403).json({ error: 'Account suspended', code: 'BANNED' });

  const { token, appId } = createAppSession(user.id);
  res.json({ ok: true, token, appId, user: sanitize(user) });
});

// ── GET /api/app/auth/poll?id=<pendingId> — browser-login poll ────────────
// DroidScript app calls this every 3 s after opening the browser login page.
// Returns { token, appId, user } once the browser session has been confirmed.
router.get('/poll', (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'id required' });

  const data = readApp();
  purge(data);
  const entry = data.pending[id];

  if (!entry) return res.status(404).json({ error: 'Not found or expired' });
  if (!entry.userId) return res.json({ ok: false, waiting: true });

  // Fulfilled — issue a real app session
  const user = getWebUser(entry.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { token, appId } = createAppSession(entry.userId);
  delete data.pending[id];
  writeApp(data);

  res.json({ ok: true, token, appId, user: sanitize(user) });
});

// ── POST /api/app/auth/confirm — called by the website after browser login ─
// The web login page posts here with x-session-token (web session) + pendingId
// so the pending slot gets fulfilled.
router.post('/confirm', (req, res) => {
  const { pendingId } = req.body || {};
  if (!pendingId) return res.status(400).json({ error: 'pendingId required' });

  // Caller must supply a valid WEB session token
  const webToken = req.headers['x-session-token'] || req.cookies?.session;
  const { getSessionUser } = req._webAuth || {};     // injected by bot.js (see below)
  if (!getSessionUser) return res.status(500).json({ error: 'Server config error' });

  const user = getSessionUser(webToken);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const data = readApp();
  purge(data);
  if (!data.pending[pendingId]) return res.status(404).json({ error: 'Pending session not found or expired' });

  data.pending[pendingId].userId = user.id;
  writeApp(data);
  res.json({ ok: true });
});

// ── POST /api/app/auth/pending — create a pending slot (called by the app) ─
router.post('/pending', (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id required' });

  const data = readApp();
  purge(data);
  if (data.pending[id]) return res.json({ ok: true }); // already exists

  data.pending[id] = { createdAt: Date.now(), userId: null };
  writeApp(data);
  res.json({ ok: true });
});

// ── GET /api/app/auth/me — verify token + return user ─────────────────────
router.get('/me', (req, res) => {
  const token = req.headers['x-session-token'] || req.query?.token;
  const user  = getAppSessionUser(token);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  const banned = isBanned(user.id);
  res.json({ ok: true, user: sanitize(user), banned });
});

// ── POST /api/app/auth/logout ──────────────────────────────────────────────
router.post('/logout', (req, res) => {
  const token = req.headers['x-session-token'];
  if (token) destroyAppSession(token);
  res.json({ ok: true });
});

export default router;
