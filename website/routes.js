// website/routes.js — All web routes
import express  from 'express';
import fs       from 'fs';
import path     from 'path';
import multer   from 'multer';
import { fileURLToPath } from 'url';
import {
  createUser, verifyLogin, getWebUser, saveWebUser,
  deleteWebUser, findWebUserByToken, listPapersLocal,
  getPapersTotalBytes, MAX_PAPERS_BYTES, addWishlistVote,
  getWishlistCount, incrementPaperUpload, PAPER_UPLOAD_LIMIT,
  addPaper, removePaper, getAllWebUsers,
  banUser, unbanUser, getBan, getAllBans, isBanned,
  submitAppeal, resolveAppeal, hashPassword,
  addCommunityMessage, getCommunityMessages,
  deleteCommunityMessage, getCommunityCount,
  // subscription & usage
  getUserPlan, getPlanLimits, setUserSubscription, getAllSubscriptions,
  getUserSubscription, savePaymentProof, getAllProofs, getPendingProofs,
  getProofFilePath, reviewProof, getUserProofs, getUserPendingProof, PLANS,
  getFullUsage, incrementStudySession, incrementQuizUsage,
  incrementProjectUsage, incrementPaperDl, canDownloadPaper,
  incrementChatUsage, incrementPdfUsage as _incPdf,
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
  getAllAmbassadors, getAllAmbassadorsWithCodes,
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
import { askWebAI, clearWebHistory } from './ai.js';
import { createVerifyToken, consumeToken } from '../utils/verify.js';
import {
  uploadUpdateJson, uploadApk, fetchUpdateJson, getApkPublicUrl,
} from '../utils/update-store.js';
import {
  backupExamToSupabase, deleteExamBackup, purgeExpiredExamBackups, syncToSupabase,
} from '../utils/supabase-data.js';
import webpush from 'web-push';

// ── Web Push (VAPID) setup ─────────────────────────────────────────────────
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  || 'BEPEHkkKDM0XGZVnCphAAq2IjX_V2kaVSOUfIEYBi2l33bAW9_GY4xbDS0WHAU5SOeceWuMrfTmtm3tHfc6izKs';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || 'K-4QFQ4WJ__l5zoQ5zZlqYcsyalMi1q3DtEesGhnbDI';
webpush.setVapidDetails('mailto:support@fundoplus.co.zw', VAPID_PUBLIC, VAPID_PRIVATE);

async function sendPushToSubscriptions(subscriptions, payload) {
  const results = await Promise.allSettled(
    subscriptions.map(sub => webpush.sendNotification(sub, JSON.stringify(payload)))
  );
  const failed = results.filter(r => r.status === 'rejected').length;
  if (failed) console.warn(`[Push] ${failed}/${subscriptions.length} pushes failed`);
}

// Run expired exam backup purge on startup (non-blocking)
purgeExpiredExamBackups().catch(e => console.warn('[Routes] purgeExpiredExamBackups startup error:', e.message));

// Schedule recurring purge every hour
setInterval(() => {
  purgeExpiredExamBackups().catch(e => console.warn('[Routes] purgeExpiredExamBackups interval error:', e.message));
}, 60 * 60 * 1000);

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

// ── Ban guard helper ─────────────────────────────────────────────────────
function parseCookies(req) {
  const raw = req.headers.cookie || '';
  return Object.fromEntries(raw.split(';').map(c => c.trim().split('=').map(decodeURIComponent)));
}

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
router.get('/community',   pageGuardBan, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'community.html')));
router.get('/support',     pageGuardBan, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'support.html')));
router.get('/resources',   pageGuardBan, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'resources.html')));
router.get('/redeem',      pageGuardBan, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'redeem.html')));
router.get('/banned',      (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'banned.html')));
router.get('/samazed',     (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'samazed.html')));

// ═══════════════════════════════════════════════════════════════════
//  AUTH API
// ═══════════════════════════════════════════════════════════════════
router.post('/api/auth/register', (req, res) => {
  const { email, phone, password } = req.body || {};
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (!email && !phone) return res.status(400).json({ error: 'Email or phone number required' });
  const result = createUser({ email: email?.trim().toLowerCase(), phone: phone?.trim(), password });
  if (!result.ok) return res.status(400).json({ error: result.error });

  // Record referral if they came through an ambassador link
  const refCode = req.cookies?.amb_ref;
  if (refCode) {
    const amb = getAmbassadorByCode(refCode);
    if (amb) {
      recordReferral(amb.id, result.user.id, result.user.email || phone || '');
      import('../utils/supabase-data.js').then(m => m.uploadDataFile('ambassadors.json')).catch(() => {});
    }
    res.clearCookie('amb_ref');
  }

  const token = createSession(result.user.id);
  res.cookie('session', token, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000 });
  res.json({ ok: true, token, user: sanitizeUser(result.user), onboarded: false });
});

