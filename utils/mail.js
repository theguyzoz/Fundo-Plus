import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { normalizeEmail } from '../store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const SMTP_FILE = path.join(DATA_DIR, 'smtp.json');
const OTP_FILE = path.join(DATA_DIR, 'email-otp.json');
const LOG_FILE = path.join(DATA_DIR, 'email-log.json');
const LOG_LIMIT = 500;

// Two independent mail accounts:
//   'system'  → automatic emails: verification codes + forgot-password codes
//   'mailing' → admin messages: emails the admin sends to one user or all users
const PROFILES = ['system', 'mailing'];

function readJson(fp, def) {
  try { if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch {}
  return def;
}
function writeJson(fp, data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(data, null, 2));
}

function validProfile(p) { return PROFILES.includes(p) ? p : 'system'; }

// Read one profile. Migrates the old flat smtp.json (single account) to the
// 'system' profile so nothing breaks after upgrade.
function readProfile(profile) {
  const raw = readJson(SMTP_FILE, {});
  const src = (profile === 'mailing') ? (raw.mailing || {}) : (raw.system || (raw.user || raw.host ? raw : {}));
  const port = parseInt(src.port, 10) || 465;
  return {
    host: src.host || 'smtp.gmail.com',
    port,
    // secure = implicit TLS (typ. port 465). When not set explicitly it follows the port.
    secure: src.secure !== undefined && src.secure !== null ? src.secure !== false : port === 465,
    user: src.user || '',
    appPassword: src.appPassword || '',
    fromEmail: src.fromEmail || src.user || '',
    fromName: src.fromName || 'Fundo Plus',
  };
}

export function getSmtpConfig(profile) {
  return readProfile(validProfile(profile));
}

export function saveSmtpConfig(profile, patch) {
  profile = validProfile(profile);
  const raw = readJson(SMTP_FILE, {});
  if (!raw.system && !raw.mailing && (raw.user || raw.host)) {
    // migrate old flat config → system profile
    raw.system = { ...raw };
    delete raw.system.system; delete raw.system.mailing;
  }
  const cur = readProfile(profile);
  const next = { ...cur };
  for (const k of Object.keys(patch || {})) {
    if (patch[k] === undefined) continue;
    if (k === 'appPassword' && (!patch[k] || patch[k] === '********')) continue;
    next[k] = patch[k];
  }
  // The admin UI has no separate From field (login = From), so when the login
  // changes, keep an auto-derived From in sync.
  if (patch && patch.user != null && patch.fromEmail == null &&
      (!cur.fromEmail || cur.fromEmail === cur.user)) {
    next.fromEmail = next.user;
  }
  raw[profile] = next;
  if (profile === 'system') _okUntil.system = 0; else _okUntil.mailing = 0;
  writeJson(SMTP_FILE, raw);
  try {
    import('./supabase-data.js').then(m => m.uploadDataFile('smtp.json')).catch(() => {});
  } catch {}
  return publicSmtpConfig(profile);
}

export function publicSmtpConfig(profile) {
  profile = validProfile(profile);
  const c = readProfile(profile);
  return {
    profile,
    host: c.host,
    port: c.port,
    user: c.user,
    fromEmail: c.fromEmail,
    fromName: c.fromName,
    configured: !!(c.user && c.appPassword && c.fromEmail),
    hasPassword: !!c.appPassword,
  };
}

export function smtpReady(profile) {
  const c = readProfile(validProfile(profile));
  return !!(c.user && c.appPassword && c.fromEmail);
}

async function getTransport(profile) {
  profile = validProfile(profile);
  if (!smtpReady(profile)) return null;
  const nodemailer = (await import('nodemailer')).default;
  const c = readProfile(profile);
  return nodemailer.createTransport({
    host: c.host,
    port: c.port,
    secure: !!c.secure,
    auth: { user: c.user, pass: c.appPassword },
  });
}

const _okUntil = { system: 0, mailing: 0 };

export async function canSendMail(profile) {
  profile = validProfile(profile);
  if (!smtpReady(profile)) return false;
  if (Date.now() < _okUntil[profile]) return true;
  try {
    const t = await getTransport(profile);
    if (!t) return false;
    await t.verify();
    _okUntil[profile] = Date.now() + 5 * 60 * 1000;
    return true;
  } catch (e) {
    console.warn(`[Mail:${profile}] verify failed:`, e.message);
    _okUntil[profile] = 0;
    return false;
  }
}

