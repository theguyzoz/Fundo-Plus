import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { normalizeEmail } from '../store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const SMTP_FILE = path.join(DATA_DIR, 'smtp.json');
const OTP_FILE = path.join(DATA_DIR, 'email-otp.json');

function readJson(fp, def) {
  try { if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch {}
  return def;
}
function writeJson(fp, data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(data, null, 2));
}

export function getSmtpConfig() {
  const c = readJson(SMTP_FILE, {});
  return {
    host: c.host || 'smtp.gmail.com',
    port: parseInt(c.port, 10) || 465,
    secure: c.secure !== false,
    user: c.user || '',
    appPassword: c.appPassword || '',
    fromEmail: c.fromEmail || c.user || '',
    fromName: c.fromName || 'Fundo Plus',
  };
}

export function saveSmtpConfig(patch) {
  const cur = getSmtpConfig();
  const next = { ...cur };
  for (const k of Object.keys(patch || {})) {
    if (patch[k] === undefined) continue;
    if (k === 'appPassword' && (!patch[k] || patch[k] === '********')) continue;
    next[k] = patch[k];
  }
  writeJson(SMTP_FILE, next);
  try {
    import('./supabase-data.js').then(m => m.uploadDataFile('smtp.json')).catch(() => {});
  } catch {}
  return publicSmtpConfig();
}

export function publicSmtpConfig() {
  const c = getSmtpConfig();
  return {
    host: c.host,
    port: c.port,
    user: c.user,
    fromEmail: c.fromEmail,
    fromName: c.fromName,
    configured: !!(c.user && c.appPassword && c.fromEmail),
    hasPassword: !!c.appPassword,
  };
}

export function smtpReady() {
  const c = getSmtpConfig();
  return !!(c.user && c.appPassword && c.fromEmail);
}

async function getTransport() {
  if (!smtpReady()) return null;
  const nodemailer = (await import('nodemailer')).default;
  const c = getSmtpConfig();
  return nodemailer.createTransport({
    host: c.host,
    port: c.port,
    secure: c.port === 465 || c.secure,
    auth: { user: c.user, pass: c.appPassword },
  });
}

let _mailOkUntil = 0;
export async function canSendMail() {
  if (!smtpReady()) return false;
  if (Date.now() < _mailOkUntil) return true;
  try {
    const t = await getTransport();
    if (!t) return false;
    await t.verify();
    _mailOkUntil = Date.now() + 5 * 60 * 1000;
    return true;
  } catch (e) {
    console.warn('[Mail] verify failed:', e.message);
    _mailOkUntil = 0;
    return false;
  }
}

export async function sendMail({ to, subject, html, text }) {
  const t = await getTransport();
  if (!t) throw new Error('Email is not configured');
  const c = getSmtpConfig();
  await t.sendMail({
    from: `"${c.fromName}" <${c.fromEmail}>`,
    to,
    subject,
    text: text || '',
    html: html || `<p>${text || ''}</p>`,
  });
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
  await sendMail({ to: email, subject: title, html, text: `${title}: ${code}` });
}