router.post('/api/auth/login', (req, res) => {
  const { email, phone, password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'Password required' });
  if (!email && !phone) return res.status(400).json({ error: 'Email or phone required' });
  const user = verifyLogin({ email: email?.trim().toLowerCase(), phone: phone?.trim(), password });
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const token = createSession(user.id);
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

  res.json({ ok: true, user: sanitizeUser(user), pairingStatus, daysLeft, plan, limits, usage, sub,
    isAmbassador: ambassadorActive });
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

  const DEFAULT_SYS = 'You are Prok AI, made by Fundo Plus. You are a helpful, intelligent AI assistant. Assist the user clearly and concisely.';
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
  const { message } = req.body || {};
  if (!message) return res.status(400).json({ error: 'No message' });

  const uid    = req.user.id;
  const isLinked = !!req.user.jid;
  const limits = getPlanLimits(uid, isLinked);
  const usage  = getFullUsage(uid);
  const ambassadorActive = !!(getAmbassadorByEmail(req.user.email));

  const aiLimit = (limits.aiMsg === 'unlimited' || ambassadorActive) ? Infinity : limits.aiMsg;
  if (aiLimit !== Infinity && (usage.chat || 0) >= aiLimit) {
    return res.status(429).json({ error: `Daily AI message limit reached (${aiLimit}). Upgrade your plan for more.` });
  }

  try {
    const reply = await askWebAI(`web:${uid}`, message);
    incrementChatUsage(uid);
    res.json({ reply });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════
//  QUIZ
// ═══════════════════════════════════════════════════════════════════
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
  const proofs = getUserProofs(uid);
  const pendingProof = getUserPendingProof(uid);
  res.json({ ok: true, plan, sub, limits, usage, proofs, pendingProof: pendingProof || null, plans: PLANS });
});

// Submit payment proof
router.post('/api/subscription/proof', requireAuth, proofUpload.single('proof'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Image file required' });
  const { plan } = req.body || {};
  if (!PLANS[plan] || plan === 'free') return res.status(400).json({ error: 'Invalid plan' });

  const ext = req.file.mimetype.split('/')[1] || 'jpg';
  const result = await savePaymentProof(req.user.id, plan, req.file.buffer, ext);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ ok: true, proofId: result.proofId, message: 'Proof submitted. Admin will review within 24 hours.' });
});

// ═══════════════════════════════════════════════════════════════════
//  COMMUNITY
// ═══════════════════════════════════════════════════════════════════
router.get('/api/community', (req, res) => {
  const msgs = getCommunityMessages(300);
  res.json({ ok: true, messages: msgs, total: getCommunityCount() });
});

router.post('/api/community', requireAuth, (req, res) => {
  const { text, replyTo = null } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'Message text required' });
  if (text.trim().length > 1000) return res.status(400).json({ error: 'Message too long (max 1000 chars)' });
  const user = req.user;
  const displayName = user.name ? `${user.name} ${user.surname || ''}`.trim() : (user.email || 'Anonymous');
  const ambassadorStatus = !!(getAmbassadorByEmail(user.email));
  const msg = addCommunityMessage({
    userId: user.id, name: displayName, text: text.trim(), replyTo,
    isAmbassador: ambassadorStatus, isAdmin: !!user.isAdmin,
  });
  res.json({ ok: true, message: msg });
});

router.delete('/api/community/:id', requireAuth, (req, res) => {
  const ok = deleteCommunityMessage(req.params.id, req.user.id, false);
  if (!ok) return res.status(403).json({ error: 'Not allowed or not found' });
  res.json({ ok: true });
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
  // Accept classic admin key
  const key = req.headers['x-admin-token'] || req.headers['x-admin-key'] || req.body?.adminKey || req.query?.adminKey;
  if (key && key === ADMIN_PASS) return next();

  // Also accept session token from a user with isAdmin: true
  const sessionToken = req.headers['x-session-token'];
  if (sessionToken) {
    const user = findWebUserByToken(sessionToken);
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
  res.json({ users: users.map(sanitizeUser) });
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
  res.json({ messages: getAllMessageCounts() });
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
  res.json({ key: VAPID_PUBLIC });
});

router.post('/api/push/subscribe', requireAuth, (req, res) => {
  const user = getSessionUser(req);
  const sub  = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
  savePushSubscription(user.id, sub);
  import('../utils/supabase-data.js').then(m => m.uploadDataFile('push_subscriptions.json')).catch(() => {});
  res.json({ ok: true });
});

router.post('/api/push/unsubscribe', requireAuth, (req, res) => {
  const user = getSessionUser(req);
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
  try {
    let subscriptions;
    if (target === 'all') {
      subscriptions = getAllPushSubscriptions();
    } else {
      const users = getAllWebUsers().filter(u =>
        (targetEmails || []).map(e => e.toLowerCase()).includes((u.email || '').toLowerCase())
      );
      subscriptions = getPushSubscriptionsForUsers(users.map(u => u.id));
    }
    if (subscriptions.length > 0) {
      sendPushToSubscriptions(subscriptions, {
        title,
        body:  description || '',
        icon:  '/images/logo.png',
        badge: '/images/logo.png',
        url:   '/~/notifications',
      }); // fire-and-forget
    }
  } catch (e) {
    console.warn('[Push] Failed to send push notifications:', e.message);
  }

  res.json({ ok: true, notification: notif });
  import('../utils/supabase-data.js').then(m => m.uploadDataFile('notifications.json')).catch(() => {});
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
  res.json({ ok: true, ambassadors: getAllAmbassadorsWithCodes() });
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
