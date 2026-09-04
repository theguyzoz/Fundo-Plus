// website/routes.js — All web routes
import express  from 'express';
import fs       from 'fs';
import path     from 'path';
import multer   from 'multer';
import { fileURLToPath } from 'url';
import {
  createUser, verifyLogin, getWebUser, saveWebUser, findWebUserByEmail, isEmailVerified, normalizeEmail,
  deleteWebUser, findWebUserByToken, listPapersLocal,
  getPapersTotalBytes, MAX_PAPERS_BYTES, addWishlistVote,
  getWishlistCount, incrementPaperUpload, PAPER_UPLOAD_LIMIT,
  addPaper, removePaper, getAllWebUsers,
  banUser, unbanUser, getBan, getAllBans, isBanned,
  submitAppeal, resolveAppeal, hashPassword,
  addCommunityMessage, getCommunityMessages,
  deleteCommunityMessage, getCommunityCount,
  toggleCommunityLike, getCommunityMentionCount,
  markCommunityMentionsRead, setCommunityMessageMentions,
  // messenger
  getMessengerSettings, saveMessengerSettings, blockUser, unblockUser, isBlocked,
  searchPublicUsers, findUserByEmail, getUserInfoBulk,
  isVerified, setVerified, getSupportCard, publicMessengerCard, isSupportEmail,
  storePendingMessage, drainPendingMessages, countPendingMessages,
  countPendingBySender, pruneExpiredMessages, markMessagesRead,
  unsendPendingMessage, getOrCreateMediaPreview, touchMediaPreview, pruneExpiredMediaPreviews,
  drainMessengerAcks, getLastSeenBulk, getUserLastSeen,
  // subscription & usage
  getUserPlan, getPlanLimits, setUserSubscription, getAllSubscriptions,
  getUserSubscription, savePaymentProof, getAllProofs, getPendingProofs,
  getProofFilePath, reviewProof, getUserProofs, getUserPendingProof, PLANS,
  getFullUsage, getPaperDlCount, incrementStudySession, incrementQuizUsage,
  incrementProjectUsage, incrementPaperDl, canDownloadPaper,
  incrementChatUsage, incrementPdfUsage as _incPdf,
  // paynow / virtual balance
  getUserBalance, adjustUserBalance, getBalanceTransactions,
  savePendingDeposit, getPendingDeposit, getPendingDepositsForUser,
  deletePendingDeposit, finalizeDeposit, failDeposit,
  getWithdrawalBalance, getRemainingTopupCapacity,
  MAX_BALANCE_CENTS, MIN_TOPUP_CENTS, MIN_WITHDRAW_CENTS, TRANSACTION_FEE_PCT,
  sanitizeCents, feeCents,
  requestWithdrawal, getWithdrawals, getAllWithdrawals, getWithdrawal, updateWithdrawalStatus,
  flushMoneyBackup,
  // recent logins (in-memory)
  recordLogin, getRecentLogins, getLoginCount,
  // support
  addSupportMessage, getAllSupportMessages, resolveSupportMessage,
  // messages / wishlist / files
  getAllMessageCounts, DATA_DIR,
  // promo links
  createPromoLink, getAllPromoLinks,
  deactivatePromoLink, deletePromoLink, redeemPromoLink, getPromoLink,
  // zimsec
  getAllZimsecExams, getZimsecExam, createZimsecExam, updateZimsecExam, deleteZimsecExam,
  getAllZimsecQuestions, getZimsecQuestion, createZimsecQuestion, updateZimsecQuestion,
  deleteZimsecQuestion, deleteZimsecQuestionsByExam,
  getAllZimsecResults, getUserZimsecResults, getExamZimsecResults,
  submitZimsecResult, deleteZimsecResult, getZimsecLeaderboard, parseZimsecTxt,
  unlockExamForUser, getExamUnlock, isExamWindowOpen, getExamWindowExpiry,
  // notifications
  createNotification, getAllNotifications, deleteNotification,
  getNotificationsForUser, getUnreadNotificationsForUser,
  markNotificationRead, getReadNotifIds,
  // push subscriptions
  savePushSubscription, removePushSubscription,
  getPushSubscriptionsForUsers, getAllPushSubscriptions,
  // ambassadors
  addAmbassador, removeAmbassador, updateAmbassador,
  getAllAmbassadors, getAllAmbassadorsWithCodes, getAmbassadorsAdminOverview,
  getAmbassadorByEmail, getAmbassadorByEmailWithCode,
  getAmbassadorByCode, recordReferral,
  isAmbassador, isAmbassadorExam,
  getAmbassadorExamWindowExpiry, isAmbassadorExamWindowOpen,
  AMBASSADOR_EXAM_WINDOW_MS,
} from '../store.js';
import {
  createSession, destroySession, getSessionUser,
  requireAuth, requireOnboarded, requireAuthAllowBanned,
} from './auth.js';
import { askWebAI, clearWebHistory, wantsPdf, looksLikePdfRefusal, parsePdfMarker, stripPdfMarker, expandPdfContent } from './ai.js';
import { createVerifyToken, consumeToken } from '../utils/verify.js';
import {
  smtpReady, canSendMail, sendCodeEmail, issueEmailCode, consumeEmailCode,
  saveSmtpConfig, publicSmtpConfig,
  testSmtpConnection, sendMail, sendAdminMail,
  getEmailLogs, clearEmailLogs,
  getMailService, saveMailServiceConfig,
} from '../utils/mail.js';
import { uploadToCatbox, classifyMedia, assertAllowedMedia, safeFilename, CATBOX_MAX_BYTES } from '../utils/catbox.js';
import { createPayment, verifyUpdate, pollTransaction, isConfigured as isPaynowConfigured } from '../utils/paynow.js';
import rateLimit from 'express-rate-limit';
import {
  uploadUpdateJson, uploadApk, fetchUpdateJson, getApkPublicUrl,
} from '../utils/update-store.js';
import {
  backupExamToSupabase, deleteExamBackup, purgeExpiredExamBackups, syncToSupabase,
} from '../utils/supabase-data.js';
import webpush from 'web-push';

// ── Web Push (VAPID) setup ─────────────────────────────────────────────────
// Priority: env vars → data/vapid.json (set via admin) → hardcoded defaults.
const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');
const VAPID_DEFAULT_PUBLIC  = 'BEPEHkkKDM0XGZVnCphAAq2IjX_V2kaVSOUfIEYBi2l33bAW9_GY4xbDS0WHAU5SOeceWuMrfTmtm3tHfc6izKs';
const VAPID_DEFAULT_PRIVATE = 'K-4QFQ4WJ__l5zoQ5zZlqYcsyalMi1q3DtEesGhnbDI';

function loadVapidKeys() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY, source: 'env' };
  }
  try {
    if (fs.existsSync(VAPID_FILE)) {
      const v = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
      if (v.publicKey && v.privateKey) return { ...v, source: 'custom' };
    }
  } catch {}
  return { publicKey: VAPID_DEFAULT_PUBLIC, privateKey: VAPID_DEFAULT_PRIVATE, source: 'default' };
}

let vapidKeys = loadVapidKeys();
function applyVapid() {
  webpush.setVapidDetails('mailto:support@fundoplus.co.zw', vapidKeys.publicKey, vapidKeys.privateKey);
}
applyVapid();
const VAPID_PUBLIC = () => vapidKeys.publicKey;

const SITE_BASE = () => (process.env.WEBSITE_URL || '').replace(/\/+$/, '');

async function sendPushToSubscriptions(subscriptions, payload) {
  if (!subscriptions.length) return { sent: 0, failed: 0, errors: [] };

  // Absolute URLs are REQUIRED by push services — relative icons/images fail.
  const base = SITE_BASE();
  const abs = (p) => (p && /^https?:\/\//i.test(p) ? p : (base ? base + (p || '') : p));

  const data = {
    title:       payload.title,
    body:        payload.body || '',
    icon:        abs(payload.icon || '/images/logo.png'),
    badge:       abs(payload.badge || '/images/logo.png'),
    image:       abs(payload.image) || undefined,      // big banner image (Android/desktop)
    url:         payload.url || '/~/notifications',
    tag:         payload.tag || ('notif-' + Date.now()), // unique tag → always re-shows
    renotify:    true,
    requireInteraction: false,
  };

  const results = await Promise.allSettled(
    subscriptions.map(sub => webpush.sendNotification(sub, JSON.stringify(data)))
  );

  const errors = [];
  let failed = 0;
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      failed++;
      const reason = r.reason || {};
      // 404/410 = stale subscription (browser revoked it) — safe to log & prune
      const code = reason.statusCode || reason.code || '';
      errors.push({
        endpoint: (subscriptions[i]?.endpoint || '').slice(0, 80),
        statusCode: code,
        message: String(reason.message || reason).slice(0, 160),
      });
      console.error(`[Push] ❌ failed (${code}):`, errors[errors.length - 1].message);
    }
  });

  if (failed) console.warn(`[Push] ${failed}/${subscriptions.length} failed`);
  else console.log(`[Push] ✅ sent ${subscriptions.length} notification(s)`);
  return { sent: subscriptions.length - failed, failed, errors };
}

// Run expired exam backup purge on startup (non-blocking)
purgeExpiredExamBackups().catch(e => console.warn('[Routes] purgeExpiredExamBackups startup error:', e.message));

// Schedule recurring purge every hour
setInterval(() => {
  purgeExpiredExamBackups().catch(e => console.warn('[Routes] purgeExpiredExamBackups interval error:', e.message));
}, 60 * 60 * 1000);

// Auto-sync all managed data files to Supabase every 10 minutes
setInterval(() => {
  import('../utils/supabase-data.js')
    .then(m => m.syncToSupabase())
    .catch(e => console.warn('[Routes] periodic syncToSupabase failed:', e.message));
}, 10 * 60 * 1000);

const __dirname    = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR   = path.join(__dirname, '..', 'public');
const SKILLS_DIR   = path.join(__dirname, '..', 'skills');
const SYLLABUS_DIR = path.join(SKILLS_DIR, 'syllabus');
const PROJECTS_DIR = path.join(SKILLS_DIR, 'projects');

const router = express.Router();

// ── Multer for payment proofs (memory, 5 MB per file) ─────────────────────
const proofUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Image files only'));
    cb(null, true);
  }
});

// ── Multer for data file uploads (memory, 50 MB per file, JSON only) ───────
const dataUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (!file.originalname.endsWith('.json')) return cb(new Error('JSON files only'));
    cb(null, true);
  }
});

// ── Multer for update.json upload (admin only, 1 MB max) ──────────────────
const updateJsonUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (!file.originalname.endsWith('.json')) return cb(new Error('JSON files only'));
    cb(null, true);
  }
});

// ── Multer for APK upload (admin only, 100 MB max) ──────────────────────────
const apkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const ok = file.originalname.endsWith('.apk') ||
               file.mimetype === 'application/vnd.android.package-archive';
    if (!ok) return cb(new Error('APK files only'));
    cb(null, true);
  }
});

const messengerMediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CATBOX_MAX_BYTES },
  fileFilter(req, file, cb) {
    const err = assertAllowedMedia(file.mimetype, file.originalname, null);
    if (err) return cb(new Error(err));
    cb(null, true);
  }
});

// ── Ban guard helper ─────────────────────────────────────────────────────
function parseCookies(req) {
  const raw = req.headers.cookie || '';
  if (!raw.trim()) return {};
  return Object.fromEntries(
    raw.split(';')
      .map(c => c.trim())
      .filter(Boolean)
      .map(c => {
        const idx = c.indexOf('=');
        if (idx === -1) return [decodeURIComponent(c), ''];
        return [decodeURIComponent(c.slice(0, idx)), decodeURIComponent(c.slice(idx + 1))];
      })
  );
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) return fwd.split(',')[0].trim();
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real.trim()) return real.trim();
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function createHitLimiter({ windowMs, max }) {
  const hits = new Map();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) {
      if (now - v.start >= windowMs) hits.delete(k);
    }
  }, Math.min(windowMs, 60_000));
  if (typeof sweep.unref === 'function') sweep.unref();
  return (key) => {
    const k = String(key || 'unknown');
    const now = Date.now();
    let rec = hits.get(k);
    if (!rec || now - rec.start >= windowMs) {
      rec = { start: now, n: 0 };
      hits.set(k, rec);
    }
    rec.n += 1;
    if (rec.n > max) {
      return { ok: false, retryAfter: Math.max(1, Math.ceil((rec.start + windowMs - now) / 1000)) };
    }
    return { ok: true };
  };
}

function rateMw(check, keyFn, message) {
  return (req, res, next) => {
    const r = check(keyFn(req));
    if (!r.ok) {
      res.setHeader('Retry-After', String(r.retryAfter || 60));
      return res.status(429).json({ error: message });
    }
    next();
  };
}

const registerIpLimit = createHitLimiter({ windowMs: 60 * 60 * 1000, max: 8 });
const loginIpLimit = createHitLimiter({ windowMs: 15 * 60 * 1000, max: 20 });
const mailIpLimit = createHitLimiter({ windowMs: 60 * 60 * 1000, max: 8 });
const mailEmailLimit = createHitLimiter({ windowMs: 60 * 60 * 1000, max: 3 });
const codeTryIpLimit = createHitLimiter({ windowMs: 15 * 60 * 1000, max: 15 });

function pageGuardBan(req, res, next) {
  const cookies = parseCookies(req);
  const token = cookies.session || req.headers['x-session-token'] || req.query.token;
  if (!token) return next();
  const user = getSessionUser(token);
  if (!user) return next();
  if (isBanned(user.id)) return res.sendFile(path.join(PUBLIC_DIR, 'banned.html'));
  next();
}

// ═══════════════════════════════════════════════════════════════════
//  PAGE ROUTES
// ═══════════════════════════════════════════════════════════════════
router.get('/login',       (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));

// Ambassador referral link — sets cookie then redirects to register tab
router.get('/join/:code', (req, res) => {
  const amb = getAmbassadorByCode(req.params.code);
  if (!amb) return res.redirect('/login?tab=register&ref_invalid=1');
  // Set a short-lived cookie so the register endpoint can read it
  res.cookie('amb_ref', req.params.code, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000 });
  res.redirect('/login?tab=register&ref=' + encodeURIComponent(amb.referralCode));
});
router.get('/onboarding',  pageGuardBan, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'onboarding.html')));
router.get('/~',           pageGuardBan, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'dashboard', 'index.html')));
router.get('/~/account',   pageGuardBan, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'dashboard', 'account.html')));
router.get('/me',          pageGuardBan, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'dashboard', 'account.html')));
router.get('/~/subscription', pageGuardBan, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'dashboard', 'subscription.html')));
router.get('/~/projects',   pageGuardBan, (req, res) => res.redirect('/~/projectgen'));
router.get('/~/projectgen', pageGuardBan, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'dashboard', 'projectgen.html')));
router.get('/~/more',       pageGuardBan, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'dashboard', 'more.html')));
router.get('/~/zimsec',     pageGuardBan, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'dashboard', 'zimsec.html')));
router.get('/~/leaderboard', pageGuardBan, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'dashboard', 'leaderboard.html')));
router.get('/~/exam',       pageGuardBan, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'dashboard', 'exam.html')));
router.get('/~/exam/take',  pageGuardBan, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'dashboard', 'exam-take.html')));
router.get('/~/exam/:id',   pageGuardBan, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'dashboard', 'exam.html')));
router.get('/ai',           pageGuardBan, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'ai.html')));
router.get('/about',       (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'about.html')));
router.get('/terms',       (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'terms.html')));
router.get('/community',   pageGuardBan, (req, res) => res.redirect('/messenger'));
router.get('/messenger',   pageGuardBan, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'messenger.html')));
router.get('/support',     pageGuardBan, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'support.html')));
router.get('/resources',   pageGuardBan, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'resources.html')));
router.get('/redeem',      pageGuardBan, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'redeem.html')));
router.get('/banned',      (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'banned.html')));
router.get('/samazed',     (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'samazed.html')));

// ═══════════════════════════════════════════════════════════════════
//  AUTH API
// ═══════════════════════════════════════════════════════════════════
router.post('/api/auth/register', rateMw(registerIpLimit, clientIp, 'Too many sign-ups from this network. Try again later.'), async (req, res) => {
  const { email, phone, password, refCode: bodyRefCode } = req.body || {};
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (!email && !phone) return res.status(400).json({ error: 'Email or phone number required' });
  const emailClean = email ? String(email).trim().toLowerCase() : '';
  if (emailClean && findWebUserByEmail(emailClean)) {
    return res.status(400).json({ error: 'Email already registered' });
  }
  const mailOn = emailClean ? await canSendMail() : false;
  const result = createUser({
    email: emailClean || undefined, phone: phone?.trim(), password,
    emailVerified: emailClean ? !mailOn : true,
  });
  if (!result.ok) return res.status(400).json({ error: result.error });

  // Record referral if they came through an ambassador link
  const cookies = parseCookies(req);
  const refCode = cookies.amb_ref || bodyRefCode;
  if (refCode) {
    const amb = getAmbassadorByCode(refCode);
    if (amb) {
      recordReferral(amb.id, result.user.id, result.user.email || phone || '');
      import('../utils/supabase-data.js').then(m => m.uploadDataFile('ambassadors.json')).catch(() => {});
    }
    res.clearCookie('amb_ref');
  }

  if (mailOn && result.user.email) {
    try {
      const issued = issueEmailCode(result.user.email, 'verify');
      if (!issued.ok) return res.status(429).json({ error: issued.error, needsVerification: true, email: result.user.email });
      await sendCodeEmail(result.user.email, issued.code, 'verify');
      return res.json({ ok: true, needsVerification: true, email: result.user.email });
    } catch (e) {
      console.warn('[Register] mail failed, skipping verification:', e.message);
      saveWebUser(result.user.id, { emailVerified: true });
    }
  }

  const token = createSession(result.user.id);
  res.cookie('session', token, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000 });
  res.json({ ok: true, token, user: sanitizeUser(result.user), onboarded: false });
});

router.post('/api/auth/login', rateMw(loginIpLimit, clientIp, 'Too many login attempts. Try again in a few minutes.'), (req, res) => {
  const { email, phone, password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'Password required' });
  if (!email && !phone) return res.status(400).json({ error: 'Email or phone required' });
  const user = verifyLogin({ email: email?.trim().toLowerCase(), phone: phone?.trim(), password });
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  if (user.email && user.emailVerified === false) {
    return res.status(403).json({ error: 'Verify your email first. We sent a code if mail is on.', needsVerification: true, email: user.email });
  }
  const token = createSession(user.id);
  // Record login (in-memory only)
  const fwd = req.headers['x-forwarded-for'];
  recordLogin(user, {
    ip: (typeof fwd === 'string' && fwd.split(',')[0].trim()) || req.ip || '',
    ua: req.headers['user-agent'] || '',
  });
  res.cookie('session', token, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000 });
  res.json({ ok: true, token, user: sanitizeUser(user), onboarded: user.onboarded });
});

