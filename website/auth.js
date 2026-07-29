// website/auth.js — Session-based auth middleware (no Firebase)
// Web sessions are held in-memory AND persisted to data/sessions.json so that
// Supabase can restore them across redeploys.
import crypto from 'crypto';
import fs     from 'fs';
import path   from 'path';
import { getWebUser, saveWebUser, isBanned, DATA_DIR } from '../store.js';

const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const SESSION_TTL   = 7 * 24 * 3600 * 1000; // 7 days

// ── Persistence helpers ────────────────────────────────────────────────────
function loadSessionsFromDisk() {
  try {
    if (!fs.existsSync(SESSIONS_FILE)) return new Map();
    const raw = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    const map = new Map();
    const now = Date.now();
    for (const [token, s] of Object.entries(raw)) {
      if (now - s.createdAt < SESSION_TTL) map.set(token, s);
    }
    return map;
  } catch { return new Map(); }
}

function saveSessionsToDisk(map) {
  try {
    const obj = {};
    for (const [token, s] of map) obj[token] = s;
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(obj, null, 2));
  } catch (e) { console.warn('[auth] sessions.json write:', e.message); }
}

async function syncSessionsToSupabase() {
  try {
    const { uploadDataFile } = await import('../utils/supabase-data.js');
    await uploadDataFile('sessions.json');
  } catch (e) { console.warn('[auth] Supabase sync sessions.json:', e.message); }
}

// ── In-memory session map (pre-populated from disk on boot) ───────────────
const sessions = loadSessionsFromDisk();

/** Re-read sessions.json from disk — call this after Supabase sync on startup
 *  so that sessions reflects the restored file, not the empty map from boot. */
export function reloadSessionsFromDisk() {
  const fresh = loadSessionsFromDisk();
  if (fresh.size > 0) {
    // Merge: keep any sessions created since boot, add all from disk
    for (const [token, s] of fresh) {
      if (!sessions.has(token)) sessions.set(token, s);
    }
    console.log("[auth] ✅ Sessions reloaded from disk: " + sessions.size + " active");
  }
}

function parseCookieHeader(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    try { out[decodeURIComponent(part.slice(0, idx).trim())] = decodeURIComponent(part.slice(idx + 1).trim()); } catch {}
  }
  return out;
}

function getToken(req) {
  const cookies = parseCookieHeader(req);
  return req.headers['x-session-token'] || cookies.session || req.query?.token;
}

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId, createdAt: Date.now() });
  // Clean old sessions
  for (const [k, v] of sessions) {
    if (Date.now() - v.createdAt > SESSION_TTL) sessions.delete(k);
  }
  saveSessionsToDisk(sessions);
  syncSessionsToSupabase(); // fire-and-forget
  return token;
}

export function destroySession(token) {
  sessions.delete(token);
  saveSessionsToDisk(sessions);
  syncSessionsToSupabase(); // fire-and-forget
}

export function getSessionUser(token) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() - session.createdAt > SESSION_TTL) { sessions.delete(token); return null; }
  return getWebUser(session.userId);
}

/** Express middleware — requires valid session */
export function requireAuth(req, res, next) {
  const token = getToken(req);
  const user = getSessionUser(token);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  if (isBanned(user.id)) {
    return res.status(403).json({ error: 'Account suspended', code: 'BANNED' });
  }
  req.user = user;
  next();
}

/** Express middleware — requires valid session but allows banned users through. */
export function requireAuthAllowBanned(req, res, next) {
  const token = getToken(req);
  const user = getSessionUser(token);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  req.user = user;
  req.banned = isBanned(user.id);
  next();
}

/** Express middleware — requires auth AND completed onboarding */
export function requireOnboarded(req, res, next) {
  const token = getToken(req);
  const user = getSessionUser(token);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  if (isBanned(user.id)) return res.status(403).json({ error: 'Account suspended', code: 'BANNED' });
  if (!user.onboarded) return res.status(403).json({ error: 'Onboarding required', code: 'ONBOARDING_REQUIRED' });
  req.user = user;
  next();
}

/** Express middleware — requires auth AND linked WhatsApp (after 14-day grace) */
export function requireLinkedWhatsApp(req, res, next) {
  const token = getToken(req);
  const user = getSessionUser(token);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  req.user = user;

  // Track first dashboard visit
  if (!user.dashboardFirstAt) {
    saveWebUser(user.id, { dashboardFirstAt: new Date().toISOString() });
    user.dashboardFirstAt = new Date().toISOString();
  }

  if (!user.jid) {
    const firstAt = new Date(user.dashboardFirstAt).getTime();
    const daysSince = (Date.now() - firstAt) / (1000 * 86400);
    const daysLeft = Math.ceil(14 - daysSince);
    if (daysSince >= 14) {
      return res.status(403).json({
        error: 'WhatsApp pairing required',
        code: 'WHATSAPP_REQUIRED',
        message: 'Your 14-day trial has ended. Please pair your WhatsApp to continue.',
      });
    }
    // Still in grace — pass through with warning
    req.pairingWarning = { daysLeft, message: `Link your WhatsApp within ${daysLeft} day(s) to keep full access.` };
  }
  next();
}