// Detailed connection test used by the admin "Test connection" button.
// Only checks the login against the mail server — never sends an email.
export async function testSmtpConnection(profile) {
  profile = validProfile(profile);
  const c = readProfile(profile);
  if (!c.user || !c.appPassword) {
    return { ok: false, error: 'Enter the email and its app password first.' };
  }
  try {
    const nodemailer = (await import('nodemailer')).default;
    const t = nodemailer.createTransport({
      host: c.host,
      port: c.port,
      secure: !!c.secure,
      auth: { user: c.user, pass: c.appPassword },
    });
    await t.verify();
    _okUntil[profile] = Date.now() + 5 * 60 * 1000;
    return { ok: true, user: c.user, host: c.host, port: c.port };
  } catch (e) {
    _okUntil[profile] = 0;
    return { ok: false, user: c.user, host: c.host, port: c.port, error: e.message || 'Login failed' };
  }
}

// ═══════════════════════════════════════════════════════════════════
//  EMAIL ACTIVITY LOG — every email the system or an admin sends
// ═══════════════════════════════════════════════════════════════════
function readLogs() {
  const d = readJson(LOG_FILE, { entries: [] });
  if (!Array.isArray(d.entries)) d.entries = [];
  return d;
}

export function logEmail(entry) {
  const d = readLogs();
  d.entries.unshift({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    ts: Date.now(),
    profile: validProfile(entry.profile),
    purpose: entry.purpose || 'other',
    from: entry.from || '',
    to: entry.to || '',
    toCount: entry.toCount || (entry.to ? String(entry.to).split(',').length : 0),
    subject: entry.subject || '',
    status: entry.status === 'failed' ? 'failed' : 'sent',
    error: entry.error || '',
    sentBy: entry.sentBy || 'system',
    ...entry.extra,
  });
  if (d.entries.length > LOG_LIMIT) d.entries.length = LOG_LIMIT;
  writeJson(LOG_FILE, d);
}

export function getEmailLogs(limit) {
  const d = readLogs();
  return d.entries.slice(0, Math.max(1, Math.min(parseInt(limit, 10) || 100, LOG_LIMIT)));
}

export function clearEmailLogs() {
  writeJson(LOG_FILE, { entries: [] });
  return true;
}

function toDisplay(recipients) {
  const arr = Array.isArray(recipients) ? recipients : String(recipients).split(',').map(s => s.trim()).filter(Boolean);
  const shown = arr.slice(0, 3).join(', ');
  return arr.length > 3 ? `${shown} +${arr.length - 3} more` : shown;
}

// ═══════════════════════════════════════════════════════════════════
//  SENDING — every send (success or failure) is written to the log
// ═══════════════════════════════════════════════════════════════════
export async function sendMail({ profile = 'system', to, subject, html, text, purpose, sentBy, extra }) {
  profile = validProfile(profile);
  const c = readProfile(profile);
  const from = `"${c.fromName}" <${c.fromEmail}>`;
  const list = Array.isArray(to) ? to : String(to || '').split(',').map(s => s.trim()).filter(Boolean);
  try {
    const t = await getTransport(profile);
    if (!t) throw new Error('Email is not configured');
    await t.sendMail({
      from,
      to: list.join(', '),
      subject,
      text: text || '',
      html: html || `<p>${text || ''}</p>`,
    });
    logEmail({ profile, purpose, from, to: toDisplay(list), toCount: list.length, subject, status: 'sent', sentBy, extra });
    return { ok: true };
  } catch (e) {
    logEmail({ profile, purpose, from, to: toDisplay(list), toCount: list.length, subject, status: 'failed', error: e.message, sentBy, extra });
    throw e;
  }
}