router.post('/api/auth/logout', requireAuthAllowBanned, (req, res) => {
  destroySession(req.headers['x-session-token'] || req.cookies?.session);
  res.clearCookie('session');
  res.json({ ok: true });
});

router.get('/api/auth/me', requireAuthAllowBanned, (req, res) => {
  const isAmb = !!(getAmbassadorByEmail(req.user.email));
  res.json({ ok: true, user: sanitizeUser(req.user), banned: req.banned || false, isAmbassador: isAmb });
});

router.post('/api/auth/verify-email', rateMw(codeTryIpLimit, clientIp, 'Too many verification attempts. Try again later.'), async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const code = String(req.body?.code || '').trim();
  if (!email || !code) return res.status(400).json({ error: 'Email and code required' });
  if (!consumeEmailCode(email, 'verify', code)) return res.status(400).json({ error: 'Invalid or expired code' });
  const user = findWebUserByEmail(email);
  if (!user) return res.status(404).json({ error: 'Account not found' });
  saveWebUser(user.id, { emailVerified: true });
  const token = createSession(user.id);
  res.cookie('session', token, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000 });
  res.json({ ok: true, token, user: sanitizeUser({ ...user, emailVerified: true }), onboarded: !!user.onboarded });
});

router.post('/api/auth/resend-code', rateMw(mailIpLimit, clientIp, 'Too many email requests from this network. Try again later.'), async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const purpose = req.body?.purpose === 'reset' ? 'reset' : 'verify';
  if (!email) return res.status(400).json({ error: 'Email required' });
  const emailHits = mailEmailLimit(normalizeEmail(email) || email);
  if (!emailHits.ok) {
    res.setHeader('Retry-After', String(emailHits.retryAfter || 60));
    return res.status(429).json({ error: 'Too many codes for this email. Try again later.' });
  }
  if (!(await canSendMail())) return res.status(503).json({ error: 'Email service is currently unavailable. Please try again in a few minutes.' });
  const user = findWebUserByEmail(email);
  if (!user) return res.json({ ok: true });
  try {
    const issued = issueEmailCode(email, purpose);
    if (!issued.ok) return res.status(429).json({ error: issued.error });
    await sendCodeEmail(email, issued.code, purpose);
    res.json({ ok: true, message: 'Code sent! Check your inbox — if it doesn\'t appear, check your spam folder.' });
  } catch (e) {
    console.warn('[Resend] send failed:', e.message);
    res.status(500).json({ error: 'Email service is currently unavailable. Please try again in a few minutes.' });
  }
});

router.post('/api/auth/forgot-password', rateMw(mailIpLimit, clientIp, 'Too many reset requests from this network. Try again later.'), async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'Email required' });
  const emailHits = mailEmailLimit(normalizeEmail(email) || email);
  if (!emailHits.ok) {
    res.setHeader('Retry-After', String(emailHits.retryAfter || 60));
    return res.status(429).json({ error: 'Too many reset emails. Try again later.' });
  }
  if (!(await canSendMail())) return res.status(503).json({ error: 'Email service is currently unavailable. Please try again in a few minutes.' });
  const user = findWebUserByEmail(email);
  if (user) {
    try {
      const issued = issueEmailCode(user.email || email, 'reset');
      if (!issued.ok) return res.status(429).json({ error: issued.error });
      await sendCodeEmail(user.email || email, issued.code, 'reset');
    } catch (e) {
      console.warn('[ForgotPassword] send failed:', e.message);
      return res.status(500).json({ error: 'Email service is currently unavailable. Please try again in a few minutes.' });
    }
  }
  res.json({ ok: true, message: 'Code sent! Check your inbox — if it doesn\'t appear, check your spam folder.' });
});

router.post('/api/auth/reset-password', rateMw(codeTryIpLimit, clientIp, 'Too many reset attempts. Try again later.'), (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const code = String(req.body?.code || '').trim();
  const password = String(req.body?.password || '');
  if (!email || !code || password.length < 6) return res.status(400).json({ error: 'Email, code, and a 6+ character password required' });
  if (!consumeEmailCode(email, 'reset', code)) return res.status(400).json({ error: 'Invalid or expired code' });
  const user = findWebUserByEmail(email);
  if (!user) return res.status(404).json({ error: 'Account not found' });
  saveWebUser(user.id, { passwordHash: hashPassword(password), emailVerified: true });
  res.json({ ok: true });
});

// Who performed an admin mail action (for the email activity log)
function adminActor(req) {
  try {
    const t = req.headers['x-session-token'] || req.headers['x-admin-token'] || req.headers['x-admin-key'];
    if (t && t !== ADMIN_PASS) {
      const u = getSessionUser(t);
      if (u) return u.email || u.name || 'admin';
    }
  } catch {}
  return 'admin';
}

router.get('/api/admin/smtp', requireAdmin, (req, res) => {
  res.json({ ok: true, smtp: { system: publicSmtpConfig('system'), mailing: publicSmtpConfig('mailing') } });
});

router.post('/api/admin/smtp', requireAdmin, async (req, res) => {
  const profile = req.body?.profile === 'mailing' ? 'mailing' : 'system';
  const { user, appPassword, fromEmail, fromName, host, port } = req.body || {};
  const portNum = port != null ? parseInt(port, 10) : undefined;
  const smtp = saveSmtpConfig(profile, {
    user: user != null ? String(user).trim() : undefined,
    appPassword: appPassword != null ? String(appPassword) : undefined,
    fromEmail: fromEmail != null ? String(fromEmail).trim() : undefined,
    fromName: fromName != null ? String(fromName).trim() : undefined,
    host: host != null ? String(host).trim() : undefined,
    port: portNum,
    // 465 → implicit TLS; other ports (587, 2525…) → plain + STARTTLS.
    // Follow the port automatically unless secure was set explicitly.
    secure: req.body?.secure !== undefined && req.body?.secure !== null
      ? (req.body.secure === true || req.body.secure === 'true')
      : (portNum != null ? portNum === 465 : undefined),
  });
  let canSend = false;
  try { canSend = await canSendMail(profile); } catch {}
  res.json({ ok: true, smtp, canSend });
});

// "Test connection" only checks the login against the mail server (no email sent).
// If `to` is provided, a real test email is sent through that account too.
router.post('/api/admin/smtp/test', requireAdmin, async (req, res) => {
  const profile = req.body?.profile === 'mailing' ? 'mailing' : 'system';
  const to = String(req.body?.to || '').trim();
  try {
    const v = await testSmtpConnection(profile);
    if (!v.ok) {
      const how = v.viaBridge ? ' (through the mail bridge)' : '';
      return res.status(400).json({ error: `Login failed for ${v.user || 'this account'} on ${v.host || 'the server'}${how} — check the email and app password. (${v.error || 'rejected by server'})` });
    }
    const how = v.viaBridge ? ' (through the mail bridge)' : '';
    let message = `✅ Login works — signed in as ${v.user} on ${v.host}:${v.port}${how}. No email was sent.`;
    if (to) {
      try {
        await sendMail({
          profile,
          to,
          subject: `Fundo Plus test email (${profile === 'mailing' ? 'mailing account' : 'system account'})`,
          text: `This is a test email from your Fundo Plus ${profile} email account. If you can read this, sending works.`,
          html: `<div style="font-family:system-ui,sans-serif;padding:20px"><h2 style="color:#2563eb">Fundo Plus</h2><p>✅ This is a <b>test email</b> from your <b>${profile}</b> email account.</p><p style="color:#64748b;font-size:13px">Sent ${new Date().toLocaleString()}</p></div>`,
          purpose: 'test',
          sentBy: adminActor(req),
        });
        message = `✅ Login works as ${v.user}${how}, and a test email was sent to ${to}. Check it arrived (spam too).`;
      } catch (e) {
        return res.status(400).json({ error: `Login works as ${v.user}, but sending a test email to ${to} failed: ${e.message}` });
      }
    }
    res.json({ ok: true, message });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Test failed' });
  }
});

// Admin → user(s) email, sent through the dedicated mailing account
router.post('/api/admin/email/send', requireAdmin, async (req, res) => {
  const { target, emails, subject, message } = req.body || {};
  const subj = String(subject || '').trim();
  const body = String(message || '').trim();
  if (!subj || !body) return res.status(400).json({ error: 'Subject and message are required' });
  if (!['all', 'single', 'multiple'].includes(target))
    return res.status(400).json({ error: 'target must be all, single, or multiple' });

  let list = [];
  if (target === 'all') {
    const raw = getAllWebUsers();
    const users = Array.isArray(raw) ? raw : Object.values(raw || {});
    list = users.map(u => String(u.email || '').toLowerCase().trim()).filter(e => e && e.includes('@'));
  } else {
    list = (Array.isArray(emails) ? emails : [emails]).map(e => String(e || '').toLowerCase().trim()).filter(e => e && e.includes('@'));
  }
  list = [...new Set(list)];
  if (!list.length) return res.status(400).json({ error: 'No valid recipient emails found' });

  const actor = adminActor(req);
  const result = await sendAdminMail({ recipients: list, subject: subj, text: body, sentBy: actor });
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ ok: true, ...result });
});

// Email activity log — every email sent by the system or by an admin
router.get('/api/admin/email/logs', requireAdmin, (req, res) => {
  res.json({ ok: true, logs: getEmailLogs(req.query?.limit) });
});

router.post('/api/admin/email/logs/clear', requireAdmin, (req, res) => {
  clearEmailLogs();
  res.json({ ok: true });
});

// ── Mail bridge (for SMTP-blocked hosts like Railway free) ──
router.get('/api/admin/mail-service', requireAdmin, (req, res) => {
  const s = getMailService();
  res.json({ ok: true, service: { url: s.url, hasKey: !!s.key, enabled: s.enabled } });
});

router.post('/api/admin/mail-service', requireAdmin, (req, res) => {
  const { url, key } = req.body || {};
  if (url !== undefined && url !== '' && !/^https?:\/\//i.test(String(url))) {
    return res.status(400).json({ error: 'Bridge URL must start with http:// or https://' });
  }
  const service = saveMailServiceConfig({ url, key });
  res.json({ ok: true, service });
});

router.post('/api/admin/mail-service/test', requireAdmin, async (req, res) => {
  const s = getMailService();
  if (!s.enabled) return res.status(400).json({ error: 'Set the bridge URL and API key first.' });
  try {
    const r = await fetch(s.url.replace(/\/+$/, '') + '/health', {
      headers: { Authorization: `Bearer ${s.key}` },
      signal: AbortSignal.timeout(15000),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) {
      return res.status(400).json({ error: `Bridge responded ${r.status}${d.error ? ' — ' + d.error : ''}. Check the URL and API key.` });
    }
    res.json({ ok: true, message: `✅ Bridge reachable at ${s.url} — email will be sent through it.` });
  } catch (e) {
    res.status(400).json({ error: `Could not reach the bridge: ${e.message}` });
  }
});

// ═══════════════════════════════════════════════════════════════════
//  ONBOARDING
// ═══════════════════════════════════════════════════════════════════
router.post('/api/onboarding', requireAuth, (req, res) => {
  const { name, surname, age, school } = req.body || {};
  if (!name || !surname || !age || !school)
    return res.status(400).json({ error: 'All fields required' });
  if (isNaN(age) || age < 5 || age > 80)
    return res.status(400).json({ error: 'Invalid age' });
  const updated = saveWebUser(req.user.id, {
    name: name.trim(), surname: surname.trim(),
    age: parseInt(age), school: school.trim(),
    onboarded: true,
  });
  res.json({ ok: true, user: sanitizeUser(updated) });
});

// ═══════════════════════════════════════════════════════════════════
//  DASHBOARD / USER API
// ═══════════════════════════════════════════════════════════════════
router.get('/api/me', requireAuth, (req, res) => {
  const user = req.user;
  let pairingStatus = 'none', daysLeft = null;
  if (user.jid) {
    pairingStatus = 'paired';
  } else if (user.dashboardFirstAt) {
    const days = (Date.now() - new Date(user.dashboardFirstAt).getTime()) / 86400000;
    daysLeft = Math.max(0, Math.ceil(14 - days));
    pairingStatus = daysLeft > 0 ? 'grace' : 'grace'; // no forced linking anymore
  } else {
    pairingStatus = 'grace'; daysLeft = 14;
  }

  const plan = getUserPlan(user.id);
  const isLinked = !!user.jid;
  let limits = getPlanLimits(user.id, isLinked);
  const usage  = getFullUsage(user.id);
  const sub    = getUserSubscription(user.id);

  // Ambassadors get unlimited everything
  const ambassadorActive = !!(getAmbassadorByEmail(user.email));
  if (ambassadorActive) {
    limits = { plan: 'ambassador', aiMsg: 'unlimited', projects: 'unlimited',
      studySessions: 'unlimited', pdfExports: 'unlimited', quizzes: 'unlimited', paperDl: 'unlimited' };
  }

  const balanceCents = getUserBalance(user.id);
  res.json({
    ok: true, user: sanitizeUser(user), pairingStatus, daysLeft, plan, limits, usage, sub,
    isAmbassador: ambassadorActive,
    verified: !!(isVerified(user.id) || isSupportEmail(user.email)),
    isSupport: isSupportEmail(user.email),
    paperDlUsed: getPaperDlCount(user.id),
    balanceCents,
    balanceDollars: (balanceCents / 100).toFixed(2),
  });
});

router.delete('/api/account', requireAuth, (req, res) => {
  destroySession(req.headers['x-session-token']);
  deleteWebUser(req.user.id);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════
//  PAIRING LINK
// ═══════════════════════════════════════════════════════════════════
router.post('/api/generate-link', requireAuth, (req, res) => {
  const token   = createVerifyToken(req.user.id);
  saveWebUser(req.user.id, { pendingToken: token });
  // Include a special activation code prefix so the WA bot can distinguish verification msgs
  const verifyMsg = `VERIFY:${token}`;
  const botLink   = `https://wa.me/263717129736?text=${encodeURIComponent(verifyMsg)}`;
  res.json({ token, verifyMsg, botLink, expiresInMinutes: 15 });
});

// ═══════════════════════════════════════════════════════════════════
//  SAMAZED PARTNER API — unlimited, rate-limited client-side
// ═══════════════════════════════════════════════════════════════════
const samazedHistories = new Map();

router.post('/api/samazed/chat', async (req, res) => {
  const { messages, system } = req.body || {};
  if (!messages || !Array.isArray(messages) || messages.length === 0)
    return res.status(400).json({ error: 'No messages provided' });

  const DEFAULT_SYS = 'You are Fundo AI, made by Fundo Plus. You are a helpful, intelligent AI assistant. Assist the user clearly and concisely.';
  const systemPrompt = (typeof system === 'string' && system.trim()) ? system.trim() : DEFAULT_SYS;

  try {
    const { gpt4oChat } = await import('../utils/gpt-service.js');
    const result = await gpt4oChat({
      systemInstruction: systemPrompt,
      messages: messages.slice(-20).map(m => ({ role: m.role, content: m.content })),
      temperature: 0.8,
      max_tokens: 1500,
    });
    if (!result.success) return res.status(502).json({ error: result.error || 'AI service error' });
    res.json({ reply: result.answer });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
//  AI CHAT
// ═══════════════════════════════════════════════════════════════════
router.post('/api/chat', requireOnboarded, async (req, res) => {
  const { message, stream: wantStream = false, prefs: rawPrefs = {} } = req.body || {};
  if (!message) return res.status(400).json({ error: 'No message' });
  const prefs = {
    callName: String(rawPrefs.callName || req.user.name || 'you').slice(0, 40),
    agentMode: rawPrefs.agentMode !== false,
    pdfPages: Math.min(20, Math.max(6, parseInt(rawPrefs.pdfPages, 10) || 8)),
  };

  const uid    = req.user.id;
  const isLinked = !!req.user.jid;
  const limits = getPlanLimits(uid, isLinked);
  const usage  = getFullUsage(uid);
  const ambassadorActive = !!(getAmbassadorByEmail(req.user.email));

  const aiLimit = (limits.aiMsg === 'unlimited' || ambassadorActive) ? Infinity : limits.aiMsg;
  if (aiLimit !== Infinity && (usage.chat || 0) >= aiLimit) {
    return res.status(429).json({ error: `Daily AI message limit reached (${aiLimit}). Upgrade your plan for more.` });
  }

  const stream = !!wantStream;
  const agent = prefs.agentMode !== false;
  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
  }
  const sse = (obj) => {
    if (!stream) return;
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
    if (typeof res.flush === 'function') res.flush();
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const finish = async (payload) => {
    if (!stream) return res.json(payload);
    const text = String(payload.reply || '');
    const chunks = text.split(/(?<=\s)/);
    for (const c of chunks) {
      if (!c) continue;
      sse({ type: 'delta', text: c });
      await sleep(18);
    }
    if (payload.pdf) sse({ type: 'pdf', pdf: payload.pdf });
    sse({ type: 'done' });
    return res.end();
  };

  try {
    if (stream && agent) {
      sse({ type: 'step', id: 'think', label: 'Thinking', icon: 'brain', status: 'run' });
      await sleep(900);
    }
    let reply = await askWebAI(`web:${uid}`, message, prefs);
    incrementChatUsage(uid);
    if (stream && agent) {
      sse({ type: 'step', id: 'think', label: 'Thinking', icon: 'brain', status: 'done' });
      const thought = stripPdfMarker(reply).split('\n').filter(Boolean).slice(0, 2).join(' ');
      if (thought) sse({ type: 'thought', text: thought.slice(0, 280) });
    }

    let parsed = parsePdfMarker(reply);
    const needPdf = !!(parsed || wantsPdf(message) || looksLikePdfRefusal(reply));
    if (!needPdf) return finish({ reply: stripPdfMarker(reply) || reply });

    const pdfLimit = limits.pdfExports;
    if (pdfLimit !== 'unlimited' && !ambassadorActive && (usage.pdf || 0) >= pdfLimit) {
      const text = (stripPdfMarker(reply) || reply) +
        `\n\nI drafted the notes, but your **daily PDF export limit** (${pdfLimit}) is used up. Upgrade on Subscription to download.`;
      return finish({ reply: text });
    }

    if (!parsed || String(parsed.content || '').trim().split(/\s+/).length < 500) {
      try {
        parsed = await expandPdfContent(parsed?.title, parsed?.content, message);
      } catch (e) {
        console.warn('[AI PDF] expand failed:', e.message);
      }
    }
    if (!parsed || String(parsed.content || '').trim().length < 200) {
      return finish({ reply: (stripPdfMarker(reply) || reply) + '\n\nI could not finish the PDF body. Try again with a specific topic.' });
    }

    if (stream && agent) {
      sse({ type: 'step', id: 'pdf', label: 'Generating PDF', icon: 'bash', status: 'run' });
    }
    const { generatePdf } = await import('../utils/pdfgen.js');
    const { v4: uuidv4 } = await import('uuid');
    const { randomBytes } = await import('crypto');
    const outDir = path.join(__dirname, '..', 'temp', 'ai-pdfs');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const jobId = uuidv4();
    const title = parsed.title || 'Fundo AI notes';
    const meta = {
      title,
      student: `${req.user.name || ''} ${req.user.surname || ''}`.trim() || 'Student',
      school: req.user.school || 'Fundo Plus',
      subject: 'Study notes',
      level: '',
      year: String(new Date().getFullYear()),
    };
    const fp = await generatePdf(title, parsed.content, jobId, outDir, meta, { pixabayKey: process.env.PIXABAY_KEY || '', minPages: prefs.pdfPages });
    incrementPdfUsage(uid);

    const dlToken = randomBytes(24).toString('hex');
    const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
    pendingDownloads.set(dlToken, { filePath: fp, expiresAt, title, kind: 'ai-pdf' });
    const downloadUrl = `/api/ai/pdf/${dlToken}?dl=1`;
    const previewUrl = `/api/ai/pdf/${dlToken}`;
    const preface = parsed.preface || stripPdfMarker(reply) || `I've written **${title}**.`;
    const notice =
      `${preface}\n\n` +
      `**${title}** is hosted on Fundo Plus.\n\n` +
      `⏱️ This file is **deleted after 24 hours**.\n\n` +
      `[Download PDF](${downloadUrl}) · [Preview](${previewUrl})`;
    return finish({
      reply: notice,
      pdf: { title, downloadUrl, previewUrl, expiresAt, notice: 'Deleted after 24 hours' },
    });
  } catch (e) {
    if (stream) {
      try { res.write(`data: ${JSON.stringify({ type: 'error', error: e.message })}\n\n`); res.end(); } catch {}
      return;
    }
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/quiz/generate', requireOnboarded, async (req, res) => {
  const uid = req.user.id;
  const isLinked = !!req.user.jid;
  const limits = getPlanLimits(uid, isLinked);
  const usage  = getFullUsage(uid);

  if (limits.quizzes !== 'unlimited' && (usage.quizzes || 0) >= limits.quizzes) {
    return res.status(429).json({ error: `Daily quiz limit reached (${limits.quizzes}). Upgrade for more.` });
  }

  const { text, count = 10, style = 'mixed' } = req.body || {};
  if (!text) return res.status(400).json({ error: 'No text provided' });

  try {
    const prompt = `You are a quiz generator for Zimbabwean students (ZIMSEC curriculum).
Based on the following study material, generate exactly ${count} quiz questions.

Style: ${style} (multiple-choice, short-answer, or mixed)

For multiple-choice use this EXACT format:
Q: [question]
A) [option]
B) [option]
C) [option]
D) [option]
ANSWER: [correct letter]
EXPLANATION: [clear explanation]

For short-answer use:
Q: [question]
ANSWER: [model answer]
EXPLANATION: [full explanation]

Study material:
${text.slice(0, 6000)}

Generate ${count} questions now. Always include EXPLANATION for every question:`;

    const { gpt4oChat } = await import('../utils/gpt-service.js');
    const result = await gpt4oChat({
      systemInstruction: 'You are a quiz generator. Always include EXPLANATION for each question.',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 3000, temperature: 0.7,
    });
    if (!result.success) throw new Error(result.error);
    const questions = parseQuizFromAI(result.answer, style);
    incrementQuizUsage(uid);
    res.json({ questions, raw: result.answer });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function parseQuizFromAI(rawText, style) {
  const questions = [];
  const text = typeof rawText === 'string' ? rawText : JSON.stringify(rawText || '');
  if (!text.trim()) return [];
  const blocks = text.split(/\n(?=Q:)/g);
  for (const block of blocks) {
    if (!block.trim().startsWith('Q:')) continue;
    const lines = block.trim().split('\n');
    const question = lines[0].replace(/^Q:\s*/, '').trim();
    const options = {};
    let answer = '', explanation = '';
    for (const l of lines.slice(1)) {
      if (/^A\)/.test(l)) options.A = l.slice(2).trim();
      else if (/^B\)/.test(l)) options.B = l.slice(2).trim();
      else if (/^C\)/.test(l)) options.C = l.slice(2).trim();
      else if (/^D\)/.test(l)) options.D = l.slice(2).trim();
      else if (/^ANSWER:/.test(l)) answer = l.replace('ANSWER:', '').trim();
      else if (/^EXPLANATION:/.test(l)) explanation = l.replace('EXPLANATION:', '').trim();
    }
    if (question) questions.push({ question, options, answer, explanation, type: Object.keys(options).length > 0 ? 'mcq' : 'short' });
  }
  return questions;
}

// ═══════════════════════════════════════════════════════════════════
//  RESOURCES / PAPERS
// ═══════════════════════════════════════════════════════════════════
router.get('/api/resources', requireAuth, (req, res) => {
  res.json({ papers: listPapersLocal() });
});

router.get('/api/papers', requireOnboarded, (req, res) => {
  const uid    = req.user.id;
  const papers = listPapersLocal();
  const totalBytes = getPapersTotalBytes();
  res.json({ papers, totalBytes, limitBytes: MAX_PAPERS_BYTES,
    usedMB: (totalBytes/1024/1024).toFixed(2), limitMB: (MAX_PAPERS_BYTES/1024/1024).toFixed(0) });
});

// NOTE: /api/papers/file/:filename and /api/papers/preview/:filename are handled
// by bot.js AFTER this router — it has Supabase fallback + local caching.

// ═══════════════════════════════════════════════════════════════════
//  TOOLS
// ═══════════════════════════════════════════════════════════════════
router.post('/api/tools/pdf', requireOnboarded, async (req, res) => {
  const uid = req.user.id;
  const isLinked = !!req.user.jid;
  const limits = getPlanLimits(uid, isLinked);
  const usage  = getFullUsage(uid);

  if (limits.pdfExports !== 'unlimited' && (usage.pdf || 0) >= limits.pdfExports) {
    return res.status(429).json({ error: `Daily PDF export limit reached (${limits.pdfExports}). Upgrade for more.` });
  }

  const { title, content } = req.body || {};
  if (!title || !content) return res.status(400).json({ error: 'title and content required' });
  try {
    const { generatePdf } = await import('../utils/pdfgen.js');
    const { v4: uuidv4 }  = await import('uuid');
    const outDir = path.join(__dirname, '..', 'temp', 'docs');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const fp = await generatePdf(title, content, uuidv4(), outDir);
    const buf = fs.readFileSync(fp);
    incrementPdfUsage(uid);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${title.replace(/[^a-z0-9]/gi,'_')}.pdf"`);
    res.send(buf);
    setTimeout(() => { try { fs.unlinkSync(fp); } catch {} }, 60_000);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function incrementPdfUsage(uid) {
  _incPdf(uid);
}

router.post('/api/tools/imagine', requireOnboarded, async (req, res) => {
  const { prompt } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'No prompt' });
  const HF_TOKEN = process.env.HF_TOKEN || '';
  const MODELS = ['stabilityai/stable-diffusion-xl-base-1.0','runwayml/stable-diffusion-v1-5'];
  let lastErr = '';
  for (const model of MODELS) {
    try {
      const r = await fetch(`https://api-inference.huggingface.co/models/${model}`, {
        method: 'POST',
        headers: { 'Authorization': HF_TOKEN ? `Bearer ${HF_TOKEN}` : '', 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputs: prompt }),
      });
      if (!r.ok) { lastErr = await r.text(); continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      return res.json({ image: 'data:image/jpeg;base64,' + buf.toString('base64'), model });
    } catch (e) { lastErr = e.message; }
  }
  res.status(503).json({ error: 'Image generation unavailable: ' + lastErr.slice(0, 200) });
});

// ═══════════════════════════════════════════════════════════════════
//  SKILLS & STUDY (usage tracked)
// ═══════════════════════════════════════════════════════════════════
router.get('/api/skills/syllabuses', (req, res) => {
  try {
    if (!fs.existsSync(SYLLABUS_DIR)) return res.json({ ok: true, syllabuses: [] });
    const files = fs.readdirSync(SYLLABUS_DIR).filter(f => f.endsWith('.json') || f.endsWith('.txt'));
    const syllabuses = files.map(f => {
      try {
        const raw = fs.readFileSync(path.join(SYLLABUS_DIR, f), 'utf8');
        if (f.endsWith('.json')) { const parsed = JSON.parse(raw); return { ...parsed, _file: f }; }
        const lines = raw.trim().split('\n').filter(Boolean);
        return { id: f.replace('.txt',''), name: lines[0] || f, topics: lines.slice(1), _file: f };
      } catch { return null; }
    }).filter(Boolean);
    res.json({ ok: true, syllabuses });
  } catch { res.json({ ok: true, syllabuses: [] }); }
});

router.get('/api/skills/files', (req, res) => {
  try {
    if (!fs.existsSync(SKILLS_DIR)) return res.json({ ok: true, files: [] });
    const files = fs.readdirSync(SKILLS_DIR)
      .filter(f => (f.endsWith('.md') || f.endsWith('.txt')) && !fs.statSync(path.join(SKILLS_DIR, f)).isDirectory())
      .map(f => ({ name: f, size: fs.statSync(path.join(SKILLS_DIR, f)).size }));
    res.json({ ok: true, files });
  } catch { res.json({ ok: true, files: [] }); }
});

// Track study session open
router.post('/api/skills/session', requireAuth, (req, res) => {
  const uid = req.user.id;
  const isLinked = !!req.user.jid;
  const limits = getPlanLimits(uid, isLinked);
  const usage  = getFullUsage(uid);

  if (limits.studySessions !== 'unlimited' && (usage.studySessions || 0) >= limits.studySessions) {
    return res.status(429).json({ error: `Daily study session limit reached (${limits.studySessions}). Upgrade for more.` });
  }
  incrementStudySession(uid);
  res.json({ ok: true });
});

// ── Project generator (counts project usage, not pdf exports) ─────────────
router.post('/api/skills/project', requireAuth, async (req, res) => {
  const uid = req.user.id;
  const isLinked = !!req.user.jid;
  const limits = getPlanLimits(uid, isLinked);
  const usage  = getFullUsage(uid);

  // Projects is lifetime total for free, daily reset for paid
  const projUsed = usage.projectsTotal || 0;
  if (limits.projects !== 'unlimited' && projUsed >= limits.projects) {
    return res.status(429).json({ error: `Project limit reached (${limits.projects}). Upgrade for more.` });
  }

  const { name, content, asPdf } = req.body || {};
  if (!content) return res.status(400).json({ error: 'content required' });

  try {
    if (!fs.existsSync(PROJECTS_DIR)) fs.mkdirSync(PROJECTS_DIR, { recursive: true });
    const filename = `${Date.now()}-${(name||'project').replace(/[^a-z0-9]/gi,'-').slice(0,30)}.md`;
    const filepath = path.join(PROJECTS_DIR, filename);
    fs.writeFileSync(filepath, content, 'utf8');
    incrementProjectUsage(uid);

    if (asPdf) {
      const { generatePdf } = await import('../utils/pdfgen.js');
      const { v4: uuidv4 }  = await import('uuid');
      const outDir = path.join(__dirname, '..', 'temp', 'docs');
      if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
      const fp  = await generatePdf(name || 'Study Project', content, uuidv4(), outDir);
      const buf = fs.readFileSync(fp);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${(name||'project').replace(/[^a-z0-9]/gi,'_')}.pdf"`);
      res.send(buf);
      setTimeout(() => { try { fs.unlinkSync(fp); } catch {} }, 60_000);
    } else {
      res.json({ ok: true, filename });
    }
  } catch (e) {
    res.status(500).json({ error: 'Failed to save project' });
  }
});

// Read project template MD
router.get('/api/skills/project-template', (req, res) => {
  const tmpl = path.join(SKILLS_DIR, 'projects', 'TEMPLATE.md');
  if (fs.existsSync(tmpl)) return res.json({ ok: true, template: fs.readFileSync(tmpl, 'utf8') });
  // Default template
  res.json({ ok: true, template: `# Project Title\n\n## Subject\n## Level\n## Objectives\n## Key Concepts\n## Worked Examples\n## Practice Questions\n## Study Tips\n` });
});

// ═══════════════════════════════════════════════════════════════════
//  PROJECT GENERATOR — /api/skills/project-gen
//  Generates a 10+ page ZIMSEC academic project PDF, saves it with
//  a token-protected download URL that expires after 1 hour.
// ═══════════════════════════════════════════════════════════════════

// Add this near the top of routes.js with other imports:
// import crypto from 'crypto';

// In-memory map of download tokens → { filePath, expiresAt }
// (Survives server restarts only as long as process is alive)
const pendingDownloads = new Map();

// Clean expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of pendingDownloads.entries()) {
    if (now > entry.expiresAt) {
      try { fs.unlinkSync(entry.filePath); } catch {}
      pendingDownloads.delete(token);
    }
  }
}, 5 * 60 * 1000);

// ── Skills/project reference content ─────────────────────────────────────────
function loadProjectSkills() {
  const bits = [];
  // ZIMSEC guide
  try {
    const guide = fs.readFileSync(path.join(SKILLS_DIR, 'zimsec-guide.md'), 'utf8');
    bits.push(`=== ZIMSEC Guide ===\n${guide}`);
  } catch {}
  // Project template
  try {
    const tmpl = fs.readFileSync(path.join(PROJECTS_DIR, 'TEMPLATE.md'), 'utf8');
    bits.push(`=== Project Template ===\n${tmpl}`);
  } catch {}
  return bits.join('\n\n');
}

// ── Build AI system prompt ────────────────────────────────────────────────────
function buildProjectSystemPrompt(skillsText) {
  return `You are an expert academic project writer for Zimbabwean students (ZIMSEC curriculum).
Your task is to write a comprehensive, high-quality academic project following the ZIMSEC 6-stage project structure.

CRITICAL REQUIREMENTS:
- Write at minimum 2,500 words (typically 3,000–4,000 words) to ensure 10+ pages when rendered as PDF
- Follow all 6 ZIMSEC project stages in order (Problem Identification, Investigation of Related Ideas, Generation of Ideas, Development of Idea, Presentation of Results, Evaluation and Recommendations)
- Use proper academic language appropriate for the stated level (Grade 7, O-Level, or A-Level)
- Include specific, realistic, Zimbabwe-contextualised content throughout
- Use markdown formatting: # for stage headings, ## for sub-sections, ### for sub-sub-sections
- Use numbered lists, bullet points, and bold text where appropriate
- Every section must be substantive — no thin sections
- Write as if this is the student's genuine project work — first person where appropriate
- Include: tables of data, analysis, diagrams described in text, worked examples, evidence

FORMAT RULES:
- Start directly with the project content (no preamble)
- Use # Stage 1: Problem Identification, # Stage 2: ..., etc. as main headings
- Each stage must have detailed sub-sections using ## and ###
- Reference Zimbabwe-specific places, organisations, data, and context throughout
- End with a professional bibliography/references section

${skillsText ? `\nREFERENCE MATERIAL:\n${skillsText}` : ''}`;
}

// ── POST /api/skills/project-gen ──────────────────────────────────────────────
router.post('/api/skills/project-gen', requireAuth, async (req, res) => {
  const uid      = req.user.id;
  const isLinked = !!req.user.jid;
  const limits   = getPlanLimits(uid, isLinked);
  const usage    = getFullUsage(uid);

  // Check project usage limits
  const projUsed = usage.projectsTotal || 0;
  if (limits.projects !== 'unlimited' && projUsed >= limits.projects) {
    return res.status(429).json({
      error: `Project limit reached (${limits.projects}). Upgrade for more.`
    });
  }

  const { title, student, school, district, level, subject, year, teacher, context } = req.body || {};

  if (!title)    return res.status(400).json({ error: 'Project title is required' });
  if (!student)  return res.status(400).json({ error: 'Student name is required' });
  if (!school)   return res.status(400).json({ error: 'School name is required' });
  if (!district) return res.status(400).json({ error: 'District/city is required' });

  try {
    // ── Load skills reference ──────────────────────────────────────────────────
    const skillsText = loadProjectSkills();

    // ── Build AI prompt ────────────────────────────────────────────────────────
    const systemPrompt = buildProjectSystemPrompt(skillsText);
    const userPrompt = [
      `Write a full ZIMSEC academic project with the following details:`,
      ``,
      `- **Project Title:** ${title}`,
      `- **Subject:** ${subject || 'General'}`,
      `- **Academic Level:** ${level || 'O-Level'}`,
      `- **Student Name:** ${student}`,
      `- **School:** ${school}`,
      `- **District/City:** ${district}`,
      teacher ? `- **Supervisor/Teacher:** ${teacher}` : '',
      `- **Year:** ${year || new Date().getFullYear()}`,
      context ? `- **Additional Context:** ${context}` : '',
      ``,
      `Write the complete project following all 6 ZIMSEC stages. Be comprehensive and detailed. Minimum 2,500 words. Use Zimbabwe-specific examples, data, and references throughout.`,
    ].filter(l => l !== null && l !== undefined).join('\n');

    // ── Call GPT service ───────────────────────────────────────────────────────
    const { gpt4oChat } = await import('../utils/gpt-service.js');
    const gptResult = await gpt4oChat({
      systemInstruction: systemPrompt,
      message: userPrompt,
      max_tokens: 4096,
      temperature: 0.72,
    });

    if (!gptResult.success) {
      throw new Error(gptResult.error || 'AI generation failed');
    }

    const content = gptResult.answer;

    // ── Save markdown copy ──────────────────────────────────────────────────────
    if (!fs.existsSync(PROJECTS_DIR)) fs.mkdirSync(PROJECTS_DIR, { recursive: true });
    const mdFilename = `${Date.now()}-${student.replace(/[^a-z0-9]/gi,'-').slice(0,20)}.md`;
    fs.writeFileSync(path.join(PROJECTS_DIR, mdFilename), content, 'utf8');
    incrementProjectUsage(uid);

    // ── Generate PDF ───────────────────────────────────────────────────────────
    const { generatePdf } = await import('../utils/pdfgen.js');
    const { v4: uuidv4 }  = await import('uuid');
    const outDir  = path.join(__dirname, '..', 'temp', 'projects');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const jobId  = uuidv4();
    const meta   = { student, school, district, level, subject, year, teacher, title };
    const pdfOpts = { pixabayKey: process.env.PIXABAY_KEY || '' };
    const fp     = await generatePdf(title, content, jobId, outDir, meta, pdfOpts);

    // ── Create expiring download token ─────────────────────────────────────────
    const { randomBytes } = await import('crypto');
    const dlToken  = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 60 * 60 * 1000; // 1 hour
    pendingDownloads.set(dlToken, { filePath: fp, expiresAt, title });

    const downloadUrl = `/api/skills/project-download/${dlToken}`;
    const previewUrl  = `/api/skills/project-preview/${dlToken}`;

    res.json({
      ok: true,
      downloadUrl,
      previewUrl,
      preview: content,
      expiresAt,
      message: 'Project generated. Download link expires in 1 hour.',
    });

  } catch (err) {
    console.error('[ProjectGen] Error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to generate project' });
  }
});

// ── GET /api/skills/project-download/:token ────────────────────────────────────
// Token-protected, 1-hour expiring PDF download endpoint
router.get('/api/skills/project-download/:token', (req, res) => {
  const { token } = req.params;
  const entry = pendingDownloads.get(token);

  if (!entry) {
    return res.status(404).send(`
      <!doctype html>
      <html><head><title>Link Expired — Fundo Plus</title>
      <style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f0f4ff}
      .box{text-align:center;padding:40px;background:#fff;border-radius:16px;max-width:400px;box-shadow:0 4px 24px rgba(0,0,0,.08)}
      h2{color:#dc2626;margin-bottom:10px}p{color:#6374a0;font-size:.9rem}a{color:#2952e3;font-weight:700}</style>
      </head><body><div class="box">
      <h2>⛔ Link Expired or Invalid</h2>
      <p>This download link has expired or does not exist. Download links are valid for <strong>1 hour</strong> after generation.</p>
      <p style="margin-top:20px"><a href="/~/projectgen">← Generate a new project</a></p>
      </div></body></html>
    `);
  }

  if (Date.now() > entry.expiresAt) {
    pendingDownloads.delete(token);
    try { fs.unlinkSync(entry.filePath); } catch {}
    return res.status(410).send(`
      <!doctype html>
      <html><head><title>Link Expired — Fundo Plus</title>
      <style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f0f4ff}
      .box{text-align:center;padding:40px;background:#fff;border-radius:16px;max-width:400px;box-shadow:0 4px 24px rgba(0,0,0,.08)}
      h2{color:#dc2626;margin-bottom:10px}p{color:#6374a0;font-size:.9rem}a{color:#2952e3;font-weight:700}</style>
      </head><body><div class="box">
      <h2>⏱️ Link Expired</h2>
      <p>This download link was valid for 1 hour and has now expired. Please generate your project again.</p>
      <p style="margin-top:20px"><a href="/~/projectgen">← Generate a new project</a></p>
      </div></body></html>
    `);
  }

  if (!fs.existsSync(entry.filePath)) {
    pendingDownloads.delete(token);
    return res.status(404).json({ error: 'File not found. Please regenerate.' });
  }

  const filename = (entry.title || 'project').replace(/[^a-z0-9]/gi, '_') + '.pdf';
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  const buf = fs.readFileSync(entry.filePath);
  res.send(buf);

  // Clean up file after download (optional — also cleaned by the interval)
  setTimeout(() => {
    try { fs.unlinkSync(entry.filePath); } catch {}
    pendingDownloads.delete(token);
  }, 5 * 60 * 1000); // Remove 5 min after download
});



// ── GET /api/skills/project-preview/:token ─────────────────────────────────────
// Serves the PDF inline (for embedding in <iframe>)
router.get('/api/skills/project-preview/:token', (req, res) => {
  const { token } = req.params;
  const entry = pendingDownloads.get(token);
  if (!entry || Date.now() > entry.expiresAt) {
    return res.status(404).send('Preview expired or not found.');
  }
  if (!fs.existsSync(entry.filePath)) {
    return res.status(404).send('File not found.');
  }
  const buf = fs.readFileSync(entry.filePath);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('Content-Length', buf.length);
  res.send(buf);
});

router.get('/api/ai/pdf/:token', (req, res) => {
  const entry = pendingDownloads.get(req.params.token);
  if (!entry) {
    return res.status(404).send(`<!doctype html><html><head><title>Expired — Fundo Plus</title>
      <style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f0f4ff}
      .box{text-align:center;padding:36px;background:#fff;border-radius:16px;max-width:420px;box-shadow:0 4px 24px rgba(0,0,0,.08)}
      h2{margin:0 0 10px}p{color:#64748b}</style></head><body><div class="box">
      <h2>PDF expired</h2><p>Fundo AI files are deleted after <strong>24 hours</strong>. Ask Fundo AI to generate it again.</p>
      <p><a href="/ai">← Back to Fundo AI</a></p></div></body></html>`);
  }
  if (Date.now() > entry.expiresAt) {
    pendingDownloads.delete(req.params.token);
    try { fs.unlinkSync(entry.filePath); } catch {}
    return res.status(410).send(`<!doctype html><html><head><title>Expired — Fundo Plus</title>
      <style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f0f4ff}
      .box{text-align:center;padding:36px;background:#fff;border-radius:16px;max-width:420px;box-shadow:0 4px 24px rgba(0,0,0,.08)}
      h2{margin:0 0 10px}p{color:#64748b}</style></head><body><div class="box">
      <h2>PDF expired</h2><p>This file was deleted after 24 hours. Ask Fundo AI to generate it again.</p>
      <p><a href="/ai">← Back to Fundo AI</a></p></div></body></html>`);
  }
  if (!fs.existsSync(entry.filePath)) {
    pendingDownloads.delete(req.params.token);
    return res.status(404).send('File not found. Ask Fundo AI to generate it again.');
  }
  const filename = (entry.title || 'fundo-ai-notes').replace(/[^a-z0-9]/gi, '_') + '.pdf';
  const asDownload = String(req.query.dl || '') === '1';
  const buf = fs.readFileSync(entry.filePath);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Length', buf.length);
  res.setHeader('Content-Disposition', asDownload ? `attachment; filename="${filename}"` : 'inline');
  res.send(buf);
});

// ═══════════════════════════════════════════════════════════════════
//  SUBSCRIPTION
// ═══════════════════════════════════════════════════════════════════
router.get('/api/subscription', requireAuth, (req, res) => {
  const uid  = req.user.id;
  const plan = getUserPlan(uid);
  const sub  = getUserSubscription(uid);
  const isLinked = !!req.user.jid;
  const limits = getPlanLimits(uid, isLinked);
  const usage  = getFullUsage(uid);
  const balanceCents = getUserBalance(uid);
  const pendingDeposits = getPendingDepositsForUser(uid).filter(p => p.status === 'pending');
  res.json({
    ok: true, plan, sub, limits, usage, plans: PLANS,
    balance: balanceCents,
    balanceDollars: (balanceCents / 100).toFixed(2),
    withdrawalBalance: getWithdrawalBalance(uid),
    withdrawalDollars: (getWithdrawalBalance(uid) / 100).toFixed(2),
    remainingTopup: getRemainingTopupCapacity(uid),
    remainingTopupDollars: (getRemainingTopupCapacity(uid) / 100).toFixed(2),
    maxBalanceDollars: (MAX_BALANCE_CENTS / 100).toFixed(2),
    feePct: TRANSACTION_FEE_PCT,
    paynowConfigured: isPaynowConfigured(),
    pendingDeposit: pendingDeposits[0] || null,
    withdrawals: getWithdrawals(uid),
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  WALLET — top up via Paynow, buy plans with balance, withdraw (5% fee)
// ══════════════════════════════════════════════════════════════════════════

// Rate-limit money endpoints (defense against scripting / brute-force)
const moneyLimiter = rateLimit({
  windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
});

// Step 1: initiate a Paynow TOP-UP (adds money to the virtual wallet).
// The amount is validated and capped server-side — never trust the client.
router.post('/api/topup', requireAuth, moneyLimiter, async (req, res) => {
  const uid = req.user.id;
  const { amount, method, phone } = req.body || {};

  const cents = sanitizeCents(amount);
  if (!cents) return res.status(400).json({ error: 'Enter a valid USD amount (e.g. 5.00).' });

  const remaining = getRemainingTopupCapacity(uid);

  if (cents < MIN_TOPUP_CENTS) {
    return res.status(400).json({ error: `Minimum top-up is $${(MIN_TOPUP_CENTS/100).toFixed(2)}.` });
  }
  if (cents > remaining) {
    return res.status(400).json({ error: `Maximum top-up is $${(remaining/100).toFixed(2)} — your balance can hold at most $${(MAX_BALANCE_CENTS/100).toFixed(2)}.` });
  }

  // Block concurrent in-flight top-ups
  const existing = getPendingDepositsForUser(uid).find(p => p.status === 'pending');
  if (existing) {
    return res.status(400).json({ error: 'You already have a top-up in progress. Wait for it to confirm or fail.', reference: existing.reference });
  }

  const reference = `fp-${uid}-${Date.now()}`;
  try {
    const pay = await createPayment({
      amount:      cents / 100,
      method:      method || 'ecocash',
      phone:       String(phone || '').replace(/\s+/g, ''),
      reference,
      description: 'Fundo Plus wallet top-up (USD)',
    });

    savePendingDeposit({ reference, userId: uid, amountCents: cents, pollUrl: pay.pollUrl, method: method || 'ecocash', phone: phone || '' });

    await flushMoneyBackup(); // persist the pending deposit BEFORE returning — else a crash could lose the in-flight payment

    res.json({
      ok: true, reference, amountDollars: (cents/100).toFixed(2),
      redirectUrl: pay.redirectUrl, pollUrl: pay.pollUrl,
      instructions: pay.instructions || `Check your phone — a ${method || 'EcoCash'} prompt has been sent to approve $${(cents/100).toFixed(2)}.`,
    });
  } catch (e) {
    console.error('[Paynow topup error]', e.message);
    const safe = e.message && e.message.length < 200 && !e.message.toLowerCase().includes('hash')
      ? e.message : 'Could not initiate payment. Check your number and try again.';
    res.status(502).json({ error: safe });
  }
});

// Step 2: Paynow status-update webhook — credits the wallet on confirmation.
// Awaits the durable Supabase backup BEFORE ACKing, so Paynow won't consider the
// update lost if we crash immediately after — and the credit can't be lost.
router.post('/api/paynow/update', async (req, res) => {
  const params = req.body || {};
  if (!verifyUpdate(params)) return res.status(400).send('Invalid hash');

  const status    = (params.status || '').toLowerCase();
  const reference = params.reference || '';
  const paynowRef = params.paynowreference || '';

  if (!getPendingDeposit(reference)) return res.send('OK'); // unknown/already processed — ACK

  if (status === 'paid' || status === 'awaiting delivery') {
    finalizeDeposit(reference, paynowRef);
  } else if (status === 'cancelled' || status === 'failed' || status === 'disputed') {
    failDeposit(reference);
  }
  await flushMoneyBackup(); // durable before ACK
  res.send('OK');
});

// Step 3: poll for top-up confirmation (client calls every few seconds).
router.get('/api/subscription/poll', requireAuth, async (req, res) => {
  const reference = req.query.reference || '';
  if (!reference) return res.status(400).json({ error: 'reference required' });

  const pend = getPendingDeposit(reference);
  if (!pend || pend.userId !== req.user.id) return res.status(404).json({ status: 'unknown' });

  if (pend.status === 'paid') {
    return res.json({ status: 'paid', balance: getUserBalance(req.user.id) });
  }
  if (pend.status === 'failed') return res.json({ status: 'failed' });

  if (pend.pollUrl) {
    try {
      const s = await pollTransaction(pend.pollUrl);
      const st = (s.status || '').toLowerCase();
      if (st === 'paid' || st === 'awaiting delivery') {
        finalizeDeposit(reference, s.paynowreference || '');
        await flushMoneyBackup();
        return res.json({ status: 'paid', balance: getUserBalance(req.user.id) });
      }
      if (st === 'cancelled' || st === 'failed' || st === 'disputed') {
        failDeposit(reference);
        await flushMoneyBackup();
        return res.json({ status: 'failed' });
      }
      return res.json({ status: 'pending', paynowStatus: st });
    } catch (e) {
      return res.json({ status: 'pending', paynowStatus: 'poll-error' });
    }
  }
  return res.json({ status: 'pending' });
});

// Buy a plan using virtual balance (no direct Paynow → subscription).
router.post('/api/subscription/activate', requireAuth, moneyLimiter, async (req, res) => {
  const uid  = req.user.id;
  const { plan } = req.body || {};
  if (!PLANS[plan] || plan === 'free') return res.status(400).json({ error: 'Invalid plan' });

  const cost    = Math.round(PLANS[plan].price * 100);
  const balance = getUserBalance(uid);

  if (balance < cost) {
    return res.status(400).json({ error: `Insufficient balance. You need $${(cost/100).toFixed(2)} (have $${(balance/100).toFixed(2)}). Top up first.` });
  }
  if (getUserPlan(uid) === plan) {
    return res.status(400).json({ error: 'You are already on this plan.' });
  }

  const adj = adjustUserBalance(uid, -cost, `${plan} plan (30 days)`);
  if (!adj.ok) return res.status(400).json({ error: adj.error });
  setUserSubscription(uid, plan, 'balance');

  await flushMoneyBackup(); // durable before confirming to the user
  res.json({ ok: true, plan, balance: adj.balance, balanceDollars: (adj.balance/100).toFixed(2) });
});

// Request a withdrawal (5% fee, net paid out). Validated + atomic debit server-side.
router.post('/api/withdraw', requireAuth, moneyLimiter, async (req, res) => {
  const uid = req.user.id;
  const { amount, phone } = req.body || {};
  const cents = sanitizeCents(amount);
  if (!cents) return res.status(400).json({ error: 'Enter a valid USD amount (e.g. 3.00).' });

  const result = requestWithdrawal(uid, cents, phone);
  if (!result.ok) return res.status(400).json({ error: result.error });

  await flushMoneyBackup(); // durable before confirming

  const w = result.withdrawal;
  res.json({
    ok: true, withdrawal: w,
    feeDollars: (w.feeCents/100).toFixed(2),
    netDollars: (w.netCents/100).toFixed(2),
    balance: getUserBalance(uid),
  });
});

// List my withdrawals
router.get('/api/withdrawals', requireAuth, (req, res) => {
  res.json({ ok: true, withdrawals: getWithdrawals(req.user.id) });
});

// Wallet status (balance + withdrawal balance + transactions + pending)
router.get('/api/billing/status', requireAuth, (req, res) => {
  const uid = req.user.id;
  const balance = getUserBalance(uid);
  res.json({
    balance,
    balanceDollars: (balance/100).toFixed(2),
    withdrawalBalance: getWithdrawalBalance(uid),
    withdrawalDollars: (getWithdrawalBalance(uid)/100).toFixed(2),
    remainingTopup: getRemainingTopupCapacity(uid),
    remainingTopupDollars: (getRemainingTopupCapacity(uid)/100).toFixed(2),
    feePct: TRANSACTION_FEE_PCT,
    maxBalanceDollars: (MAX_BALANCE_CENTS/100).toFixed(2),
    plan: getUserPlan(uid),
    transactions: getBalanceTransactions(uid, 20),
    withdrawals: getWithdrawals(uid),
    pendingDeposits: getPendingDepositsForUser(uid).filter(p => p.status === 'pending'),
  });
});

// ═══════════════════════════════════════════════════════════════════
//  COMMUNITY
// ═══════════════════════════════════════════════════════════════════

// IMPORTANT: specific sub-routes MUST come before /:id wildcard routes

// Get mention count (before /:id catches it)
router.get('/api/community/mentions/count', requireAuth, (req, res) => {
  const count = getCommunityMentionCount(req.user.id);
  res.json({ ok: true, count });
});

// Mark mentions as read (before /:id catches it)
router.post('/api/community/mentions/read', requireAuth, (req, res) => {
  markCommunityMentionsRead(req.user.id);
  res.json({ ok: true });
});

// Get all messages
router.get('/api/community', (req, res) => {
  const msgs = getCommunityMessages(300);
  res.json({ ok: true, messages: msgs, total: getCommunityCount() });
});

// Post a new message
router.post('/api/community', requireAuth, async (req, res) => {
  const { text, replyTo = null, media = null } = req.body || {};
  const trimmed = String(text || '').trim();
  const hasMedia = !!(media && media.url);
  if (!trimmed && !hasMedia) return res.status(400).json({ error: 'Message text required' });
  if (trimmed.length > 1000) return res.status(400).json({ error: 'Message too long (max 1000 chars)' });
  const user = req.user;
  const displayName = user.name ? `${user.name} ${user.surname || ''}`.trim() : (user.email || 'Anonymous');
  const ambassadorStatus = !!(getAmbassadorByEmail(user.email));
  const mediaSafe = hasMedia ? {
    url: String(media.url).slice(0, 500),
    name: String(media.name || 'file').slice(0, 120),
    type: media.type || classifyMedia(media.mime, media.name),
    mime: String(media.mime || '').slice(0, 80),
    size: Number(media.size) || 0,
  } : null;
  const msg = addCommunityMessage({
    userId: user.id, name: displayName, text: trimmed, replyTo,
    media: mediaSafe,
    isAmbassador: ambassadorStatus, isAdmin: !!user.isAdmin,
  });
  try {
    const { emitChannelMessage } = await import('../bot.js').catch(() => ({}));
    if (emitChannelMessage) emitChannelMessage(msg);
  } catch (_) {}
  // Detect @mentions and store mentionedUserIds
  try {
    const mentionNames = [...trimmed.matchAll(/@([\w]+)/g)].map(m => m[1].toLowerCase());
    if (mentionNames.length) {
      const allUsers = getAllWebUsers ? getAllWebUsers() : [];
      const mentionedIds = allUsers
        .filter(u => mentionNames.some(mn => (u.name || '').toLowerCase().startsWith(mn)))
        .map(u => u.id)
        .filter(id => id !== user.id);
      if (mentionedIds.length) setCommunityMessageMentions(msg.id, mentionedIds);
    }
  } catch(e) { /* silent */ }
  res.json({ ok: true, message: msg });
});

// Like / unlike a message
router.post('/api/community/:id/like', requireAuth, (req, res) => {
  const likes = toggleCommunityLike(req.params.id, req.user.id);
  if (!likes) return res.status(404).json({ error: 'Message not found' });
  res.json({ ok: true, likes, count: likes.length, liked: likes.includes(req.user.id) });
});

// Delete a message
router.delete('/api/community/:id', requireAuth, async (req, res) => {
  const privileged = !!(req.user.isAdmin || isSupportEmail(req.user.email));
  const ok = deleteCommunityMessage(req.params.id, req.user.id, privileged);
  if (!ok) return res.status(403).json({ error: 'Not allowed or not found' });
  try {
    const { emitChannelUnsend } = await import('../bot.js').catch(() => ({}));
    if (emitChannelUnsend) emitChannelUnsend({ id: req.params.id, by: req.user.id });
  } catch (_) {}
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════
//  MESSENGER
// ═══════════════════════════════════════════════════════════════════

// Prune expired pending messages on startup + every hour
pruneExpiredMessages();
pruneExpiredMediaPreviews();
setInterval(() => { pruneExpiredMessages(); pruneExpiredMediaPreviews(); }, 60 * 60 * 1000);

// Race a promise against a hard timeout so a hung DB/store call
// can never leave a messenger request pending forever.
function withTimeout(fn, ms = 5000) {
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), ms));
  return Promise.race([Promise.resolve().then(fn), timeout]);
}
function messengerErr(res, err) {
  console.error('[Messenger]', err.message);
  res.status(500).json({ ok: false, error: 'Messenger load failed: ' + err.message });
}

// GET /api/messenger/settings — get my messenger settings
router.get('/api/messenger/settings', requireAuth, async (req, res) => {
  try {
    const result = await withTimeout(() => {
      const s = getMessengerSettings(req.user.id);
      return { ok: true, settings: s };
    });
    res.json(result);
  } catch (err) { messengerErr(res, err); }
});

// PATCH /api/messenger/settings — update settings
router.patch('/api/messenger/settings', requireAuth, async (req, res) => {
  try {
    const result = await withTimeout(() => {
      const { username, bio, profilePublic, profilePicUrl, bgType, bgUrl } = req.body || {};
      const patch = {};
      if (username !== undefined) patch.username = String(username).slice(0, 32);
      if (bio !== undefined) patch.bio = String(bio).slice(0, 120);
      if (profilePublic !== undefined) patch.profilePublic = !!profilePublic;
      if (profilePicUrl !== undefined) patch.profilePicUrl = String(profilePicUrl).slice(0, 500);
      if (bgType !== undefined) patch.bgType = ['none','default','custom'].includes(bgType) ? bgType : 'default';
      if (bgUrl !== undefined) patch.bgUrl = String(bgUrl).slice(0, 500);
      const s = saveMessengerSettings(req.user.id, patch);
      return { ok: true, settings: s };
    });
    res.json(result);
  } catch (err) { messengerErr(res, err); }
});

// POST /api/messenger/block/:targetId
router.post('/api/messenger/block/:targetId', requireAuth, async (req, res) => {
  try {
    await withTimeout(() => blockUser(req.user.id, req.params.targetId));
    res.json({ ok: true });
  } catch (err) { messengerErr(res, err); }
});

// POST /api/messenger/unblock/:targetId
router.post('/api/messenger/unblock/:targetId', requireAuth, async (req, res) => {
  try {
    await withTimeout(() => unblockUser(req.user.id, req.params.targetId));
    res.json({ ok: true });
  } catch (err) { messengerErr(res, err); }
});

// GET /api/messenger/search?q=...  — search public users
router.get('/api/messenger/search', requireAuth, async (req, res) => {
  try {
    const results = await withTimeout(() => searchPublicUsers(req.query.q || ''));
    res.json({ ok: true, results });
  } catch (err) { messengerErr(res, err); }
});

// GET /api/messenger/user-by-email?email=...
router.get('/api/messenger/user-by-email', requireAuth, async (req, res) => {
  try {
    const u = await withTimeout(() => findUserByEmail(req.query.email || ''));
    if (!u) return res.status(404).json({ error: 'User not found' });
    res.json({ ok: true, user: u });
  } catch (err) { messengerErr(res, err); }
});

// POST /api/messenger/user-info  body: { ids: [userId, ...] }
router.post('/api/messenger/user-info', requireAuth, async (req, res) => {
  try {
    const ids = (req.body?.ids || []).slice(0, 50);
    const info = await withTimeout(() => getUserInfoBulk(ids));
    res.json({ ok: true, users: info });
  } catch (err) { messengerErr(res, err); }
});

// POST /api/messenger/send  — store a pending DM + real-time emit
router.post('/api/messenger/media', requireAuth, (req, res) => {
  messengerMediaUpload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    if (!req.file) return res.status(400).json({ error: 'file required' });
    const name = safeFilename(req.file.originalname);
    const blocked = assertAllowedMedia(req.file.mimetype, name, req.file.size);
    if (blocked) return res.status(400).json({ error: blocked });
    const type = classifyMedia(req.file.mimetype, name);
    try {
      const url = await uploadToCatbox(req.file.buffer, name, req.file.mimetype);
      res.json({ ok: true, media: { url, name, type, mime: req.file.mimetype, size: req.file.size } });
    } catch (e) {
      console.warn('[messenger] catbox upload failed:', e.message);
      res.status(502).json({ error: 'Catbox could not store this file. Try a smaller image, video, or PDF.' });
    }
  });
});

router.post('/api/messenger/preview', requireAuth, (req, res) => {
  const { url, name, type, mime, size } = req.body || {};
  if (!url || !String(url).startsWith('https://files.catbox.moe/')) {
    return res.status(400).json({ error: 'catbox url required' });
  }
  const made = getOrCreateMediaPreview({ catboxUrl: url, name, type, mime, size });
  if (!made) return res.status(400).json({ error: 'Could not create preview' });
  const previewUrl = `${req.protocol}://${req.get('host')}/api/messenger/file/${made.token}`;
  res.json({
    ok: true,
    previewUrl,
    token: made.token,
    expiresInHours: 12,
    reused: !!made.reused,
  });
});

router.get('/api/messenger/file/:token', async (req, res) => {
  const p = touchMediaPreview(req.params.token);
  if (!p) return res.status(410).json({ error: 'Preview expired' });
  const filename = safeFilename(p.name || 'file');
  const asDownload = String(req.query.dl || '') === '1';
  if (!asDownload) {
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    return res.redirect(302, p.catboxUrl);
  }
  try {
    const r = await fetch(p.catboxUrl);
    if (!r.ok) return res.status(502).json({ error: 'Could not fetch file' });
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type', p.mime || r.headers.get('content-type') || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(buf.length));
    res.send(buf);
  } catch (e) {
    res.status(502).json({ error: 'Download failed' });
  }
});

router.post('/api/messenger/unsend', requireAuth, async (req, res) => {
  try {
    const { id, to, channel } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    const privileged = !!(req.user.isAdmin || isSupportEmail(req.user.email));
    if (channel) {
      const ok = deleteCommunityMessage(id, req.user.id, privileged);
      if (!ok) return res.status(403).json({ error: 'Not allowed or not found' });
      try {
        const { emitChannelUnsend } = await import('../bot.js').catch(() => ({}));
        if (emitChannelUnsend) emitChannelUnsend({ id, by: req.user.id });
      } catch (_) {}
      return res.json({ ok: true });
    }
    const result = await withTimeout(() => unsendPendingMessage(id, req.user.id, privileged));
    if (!result.ok) return res.status(403).json({ error: 'You can only delete your own messages' });
    try {
      const { emitMessengerUnsend } = await import('../bot.js').catch(() => ({}));
      if (emitMessengerUnsend) {
        emitMessengerUnsend({ id, from: req.user.id, to, by: req.user.id });
      }
    } catch (_) {}
    res.json({ ok: true });
  } catch (err) { messengerErr(res, err); }
});

router.post('/api/messenger/send', requireAuth, async (req, res) => {
  try {
    const { to, text, clientId, replyText, replyName, replyId, media } = req.body || {};
    const trimmed = String(text || '').trim();
    const hasMedia = !!(media && media.url);
    if (!to || (!trimmed && !hasMedia)) return res.status(400).json({ error: 'to and text required' });
    if (hasMedia && !String(media.url).startsWith('https://files.catbox.moe/')) {
      return res.status(400).json({ error: 'invalid media url' });
    }
    const result = await withTimeout(() => {
      if (isBlocked(to, req.user.id)) return { blocked: true };
      const msg = storePendingMessage({
        from: req.user.id, to, text: trimmed, clientId,
        replyText, replyName, replyId,
        media: hasMedia ? media : null,
      });
      return { blocked: false, msg };
    });
    if (result.blocked) return res.status(403).json({ error: 'blocked' });

    try {
      const { emitMessengerMessage } = await import('../bot.js').catch(() => ({}));
      if (emitMessengerMessage) {
        emitMessengerMessage(to, {
          id: result.msg?.id,
          from: req.user.id,
          text: trimmed,
          sentAt: result.msg?.sentAt || new Date().toISOString(),
          clientId,
          replyText: result.msg?.replyText || '',
          replyName: result.msg?.replyName || '',
          replyId: result.msg?.replyId || null,
          media: result.msg?.media || null,
        });
      }
    } catch (_) {}

    res.json({ ok: true, message: result.msg });
  } catch (err) { messengerErr(res, err); }
});

// GET /api/messenger/drain — fetch and delete pending messages for me
router.get('/api/messenger/drain', requireAuth, async (req, res) => {
  try {
    const msgs = await withTimeout(() => drainPendingMessages(req.user.id));
    try {
      const { emitMessengerAck } = await import('../bot.js').catch(() => ({}));
      if (emitMessengerAck && msgs.length) {
        const seen = new Set();
        msgs.forEach(m => {
          if (seen.has(m.from)) return;
          seen.add(m.from);
          emitMessengerAck(m.from, { type: 'delivered', senderId: m.from, readerId: req.user.id, at: new Date().toISOString() });
        });
      }
    } catch (_) {}
    res.json({ ok: true, messages: msgs });
  } catch (err) { messengerErr(res, err); }
});

// POST /api/messenger/mark-read/:fromId — mark messages from user as read
router.post('/api/messenger/mark-read/:fromId', requireAuth, async (req, res) => {
  try {
    await withTimeout(() => markMessagesRead(req.params.fromId, req.user.id));
    try {
      const { emitMessengerAck } = await import('../bot.js').catch(() => ({}));
      if (emitMessengerAck) {
        emitMessengerAck(req.params.fromId, {
          type: 'read', senderId: req.params.fromId, readerId: req.user.id, at: new Date().toISOString(),
        });
      }
    } catch (_) {}
    res.json({ ok: true });
  } catch (err) { messengerErr(res, err); }
});

// GET /api/messenger/acks — delivery/read receipts for my outbound DMs
router.get('/api/messenger/acks', requireAuth, async (req, res) => {
  try {
    const acks = await withTimeout(() => drainMessengerAcks(req.user.id));
    res.json({ ok: true, acks });
  } catch (err) { messengerErr(res, err); }
});

// GET /api/messenger/presence?ids=a,b,c
router.get('/api/messenger/presence', requireAuth, async (req, res) => {
  try {
    const ids = String(req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 80);
    let online = [];
    try {
      const bot = await import('../bot.js').catch(() => ({}));
      if (bot.getOnlineUserIds) online = bot.getOnlineUserIds();
    } catch (_) {}
    const lastSeen = getLastSeenBulk(ids.length ? ids : online);
    const onlineSet = new Set(online);
    const filteredOnline = ids.length ? ids.filter(id => onlineSet.has(id)) : online;
    res.json({ ok: true, online: filteredOnline, lastSeen });
  } catch (err) { messengerErr(res, err); }
});

// GET /api/messenger/pending-count — badge count
router.get('/api/messenger/pending-count', requireAuth, async (req, res) => {
  try {
    const result = await withTimeout(() => {
      const total = countPendingMessages(req.user.id);
      const bySender = countPendingBySender(req.user.id);
      return { ok: true, total, bySender };
    });
    res.json(result);
  } catch (err) { messengerErr(res, err); }
});

// GET /api/messenger/me — my full user info (name, email, id)
router.get('/api/messenger/me', requireAuth, async (req, res) => {
  try {
    const result = await withTimeout(() => {
      const u = req.user;
      const s = getMessengerSettings(u.id);
      const card = publicMessengerCard(u);
      return {
        ok: true,
        id: u.id,
        email: u.email,
        name: u.name || '',
        surname: u.surname || '',
        displayName: card.displayName,
        verified: card.verified,
        isSupport: card.isSupport,
        profilePicUrl: card.profilePicUrl,
        settings: s,
        support: getSupportCard(),
      };
    });
    res.json(result);
  } catch (err) { messengerErr(res, err); }
});

// ═══════════════════════════════════════════════════════════════════
//  SUPPORT (save messages to store)
// ═══════════════════════════════════════════════════════════════════
router.post('/api/support', (req, res) => {
  let { name, email, subject, message, category } = req.body || {};
  if (!message) return res.status(400).json({ error: 'Message is required' });

  // Get userId + user info if logged in
  let userId = null;
  const token = req.headers['x-session-token'];
  if (token) {
    const u = getSessionUser(token);
    if (u) {
      userId = u.id;
      if (!name)  name  = u.name  || u.email || 'User';
      if (!email) email = u.email || '';
    }
  }

  if (!name) return res.status(400).json({ error: 'Name is required' });

  const msg = addSupportMessage({ userId, name, email, subject: subject || category || 'General', message });
  res.json({ ok: true, id: msg.id });
});

// ═══════════════════════════════════════════════════════════════════
//  WISHLIST
// ═══════════════════════════════════════════════════════════════════
router.post('/api/wishlist', requireAuth, (req, res) => {
  const count = addWishlistVote(req.user.id);
  res.json({ ok: true, count });
});
router.get('/api/wishlist', (req, res) => res.json({ count: getWishlistCount() }));

// ═══════════════════════════════════════════════════════════════════
//  BAN / APPEAL
// ═══════════════════════════════════════════════════════════════════
router.get('/api/ban-status', requireAuthAllowBanned, (req, res) => {
  const ban = getBan(req.user.id);
  if (!ban) return res.json({ banned: false });
  res.json({ banned: true, ...ban });
});

router.post('/api/appeal', requireAuthAllowBanned, (req, res) => {
  const ban = getBan(req.user.id);
  if (!ban) return res.status(400).json({ error: 'Account is not banned' });
  if (ban.appealStatus === 'pending') return res.status(400).json({ error: 'Appeal already pending' });
  if (ban.appealStatus === 'rejected') return res.status(400).json({ error: 'Appeal was rejected — contact support' });
  const { message } = req.body || {};
  if (!message || message.length < 20) return res.status(400).json({ error: 'Appeal message too short (min 20 chars)' });
  submitAppeal(req.user.id, message);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════
//  PROFILE
// ═══════════════════════════════════════════════════════════════════
router.post('/api/profile/update', requireAuth, (req, res) => {
  const { name, surname, age, school } = req.body || {};
  if (!name || !surname || !age || !school) return res.status(400).json({ error: 'All fields required' });
  if (isNaN(age) || age < 5 || age > 80) return res.status(400).json({ error: 'Invalid age' });
  const updated = saveWebUser(req.user.id, { name: name.trim(), surname: surname.trim(), age: parseInt(age), school: school.trim() });
  res.json({ ok: true, user: sanitizeUser(updated) });
});

router.post('/api/profile/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
  const user = getWebUser(req.user.id);
  if (user.passwordHash !== hashPassword(currentPassword)) return res.status(401).json({ error: 'Current password is incorrect' });
  saveWebUser(req.user.id, { passwordHash: hashPassword(newPassword) });
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════
//  AI ONBOARDING VALIDATION
// ═══════════════════════════════════════════════════════════════════
router.post('/api/onboarding/validate', requireAuth, async (req, res) => {
  const { name, surname, school } = req.body || {};
  if (!name || !surname || !school) return res.status(400).json({ error: 'name, surname, school required' });
  try {
    const { gpt4oChat } = await import('../utils/gpt-service.js');
    const prompt = `You are a student registration validator for Fundo Plus, a Zimbabwean education platform.
Validate these fields:
- First Name: "${name}"
- Surname: "${surname}"
- School: "${school}" (user typed their own school name)

Rules:
1. Names must look like real human names (not gibberish, not numbers, not offensive)
2. School must look like a real school/institution name
3. Be lenient — students might go to small private schools

Respond ONLY with valid JSON:
{"valid": true/false, "nameError": "..or null", "surnameError": "..or null", "schoolError": "..or null", "message": "brief overall message"}`;

    const result = await gpt4oChat({
      systemInstruction: 'You are a form validator. Always respond with valid JSON only.',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 300, temperature: 0.1,
    });
    if (!result.success) return res.json({ valid: true });
    let parsed;
    try { const clean = result.answer.replace(/```json|```/g, '').trim(); parsed = JSON.parse(clean); }
    catch { return res.json({ valid: true }); }
    res.json(parsed);
  } catch { res.json({ valid: true }); }
});

// ── Sitemap ───────────────────────────────────────────────────────
router.get('/sitemap.xml', (req, res) => {
  const base  = (process.env.WEBSITE_URL || `https://${req.headers.host}`).replace(/\/+$/, '');
  const today = new Date().toISOString().slice(0, 10);
  const raw   = fs.readFileSync(path.join(__dirname, 'sitemap.xml'), 'utf8');
  const xml   = raw.replace(/WEBSITE_URL_PLACEHOLDER/g, base).replace(/LASTMOD_PLACEHOLDER/g, today);
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.send(xml);
});

// ═══════════════════════════════════════════════════════════════════
//  ADMIN API
// ═══════════════════════════════════════════════════════════════════
const ADMIN_PASS = 'smarttech@#2';

function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-token'] || req.headers['x-admin-key'] || req.body?.adminKey || req.query?.adminKey;
  if (key && key === ADMIN_PASS) return next();

  const sessionToken = req.headers['x-session-token'] || key;
  if (sessionToken) {
    const user = getSessionUser(sessionToken);
    if (user?.isAdmin) return next();
  }

  return res.status(403).json({ error: 'Forbidden' });
}

router.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (password === ADMIN_PASS) return res.json({ ok: true, token: password });
  res.status(401).json({ error: 'Invalid password' });
});

router.get('/api/admin/users', requireAdmin, (req, res) => {
  const raw = getAllWebUsers();
  const users = Array.isArray(raw) ? raw : Object.values(raw || {});
  res.json({ users });
});
router.get('/api/admin/bans', requireAdmin, (req, res) => {
  const bans  = getAllBans();
  const users = getAllWebUsers();
  const result = Object.values(bans).map(b => {
    const u = users[b.userId] || {};
    return {
      ...b,
      name:  ((u.name || '') + (u.surname ? ' ' + u.surname : '')).trim() || '—',
      email: u.email || '—',
    };
  });
  res.json({ bans: result });
});
router.get('/api/admin/subs',     requireAdmin, (req, res) => res.json({ subscriptions: getAllSubscriptions() }));
router.get('/api/admin/proofs',   requireAdmin, (req, res) => res.json({ proofs: getAllProofs() }));
router.get('/api/admin/support',  requireAdmin, (req, res) => res.json({ messages: getAllSupportMessages() }));

// Serve payment proof image
router.get('/api/admin/proof-image/:filename', requireAdmin, (req, res) => {
  const fp = getProofFilePath(req.params.filename);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(fp);
});

// Review proof (approve/reject)
router.post('/api/admin/proof/:id/review', requireAdmin, async (req, res) => {
  const { status } = req.body || {};
  if (!['approved','rejected'].includes(status)) return res.status(400).json({ error: 'status must be approved or rejected' });
  const ok = await reviewProof(req.params.id, status, 'admin');
  if (!ok) return res.status(404).json({ error: 'Proof not found' });
  res.json({ ok: true });
});

// Manually grant subscription
router.post('/api/admin/grant-sub', requireAdmin, (req, res) => {
  const { userId, plan } = req.body || {};
  if (!userId || !plan) return res.status(400).json({ error: 'userId and plan required' });
  const ok = setUserSubscription(userId, plan, 'admin');
  if (!ok) return res.status(400).json({ error: 'Invalid plan' });
  res.json({ ok: true });
});

// ── Admin: withdrawals ─────────────────────────────────────────────────────
router.get('/api/admin/withdrawals', requireAdmin, (req, res) => {
  res.json({ ok: true, withdrawals: getAllWithdrawals() });
});

// Mark a withdrawal as paid out (net amount sent to the user's mobile number)
router.post('/api/admin/withdrawal/:id/complete', requireAdmin, async (req, res) => {
  const w = getWithdrawal(req.params.id);
  if (!w) return res.status(404).json({ error: 'Withdrawal not found' });
  if (w.status !== 'pending') return res.status(400).json({ error: `Already ${w.status}` });
  updateWithdrawalStatus(req.params.id, 'paid', 'admin');
  await flushMoneyBackup();
  res.json({ ok: true, withdrawal: getWithdrawal(req.params.id) });
});

// Mark a withdrawal as failed — refunds the wallet (money must not vanish)
router.post('/api/admin/withdrawal/:id/fail', requireAdmin, async (req, res) => {
  const w = getWithdrawal(req.params.id);
  if (!w) return res.status(404).json({ error: 'Withdrawal not found' });
  if (w.status !== 'pending') return res.status(400).json({ error: `Already ${w.status}` });
  updateWithdrawalStatus(req.params.id, 'failed', 'admin');
  await flushMoneyBackup();
  res.json({ ok: true, withdrawal: getWithdrawal(req.params.id) });
});

// Resolve support message
router.post('/api/admin/support/:id/resolve', requireAdmin, (req, res) => {
  const ok = resolveSupportMessage(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// Legacy admin routes
router.post('/api/admin/ban',   requireAdmin, (req, res) => {
  const { userId, reason } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId required' });
  banUser(userId, reason);
  res.json({ ok: true });
});

router.post('/api/admin/unban', requireAdmin, (req, res) => {
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId required' });
  unbanUser(userId);
  res.json({ ok: true });
});

router.post('/api/admin/verify', requireAdmin, (req, res) => {
  const { userId, verified } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const ok = setVerified(userId, verified !== false);
  if (!ok) return res.status(404).json({ error: 'User not found' });
  import('../utils/supabase-data.js').then(m => m.uploadDataFile('messenger.json')).catch(() => {});
  res.json({ ok: true, verified: isVerified(userId) });
});

router.post('/api/admin/appeal/:userId/:decision', requireAdmin, (req, res) => {
  resolveAppeal(req.params.userId, req.params.decision);
  res.json({ ok: true });
});

// ── Missing admin routes ──────────────────────────────────────────

// User search (used by admin dashboard instead of /api/admin/users)
router.get('/api/admin/users/search', requireAdmin, (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  const raw = getAllWebUsers();
  let users = Array.isArray(raw) ? raw : Object.values(raw || {});
  if (q) {
    users = users.filter(u =>
      (u.email || '').toLowerCase().includes(q) ||
      (u.phone || '').toLowerCase().includes(q) ||
      (u.name  || '').toLowerCase().includes(q) ||
      String(u.id || '').includes(q)
    );
  }
  // Enrich each user with plan, wallet balance and subscription status so the
  // admin "Users" page can render full cards without extra round-trips.
  const enriched = users.map(u => {
    const base = sanitizeUser(u);
    const plan = getUserPlan(u.id);
    const sub  = getUserSubscription(u.id);
    const balance = getUserBalance(u.id);
    return {
      ...base,
      plan,
      balance,
      balanceDollars: (balance / 100).toFixed(2),
      subscription: sub ? {
        plan: sub.plan,
        status: sub.status,
        expiresAt: sub.expiresAt,
        grantedBy: sub.grantedBy,
      } : null,
      banned: isBanned(u.id),
      verified: isVerified(u.id),
      isSupport: isSupportEmail(u.email),
    };
  });
  res.json({ users: enriched });
});

// ── Admin: upload a notification/announcement image → returns a public URL ──
router.post('/api/admin/notifications/upload-image', requireAdmin, proofUpload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  const extRaw = (req.file.mimetype.split('/')[1] || 'jpg').toLowerCase().replace('jpeg', 'jpg');
  const filename = `notif_${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extRaw}`;
  try {
    const { uploadResource } = await import('../utils/supabase-resources.js');
    const url = await uploadResource(filename, req.file.buffer, req.file.mimetype);
    return res.json({ ok: true, url });
  } catch (e) {
    console.warn('[Notifications] Supabase upload failed, using data URI:', e.message);
    // Fallback: embed as data URI so image uploads work even without Supabase
    const dataUri = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    return res.json({ ok: true, url: dataUri, fallback: true });
  }
});

// Server stats
router.get('/api/admin/server', requireAdmin, async (req, res) => {
  const mem = process.memoryUsage();
  const os = (await import('os').catch(() => ({ default: null }))).default;
  const uptimeSec = process.uptime();
  const h = Math.floor(uptimeSec / 3600);
  const m = Math.floor((uptimeSec % 3600) / 60);
  res.json({
    uptime:      `${h}h ${m}m`,
    platform:    process.platform,
    arch:        process.arch,
    nodeVersion: process.version,
    cpus:        os ? os.cpus().length : '—',
    heapUsed:    `${Math.round(mem.heapUsed / 1024 / 1024)} MB`,
    totalMem:    os ? `${Math.round(os.totalmem() / 1024 / 1024)} MB` : '—',
    freeMem:     os ? `${Math.round(os.freemem()    / 1024 / 1024)} MB` : '—',
  });
});

// ── Admin: recent logins (in-memory only) ─────────────────────────────────
router.get('/api/admin/logins', requireAdmin, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 300);
  res.json({ ok: true, count: getLoginCount(), logins: getRecentLogins(limit) });
});

// ── Admin: VAPID (web-push keys) management ────────────────────────────────
router.get('/api/admin/vapid', requireAdmin, (req, res) => {
  res.json({
    ok: true,
    publicKey: vapidKeys.publicKey,
    source: vapidKeys.source,
    subscriberCount: getAllPushSubscriptions().length,
    mailto: 'support@fundoplus.co.zw',
  });
});

router.post('/api/admin/vapid/generate', requireAdmin, (req, res) => {
  // Generate a fresh VAPID keypair and persist it to data/vapid.json.
  // ⚠️ Rotating keys INVALIDATES all existing push subscriptions — browsers
  // must re-subscribe (toggle notifications off → on) to receive pushes again.
  const keys = webpush.generateVAPIDKeys();
  vapidKeys = { publicKey: keys.publicKey, privateKey: keys.privateKey, source: 'custom' };
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(VAPID_FILE, JSON.stringify(vapidKeys, null, 2));
  } catch (e) {
    return res.status(500).json({ error: 'Failed to persist keys: ' + e.message });
  }
  applyVapid();
  res.json({ ok: true, publicKey: vapidKeys.publicKey, source: 'custom', note: 'Keys rotated. Existing subscriptions are now invalid — users must re-enable notifications.' });
});

// List data files in DATA_DIR
router.get('/api/admin/files', requireAdmin, (req, res) => {
  try {
    const files = fs.readdirSync(DATA_DIR)
      .filter(f => !fs.statSync(path.join(DATA_DIR, f)).isDirectory())
      .map(f => {
        const stat = fs.statSync(path.join(DATA_DIR, f));
        return { name: f, size: stat.size, modified: stat.mtime };
      });
    res.json({ files });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Download a data file
router.get('/api/admin/files/:name', requireAdmin, (req, res) => {
  const safe = path.basename(req.params.name);
  const fp   = path.join(DATA_DIR, safe);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
  res.download(fp);
});

// Chat message counts per JID
router.get('/api/admin/messages', requireAdmin, (req, res) => {
  const rows = getAllMessageCounts();
  // Always return a map { [jid]: { count } } so the admin table can render.
  const messages = {};
  if (Array.isArray(rows)) {
    for (const r of rows) {
      if (!r) continue;
      if (r.jid) messages[r.jid] = { count: r.count || 0, ts: r.ts || null };
    }
  } else if (rows && typeof rows === 'object') {
    Object.assign(messages, rows);
  }
  res.json({ messages });
});

// Wishlist count
router.get('/api/admin/wishlist', requireAdmin, (req, res) => {
  res.json({ count: getWishlistCount() });
});

// Pending ban appeals
router.get('/api/admin/appeals', requireAdmin, (req, res) => {
  const bans    = getAllBans();
  const users   = getAllWebUsers();
  const appeals = Object.values(bans)
    .filter(b => b.appealStatus === 'pending')
    .map(b => {
      const u = users[b.userId] || {};
      return {
        ...b,
        name:  (u.name || '') + (u.surname ? ' ' + u.surname : '') || '—',
        email: u.email || '—',
      };
    });
  res.json({ appeals });
});

// Papers list (admin)
router.get('/api/admin/papers', requireAdmin, (req, res) => {
  res.json({ papers: listPapersLocal() });
});

// Delete a paper (admin)
router.delete('/api/admin/papers/:id', requireAdmin, (req, res) => {
  const ok = removePaper(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// ── Admin: Upload update.json ──────────────────────────────────────────────
router.post('/api/admin/update/upload-json', requireAdmin,
  updateJsonUpload.single('updateJson'),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    try {
      const result = await uploadUpdateJson(req.file.buffer);
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

// ── Admin: Upload APK ───────────────────────────────────────────────────────
router.post('/api/admin/update/upload-apk', requireAdmin,
  apkUpload.single('apkFile'),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    try {
      const publicUrl = await uploadApk(req.file.buffer, req.file.originalname);
      res.json({ ok: true, apkUrl: publicUrl });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

// ── Admin: Get current update info ─────────────────────────────────────────
router.get('/api/admin/update/info', requireAdmin, async (req, res) => {
  try {
    const info = await fetchUpdateJson();
    const apkUrl = getApkPublicUrl();
    res.json({ ok: true, update: info, apkUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Public: App fetches update info (no auth required) ─────────────────────
// The DroidScript app hits this on startup and compares its local version.json
router.get('/api/app/update', async (req, res) => {
  try {
    const info = await fetchUpdateJson();
    if (!info) return res.json({ ok: true, update: null });
    res.json({ ok: true, update: info });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Sync — push all data files to Supabase
router.post('/api/admin/sync', requireAdmin, async (req, res) => {
  try {
    const { syncToSupabase } = await import('../utils/supabase-data.js');
    await syncToSupabase();
    res.json({ ok: true, message: 'Sync complete.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
//  PROMO LINKS (Admin)
// ═══════════════════════════════════════════════════════════════════

// List all promo links
router.get('/api/admin/promo-links', requireAdmin, (req, res) => {
  res.json({ ok: true, links: getAllPromoLinks() });
});

// Create a promo link
router.post('/api/admin/promo-links', requireAdmin, (req, res) => {
  const { plan, maxUses = 1, expiresAt = null, note = '' } = req.body || {};
  if (!plan) return res.status(400).json({ error: 'plan required' });
  try {
    const link = createPromoLink({ plan, maxUses, expiresAt, note });
    // Async sync to Supabase — don't await
    import('../utils/supabase-data.js').then(m => m.uploadDataFile('promo_links.json')).catch(() => {});
    res.json({ ok: true, link });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Deactivate a promo link
router.post('/api/admin/promo-links/:code/deactivate', requireAdmin, (req, res) => {
  const ok = deactivatePromoLink(req.params.code);
  if (!ok) return res.status(404).json({ error: 'Link not found' });
  import('../utils/supabase-data.js').then(m => m.uploadDataFile('promo_links.json')).catch(() => {});
  res.json({ ok: true });
});

// Delete a promo link
router.delete('/api/admin/promo-links/:code', requireAdmin, (req, res) => {
  const ok = deletePromoLink(req.params.code);
  if (!ok) return res.status(404).json({ error: 'Link not found' });
  import('../utils/supabase-data.js').then(m => m.uploadDataFile('promo_links.json')).catch(() => {});
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════
//  PROMO REDEEM (Public — called after login/signup)
// ═══════════════════════════════════════════════════════════════════

// Check if a promo code is valid (public, no auth needed)
router.get('/api/promo/:code/check', (req, res) => {
  const link = getPromoLink(req.params.code);
  if (!link || !link.active) return res.status(404).json({ valid: false, error: 'Invalid or expired link.' });
  if (link.expiresAt && new Date(link.expiresAt) < new Date())
    return res.status(410).json({ valid: false, error: 'This link has expired.' });
  if (link.maxUses > 0 && link.uses >= link.maxUses)
    return res.status(410).json({ valid: false, error: 'This link has reached its usage limit.' });
  res.json({ valid: true, plan: link.plan, note: link.note });
});

// Redeem a promo code (requires auth)
router.post('/api/promo/:code/redeem', requireAuth, (req, res) => {
  const result = redeemPromoLink(req.params.code, req.user.id);
  if (!result.ok) return res.status(400).json({ error: result.error });
  import('../utils/supabase-data.js').then(m => {
    m.uploadDataFile('promo_links.json');
    m.uploadDataFile('subscriptions.json');
  }).catch(() => {});
  res.json({ ok: true, plan: result.plan });
});

// ── Helper ────────────────────────────────────────────────────────
function sanitizeUser(user) {
  if (!user) return null;
  const { passwordHash, pendingToken, pendingOtp, otpCreatedAt, ...safe } = user;
  return safe;
}

// ═══════════════════════════════════════════════════════════════════
//  DATA FILE MANAGEMENT (Admin)
// ═══════════════════════════════════════════════════════════════════

// List all managed files: local presence + size + Supabase presence
router.get('/api/admin/data/status', requireAdmin, async (req, res) => {
  try {
    const sbMod = await import('../utils/supabase-data.js');
    const MANAGED_FILES = sbMod.MANAGED_FILES;

    // Get Supabase bucket listing
    let bucketFiles = [];
    try {
      const { createClient } = await import('@supabase/supabase-js');
      const URL_ = process.env.SUPABASE_DATA_URL || process.env.SUPABASE_URL;
      const KEY_ = process.env.SUPABASE_DATA_SERVICE_KEY || process.env.SUPABASE_DATA_ANON_KEY ||
                   process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY ||
                   process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
      const BUCKET = process.env.SUPABASE_DATA_BUCKET || 'prok-ai-data';
      if (URL_ && KEY_) {
        const sbc = createClient(URL_, KEY_, { auth: { persistSession: false } });
        const { data } = await sbc.storage.from(BUCKET).list('', { limit: 500 });
        bucketFiles = (data || []).filter(f => f.name.endsWith('.json')).map(f => ({
          name: f.name, size: f.metadata?.size || 0, updatedAt: f.updated_at || f.created_at,
        }));
      }
    } catch (_e) { /* supabase not configured */ }

    const bucketMap = Object.fromEntries(bucketFiles.map(f => [f.name, f]));

    const result = MANAGED_FILES.map(name => {
      const localPath = path.join(DATA_DIR, name);
      const localExists = fs.existsSync(localPath);
      let localSize = 0, localModified = null;
      if (localExists) { const st = fs.statSync(localPath); localSize = st.size; localModified = st.mtime.toISOString(); }
      const inBucket = !!bucketMap[name];
      return { name, localExists, localSize, localModified, inBucket, bucketSize: inBucket ? bucketMap[name].size : 0, bucketUpdated: inBucket ? bucketMap[name].updatedAt : null };
    });

    const extras = bucketFiles
      .filter(f => !MANAGED_FILES.includes(f.name))
      .map(f => {
        const localPath = path.join(DATA_DIR, f.name);
        const localExists = fs.existsSync(localPath);
        return { name: f.name, localExists, localSize: localExists ? fs.statSync(localPath).size : 0, localModified: localExists ? fs.statSync(localPath).mtime.toISOString() : null, inBucket: true, bucketSize: f.size, bucketUpdated: f.updatedAt, extra: true };
      });

    res.json({ ok: true, files: [...result, ...extras], supabaseConnected: bucketFiles.length >= 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Pull specific files from Supabase -> data dir
router.post('/api/admin/data/pull', requireAdmin, async (req, res) => {
  try {
    const { files } = req.body || {};
    if (!Array.isArray(files) || !files.length) return res.status(400).json({ error: 'files array required' });
    const { downloadDataFile } = await import('../utils/supabase-data.js');
    const results = [];
    for (const name of files) {
      if (!name.endsWith('.json') || name.includes('..') || name.includes('/')) { results.push({ name, ok: false, error: 'Invalid filename' }); continue; }
      const ok = await downloadDataFile(name);
      results.push({ name, ok });
    }
    res.json({ ok: true, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Push specific files from data dir -> Supabase
router.post('/api/admin/data/push', requireAdmin, async (req, res) => {
  try {
    const { files } = req.body || {};
    if (!Array.isArray(files) || !files.length) return res.status(400).json({ error: 'files array required' });
    const { uploadDataFile } = await import('../utils/supabase-data.js');
    const results = [];
    for (const name of files) {
      if (!name.endsWith('.json') || name.includes('..') || name.includes('/')) { results.push({ name, ok: false, error: 'Invalid filename' }); continue; }
      const fp = path.join(DATA_DIR, name);
      if (!fs.existsSync(fp)) { results.push({ name, ok: false, error: 'Not on server' }); continue; }
      try { await uploadDataFile(name); results.push({ name, ok: true }); }
      catch (e2) { results.push({ name, ok: false, error: e2.message }); }
    }
    res.json({ ok: true, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Pull ALL managed files from Supabase
router.post('/api/admin/data/pull-all', requireAdmin, async (req, res) => {
  try {
    const { syncFromSupabase } = await import('../utils/supabase-data.js');
    await syncFromSupabase();
    res.json({ ok: true, message: 'All files pulled from Supabase.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Upload JSON files from admin device -> server data dir (optionally push to Supabase)
router.post('/api/admin/data/upload', requireAdmin, dataUpload.array('files', 20), async (req, res) => {
  try {
    if (!req.files || !req.files.length) return res.status(400).json({ error: 'No files uploaded' });
    const pushToSupabase = req.body?.push === 'true';
    const { uploadDataFile } = await import('../utils/supabase-data.js');
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const results = [];
    for (const file of req.files) {
      const name = path.basename(file.originalname);
      if (!name.endsWith('.json') || name.includes('..')) { results.push({ name, ok: false, error: 'Invalid file type' }); continue; }
      let parsed;
      try { parsed = JSON.parse(file.buffer.toString('utf8')); }
      catch { results.push({ name, ok: false, error: 'Invalid JSON' }); continue; }
      fs.writeFileSync(path.join(DATA_DIR, name), JSON.stringify(parsed, null, 2), 'utf8');
      let pushed = false;
      if (pushToSupabase) { try { await uploadDataFile(name); pushed = true; } catch {} }
      results.push({ name, ok: true, pushed });
    }
    res.json({ ok: true, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Download a data file from server to admin browser
router.get('/api/admin/data/download/:name', requireAdmin, (req, res) => {
  const name = path.basename(req.params.name);
  if (!name.endsWith('.json') || name.includes('..')) return res.status(400).json({ error: 'Invalid' });
  const fp = path.join(DATA_DIR, name);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.setHeader('Content-Type', 'application/json');
  res.sendFile(fp);
});

// Delete a data file from server data dir
router.delete('/api/admin/data/:name', requireAdmin, (req, res) => {
  const name = path.basename(req.params.name);
  if (!name.endsWith('.json') || name.includes('..')) return res.status(400).json({ error: 'Invalid' });
  const fp = path.join(DATA_DIR, name);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
  fs.unlinkSync(fp);
  res.json({ ok: true });
});

// ── /api/config — expose public env vars to frontend ─────────────────────────
router.get('/api/config', (req, res) => {
  res.json({
    supabaseUrl:     process.env.SUPABASE_URL     || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
  });
});

// ── Admin: upload + parse a .txt exam file, bulk-create exam + questions ──────
router.post('/api/admin/zimsec/upload-txt', requireAdmin, (req, res) => {
  try {
    const { title, subject, level, year, description, scheduledAt, durationMins, txtContent } = req.body || {};
    if (!title || !txtContent) return res.status(400).json({ error: 'title and txtContent are required' });

    const parsed = parseZimsecTxt(txtContent);
    if (!parsed.length) return res.status(400).json({ error: 'No questions found in file. Check the format.' });

    // Create the exam
    const exam = createZimsecExam({ title, subject, level, year, description, scheduledAt, durationMins, createdBy: 'admin' });

    // Bulk-create questions
    const questions = parsed.map((q, i) => createZimsecQuestion({
      examId:   exam.id,
      text:     q.text,
      type:     q.type,
      options:  q.options,
      answer:   q.answer,
      marks:    1,
      order:    i,
    }));

    // Store the raw txt for reference
    const DATA_DIR_PATH = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'data');
    const safeTitle = title.replace(/[^a-z0-9]/gi, '_').slice(0, 40);
    const txtPath = path.join(DATA_DIR_PATH, `zimsec_${safeTitle}_${exam.id}.txt`);
    try { fs.writeFileSync(txtPath, txtContent, 'utf8'); } catch {}

    // Back up exam + questions to Supabase immediately (crash-safe)
    backupExamToSupabase(exam, questions).catch(e =>
      console.warn('[Routes] Exam backup failed (non-fatal):', e.message)
    );
    // Also sync the main zimsec JSON files
    syncToSupabase().catch(e =>
      console.warn('[Routes] zimsec syncToSupabase failed (non-fatal):', e.message)
    );

    res.json({ ok: true, exam, questionCount: questions.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: get short answer question and AI-mark it ──────────────────────────
router.post('/api/admin/zimsec/ai-mark', requireAdmin, async (req, res) => {
  try {
    const { question, modelAnswer, studentAnswer } = req.body || {};
    if (!question || !studentAnswer) return res.status(400).json({ error: 'question and studentAnswer required' });
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', max_tokens: 300,
        messages: [{ role: 'user', content: `Mark this ZIMSEC exam answer. Score 0.0–1.0.\nQuestion: ${question}\n${modelAnswer ? 'Model answer: ' + modelAnswer + '\n' : ''}Student answer: ${studentAnswer}\nRespond ONLY with JSON: {"score":0.0,"feedback":"1-2 sentence feedback"}` }]
      })
    });
    const ad = await aiRes.json();
    const text = ad.content?.[0]?.text || '{}';
    const parsed = JSON.parse(text.replace(/\`\`\`json|\`\`\`/g,'').trim());
    res.json({ ok: true, score: parsed.score, feedback: parsed.feedback });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════
//  ZIMSEC — Exams
// ═══════════════════════════════════════════════════════════════════

// List all exams (requires auth)
// POST /api/zimsec/exams/:id/unlock — subscriber unlocks a 3-day exam window
router.post('/api/zimsec/exams/:id/unlock', requireOnboarded, (req, res) => {
  const uid  = req.user.id;
  const plan = req.user.plan || getUserPlan(uid);
  if (plan === 'free') {
    return res.status(403).json({ error: 'Exam access requires a paid plan. Upgrade to unlock exams.' });
  }
  const exam = getZimsecExam(req.params.id);
  if (!exam || !exam.active) return res.status(404).json({ error: 'Exam not found' });

  // Already submitted — no point unlocking again
  const existing = getUserZimsecResults(uid).find(r => r.examId === exam.id);
  if (existing) return res.status(403).json({ error: 'You have already submitted this exam.' });

  const unlock  = unlockExamForUser(uid, exam.id);
  const expiresAt = getExamWindowExpiry(uid, exam.id);
  res.json({ ok: true, unlockedAt: unlock.unlockedAt, expiresAt });
});

router.get('/api/zimsec/exams', requireOnboarded, (req, res) => {
  const uid  = req.user.id;
  const plan = req.user.plan || getUserPlan(uid);
  const exams = getAllZimsecExams().filter(e => e.active).map(e => {
    const unlock    = getExamUnlock(uid, e.id);
    const windowOpen = unlock ? isExamWindowOpen(uid, e.id) : false;
    const expiresAt  = unlock ? getExamWindowExpiry(uid, e.id) : null;
    const submitted  = !!getUserZimsecResults(uid).find(r => r.examId === e.id);
    return {
      ...e,
      questionCount: getAllZimsecQuestions(e.id).length,
      // Unlock info for the UI
      requiresUnlock: !e.scheduledAt,
      unlocked:       windowOpen,
      unlockedAt:     unlock?.unlockedAt || null,
      expiresAt,
      submitted,
      canUnlock:      plan !== 'free' && !submitted && !windowOpen,
    };
  });
  res.json({ ok: true, exams });
});

// Get a single exam with its questions (requires auth)
router.get('/api/zimsec/exams/:id', requireOnboarded, (req, res) => {
  const exam = getZimsecExam(req.params.id);
  if (!exam || !exam.active) return res.status(404).json({ error: 'Exam not found' });

  // ── Access check: scheduled window OR subscriber unlock window ─────────────
  const uid  = req.user.id;
  const plan = req.user.plan || getUserPlan(uid);
  const now  = Date.now();

  if (exam.scheduledAt) {
    // Scheduled exam — 60-min entry window logic
    const startTs  = new Date(exam.scheduledAt).getTime();
    const entryEnd = startTs + 60 * 60_000;
    const examEnd  = startTs + (exam.durationMins || 60) * 60_000;

    const hasUnlock = plan !== 'free' && isExamWindowOpen(uid, exam.id);

    if (!hasUnlock) {
      if (now < startTs)    return res.status(403).json({ error: 'Exam has not started yet.', startsAt: exam.scheduledAt });
      if (now > entryEnd)   return res.status(403).json({ error: 'The 1-hour entry window has closed. You can no longer join this exam.' });
      if (now > examEnd)    return res.status(403).json({ error: 'Exam window has closed.' });
    }
  } else {
    // No schedule — subscriber self-serve: must have an active 3-day unlock
    if (plan === 'free') {
      return res.status(403).json({ error: 'Exam access requires a paid plan.', code: 'UPGRADE_REQUIRED' });
    }
    if (!isExamWindowOpen(uid, exam.id)) {
      const unlock = getExamUnlock(uid, exam.id);
      if (unlock) return res.status(403).json({ error: 'Your 3-day exam window has expired.', code: 'WINDOW_EXPIRED' });
      return res.status(403).json({ error: 'You need to unlock this exam first.', code: 'NOT_UNLOCKED' });
    }
  }

  // ── Exit-ban enforcement ─────────────────────────────────────────────────
  const exitedExams = JSON.parse(req.user.exitedExams || '[]');
  if (exitedExams.includes(exam.id)) {
    return res.status(403).json({ error: 'You exited this exam during a previous attempt. Access has been permanently revoked.' });
  }

  // ── One-attempt enforcement: block if already submitted ─────────────────
  const existing = getUserZimsecResults(req.user.id).find(r => r.examId === exam.id);
  if (existing) {
    return res.status(403).json({ error: 'You have already submitted this exam.' });
  }

  const questions = getAllZimsecQuestions(exam.id).map(q => {
    // Strip answer from question data served to students
    const { answer, explanation, ...safe } = q;
    return safe;
  });
  res.json({ ok: true, exam, questions });
});

// ── Helper: AI mark a short answer question using GPT-4O ─────────────────────
async function markShortAnswer(question, studentAnswer) {
  if (!studentAnswer?.trim()) {
    return { score: 0, feedback: 'No answer provided.' };
  }
  try {
    const { gpt4oChat } = await import('../utils/gpt-service.js');
    
    const systemPrompt = `You are an expert ZIMSEC examiner marking student exam answers for Zimbabwean O-Level and A-Level students.
Your job is to score answers on a scale of 0.0 (completely wrong) to 1.0 (perfect).

SCORING GUIDELINES:
- 1.0: Complete, accurate, well-explained answer matching the model answer
- 0.8-0.9: Good answer with minor omissions or clarity issues
- 0.6-0.7: Partially correct, missing key concepts or explanations
- 0.4-0.5: Significant gaps or misunderstandings but some correct elements
- 0.1-0.3: Minimal correct content or largely incorrect
- 0.0: No attempt or completely wrong

Be consistent and fair. Consider partial credit for partial understanding.
Award marks for correct method even if final answer is wrong (where applicable).`;

    const userPrompt = `Mark this ZIMSEC student answer.

QUESTION: ${question.text}

${question.answer ? `MODEL/EXPECTED ANSWER:
${question.answer}
` : ''}

STUDENT ANSWER:
${studentAnswer}

Respond ONLY with valid JSON on a single line (no markdown, no code fence):
{"score": 0.85, "feedback": "Brief 1-2 sentence marking feedback explaining the score and any gaps"}`;

    const result = await gpt4oChat({
      systemInstruction: systemPrompt,
      message: userPrompt,
      temperature: 0.3,
      max_tokens: 400,
    });

    if (!result.success) {
      console.error('[ZIMSEC] GPT marking failed:', result.error);
      return { score: 0, feedback: `Marking error: ${result.error}. Answer flagged for manual review.` };
    }

    // Parse JSON response from GPT
    let parsed;
    try {
      const clean = result.answer.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(clean);
    } catch (parseErr) {
      console.error('[ZIMSEC] Failed to parse GPT response:', result.answer.slice(0, 100));
      return { score: 0, feedback: 'Marking error: invalid response format. Answer flagged for manual review.' };
    }

    const score = Math.max(0, Math.min(1, parseFloat(parsed.score) || 0));
    const feedback = (parsed.feedback || 'Marked by AI.').slice(0, 250);
    
    return { score, feedback };
  } catch (err) {
    console.error('[ZIMSEC] Short answer marking error:', err.message);
    return { score: 0, feedback: `Marking error: ${err.message.slice(0, 80)}. Answer flagged for manual review.` };
  }
}

// Submit an exam attempt (requires auth) — supports MCQ + AI-marked short answers
router.post('/api/zimsec/exams/:id/submit', requireOnboarded, async (req, res) => {
  try {
    const exam = getZimsecExam(req.params.id);
    if (!exam || !exam.active) return res.status(404).json({ error: 'Exam not found' });

    // ── Server-side timing enforcement ──────────────────────────────────────
    const now = Date.now();
    if (exam.scheduledAt) {
      const startTs = new Date(exam.scheduledAt).getTime();
      // Entry window is 60 minutes; grace: allow submit up to 30s after the exam window closes
      const examEnd = startTs + (exam.durationMins || 60) * 60_000 + 30_000;
      if (now < startTs) {
        return res.status(403).json({ error: 'Exam has not started yet.' });
      }
      if (now > examEnd) {
        return res.status(403).json({ error: 'Exam window has closed. Submission rejected.' });
      }
    }

    // ── Self-serve unlock window validation ─────────────────────────────────
    if (!exam.scheduledAt) {
      const uid = req.user.id;
      const plan = req.user.plan || getUserPlan(uid);
      if (plan === 'free') {
        return res.status(403).json({ error: 'Exam access requires a paid plan.' });
      }
      if (!isExamWindowOpen(uid, exam.id)) {
        return res.status(403).json({ error: 'Your exam unlock window has expired or was never opened.' });
      }
    }

    // ── Exit-ban enforcement ─────────────────────────────────────────────────
    const exitedExams = JSON.parse(req.user.exitedExams || '[]');
    if (exitedExams.includes(exam.id)) {
      return res.status(403).json({ error: 'You exited this exam during a previous attempt.' });
    }

    // ── One-attempt enforcement ──────────────────────────────────────────────
    const existing = getUserZimsecResults(req.user.id).find(r => r.examId === exam.id);
    if (existing) {
      return res.status(403).json({ error: 'You have already submitted this exam.' });
    }

    const { answers = {}, timeTaken = 0 } = req.body || {};
    const questions = getAllZimsecQuestions(exam.id);

    let score = 0;
    const breakdown = {};

    for (const q of questions) {
      const given = answers[q.id];
      const marks = q.marks || 1;

      if (q.type === 'sa') {
        // AI marking for short answers
        const studentAns = (given || '').trim();
        const { score: saScore, feedback: explanation } = await markShortAnswer(q, studentAns);
        score += saScore * marks;
        breakdown[q.id] = { 
          correct: saScore >= 0.5, 
          given: studentAns, 
          score: saScore, 
          explanation, 
          correct_answer: q.answer || '',
          type: 'sa',
          marks: marks
        };
      } else {
        // MCQ: compare letter answers case-insensitively
        const correct = given !== undefined && String(given).trim().toUpperCase() === String(q.answer || '').trim().toUpperCase();
        if (correct) score += marks;
        breakdown[q.id] = { 
          correct, 
          given, 
          correct_answer: q.answer, 
          explanation: q.explanation || '',
          type: 'mcq',
          marks: marks
        };
      }
    }

    const total = questions.reduce((s, q) => s + (q.marks || 1), 0);
    const result = submitZimsecResult({
      userId: req.user.id,
      examId: exam.id,
      answers,
      score: Math.round(score * 10) / 10,
      total,
      timeTaken: parseInt(timeTaken) || 0,
    });

    const saQuestions = Object.values(breakdown).filter(b => b.type === 'sa').length;
    res.json({ 
      ok: true, 
      result, 
      breakdown, 
      score: result.score, 
      total, 
      pct: result.pct,
      aiMarked: saQuestions > 0 ? `${saQuestions} short answer(s) marked by AI` : null
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// Record exam exit — permanently bans user from re-entering
router.post('/api/zimsec/exams/:id/exit', requireAuth, async (req, res) => {
  try {
    const exam = getZimsecExam(req.params.id);
    if (!exam) return res.status(404).json({ error: 'Exam not found' });

    // Only ban if they haven't already submitted
    const existing = getUserZimsecResults(req.user.id).find(r => r.examId === exam.id);
    if (existing) return res.json({ ok: true, message: 'Already submitted, no ban needed.' });

    // Store exit ban on the user record
    const { updateUser } = await import('./auth.js').catch(() => ({ updateUser: null }));
    if (updateUser) {
      const exitedExams = JSON.parse(req.user.exitedExams || '[]');
      if (!exitedExams.includes(exam.id)) {
        exitedExams.push(exam.id);
        await updateUser(req.user.id, { exitedExams: JSON.stringify(exitedExams) });
      }
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get current user's results
router.get('/api/zimsec/results', requireAuth, (req, res) => {
  const results = getUserZimsecResults(req.user.id);
  res.json({ ok: true, results });
});

// Get leaderboard (public, no auth needed)
router.get('/api/zimsec/leaderboard', (req, res) => {
  const { examId, limit } = req.query;
  const board = getZimsecLeaderboard(examId || null, parseInt(limit) || 50);
  res.json({ ok: true, leaderboard: board });
});

// Leaderboard with names (requires auth)
router.get('/api/zimsec/leaderboard/named', requireAuth, (req, res) => {
  const { examId, limit } = req.query;
  const board   = getZimsecLeaderboard(examId || null, parseInt(limit) || 50);
  const users   = getAllWebUsers();
  const named   = board.map((r, i) => {
    const u = users[r.userId];
    return {
      rank:     i + 1,
      name:     u ? `${u.name || ''} ${u.surname || ''}`.trim() || 'Unknown' : 'Unknown',
      isMe:     r.userId === req.user.id,
      pct:      r.pct,
      score:    r.score,
      total:    r.total,
      timeTaken: r.timeTaken,
      submittedAt: r.submittedAt,
    };
  });
  res.json({ ok: true, leaderboard: named });
});

// ── Admin ZIMSEC routes ───────────────────────────────────────────────────

// Admin: list all exams (including inactive)
router.get('/api/admin/zimsec/exams', requireAdmin, (req, res) => {
  res.json({ ok: true, exams: getAllZimsecExams() });
});

// Admin: create exam
router.post('/api/admin/zimsec/exams', requireAdmin, (req, res) => {
  const { title, subject, level, year, description, scheduledAt, durationMins } = req.body || {};
  if (!title || !subject || !level) return res.status(400).json({ error: 'title, subject, level are required' });
  const exam = createZimsecExam({ title, subject, level, year, description, scheduledAt, durationMins, createdBy: 'admin' });
  // Back up immediately to Supabase
  backupExamToSupabase(exam, []).catch(e => console.warn('[Routes] Exam backup (create):', e.message));
  syncToSupabase().catch(e => console.warn('[Routes] zimsec sync (create):', e.message));
  res.json({ ok: true, exam });
});

// Admin: update exam
router.put('/api/admin/zimsec/exams/:id', requireAdmin, (req, res) => {
  const updated = updateZimsecExam(req.params.id, req.body || {});
  if (!updated) return res.status(404).json({ error: 'Exam not found' });
  // Re-backup updated exam with its questions
  const questions = getAllZimsecQuestions(updated.id);
  backupExamToSupabase(updated, questions).catch(e => console.warn('[Routes] Exam backup (update):', e.message));
  syncToSupabase().catch(e => console.warn('[Routes] zimsec sync (update):', e.message));
  res.json({ ok: true, exam: updated });
});

// Admin: delete exam (also removes its questions and Supabase backup)
router.delete('/api/admin/zimsec/exams/:id', requireAdmin, (req, res) => {
  const ok = deleteZimsecExam(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Exam not found' });
  deleteZimsecQuestionsByExam(req.params.id);
  // Remove backup from Supabase and sync
  deleteExamBackup(req.params.id).catch(e => console.warn('[Routes] deleteExamBackup:', e.message));
  syncToSupabase().catch(e => console.warn('[Routes] zimsec sync (delete):', e.message));
  res.json({ ok: true });
});

// Admin: list questions for an exam
router.get('/api/admin/zimsec/exams/:id/questions', requireAdmin, (req, res) => {
  const qs = getAllZimsecQuestions(req.params.id);
  res.json({ ok: true, questions: qs });
});

// Admin: add question to exam
router.post('/api/admin/zimsec/exams/:id/questions', requireAdmin, (req, res) => {
  const exam = getZimsecExam(req.params.id);
  if (!exam) return res.status(404).json({ error: 'Exam not found' });
  const { text, options, answer, explanation, marks, order } = req.body || {};
  if (!text || answer === undefined) return res.status(400).json({ error: 'text and answer are required' });
  const q = createZimsecQuestion({ examId: exam.id, text, options, answer, explanation, marks, order });
  res.json({ ok: true, question: q });
});

// Admin: update a question
router.put('/api/admin/zimsec/questions/:id', requireAdmin, (req, res) => {
  const updated = updateZimsecQuestion(req.params.id, req.body || {});
  if (!updated) return res.status(404).json({ error: 'Question not found' });
  res.json({ ok: true, question: updated });
});

// Admin: delete a question
router.delete('/api/admin/zimsec/questions/:id', requireAdmin, (req, res) => {
  const ok = deleteZimsecQuestion(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Question not found' });
  res.json({ ok: true });
});

// Admin: all results (optionally filtered by examId or userId)
router.get('/api/admin/zimsec/results', requireAdmin, (req, res) => {
  const { examId, userId } = req.query;
  let results = getAllZimsecResults();
  if (examId) results = results.filter(r => r.examId === examId);
  if (userId) results = results.filter(r => r.userId === userId);
  res.json({ ok: true, results });
});

// Admin: delete a result
router.delete('/api/admin/zimsec/results/:id', requireAdmin, (req, res) => {
  const ok = deleteZimsecResult(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Result not found' });
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════
//  NOTIFICATIONS — page + API routes
// ══════════════════════════════════════════════════════════════════════════

// Admin page
router.get('/admin/notifications', (req, res) =>
  res.sendFile(path.join(PUBLIC_DIR, 'notifications.html'))
)

// ── Push subscription endpoints ────────────────────────────────────────────
router.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ key: VAPID_PUBLIC() });
});

router.post('/api/push/subscribe', requireAuth, (req, res) => {
  // NOTE: use req.user (set by requireAuth) — previously getSessionUser(req)
  // was passed the req object instead of a token, returned null, and threw,
  // so subscriptions were never saved (the "enabled but no push" bug).
  const user = req.user;
  const sub  = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
  savePushSubscription(user.id, sub);
  import('../utils/supabase-data.js').then(m => m.uploadDataFile('push_subscriptions.json')).catch(() => {});
  res.json({ ok: true });
});

router.post('/api/push/unsubscribe', requireAuth, (req, res) => {
  const user = req.user;
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
  removePushSubscription(user.id, endpoint);
  import('../utils/supabase-data.js').then(m => m.uploadDataFile('push_subscriptions.json')).catch(() => {});
  res.json({ ok: true });
});;

// User notifications page
router.get('/~/notifications', requireAuth, (req, res) =>
  res.sendFile(path.join(PUBLIC_DIR, 'dashboard', 'notifications.html'))
);

// ── Admin: CRUD ───────────────────────────────────────────────────────────
router.get('/api/admin/notifications', requireAdmin, (req, res) => {
  res.json({ ok: true, notifications: getAllNotifications() });
});

router.post('/api/admin/notifications', requireAdmin, async (req, res) => {
  const { type, title, description, bgImage, target, targetEmails } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title is required' });
  if (!['silent', 'popup'].includes(type))
    return res.status(400).json({ error: 'type must be silent or popup' });
  if (!['all', 'single', 'multiple'].includes(target))
    return res.status(400).json({ error: 'target must be all, single, or multiple' });

  const notif = createNotification({ type, title, description, bgImage, target, targetEmails });

  // Send real Web Push to subscribed browsers
  let push = { sent: 0, failed: 0, subscribers: 0 };
  try {
    let subscriptions;
    if (target === 'all') {
      subscriptions = getAllPushSubscriptions();
    } else {
      const wanted = new Set((targetEmails || []).map(e => String(e).toLowerCase().trim()).filter(Boolean));
      const raw = getAllWebUsers();
      const users = (Array.isArray(raw) ? raw : Object.values(raw || {})).filter(u =>
        wanted.has(String(u.email || '').toLowerCase().trim())
      );
      subscriptions = getPushSubscriptionsForUsers(users.map(u => u.id));
    }
    push.subscribers = subscriptions.length;
    if (subscriptions.length > 0) {
      const result = await sendPushToSubscriptions(subscriptions, {
        title,
        body:  description || '',
        icon:  '/images/logo.png',
        badge: '/images/logo.png',
        image: bgImage || undefined,   // big banner image in the push notification
        url:   '/~/notifications',
      });
      push.sent = result.sent;
      push.failed = result.failed;
    }
  } catch (e) {
    console.warn('[Push] Failed to send push notifications:', e.message);
    push.error = e.message;
  }

  res.json({ ok: true, notification: notif, push });
  import('../utils/supabase-data.js').then(m => m.uploadDataFile('notifications.json')).catch(() => {});
});

// ── Admin: send a TEST push to all subscribers (diagnostic) ────────────────
router.post('/api/admin/notifications/test', requireAdmin, async (req, res) => {
  const { title, body, image } = req.body || {};
  const subscriptions = getAllPushSubscriptions();
  if (!subscriptions.length) {
    return res.json({ ok: false, sent: 0, failed: 0, errors: [], message: 'No push subscriptions found. Users must enable notifications from their dashboard (Notifications → toggle ON).' });
  }
  const result = await sendPushToSubscriptions(subscriptions, {
    title: title || '🔔 Fundo Plus Test',
    body:  body  || 'This is a test notification — push is working!',
    icon:  '/images/logo.png',
    badge: '/images/logo.png',
    image: image || undefined,
    url:   '/~/notifications',
    tag:   'test-' + Date.now(),
  });
  res.json({ ok: true, ...result, totalSubscribers: subscriptions.length });
});

router.delete('/api/admin/notifications/:id', requireAdmin, (req, res) => {
  const ok = deleteNotification(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Notification not found' });
  import('../utils/supabase-data.js').then(m => m.uploadDataFile('notifications.json')).catch(() => {});
  res.json({ ok: true });
});

// Admin: proxy Pixabay image search (keeps API key server-side)
router.get('/api/admin/pixabay-search', requireAdmin, async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'q is required' });
  const key = process.env.PIXABAY_KEY || '';
  if (!key) return res.status(503).json({ error: 'Pixabay not configured' });
  try {
    const url = `https://pixabay.com/api/?key=${key}&q=${encodeURIComponent(q)}&image_type=photo&orientation=horizontal&per_page=20&safesearch=true`;
    const r = await fetch(url);
    const data = await r.json();
    const hits = (data.hits || []).map(h => ({
      id:        h.id,
      thumb:     h.previewURL,
      preview:   h.webformatURL,
      full:      h.largeImageURL,
      user:      h.user,
      tags:      h.tags,
    }));
    res.json({ ok: true, hits });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── User-facing: get my notifications + unread count ─────────────────────
router.get('/api/notifications', requireAuth, (req, res) => {
  const uid   = req.user.id;
  const email = req.user.email;
  const all     = getNotificationsForUser(uid, email);
  const readSet = getReadNotifIds(uid);
  const result  = all.map(n => ({ ...n, read: readSet.has(n.id) }));
  const unread  = result.filter(n => !n.read).length;
  res.json({ ok: true, notifications: result, unread });
});

// ── User-facing: mark one or all as read ─────────────────────────────────
router.post('/api/notifications/read', requireAuth, (req, res) => {
  const uid = req.user.id;
  const { notifId, all } = req.body || {};
  if (all) {
    const email  = req.user.email;
    const visible = getNotificationsForUser(uid, email);
    visible.forEach(n => markNotificationRead(uid, n.id));
  } else if (notifId) {
    markNotificationRead(uid, notifId);
  }
  import('../utils/supabase-data.js').then(m => m.uploadDataFile('notif_reads.json')).catch(() => {});
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════
//  AMBASSADOR — Admin CRUD
// ══════════════════════════════════════════════════════════════════════════

// Serve ambassador dashboard page
router.get('/~/ambassador', requireAuth, (req, res) => {
  if (!getAmbassadorByEmail(req.user.email) && !req.user.isAdmin) return res.redirect('/~/');
  res.sendFile(path.join(PUBLIC_DIR, 'dashboard', 'ambassador.html'));
});

// Admin: list all ambassadors
router.get('/api/admin/ambassadors', requireAdmin, (req, res) => {
  const ambassadors = getAmbassadorsAdminOverview();
  const totals = ambassadors.reduce((acc, a) => {
    acc.referred += a.referredCount || 0;
    acc.exams += a.examsCreated || 0;
    acc.submissions += a.totalSubmissions || 0;
    acc.students += a.studentsReached || 0;
    if (a.active) acc.active += 1;
    return acc;
  }, { referred: 0, exams: 0, submissions: 0, students: 0, active: 0 });
  res.json({ ok: true, ambassadors, totals });
});

// Admin: add ambassador by email
router.post('/api/admin/ambassadors', requireAdmin, (req, res) => {
  const { email, note = '' } = req.body || {};
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });
  const result = addAmbassador({ email, addedBy: req.user?.id || 'admin', note });
  if (!result.ok) return res.status(409).json({ error: result.error });
  import('../utils/supabase-data.js').then(m => m.uploadDataFile('ambassadors.json')).catch(() => {});
  import('../utils/supabase-data.js').then(m => m.uploadDataFile('webusers.json')).catch(() => {});
  res.json(result);
});

// Admin: update ambassador (note / active toggle)
router.put('/api/admin/ambassadors/:id', requireAdmin, (req, res) => {
  const updated = updateAmbassador(req.params.id, req.body || {});
  if (!updated) return res.status(404).json({ error: 'Ambassador not found' });
  import('../utils/supabase-data.js').then(m => m.uploadDataFile('ambassadors.json')).catch(() => {});
  res.json({ ok: true, ambassador: updated });
});

// Admin: remove ambassador
router.delete('/api/admin/ambassadors/:id', requireAdmin, (req, res) => {
  const ok = removeAmbassador(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Ambassador not found' });
  import('../utils/supabase-data.js').then(m => m.uploadDataFile('ambassadors.json')).catch(() => {});
  import('../utils/supabase-data.js').then(m => m.uploadDataFile('webusers.json')).catch(() => {});
  res.json({ ok: true });
});

// ── Ambassador Self Routes ────────────────────────────────────────────────

function requireAmbassador(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorised' });
  if (req.user.isAdmin) return next();
  if (getAmbassadorByEmail(req.user.email)) return next();
  return res.status(403).json({ error: 'Ambassador access required' });
}

// Ambassador: get their own profile + stats
router.get('/api/ambassador/me', requireAuth, requireAmbassador, (req, res) => {
  const user = req.user;
  const amb  = getAmbassadorByEmailWithCode(user.email);
  const myExams = getAllZimsecExams().filter(e => e.createdBy === `ambassador:${user.id}`);
  const myResults = getAllZimsecResults().filter(r => myExams.some(e => e.id === r.examId));
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.json({
    ok: true,
    ambassador: amb,
    referralLink: `${baseUrl}/join/${amb.referralCode}`,
    referrals: amb.referrals || [],
    stats: {
      examsCreated:     myExams.length,
      totalSubmissions: myResults.length,
      studentsReached:  new Set(myResults.map(r => r.userId)).size,
      referredUsers:    (amb.referrals || []).length,
    },
  });
});

// Ambassador: create an exam (tagged ambassador:<userId>)
router.post('/api/ambassador/exams', requireAuth, requireAmbassador, (req, res) => {
  const { title, subject, level, year, description, scheduledAt, durationMins } = req.body || {};
  if (!title || !subject) return res.status(400).json({ error: 'Title and subject required' });
  const exam = createZimsecExam({
    title: `Ambassador's Test: ${title}`,
    subject, level, year, description, scheduledAt, durationMins,
    createdBy: `ambassador:${req.user.id}`,
  });
  res.json({ ok: true, exam });
});

// Ambassador: list only their own exams
router.get('/api/ambassador/exams', requireAuth, requireAmbassador, (req, res) => {
  const exams = getAllZimsecExams().filter(e => e.createdBy === `ambassador:${req.user.id}`);
  res.json({ ok: true, exams });
});

// Ambassador: update their own exam
router.put('/api/ambassador/exams/:id', requireAuth, requireAmbassador, (req, res) => {
  const exam = getZimsecExam(req.params.id);
  if (!exam) return res.status(404).json({ error: 'Exam not found' });
  if (exam.createdBy !== `ambassador:${req.user.id}` && !req.user.isAdmin)
    return res.status(403).json({ error: 'Not your exam' });
  const updated = updateZimsecExam(req.params.id, req.body);
  res.json({ ok: true, exam: updated });
});

// Ambassador: delete their own exam
router.delete('/api/ambassador/exams/:id', requireAuth, requireAmbassador, (req, res) => {
  const exam = getZimsecExam(req.params.id);
  if (!exam) return res.status(404).json({ error: 'Exam not found' });
  if (exam.createdBy !== `ambassador:${req.user.id}` && !req.user.isAdmin)
    return res.status(403).json({ error: 'Not your exam' });
  deleteZimsecExam(req.params.id);
  deleteZimsecQuestionsByExam(req.params.id);
  res.json({ ok: true });
});

// Ambassador: add question to their exam
router.post('/api/ambassador/exams/:id/questions', requireAuth, requireAmbassador, (req, res) => {
  const exam = getZimsecExam(req.params.id);
  if (!exam) return res.status(404).json({ error: 'Exam not found' });
  if (exam.createdBy !== `ambassador:${req.user.id}` && !req.user.isAdmin)
    return res.status(403).json({ error: 'Not your exam' });
  const q = createZimsecQuestion({ examId: req.params.id, ...req.body });
  res.json({ ok: true, question: q });
});

// Ambassador: get questions for their exam
router.get('/api/ambassador/exams/:id/questions', requireAuth, requireAmbassador, (req, res) => {
  const exam = getZimsecExam(req.params.id);
  if (!exam) return res.status(404).json({ error: 'Exam not found' });
  if (exam.createdBy !== `ambassador:${req.user.id}` && !req.user.isAdmin)
    return res.status(403).json({ error: 'Not your exam' });
  res.json({ ok: true, questions: getAllZimsecQuestions(req.params.id) });
});

// Ambassador: leaderboard for their exam
router.get('/api/ambassador/exams/:id/leaderboard', requireAuth, requireAmbassador, (req, res) => {
  const exam = getZimsecExam(req.params.id);
  if (!exam) return res.status(404).json({ error: 'Exam not found' });
  res.json({ ok: true, leaderboard: getZimsecLeaderboard(req.params.id, 100) });
});

// Ambassador: submit results for their exam (uses same unlock mechanism, 7-day grace)
// Students unlock ambassador exams via normal /api/zimsec/exams/:id/unlock endpoint
// but we override the window check on the front-end. Here we store a special flag.

// User-facing: unlock an ambassador exam (7-day window)
router.post('/api/zimsec/ambassador-exams/:id/unlock', requireAuth, (req, res) => {
  const exam = getZimsecExam(req.params.id);
  if (!exam) return res.status(404).json({ error: 'Exam not found' });
  if (!isAmbassadorExam(exam)) return res.status(400).json({ error: 'Not an ambassador exam' });
  const unlock = unlockExamForUser(req.user.id, req.params.id);
  const expiry = getAmbassadorExamWindowExpiry(req.user.id, req.params.id);
  res.json({ ok: true, unlock, expiresAt: expiry, windowDays: 7 });
});

export default router;