// Admin → user(s) mail. Uses the dedicated 'mailing' account and sends in
// BCC batches so a big blast doesn't expose addresses or time out.
export async function sendAdminMail({ recipients, subject, html, text, sentBy }) {
  const list = [...new Set(
    (Array.isArray(recipients) ? recipients : [recipients])
      .map(e => normalizeEmail(e) || String(e || '').toLowerCase().trim())
      .filter(e => e && e.includes('@'))
  )];
  if (!list.length) return { sent: 0, failed: 0, skipped: true };
  if (!smtpReady('mailing')) return { sent: 0, failed: 0, error: 'Mailing email is not configured' };

  const BATCH = 25;
  let sent = 0, failed = 0;
  for (let i = 0; i < list.length; i += BATCH) {
    const batch = list.slice(i, i + BATCH);
    try {
      const t = await getTransport('mailing');
      const c = readProfile('mailing');
      const from = `"${c.fromName}" <${c.fromEmail}>`;
      if (batch.length === 1) {
        await t.sendMail({ from, to: batch[0], subject, text: text || '', html: html || `<p>${text || ''}</p>` });
      } else {
        await t.sendMail({ from, to: from, bcc: batch.join(', '), subject, text: text || '', html: html || `<p>${text || ''}</p>` });
      }
      sent += batch.length;
      logEmail({ profile: 'mailing', purpose: 'admin-message', from, to: toDisplay(batch), toCount: batch.length, subject, status: 'sent', sentBy });
    } catch (e) {
      failed += batch.length;
      logEmail({ profile: 'mailing', purpose: 'admin-message', from: '', to: toDisplay(batch), toCount: batch.length, subject, status: 'failed', error: e.message, sentBy });
    }
  }
  return { sent, failed, total: list.length };
}

function loadOtps() {
  const d = readJson(OTP_FILE, { codes: {} });
  if (!d.codes) d.codes = {};
  return d;
}
function saveOtps(d) { writeJson(OTP_FILE, d); }

export function issueEmailCode(email, purpose) {
  const key = normalizeEmail(email) || String(email || '').toLowerCase().trim();
  if (!key) return { ok: false, error: 'Email required' };
  const slot = `${purpose}:${key}`;
  const d = loadOtps();
  const rec = d.codes[slot];
  const now = Date.now();
  if (rec && rec.sentAt && now - rec.sentAt < 60 * 1000) {
    return { ok: false, error: 'Wait 60 seconds before requesting another code' };
  }
  const sends = (rec?.sends || []).filter(t => now - t < 60 * 60 * 1000);
  if (sends.length >= 5) {
    return { ok: false, error: 'Too many codes sent to this email. Try again later.' };
  }
  const code = String(Math.floor(100000 + Math.random() * 900000));
  d.codes[slot] = {
    code,
    purpose,
    email: key,
    expiresAt: now + 20 * 60 * 1000,
    sentAt: now,
    sends: [...sends, now],
    attempts: 0,
  };
  saveOtps(d);
  return { ok: true, code };
}

export function consumeEmailCode(email, purpose, code) {
  const key = normalizeEmail(email) || String(email || '').toLowerCase().trim();
  const d = loadOtps();
  const slot = `${purpose}:${key}`;
  const rec = d.codes[slot];
  if (!rec) return false;
  if (Date.now() > rec.expiresAt) { delete d.codes[slot]; saveOtps(d); return false; }
  rec.attempts = (rec.attempts || 0) + 1;
  if (rec.attempts > 8) {
    delete d.codes[slot];
    saveOtps(d);
    return false;
  }
  if (String(rec.code) !== String(code).trim()) {
    saveOtps(d);
    return false;
  }
  delete d.codes[slot];
  saveOtps(d);
  return true;
}

export async function sendCodeEmail(email, code, purpose) {
  const isReset = purpose === 'reset';
  const title = isReset ? 'Reset your Fundo Plus password' : 'Verify your Fundo Plus email';
  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:440px;margin:0 auto;padding:24px">
      <h2 style="color:#2563eb">Fundo Plus</h2>
      <p>${isReset ? 'Use this code to set a new password.' : 'Use this code to verify your email and finish creating your account.'}</p>
      <p style="font-size:28px;font-weight:800;letter-spacing:6px;background:#eff6ff;padding:12px 16px;border-radius:12px;text-align:center">${code}</p>
      <p style="color:#64748b;font-size:13px">Expires in 20 minutes. If you did not request this, ignore this email.</p>
    </div>`;
  await sendMail({
    profile: 'system',
    to: email,
    subject: title,
    html,
    text: `${title}: ${code}`,
    purpose: isReset ? 'password-reset' : 'email-verification',
    sentBy: 'system',
  });
}
