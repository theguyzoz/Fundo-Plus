// store.js — Persistent store: JIDs, usage, images, docs, messages, papers, wishlist
// No Firebase dependency — uses local JSON files: webusers.json, store.json, wa.json
import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

// Lazy import for Supabase proof storage (avoids circular deps)
let _supabaseData = null;
async function getSupabaseData() {
  if (!_supabaseData) _supabaseData = await import('./utils/supabase-data.js');
  return _supabaseData;
}

// ── Immediate Supabase backup engine (money safety) ────────────────────────
// Every money mutation writes its JSON file synchronously, then schedules an
// immediate Supabase upload so a redeploy/crash mid-transaction can't lose
// (or replay) funds. Rapid writes are coalesced by a tiny debounce, and
// critical request handlers additionally AWAIT flushMoneyBackup() before
// responding, so the caller only succeeds once state is durably saved.
const MONEY_FILES = ['balances.json', 'pending_deposits.json', 'withdrawals.json', 'subscriptions.json'];
const MONEY_BACKUP_DEBOUNCE_MS = 100;

let _moneyTimer   = null;
let _moneyInFlight = null;

async function _uploadMoneyFiles() {
  try {
    const sb = await getSupabaseData();
    if (!sb || typeof sb.uploadDataFile !== 'function') return false;
    for (const f of MONEY_FILES) {
      await sb.uploadDataFile(f);
    }
    return true;
  } catch (e) {
    console.error('[MoneyBackup] Supabase backup failed:', e.message);
    return false;
  }
}

/** Coalesced immediate backup — called after every money write. */
function scheduleMoneyBackup() {
  if (_moneyTimer) clearTimeout(_moneyTimer);
  _moneyTimer = setTimeout(() => {
    _moneyTimer = null;
    _moneyInFlight = _uploadMoneyFiles();
  }, MONEY_BACKUP_DEBOUNCE_MS);
}

/** Await a durable backup now. Used at the end of critical request handlers. */
export function flushMoneyBackup() {
  if (_moneyTimer) { clearTimeout(_moneyTimer); _moneyTimer = null; }
  if (_moneyInFlight) return _moneyInFlight;
  return _uploadMoneyFiles();
}

const __dirname      = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(__dirname, 'data');

// ── File paths ─────────────────────────────────────────────────────────────
const WEBUSERS_FILE  = path.join(DATA_DIR, 'webusers.json');
const STORE_FILE     = path.join(DATA_DIR, 'store.json');
const WA_FILE        = path.join(DATA_DIR, 'wa.json');
const IMAGES_FILE    = path.join(DATA_DIR, 'images.json');
const USAGE_FILE     = path.join(DATA_DIR, 'usage.json');
const DOC_FILE       = path.join(DATA_DIR, 'doc.json');
const MESSAGES_FILE  = path.join(DATA_DIR, 'messages.json');
const PAPERS_FILE    = path.join(DATA_DIR, 'papers.json');
const WISHLIST_FILE  = path.join(DATA_DIR, 'wishlist.json');
const SUBS_FILE      = path.join(DATA_DIR, 'subscriptions.json');
const PROOFS_DIR     = path.join(DATA_DIR, 'payment_proofs');
const SUPPORT_FILE   = path.join(DATA_DIR, 'support.json');
const BALANCES_FILE  = path.join(DATA_DIR, 'balances.json');
const PENDING_FILE   = path.join(DATA_DIR, 'pending_deposits.json');
const WITHDRAWALS_FILE = path.join(DATA_DIR, 'withdrawals.json');

if (!fs.existsSync(DATA_DIR))   fs.mkdirSync(DATA_DIR,   { recursive: true });
if (!fs.existsSync(PROOFS_DIR)) fs.mkdirSync(PROOFS_DIR, { recursive: true });

// ── Plan definitions ────────────────────────────────────────────────────────
export const PLANS = {
  free: {
    name: 'Free',
    price: 0,
    aiMsg:         { unlinked: 15, linked: 30 },  // per day
    projects:      3,    // total forever (not per day)
    studySessions: 3,    // per day (skills sessions opened)
    pdfExports:    5,    // per day
    quizzes:       3,    // per day
    paperDl:       4,    // per 6 hours
  },
  lite: {
    name: 'Lite',
    price: 2,
    aiMsg:         { unlinked: 70, linked: 70 },
    projects:      8,
    studySessions: 8,
    pdfExports:    10,
    quizzes:       7,
    paperDl:       8,
  },
  plus: {
    name: 'Plus',
    price: 5,
    aiMsg:         { unlinked: 200, linked: 200 },
    projects:      25,
    studySessions: 25,
    pdfExports:    30,
    quizzes:       20,
    paperDl:       20,
  },
  pro: {
    name: 'Pro',
    price: 7,
    aiMsg:         { unlinked: Infinity, linked: Infinity },
    projects:      Infinity,
    studySessions: Infinity,
    pdfExports:    Infinity,
    quizzes:       Infinity,
    paperDl:       Infinity,
  },
};

// ── Legacy limits (kept for WA bot compat) ─────────────────────────────────
export const DAILY_CHAT_LIMIT   = 25;
export const DAILY_IMAGE_LIMIT  = 15;
export const DAILY_PDF_LIMIT    = 5;
export const PAPER_UPLOAD_LIMIT = 3;
export const MAX_PAPERS_BYTES   = 800 * 1024 * 1024; // 800 MB for papers

// ── Generic file helpers ───────────────────────────────────────────────────
function readJson(fp, def) {
  try { if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp,'utf8')); } catch {}
  return def;
}
function writeJson(fp, data) {
  try { fs.writeFileSync(fp, JSON.stringify(data, null, 2)); } catch (e) {
    console.error('⚠️ Failed to save', path.basename(fp), e.message);
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  Subscriptions
// ══════════════════════════════════════════════════════════════════════════
let subsData = readJson(SUBS_FILE, { subscriptions: {} });
function saveSubs() { writeJson(SUBS_FILE, subsData); scheduleMoneyBackup(); }

export function getUserPlan(userId) {
  const sub = subsData.subscriptions[userId];
  if (!sub || sub.status !== 'active') return 'free';
  // Check expiry
  if (sub.expiresAt && new Date(sub.expiresAt) < new Date()) {
    sub.status = 'expired';
    saveSubs();
    return 'free';
  }
  return sub.plan || 'free';
}

export function getPlanLimits(userId, isLinked = false) {
  const plan = getUserPlan(userId);
  const def  = PLANS[plan] || PLANS.free;
  // Replace Infinity with "unlimited" so it serialises safely over JSON
  const safe = v => (v === Infinity ? 'unlimited' : v);
  return {
    plan,
    aiMsg:         safe(isLinked ? def.aiMsg.linked : def.aiMsg.unlinked),
    projects:      safe(def.projects),
    studySessions: safe(def.studySessions),
    pdfExports:    safe(def.pdfExports),
    quizzes:       safe(def.quizzes),
    paperDl:       safe(def.paperDl),
  };
}

export function setUserSubscription(userId, plan, adminId = 'admin') {
  if (!PLANS[plan]) return false;
  const now = new Date();
  const exp = new Date(now);
  exp.setDate(exp.getDate() + 30);
  subsData.subscriptions[userId] = {
    plan, status: 'active',
    grantedBy: adminId,
    grantedAt: now.toISOString(),
    expiresAt: plan === 'free' ? null : exp.toISOString(),
  };
  saveSubs();
  return true;
}

export function getAllSubscriptions() { return subsData.subscriptions; }
export function getUserSubscription(userId) { return subsData.subscriptions[userId] || null; }

// ── Payment proofs ─────────────────────────────────────────────────────────
let proofMeta = readJson(path.join(DATA_DIR, 'proofmeta.json'), { proofs: [] });
function saveProofMeta() { writeJson(path.join(DATA_DIR, 'proofmeta.json'), proofMeta); }

// Check if user already has a pending proof (block duplicates)
export function getUserPendingProof(userId) {
  return proofMeta.proofs.find(p => p.userId === userId && p.status === 'pending') || null;
}

// Save proof — uploads straight to Supabase, no local file kept
export async function savePaymentProof(userId, plan, imageBuffer, ext) {
  // Block if user already has a pending proof
  const existing = getUserPendingProof(userId);
  if (existing) {
    return { ok: false, error: 'You already have a pending proof awaiting review. Please wait for admin approval before submitting another.' };
  }

  const filename = `proof-${userId}-${Date.now()}.${ext}`;

  // Upload directly to Supabase storage
  let supabasePath = null;
  try {
    const sb = await getSupabaseData();
    if (sb && sb.uploadProofImage) {
      supabasePath = await sb.uploadProofImage(filename, imageBuffer);
      console.log(`[Proofs] ✅ Uploaded ${filename} to Supabase`);
    } else {
      console.warn('[Proofs] Supabase not available — proof not stored');
    }
  } catch (e) {
    console.error('[Proofs] Supabase upload failed on submit:', e.message);
    // Still record the meta so admin can see it; mark as not stored
  }

  const meta = {
    id: `pr-${Date.now()}`,
    userId, plan, filename,
    size: imageBuffer.length,
    status: 'pending', // pending | approved | rejected
    submittedAt: new Date().toISOString(),
    supabasePath,       // path in Supabase bucket
    reviewedAt: null,
    reviewedBy: null,
  };
  proofMeta.proofs.unshift(meta);
  if (proofMeta.proofs.length > 500) proofMeta.proofs = proofMeta.proofs.slice(0, 500);
  saveProofMeta();
  return { ok: true, proofId: meta.id, filename };
}

export function getAllProofs()             { return proofMeta.proofs; }
export function getPendingProofs()        { return proofMeta.proofs.filter(p => p.status === 'pending'); }
export function getProofFilePath(filename){ return path.join(PROOFS_DIR, filename); }

// Review proof — deletes from Supabase after decision (approved or rejected)
export async function reviewProof(proofId, status, adminId) {
  const p = proofMeta.proofs.find(x => x.id === proofId);
  if (!p) return false;
  p.status = status;
  p.reviewedAt = new Date().toISOString();
  p.reviewedBy = adminId;

  if (status === 'approved') {
    setUserSubscription(p.userId, p.plan, adminId);
  }

  // Delete image from Supabase after review (approved or rejected)
  if (p.supabasePath || p.filename) {
    try {
      const sb = await getSupabaseData();
      if (sb && sb.deleteProofImage) {
        await sb.deleteProofImage(p.filename);
        console.log(`[Proofs] 🗑 Deleted ${p.filename} from Supabase after ${status}`);
      }
    } catch (e) {
      console.error('[Proofs] Supabase delete failed:', e.message);
    }
  }

  // Also clean up any local file if it somehow exists
  const localPath = path.join(PROOFS_DIR, p.filename);
  try { if (fs.existsSync(localPath)) fs.unlinkSync(localPath); } catch {}

  p.supabasePath = null; // cleared after deletion
  saveProofMeta();
  return true;
}

export function getUserProofs(userId) { return proofMeta.proofs.filter(p => p.userId === userId); }

// ── Virtual balance, fees & withdrawals (USD cents) ────────────────────────
// Money is stored as integer USD cents. Every amount is computed and validated
// SERVER-SIDE — the client can never set a credited/debited amount directly.
// Plan prices, fees and caps all originate here, not from the browser.

export const MAX_BALANCE_CENTS  = 1000;   // $10.00 USD — wallet hard cap
export const MIN_TOPUP_CENTS    = 100;    // $1.00 minimum top-up
export const MIN_WITHDRAW_CENTS = 100;    // $1.00 minimum withdrawal
export const TRANSACTION_FEE_PCT = 5;     // 5% per cash-out transaction
export const FEE_ON_DEPOSIT     = false;  // deposits credited in full; fee applies on withdrawal

// Fee in cents (floor, so we never over-charge).
export function feeCents(amountCents) {
  return Math.floor((amountCents * TRANSACTION_FEE_PCT) / 100);
}

// Parse/validate a client-supplied USD amount string/number → integer cents.
// Returns null if invalid. Rejects NaN, negatives, zero, >2 decimals, absurd values.
export function sanitizeCents(input) {
  if (typeof input === 'string' && !input.trim()) return null;
  const n = Number(input);
  if (!Number.isFinite(n) || n <= 0) return null;
  const cents = Math.round(n * 100);
  if (cents < 1) return null;
  // Reject values with sub-cent precision that can't round-trip cleanly
  if (Math.abs(cents - n * 100) > 0.001) return null;
  return cents;
}

let balancesData = readJson(BALANCES_FILE, { balances: {}, transactions: [] });
function saveBalances() { writeJson(BALANCES_FILE, balancesData); scheduleMoneyBackup(); }

export function getUserBalance(userId) {
  return balancesData.balances[userId] || 0; // integer cents
}

// Net amount a user would receive if they cashed out their entire balance.
// Always 5% below the virtual balance (the "withdrawal balance").
export function getWithdrawalBalance(userId) {
  const b = getUserBalance(userId);
  return Math.max(0, b - feeCents(b));
}

// How much more this wallet can hold before hitting the $10 cap.
export function getRemainingTopupCapacity(userId) {
  return Math.max(0, MAX_BALANCE_CENTS - getUserBalance(userId));
}

/**
 * Atomically adjust a balance. Guards against going negative on debit and
 * against exceeding the cap on credit. Returns { ok, balance, error }.
 */
export function adjustUserBalance(userId, cents, reason = '') {
  const before = balancesData.balances[userId] || 0;
  const after  = before + cents;

  if (cents < 0 && after < 0) {
    return { ok: false, balance: before, error: 'Insufficient balance' };
  }
  if (cents > 0 && after > MAX_BALANCE_CENTS) {
    return { ok: false, balance: before, error: 'Balance would exceed the $10.00 maximum' };
  }

  balancesData.balances[userId] = after;
  balancesData.transactions.push({
    id: `tx-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
    userId, cents, reason, balance: after, at: new Date().toISOString(),
  });
  if (balancesData.transactions.length > 5000) balancesData.transactions = balancesData.transactions.slice(-5000);
  saveBalances();
  return { ok: true, balance: after };
}

export function getBalanceTransactions(userId, limit = 50) {
  return balancesData.transactions.filter(t => t.userId === userId).slice(-limit).reverse();
}

// ── Withdrawals ─────────────────────────────────────────────────────────────
let withdrawalsData = readJson(WITHDRAWALS_FILE, { withdrawals: [] });
function saveWithdrawals() { writeJson(WITHDRAWALS_FILE, withdrawalsData); scheduleMoneyBackup(); }

/**
 * Request a withdrawal. VALIDATES everything server-side and debits the wallet
 * atomically so the money cannot be double-spent. Returns { ok, withdrawal, error }.
 * The 5% fee is applied here: net = amount - fee.
 */
export function requestWithdrawal(userId, amountCents, phone = '') {
  const balance = getUserBalance(userId);
  if (amountCents < MIN_WITHDRAW_CENTS) {
    return { ok: false, error: `Minimum withdrawal is $${(MIN_WITHDRAW_CENTS/100).toFixed(2)}.` };
  }
  if (amountCents > balance) {
    return { ok: false, error: `Amount exceeds your balance ($${(balance/100).toFixed(2)}).` };
  }
  if (!/^0?7\d{8}$|^2637\d{8}$/.test(String(phone || '').replace(/\s+/g, ''))) {
    return { ok: false, error: 'Enter a valid EcoCash/OneMoney mobile number.' };
  }

  const fee  = feeCents(amountCents);
  const net  = amountCents - fee;

  // Atomic debit (fails if insufficient — prevents races/double-spend)
  const adj = adjustUserBalance(userId, -amountCents, `Withdrawal (fee $${(fee/100).toFixed(2)})`);
  if (!adj.ok) return { ok: false, error: adj.error };

  const w = {
    id: `wd-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
    userId,
    phone: String(phone).replace(/\s+/g, ''),
    amountCents,
    feeCents: fee,
    netCents: net,
    status: 'pending', // pending | paid | failed
    requestedAt: new Date().toISOString(),
    processedAt: null,
    processedBy: null,
  };
  withdrawalsData.withdrawals.unshift(w);
  if (withdrawalsData.withdrawals.length > 2000) withdrawalsData.withdrawals = withdrawalsData.withdrawals.slice(0, 2000);
  saveWithdrawals();
  return { ok: true, withdrawal: w };
}

export function getWithdrawals(userId) {
  return withdrawalsData.withdrawals.filter(w => w.userId === userId);
}
export function getAllWithdrawals() { return withdrawalsData.withdrawals; }
export function getWithdrawal(id) {
  return withdrawalsData.withdrawals.find(w => w.id === id) || null;
}
export function updateWithdrawalStatus(id, status, adminId = 'admin') {
  const w = withdrawalsData.withdrawals.find(x => x.id === id);
  if (!w) return false;
  if (status === 'failed' && w.status === 'pending') {
    // Refund the wallet if a payout fails — money must not vanish.
    adjustUserBalance(w.userId, w.amountCents, `Withdrawal failed — refund (${id})`);
  }
  w.status = status;
  w.processedAt = new Date().toISOString();
  w.processedBy = adminId;
  saveWithdrawals();
  return true;
}

// ── Pending Paynow top-ups (polled until confirmed) ─────────────────────────
let pendingData = readJson(PENDING_FILE, { pending: {} });
function savePending() { writeJson(PENDING_FILE, pendingData); scheduleMoneyBackup(); }

export function savePendingDeposit({ reference, userId, amountCents, pollUrl, method, phone }) {
  pendingData.pending[reference] = {
    reference, userId,
    amountCents, pollUrl: pollUrl || null,
    method: method || 'ecocash', phone: phone || '',
    status: 'pending', // pending | paid | failed
    createdAt: new Date().toISOString(),
    paynowReference: null, confirmedAt: null,
  };
  savePending();
  return pendingData.pending[reference];
}

export function getPendingDeposit(reference) {
  return pendingData.pending[reference] || null;
}

export function getPendingDepositsForUser(userId) {
  return Object.values(pendingData.pending).filter(p => p.userId === userId);
}

export function deletePendingDeposit(reference) {
  delete pendingData.pending[reference];
  savePending();
}

/**
 * Finalize a pending top-up on payment confirmation (webhook OR poll).
 * Credits the wallet (minus deposit fee if FEE_ON_DEPOSIT) and enforces the
 * $10 cap. IDEMPOTENT — a second call returns { already: true } and never
 * double-credits. This is the key anti-fraud guard against replay attacks.
 */
export function finalizeDeposit(reference, paynowReference = null) {
  const pend = pendingData.pending[reference];
  if (!pend) return null;
  if (pend.status === 'paid') {
    return { already: true, userId: pend.userId, amountCents: pend.amountCents };
  }

  const gross  = pend.amountCents;
  const fee    = FEE_ON_DEPOSIT ? feeCents(gross) : 0;
  const credit = gross - fee;

  const adj = adjustUserBalance(pend.userId, credit, `Paynow top-up (ref ${reference})${fee ? ` — fee $${(fee/100).toFixed(2)}` : ''}`);
  // If the cap would be exceeded (shouldn't happen — validated at initiation),
  // credit only up to the cap and record the difference safely.
  if (!adj.ok && adj.error.includes('maximum')) {
    const room = MAX_BALANCE_CENTS - getUserBalance(pend.userId);
    if (room > 0) adjustUserBalance(pend.userId, room, `Paynow top-up (partial, capped) ref ${reference}`);
  }

  pend.status = 'paid';
  pend.paynowReference = paynowReference || null;
  pend.confirmedAt = new Date().toISOString();
  savePending();
  return { userId: pend.userId, amountCents: gross, creditedCents: Math.min(credit, MAX_BALANCE_CENTS) };
}

/** Mark a pending top-up as failed/cancelled (no credit). */
export function failDeposit(reference) {
  const pend = pendingData.pending[reference];
  if (!pend || pend.status !== 'pending') return null;
  pend.status = 'failed';
  pend.confirmedAt = new Date().toISOString();
  savePending();
  return pend;
}

/** Re-read all money files from disk — call after Supabase sync on startup so
 *  restored wallets/pending/withdrawals/subscriptions are visible in memory. */
export function reloadMoneyFromDisk() {
  const freshSubs = readJson(SUBS_FILE, null);
  if (freshSubs && freshSubs.subscriptions && typeof freshSubs.subscriptions === 'object') {
    subsData = freshSubs;
    console.log(`[store] ✅ Subscriptions reloaded: ${Object.keys(subsData.subscriptions || {}).length}`);
  }
  const freshBal = readJson(BALANCES_FILE, null);
  if (freshBal && freshBal.balances && typeof freshBal.balances === 'object') {
    balancesData = freshBal;
    console.log(`[store] ✅ Balances reloaded: ${Object.keys(balancesData.balances || {}).length} wallets`);
  }
  const freshWd = readJson(WITHDRAWALS_FILE, null);
  if (freshWd && Array.isArray(freshWd.withdrawals)) {
    withdrawalsData = freshWd;
    console.log(`[store] ✅ Withdrawals reloaded: ${withdrawalsData.withdrawals.length}`);
  }
  const freshPend = readJson(PENDING_FILE, null);
  if (freshPend && freshPend.pending && typeof freshPend.pending === 'object') {
    pendingData = freshPend;
    console.log(`[store] ✅ Pending deposits reloaded: ${Object.keys(pendingData.pending || {}).length}`);
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  webusers.json — Web user accounts
// ══════════════════════════════════════════════════════════════════════════
let webUsersData = readJson(WEBUSERS_FILE, { users: {} });
function saveWebUsers() { writeJson(WEBUSERS_FILE, webUsersData); }

export function hashPassword(plain) {
  return crypto.createHash('sha256').update(plain + 'fundaplus_salt_2025').digest('hex');
}

const ALLOWED_EMAIL_DOMAINS = ['gmail.com','googlemail.com','outlook.com','hotmail.com','live.com','yahoo.com','yahoo.co.uk','icloud.com','me.com','protonmail.com','proton.me','zoho.com','aol.com','mail.com','yandex.com','msn.com'];

export function isEmailAllowed(email) {
  const domain = email.split('@')[1]?.toLowerCase();
  return domain && ALLOWED_EMAIL_DOMAINS.includes(domain);
}

export function createUser({ email, phone, password }) {
  const id = `u-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  if (email && !isEmailAllowed(email)) return { ok:false, error:'Only popular email providers allowed (Gmail, Outlook, Yahoo, iCloud, etc.)' };
  if (email) {
    const ex = Object.values(webUsersData.users).find(u => u.email?.toLowerCase() === email.toLowerCase());
    if (ex) return { ok:false, error:'Email already registered' };
  }
  if (phone) {
    const ex = Object.values(webUsersData.users).find(u => u.phone === phone);
    if (ex) return { ok:false, error:'Phone already registered' };
  }
  const user = {
    id, email:email||'', phone:phone||'',
    passwordHash: hashPassword(password),
    onboarded: false,
    name:'', surname:'', age:null, school:'',
    jid:null, pairLinkedAt:null,
    dashboardFirstAt:null,
    isAdmin: false,
    registeredAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  webUsersData.users[id] = user;
  saveWebUsers();
  return { ok:true, user };
}

export function verifyLogin({ email, phone, password }) {
  const hash = hashPassword(password);
  const users = Object.values(webUsersData.users);
  let user = null;
  if (email) user = users.find(u => u.email?.toLowerCase() === email.toLowerCase() && u.passwordHash === hash);
  if (!user && phone) user = users.find(u => u.phone === phone && u.passwordHash === hash);
  return user || null;
}

export function getWebUser(id) { return webUsersData.users[id] || null; }
export function saveWebUser(id, data) {
  if (!webUsersData.users[id]) return null;
  webUsersData.users[id] = { ...webUsersData.users[id], ...data, updatedAt:new Date().toISOString() };
  saveWebUsers();
  return webUsersData.users[id];
}
export function deleteWebUser(id) { delete webUsersData.users[id]; saveWebUsers(); }
export function findWebUserByJid(jid) { return Object.values(webUsersData.users).find(u=>u.jid===jid)||null; }
export function findWebUserByToken(token) { return Object.entries(webUsersData.users).find(([,u])=>u.pendingToken===token)||null; }
export function getAllWebUsers() { return webUsersData.users; }

// ══════════════════════════════════════════════════════════════════════════
//  store.json — Pairing / connection info
// ══════════════════════════════════════════════════════════════════════════
let storeData = readJson(STORE_FILE, { pairInfo:{} });
function saveStore() { writeJson(STORE_FILE, storeData); }
export function getPairInfo()     { return storeData.pairInfo||{}; }
export function savePairInfo(data){ storeData.pairInfo={...storeData.pairInfo,...data,updatedAt:new Date().toISOString()}; saveStore(); }

// ══════════════════════════════════════════════════════════════════════════
//  wa.json — Known WhatsApp JIDs
// ══════════════════════════════════════════════════════════════════════════
let waData = readJson(WA_FILE, { knownJids:[] });
function saveWa() { writeJson(WA_FILE, waData); }
export const knownJids = new Set(waData.knownJids||[]);
export function trackJid(jid) {
  if (!jid||(!jid.endsWith('@s.whatsapp.net')&&!jid.endsWith('@lid'))) return;
  if (!knownJids.has(jid)) { knownJids.add(jid); waData.knownJids=[...knownJids]; saveWa(); console.log(`📒 New contact: ${jid.split('@')[0]}`); }
}

// ── Usage tracking — extended for plan limits ──────────────────────────────
let usageData = readJson(USAGE_FILE, {});
function saveUsage() { writeJson(USAGE_FILE, usageData); }
function todayKey() { return new Date().toISOString().slice(0,10); }

function getEntry(uid) {
  const today=todayKey();
  if (!usageData[uid]||usageData[uid].date!==today) {
    usageData[uid]={
      date:today, chat:0, images:0, pdf:0, paperUploads:0,
      studySessions:0, quizzes:0, projectsTotal: usageData[uid]?.projectsTotal||0,
      paperDlWindows: usageData[uid]?.paperDlWindows||[],
    };
  }
  // Ensure new fields on existing entries
  if (usageData[uid].studySessions === undefined) usageData[uid].studySessions = 0;
  if (usageData[uid].quizzes      === undefined) usageData[uid].quizzes       = 0;
  if (usageData[uid].projectsTotal=== undefined) usageData[uid].projectsTotal = 0;
  if (!Array.isArray(usageData[uid].paperDlWindows)) usageData[uid].paperDlWindows = [];
  return usageData[uid];
}

// Paper download windows: array of { windowStart, count }
function getPaperDlCount(uid) {
  const e = getEntry(uid);
  const now = Date.now();
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  // Clean old windows
  e.paperDlWindows = e.paperDlWindows.filter(w => now - w.windowStart < SIX_HOURS);
  if (!e.paperDlWindows.length) e.paperDlWindows.push({ windowStart: now, count: 0 });
  return e.paperDlWindows[e.paperDlWindows.length - 1];
}

export function canDownloadPaper(uid, planLimits) {
  const window = getPaperDlCount(uid);
  return window.count < planLimits.paperDl;
}

export function incrementPaperDl(uid) {
  const e = getEntry(uid);
  const now = Date.now();
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  e.paperDlWindows = e.paperDlWindows.filter(w => now - w.windowStart < SIX_HOURS);
  if (!e.paperDlWindows.length) e.paperDlWindows.push({ windowStart: now, count: 0 });
  e.paperDlWindows[e.paperDlWindows.length - 1].count++;
  saveUsage();
}

export function incrementChatUsage(uid)  { const e=getEntry(uid); e.chat++;         saveUsage(); return true; }
export function incrementImageUsage(uid) { const e=getEntry(uid); e.images++;       saveUsage(); return true; }
export function incrementPdfUsage(uid)   { const e=getEntry(uid); e.pdf++;          saveUsage(); return true; }
export function incrementPaperUpload(uid){ const e=getEntry(uid); if(e.paperUploads>=PAPER_UPLOAD_LIMIT) return false; e.paperUploads++; saveUsage(); return true; }
export function incrementStudySession(uid){ const e=getEntry(uid); e.studySessions++; saveUsage(); }
export function incrementQuizUsage(uid)  { const e=getEntry(uid); e.quizzes++;      saveUsage(); }
export function incrementProjectUsage(uid){ const e=getEntry(uid); e.projectsTotal++; saveUsage(); }

export function getUsage(uid) {
  const e = getEntry(uid);
  return {
    chat: e.chat, images: e.images, pdf: e.pdf||0,
    studySessions: e.studySessions||0, quizzes: e.quizzes||0,
    projectsTotal: e.projectsTotal||0,
    paperUploads: e.paperUploads||0,
    paperDlWindows: e.paperDlWindows||[],
    chatLimit: DAILY_CHAT_LIMIT, imageLimit: DAILY_IMAGE_LIMIT, pdfLimit: DAILY_PDF_LIMIT,
  };
}

export function getFullUsage(uid) { return getEntry(uid); }

// ── Image Queue ────────────────────────────────────────────────────────────
let imageStore = readJson(IMAGES_FILE, { queue:[] });
function saveImages() { writeJson(IMAGES_FILE, imageStore); }
export function addImageJob(jid,prompt,model){ const job={id:`${Date.now()}-${Math.random().toString(36).slice(2,7)}`,jid,prompt,model:model||'Deliberate',status:'pending',startedAt:Date.now()}; imageStore.queue.push(job); saveImages(); return job; }
export function jidHasActiveJob(jid)  { return imageStore.queue.some(j=>j.jid===jid&&(j.status==='pending'||j.status==='generating')); }
export function getQueuePosition(jid) { const active=imageStore.queue.filter(j=>j.status==='pending'||j.status==='generating'); return active.findIndex(j=>j.jid===jid); }
export function updateImageJob(id,updates){ const job=imageStore.queue.find(j=>j.id===id); if(job){Object.assign(job,updates);saveImages();} return job; }
export function cleanImageQueue(){ const hr=Date.now()-3600_000; imageStore.queue=imageStore.queue.filter(j=>(j.status==='done'||j.status==='failed')?j.startedAt>hr:true); saveImages(); }

// ── Doc Jobs ───────────────────────────────────────────────────────────────
let docStore = readJson(DOC_FILE, { jobs:[] });
function saveDocStore() { writeJson(DOC_FILE, docStore); }
export function createDocJob(jid,type,title,remoteJobId){ const job={id:remoteJobId,jid,type,title,status:'processing',downloadUrl:null,error:null,requestedAt:new Date().toISOString(),updatedAt:new Date().toISOString()}; docStore.jobs.unshift(job); if(docStore.jobs.length>200) docStore.jobs=docStore.jobs.slice(0,200); saveDocStore(); return job; }
export function updateDocJob(id,patch){ const job=docStore.jobs.find(j=>j.id===id); if(!job) return null; Object.assign(job,patch,{updatedAt:new Date().toISOString()}); saveDocStore(); return job; }
export function getDocJob(id)             { return docStore.jobs.find(j=>j.id===id)||null; }
export function getDocJobsByJid(jid,n=10) { return docStore.jobs.filter(j=>j.jid===jid).slice(0,n); }
export function getAllDocJobs(n=50)        { return docStore.jobs.slice(0,n); }

// ── Messages per JID ───────────────────────────────────────────────────────
let msgStore = readJson(MESSAGES_FILE, {});
function saveMsgStore() { writeJson(MESSAGES_FILE, msgStore); }
export function recordMessage(jid,role,text){ if(!msgStore[jid]) msgStore[jid]=[]; msgStore[jid].push({role,text:text.slice(0,500),ts:Date.now()}); if(msgStore[jid].length>100) msgStore[jid]=msgStore[jid].slice(-100); saveMsgStore(); }
export function getMessages(jid,limit=50)  { return (msgStore[jid]||[]).slice(-limit); }
export function getAllMessageCounts()       { return Object.entries(msgStore).map(([jid,msgs])=>({jid,count:msgs.length})); }

// ── Past Papers ────────────────────────────────────────────────────────────
let papersStore = readJson(PAPERS_FILE, { papers:[],totalBytes:0 });
function savePapers() { writeJson(PAPERS_FILE, papersStore); }
export function addPaper(meta){ papersStore.papers.unshift({id:`p-${Date.now()}`,...meta,uploadedAt:new Date().toISOString()}); papersStore.totalBytes=(papersStore.totalBytes||0)+(meta.size||0); savePapers(); return papersStore.papers[0]; }
export function removePaper(id){ const idx=papersStore.papers.findIndex(p=>p.id===id); if(idx===-1) return false; papersStore.totalBytes=Math.max(0,(papersStore.totalBytes||0)-(papersStore.papers[idx].size||0)); papersStore.papers.splice(idx,1); savePapers(); return true; }
export function listPapersLocal()     { return papersStore.papers; }
export function getPapersTotalBytes() { return papersStore.totalBytes||0; }
export function getPaperById(id)      { return papersStore.papers.find(p=>p.id===id)||null; }

/** Re-read papers.json from disk — call after Supabase sync on startup so
 *  restored papers are visible in memory (otherwise listPapersLocal() is empty). */
export function reloadPapersFromDisk() {
  const fresh = readJson(PAPERS_FILE, null);
  if (fresh && Array.isArray(fresh.papers)) {
    papersStore = fresh;
    console.log(`[store] ✅ Papers reloaded from disk: ${papersStore.papers.length} papers`);
  }
}

// ── Wishlist ───────────────────────────────────────────────────────────────
let wishlist = readJson(WISHLIST_FILE, { upgrade:0,voters:[] });
function saveWishlist() { writeJson(WISHLIST_FILE, wishlist); }
export function addWishlistVote(uid){ if(wishlist.voters.includes(uid)) return wishlist.upgrade; wishlist.voters.push(uid); wishlist.upgrade++; saveWishlist(); return wishlist.upgrade; }
export function getWishlistCount()  { return wishlist.upgrade||0; }

// ══════════════════════════════════════════════════════════════════════════
//  Ban system
// ══════════════════════════════════════════════════════════════════════════
const BANS_FILE = path.join(DATA_DIR, 'bans.json');
let bansData = readJson(BANS_FILE, { bans: {} });
function saveBans() { writeJson(BANS_FILE, bansData); }

export function banUser(userId, reason, bannedBy = 'admin') {
  bansData.bans[userId] = {
    userId, reason: reason || 'No reason provided',
    bannedBy, bannedAt: new Date().toISOString(),
    appealStatus: 'none',
    appealMessage: '',
    appealAt: null,
    unbannedAt: null,
  };
  saveBans();
}

export function unbanUser(userId) {
  if (bansData.bans[userId]) {
    bansData.bans[userId].unbannedAt = new Date().toISOString();
    delete bansData.bans[userId];
    saveBans();
  }
}

export function getBan(userId)  { return bansData.bans[userId] || null; }
export function getAllBans()     { return bansData.bans; }
export function isBanned(userId){ return !!bansData.bans[userId]; }

export function submitAppeal(userId, message) {
  if (!bansData.bans[userId]) return false;
  bansData.bans[userId].appealStatus  = 'pending';
  bansData.bans[userId].appealMessage = message;
  bansData.bans[userId].appealAt      = new Date().toISOString();
  saveBans(); return true;
}

export function resolveAppeal(userId, decision) {
  if (!bansData.bans[userId]) return false;
  bansData.bans[userId].appealStatus = decision;
  if (decision === 'approved') unbanUser(userId);
  else saveBans();
  return true;
}

// ══════════════════════════════════════════════════════════════════════════
//  Support messages
// ══════════════════════════════════════════════════════════════════════════
let supportData = readJson(SUPPORT_FILE, { messages: [] });
function saveSupport() { writeJson(SUPPORT_FILE, supportData); }

export function addSupportMessage({ userId, name, email, subject, message }) {
  const msg = {
    id: `sup-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
    userId: userId || null, name, email, subject, message,
    createdAt: new Date().toISOString(),
    resolved: false,
  };
  supportData.messages.unshift(msg);
  if (supportData.messages.length > 1000) supportData.messages = supportData.messages.slice(0, 1000);
  saveSupport();
  return msg;
}

export function getAllSupportMessages() { return supportData.messages; }
export function resolveSupportMessage(id) {
  const m = supportData.messages.find(x => x.id === id);
  if (m) { m.resolved = true; saveSupport(); }
  return !!m;
}

// ══════════════════════════════════════════════════════════════════════════
//  Community messages
// ══════════════════════════════════════════════════════════════════════════
const COMMUNITY_FILE  = path.join(DATA_DIR, 'community.json');
const COMMUNITY_LIMIT = 5000;

let communityData = readJson(COMMUNITY_FILE, { messages: [] });
function saveCommunity() { writeJson(COMMUNITY_FILE, communityData); }

/** Re-read community.json from disk — call this after Supabase sync on startup
 *  so that communityData reflects the restored file, not the empty default. */
export function reloadCommunityFromDisk() {
  const fresh = readJson(COMMUNITY_FILE, null);
  if (fresh && Array.isArray(fresh.messages) && fresh.messages.length > communityData.messages.length) {
    communityData = fresh;
    console.log(`[store] ✅ Community reloaded from disk: ${communityData.messages.length} messages`);
  }
}

/** Re-read webusers.json from disk — call this after Supabase sync on startup. */
export function reloadWebUsersFromDisk() {
  const fresh = readJson(WEBUSERS_FILE, null);
  if (fresh && fresh.users && Object.keys(fresh.users).length > Object.keys(webUsersData.users).length) {
    webUsersData = fresh;
    console.log(`[store] ✅ WebUsers reloaded from disk: ${Object.keys(webUsersData.users).length} users`);
  }
}

/** Re-read messenger.json from disk — call this after Supabase sync on startup. */
export function reloadMessengerFromDisk() {
  const fresh = readJson(MESSENGER_FILE, null);
  if (fresh && fresh.settings) {
    messengerData = fresh;
    if (!Array.isArray(messengerData.pending)) messengerData.pending = [];
    console.log(`[store] ✅ Messenger reloaded from disk: ${Object.keys(messengerData.settings).length} settings, ${messengerData.pending.length} pending`);
  }
}

export function addCommunityMessage({ userId, name, text, replyTo = null, isAmbassador = false, isAdmin = false }) {
  const msg = {
    id: `cm-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
    userId, name, text: text.slice(0, 1000),
    replyTo,
    isAmbassador: !!isAmbassador,
    isAdmin: !!isAdmin,
    createdAt: new Date().toISOString(),
  };
  communityData.messages.push(msg);
  if (communityData.messages.length > COMMUNITY_LIMIT) {
    communityData.messages = communityData.messages.slice(-COMMUNITY_LIMIT);
  }
  saveCommunity();
  return msg;
}

export function getCommunityMessages(limit = 200) {
  return communityData.messages.slice(-limit);
}

export function deleteCommunityMessage(msgId, userId, isAdmin = false) {
  const idx = communityData.messages.findIndex(m => m.id === msgId);
  if (idx === -1) return false;
  if (!isAdmin && communityData.messages[idx].userId !== userId) return false;
  communityData.messages.splice(idx, 1);
  saveCommunity();
  return true;
}

export function getCommunityCount() { return communityData.messages.length; }

/** Toggle a like on a message. Returns updated likes array. */
export function toggleCommunityLike(msgId, userId) {
  const msg = communityData.messages.find(m => m.id === msgId);
  if (!msg) return null;
  if (!msg.likes) msg.likes = [];
  const idx = msg.likes.indexOf(userId);
  if (idx === -1) msg.likes.push(userId);
  else msg.likes.splice(idx, 1);
  saveCommunity();
  return msg.likes;
}

/** Get unread mention count for a userId */
export function getCommunityMentionCount(userId) {
  if (!communityData.mentionReads) communityData.mentionReads = {};
  const lastRead = communityData.mentionReads[userId] || '1970-01-01T00:00:00.000Z';
  return communityData.messages.filter(m =>
    m.mentions && m.mentions.includes(userId) && m.createdAt > lastRead
  ).length;
}

/** Mark mentions as read for a userId */
export function markCommunityMentionsRead(userId) {
  if (!communityData.mentionReads) communityData.mentionReads = {};
  communityData.mentionReads[userId] = new Date().toISOString();
  saveCommunity();
}

/** Store mention userIds in a message when posting */
export function setCommunityMessageMentions(msgId, mentionedUserIds) {
  const msg = communityData.messages.find(m => m.id === msgId);
  if (!msg) return;
  msg.mentions = mentionedUserIds;
  saveCommunity();
}

/** Get all users (minimal) so community can resolve @names to IDs */
export function getCommunityUserIndex() {
  // Returns lightweight array [{id, name}] from web users
  return []; // routes.js will handle this using getAllWebUsers
}

// ══════════════════════════════════════════════════════════════════════════
//  Promo / Free-Premium Links
// ══════════════════════════════════════════════════════════════════════════
const PROMO_FILE = path.join(DATA_DIR, 'promo_links.json');
let promoData = readJson(PROMO_FILE, { links: {} });
function savePromo() { writeJson(PROMO_FILE, promoData); }

/**
 * Create a promo link.
 * @param {object} opts
 * @param {string} opts.plan        - 'lite' | 'plus' | 'pro'
 * @param {number} opts.maxUses     - max number of redemptions (0 = unlimited)
 * @param {string|null} opts.expiresAt - ISO date string or null
 * @param {string} opts.note        - admin note / label
 * @returns {object} the new promo link record
 */
export function createPromoLink({ plan, maxUses = 1, expiresAt = null, note = '' }) {
  if (!PLANS[plan] || plan === 'free') throw new Error('Invalid plan');
  const code = crypto.randomBytes(10).toString('base64url').slice(0, 14);
  const link = {
    code,
    plan,
    maxUses: parseInt(maxUses) || 1,
    expiresAt: expiresAt || null,
    note: note || '',
    uses: 0,
    redeemedBy: [],
    createdAt: new Date().toISOString(),
    active: true,
  };
  promoData.links[code] = link;
  savePromo();
  return link;
}

export function getPromoLink(code) { return promoData.links[code] || null; }
export function getAllPromoLinks() { return promoData.links; }

export function deactivatePromoLink(code) {
  if (!promoData.links[code]) return false;
  promoData.links[code].active = false;
  savePromo();
  return true;
}

export function deletePromoLink(code) {
  if (!promoData.links[code]) return false;
  delete promoData.links[code];
  savePromo();
  return true;
}

/**
 * Attempt to redeem a promo link for a user.
 * Returns { ok, error?, plan? }
 */
export function redeemPromoLink(code, userId) {
  const link = promoData.links[code];
  if (!link)         return { ok: false, error: 'Invalid or expired link.' };
  if (!link.active)  return { ok: false, error: 'This link has been deactivated.' };
  if (link.expiresAt && new Date(link.expiresAt) < new Date())
    return { ok: false, error: 'This link has expired.' };
  if (link.maxUses > 0 && link.uses >= link.maxUses)
    return { ok: false, error: 'This link has reached its usage limit.' };
  if (link.redeemedBy.includes(userId))
    return { ok: false, error: 'You have already used this link.' };

  // Grant the subscription (30-day period)
  setUserSubscription(userId, link.plan, `promo:${code}`);

  link.uses += 1;
  link.redeemedBy.push(userId);
  if (link.maxUses > 0 && link.uses >= link.maxUses) link.active = false;
  savePromo();
  return { ok: true, plan: link.plan };
}

// ═══════════════════════════════════════════════════════════════════════════
//  ZIMSEC — Exams, Questions, Results  (JSON-backed)
// ═══════════════════════════════════════════════════════════════════════════

const ZIMSEC_EXAMS_FILE     = path.join(DATA_DIR, 'zimsec-exams.json');
const ZIMSEC_QUESTIONS_FILE = path.join(DATA_DIR, 'zimsec-questions.json');
const ZIMSEC_RESULTS_FILE   = path.join(DATA_DIR, 'zimsec-results.json');

function loadZimsecExams()     { try { return JSON.parse(fs.readFileSync(ZIMSEC_EXAMS_FILE,     'utf8')); } catch { return { exams: [] }; } }
function loadZimsecQuestions() { try { return JSON.parse(fs.readFileSync(ZIMSEC_QUESTIONS_FILE, 'utf8')); } catch { return { questions: [] }; } }
function loadZimsecResults()   { try { return JSON.parse(fs.readFileSync(ZIMSEC_RESULTS_FILE,   'utf8')); } catch { return { results: [] }; } }
function saveZimsecExams(d)     { fs.mkdirSync(DATA_DIR,{recursive:true}); fs.writeFileSync(ZIMSEC_EXAMS_FILE,     JSON.stringify(d, null, 2)); }
function saveZimsecQuestions(d) { fs.mkdirSync(DATA_DIR,{recursive:true}); fs.writeFileSync(ZIMSEC_QUESTIONS_FILE, JSON.stringify(d, null, 2)); }
function saveZimsecResults(d)   { fs.mkdirSync(DATA_DIR,{recursive:true}); fs.writeFileSync(ZIMSEC_RESULTS_FILE,   JSON.stringify(d, null, 2)); }

// ── Exams ──────────────────────────────────────────────────────────────────
export function getAllZimsecExams() { return loadZimsecExams().exams; }

export function getZimsecExam(id) {
  return loadZimsecExams().exams.find(e => e.id === id) || null;
}

export function createZimsecExam({ title, subject, level, year, description, scheduledAt, durationMins, createdBy }) {
  const d = loadZimsecExams();
  const durMins = parseInt(durationMins) || 60;
  // Compute examEndsAt = scheduledAt + durationMins
  let examEndsAt = null;
  if (scheduledAt) {
    examEndsAt = new Date(new Date(scheduledAt).getTime() + durMins * 60_000).toISOString();
  }
  const exam = {
    id: 'exam_' + Date.now() + '_' + Math.random().toString(36).slice(2,7),
    title, subject, level: level || 'O-Level',
    year: year || new Date().getFullYear(),
    description: description || '',
    scheduledAt: scheduledAt || null,
    examEndsAt,
    durationMins: durMins,
    active: true,
    createdBy: createdBy || 'admin',
    createdAt: new Date().toISOString(),
  };
  d.exams.push(exam);
  saveZimsecExams(d);
  return exam;
}

export function updateZimsecExam(id, updates) {
  const d = loadZimsecExams();
  const idx = d.exams.findIndex(e => e.id === id);
  if (idx < 0) return null;
  const merged = { ...d.exams[idx], ...updates, id, updatedAt: new Date().toISOString() };
  // Recalculate examEndsAt whenever scheduledAt or durationMins changes
  if (merged.scheduledAt) {
    const durMins = parseInt(merged.durationMins) || 60;
    merged.examEndsAt = new Date(new Date(merged.scheduledAt).getTime() + durMins * 60_000).toISOString();
    merged.durationMins = durMins;
  } else {
    merged.examEndsAt = null;
  }
  d.exams[idx] = merged;
  saveZimsecExams(d);
  return d.exams[idx];
}

export function deleteZimsecExam(id) {
  const d = loadZimsecExams();
  const before = d.exams.length;
  d.exams = d.exams.filter(e => e.id !== id);
  if (d.exams.length === before) return false;
  saveZimsecExams(d);
  return true;
}

// ── Questions ──────────────────────────────────────────────────────────────
export function getAllZimsecQuestions(examId) {
  const d = loadZimsecQuestions();
  return (d.questions || []).filter(q => q.examId === examId).sort((a,b) => (a.order||0)-(b.order||0));
}

export function getZimsecQuestion(id) {
  return loadZimsecQuestions().questions.find(q => q.id === id) || null;
}

export function createZimsecQuestion({ examId, text, type, options, answer, explanation, marks, order }) {
  const d = loadZimsecQuestions();
  d.questions = d.questions || [];
  const q = {
    id: 'q_' + Date.now() + '_' + Math.random().toString(36).slice(2,7),
    examId, text, type: type || 'mcq',
    options: options || [],
    answer,                    // correct option letter/index for mcq; model answer text for sa
    explanation: explanation || '',
    marks: parseInt(marks) || 1,
    order: parseInt(order) || d.questions.filter(x => x.examId === examId).length,
    createdAt: new Date().toISOString(),
  };
  d.questions.push(q);
  saveZimsecQuestions(d);
  return q;
}

export function updateZimsecQuestion(id, updates) {
  const d = loadZimsecQuestions();
  const idx = d.questions.findIndex(q => q.id === id);
  if (idx < 0) return null;
  d.questions[idx] = { ...d.questions[idx], ...updates, id };
  saveZimsecQuestions(d);
  return d.questions[idx];
}

export function deleteZimsecQuestion(id) {
  const d = loadZimsecQuestions();
  const before = (d.questions||[]).length;
  d.questions = (d.questions||[]).filter(q => q.id !== id);
  if (d.questions.length === before) return false;
  saveZimsecQuestions(d);
  return true;
}

export function deleteZimsecQuestionsByExam(examId) {
  const d = loadZimsecQuestions();
  d.questions = (d.questions||[]).filter(q => q.examId !== examId);
  saveZimsecQuestions(d);
}

// ── Results ────────────────────────────────────────────────────────────────
export function getAllZimsecResults() { return loadZimsecResults().results || []; }

export function getUserZimsecResults(userId) {
  return (loadZimsecResults().results||[]).filter(r => r.userId === userId);
}

export function getExamZimsecResults(examId) {
  return (loadZimsecResults().results||[]).filter(r => r.examId === examId);
}

export function submitZimsecResult({ userId, examId, answers, score, total, timeTaken }) {
  const d = loadZimsecResults();
  d.results = d.results || [];
  const pct = total > 0 ? Math.round((score / total) * 100) : 0;
  const result = {
    id: 'res_' + Date.now() + '_' + Math.random().toString(36).slice(2,7),
    userId, examId, answers, score, total, pct,
    timeTaken: parseInt(timeTaken) || 0,
    submittedAt: new Date().toISOString(),
  };
  d.results.push(result);
  saveZimsecResults(d);
  return result;
}

export function deleteZimsecResult(id) {
  const d = loadZimsecResults();
  const before = (d.results||[]).length;
  d.results = (d.results||[]).filter(r => r.id !== id);
  if (d.results.length === before) return false;
  saveZimsecResults(d);
  return true;
}

export function getZimsecLeaderboard(examId, limit = 50) {
  let results = loadZimsecResults().results || [];
  if (examId) results = results.filter(r => r.examId === examId);
  // Best attempt per user per exam
  const best = {};
  for (const r of results) {
    const key = r.userId + '_' + r.examId;
    if (!best[key] || r.pct > best[key].pct) best[key] = r;
  }
  return Object.values(best)
    .sort((a, b) => b.pct - a.pct || a.timeTaken - b.timeTaken)
    .slice(0, limit);
}

// ── Parse .txt exam file into questions ────────────────────────────────────
export function parseZimsecTxt(content) {
  const lines = content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  const questions = [];
  let cur = null;

  for (const line of lines) {
    if (/^Q\s*:/i.test(line)) {
      if (cur) questions.push(cur);
      cur = { type: 'mcq', text: line.replace(/^Q\s*:\s*/i,'').trim(), options: [], answer: null };
    } else if (/^SA\s*:/i.test(line)) {
      if (cur) questions.push(cur);
      cur = { type: 'sa', text: line.replace(/^SA\s*:\s*/i,'').trim(), options: [], answer: '' };
    } else if (cur && /^ANS\s*:/i.test(line)) {
      cur.answer = line.replace(/^ANS\s*:\s*/i,'').trim().toUpperCase();
    } else if (cur && cur.type === 'mcq') {
      // Options: "A: text  B: text  C: text  D: text" on one line or separate "A: text"
      const parts = line.split(/(?=[A-D]\s*:)/i);
      parts.forEach(p => {
        const m = p.match(/^([A-D])\s*:\s*(.+)/i);
        if (m) cur.options.push({ letter: m[1].toUpperCase(), text: m[2].trim() });
      });
    } else if (cur && cur.type === 'sa' && /^MODEL\s*:/i.test(line)) {
      cur.answer = line.replace(/^MODEL\s*:\s*/i,'').trim();
    }
  }
  if (cur) questions.push(cur);
  return questions;
}

// ── Exam unlock (subscriber self-serve, 3-day window) ─────────────────────────
// Stored in usage.json per user: examUnlocks: { examId: { unlockedAt } }

const EXAM_WINDOW_MS = 3 * 24 * 3600 * 1000; // 3 days

export function unlockExamForUser(uid, examId) {
  const e = getEntry(uid);
  if (!e.examUnlocks) e.examUnlocks = {};
  if (e.examUnlocks[examId]) return e.examUnlocks[examId]; // already unlocked
  e.examUnlocks[examId] = { unlockedAt: new Date().toISOString() };
  saveUsage();
  return e.examUnlocks[examId];
}

export function getExamUnlock(uid, examId) {
  const e = getEntry(uid);
  return (e.examUnlocks || {})[examId] || null;
}

export function isExamWindowOpen(uid, examId) {
  const unlock = getExamUnlock(uid, examId);
  if (!unlock) return false;
  return Date.now() - new Date(unlock.unlockedAt).getTime() < EXAM_WINDOW_MS;
}

export function getExamWindowExpiry(uid, examId) {
  const unlock = getExamUnlock(uid, examId);
  if (!unlock) return null;
  return new Date(new Date(unlock.unlockedAt).getTime() + EXAM_WINDOW_MS).toISOString();
}

// ══════════════════════════════════════════════════════════════════════════
//  Notifications
// ══════════════════════════════════════════════════════════════════════════
const NOTIFICATIONS_FILE  = path.join(DATA_DIR, 'notifications.json');
const NOTIF_READS_FILE    = path.join(DATA_DIR, 'notif_reads.json');
const PUSH_SUBS_FILE      = path.join(DATA_DIR, 'push_subscriptions.json');

function loadNotifications() { return readJson(NOTIFICATIONS_FILE, { notifications: [] }); }
function saveNotifications(d) { writeJson(NOTIFICATIONS_FILE, d); }
function loadNotifReads()     { return readJson(NOTIF_READS_FILE, { reads: {} }); }
function saveNotifReads(d)    { writeJson(NOTIF_READS_FILE, d); }

// Push subscriptions — keyed by userId, value is array of subscription objects
function loadPushSubs() { return readJson(PUSH_SUBS_FILE, { subs: {} }); }
function savePushSubs(d) { writeJson(PUSH_SUBS_FILE, d); }

export function savePushSubscription(userId, subscription) {
  const d = loadPushSubs();
  if (!d.subs[userId]) d.subs[userId] = [];
  // Deduplicate by endpoint
  const endpoint = subscription.endpoint;
  d.subs[userId] = d.subs[userId].filter(s => s.endpoint !== endpoint);
  d.subs[userId].push(subscription);
  savePushSubs(d);
}

export function removePushSubscription(userId, endpoint) {
  const d = loadPushSubs();
  if (d.subs[userId]) {
    d.subs[userId] = d.subs[userId].filter(s => s.endpoint !== endpoint);
    savePushSubs(d);
  }
}

export function getPushSubscriptionsForUsers(userIds) {
  const d = loadPushSubs();
  const result = [];
  for (const uid of userIds) {
    if (d.subs[uid]) result.push(...d.subs[uid]);
  }
  return result;
}

export function getAllPushSubscriptions() {
  const d = loadPushSubs();
  const result = [];
  for (const uid of Object.keys(d.subs)) {
    result.push(...d.subs[uid]);
  }
  return result;
}

export function createNotification({ type, title, description, bgImage, target, targetEmails }) {
  const d = loadNotifications();
  const notif = {
    id:           'notif_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    type:         type || 'silent',           // 'silent' | 'popup'
    title:        title || '',
    description:  description || '',
    bgImage:      bgImage || null,            // null = default (white)
    target:       target || 'all',            // 'all' | 'single' | 'multiple'
    targetEmails: targetEmails || [],         // used when target !== 'all'
    createdAt:    new Date().toISOString(),
    active:       true,
  };
  d.notifications.unshift(notif);
  if (d.notifications.length > 1000) d.notifications = d.notifications.slice(0, 1000);
  saveNotifications(d);
  return notif;
}

export function getAllNotifications() { return loadNotifications().notifications; }
export function deleteNotification(id) {
  const d = loadNotifications();
  const before = d.notifications.length;
  d.notifications = d.notifications.filter(n => n.id !== id);
  if (d.notifications.length === before) return false;
  saveNotifications(d);
  return true;
}

// Returns notifications visible to a user (checks target)
export function getNotificationsForUser(userId, userEmail) {
  const all = loadNotifications().notifications.filter(n => n.active);
  return all.filter(n => {
    if (n.target === 'all') return true;
    if (!userEmail) return false;
    const emails = (n.targetEmails || []).map(e => e.toLowerCase().trim());
    return emails.includes((userEmail || '').toLowerCase().trim());
  });
}

// Mark a specific notification as read for a user
export function markNotificationRead(userId, notifId) {
  const d = loadNotifReads();
  if (!d.reads[userId]) d.reads[userId] = [];
  if (!d.reads[userId].includes(notifId)) {
    d.reads[userId].push(notifId);
    saveNotifReads(d);
  }
}

// Get set of read notif IDs for a user
export function getReadNotifIds(userId) {
  const d = loadNotifReads();
  return new Set(d.reads[userId] || []);
}

// Returns unread notifications for a user
export function getUnreadNotificationsForUser(userId, userEmail) {
  const visible = getNotificationsForUser(userId, userEmail);
  const read    = getReadNotifIds(userId);
  return visible.filter(n => !read.has(n.id));
}

// ══════════════════════════════════════════════════════════════════════════
//  AMBASSADORS  (JSON-backed)
// ══════════════════════════════════════════════════════════════════════════

const AMBASSADORS_FILE = path.join(DATA_DIR, 'ambassadors.json');
function loadAmbassadors() { return readJson(AMBASSADORS_FILE, { ambassadors: [] }); }
function saveAmbassadors(d) { writeJson(AMBASSADORS_FILE, d); }

/**
 * Add a user as an ambassador by email.
 * Also flips isAmbassador on their webuser record if found.
 */
export function addAmbassador({ email, addedBy = 'admin', note = '' }) {
  const d = loadAmbassadors();
  if (d.ambassadors.find(a => a.email.toLowerCase() === email.toLowerCase()))
    return { ok: false, error: 'Already an ambassador' };

  const entry = {
    id: 'amb_' + Date.now() + '_' + Math.random().toString(36).slice(2,6),
    email: email.toLowerCase().trim(),
    addedBy,
    note,
    addedAt: new Date().toISOString(),
    active: true,
  };
  d.ambassadors.push(entry);
  saveAmbassadors(d);

  // Flip flag on existing webuser
  const user = Object.values(webUsersData.users).find(u => u.email?.toLowerCase() === email.toLowerCase());
  if (user) { user.isAmbassador = true; user.updatedAt = new Date().toISOString(); saveWebUsers(); }

  return { ok: true, ambassador: entry };
}

export function removeAmbassador(id) {
  const d = loadAmbassadors();
  const idx = d.ambassadors.findIndex(a => a.id === id);
  if (idx === -1) return false;
  const email = d.ambassadors[idx].email;
  d.ambassadors.splice(idx, 1);
  saveAmbassadors(d);
  // Remove flag from webuser
  const user = Object.values(webUsersData.users).find(u => u.email?.toLowerCase() === email.toLowerCase());
  if (user) { user.isAmbassador = false; user.updatedAt = new Date().toISOString(); saveWebUsers(); }
  return true;
}

export function updateAmbassador(id, updates) {
  const d = loadAmbassadors();
  const idx = d.ambassadors.findIndex(a => a.id === id);
  if (idx === -1) return null;
  d.ambassadors[idx] = { ...d.ambassadors[idx], ...updates, id, updatedAt: new Date().toISOString() };
  saveAmbassadors(d);
  return d.ambassadors[idx];
}

export function getAllAmbassadors() { return loadAmbassadors().ambassadors; }
export function getAmbassadorByEmail(email) {
  return loadAmbassadors().ambassadors.find(a => a.email.toLowerCase() === email.toLowerCase() && a.active) || null;
}
export function isAmbassador(emailOrId) {
  const d = loadAmbassadors();
  return d.ambassadors.some(a => a.active && (a.email.toLowerCase() === emailOrId.toLowerCase() || a.id === emailOrId));
}

// Ambassador exams — stored separately so they show "Ambassador's Test" branding
// They use the same zimsec-exams store but tagged with createdBy = 'ambassador:<userId>'
// Grace window = 7 days (vs 3 days for admin exams)
export const AMBASSADOR_EXAM_WINDOW_MS = 7 * 24 * 3600 * 1000;

export function isAmbassadorExam(exam) {
  return typeof exam?.createdBy === 'string' && exam.createdBy.startsWith('ambassador:');
}

export function getAmbassadorExamWindowExpiry(uid, examId) {
  const unlock = getExamUnlock(uid, examId);
  if (!unlock) return null;
  return new Date(new Date(unlock.unlockedAt).getTime() + AMBASSADOR_EXAM_WINDOW_MS).toISOString();
}

export function isAmbassadorExamWindowOpen(uid, examId) {
  const unlock = getExamUnlock(uid, examId);
  if (!unlock) return false;
  return Date.now() - new Date(unlock.unlockedAt).getTime() < AMBASSADOR_EXAM_WINDOW_MS;
}

// ══════════════════════════════════════════════════════════════════════════
//  AMBASSADOR REFERRALS
// ══════════════════════════════════════════════════════════════════════════

/** Generate a short unique referral code for an ambassador */
function genRefCode(email) {
  const base = email.split('@')[0].replace(/[^a-z0-9]/gi, '').slice(0, 6).toLowerCase();
  const rand  = Math.random().toString(36).slice(2, 5);
  return `${base}${rand}`;
}

/** Ensure every ambassador has a referralCode; call on read */
function ensureRefCode(amb) {
  if (!amb.referralCode) {
    amb.referralCode = genRefCode(amb.email);
    amb.referrals = amb.referrals || [];
  }
  return amb;
}

export function getAmbassadorByCode(code) {
  const d = loadAmbassadors();
  return d.ambassadors.find(a => a.referralCode === code && a.active) || null;
}

export function recordReferral(ambassadorId, newUserId, newUserEmail) {
  const d = loadAmbassadors();
  const idx = d.ambassadors.findIndex(a => a.id === ambassadorId);
  if (idx === -1) return;
  if (!d.ambassadors[idx].referrals) d.ambassadors[idx].referrals = [];
  // Avoid duplicates
  if (d.ambassadors[idx].referrals.some(r => r.userId === newUserId)) return;
  d.ambassadors[idx].referrals.push({
    userId: newUserId,
    email:  newUserEmail,
    joinedAt: new Date().toISOString(),
  });
  saveAmbassadors(d);
}

/** Get all ambassadors, ensuring each has a referral code */
export function getAllAmbassadorsWithCodes() {
  const d = loadAmbassadors();
  let changed = false;
  d.ambassadors = d.ambassadors.map(a => {
    const before = a.referralCode;
    ensureRefCode(a);
    if (!before) changed = true;
    return a;
  });
  if (changed) saveAmbassadors(d);
  return d.ambassadors;
}

/** Get ambassador entry with code, ensuring code exists */
export function getAmbassadorByEmailWithCode(email) {
  const d = loadAmbassadors();
  const idx = d.ambassadors.findIndex(a => a.email.toLowerCase() === email.toLowerCase() && a.active);
  if (idx === -1) return null;
  const before = d.ambassadors[idx].referralCode;
  ensureRefCode(d.ambassadors[idx]);
  if (!before) saveAmbassadors(d);
  return d.ambassadors[idx];
}

// ══════════════════════════════════════════════════════════════════════════
//  Messenger — DMs stored server-side until delivered, then deleted
//  Community messages stored in community.json (already exists above)
//  Individual chat history stored in localStorage on client only
// ══════════════════════════════════════════════════════════════════════════
const MESSENGER_FILE = path.join(DATA_DIR, 'messenger.json');
// { settings: { [userId]: { username, bio, profilePublic, profilePicUrl, bgType, bgUrl, blocked: [userId] } },
//   pending: [ { id, from, to, text, sentAt, expiresAt, readAt } ] }
let messengerData = readJson(MESSENGER_FILE, { settings: {}, pending: [] });
function saveMessenger() { writeJson(MESSENGER_FILE, messengerData); }

// Prune expired pending messages (older than 2 months)
export function pruneExpiredMessages() {
  const cutoff = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(); // 60 days
  const before = messengerData.pending.length;
  messengerData.pending = messengerData.pending.filter(m => m.sentAt > cutoff);
  if (messengerData.pending.length !== before) saveMessenger();
}

// ── Messenger Settings ──────────────────────────────────────────────────
export function getMessengerSettings(userId) {
  return messengerData.settings[userId] || {
    username: '', bio: '', profilePublic: false, profilePicUrl: '',
    bgType: 'default', bgUrl: '', blocked: [],
  };
}

export function saveMessengerSettings(userId, patch) {
  const current = getMessengerSettings(userId);
  messengerData.settings[userId] = { ...current, ...patch };
  saveMessenger();
  return messengerData.settings[userId];
}

export function blockUser(userId, targetId) {
  const s = getMessengerSettings(userId);
  if (!s.blocked) s.blocked = [];
  if (!s.blocked.includes(targetId)) s.blocked.push(targetId);
  messengerData.settings[userId] = s;
  saveMessenger();
}

export function unblockUser(userId, targetId) {
  const s = getMessengerSettings(userId);
  if (!s.blocked) s.blocked = [];
  s.blocked = s.blocked.filter(id => id !== targetId);
  messengerData.settings[userId] = s;
  saveMessenger();
}

export function isBlocked(userId, targetId) {
  const s = getMessengerSettings(userId);
  return (s.blocked || []).includes(targetId);
}

// ── Search users by name or email (all users are searchable) ─────────────
export function searchPublicUsers(query) {
  query = (query || '').toLowerCase().trim();
  if (!query || query.length < 2) return [];
  const users = Object.values(webUsersData.users);
  return users
    .filter(u => {
      const s = messengerData.settings[u.id] || {};
      const displayName = s.username || `${u.name || ''} ${u.surname || ''}`.trim();
      return (
        displayName.toLowerCase().includes(query) ||
        (u.email || '').toLowerCase().includes(query)
      );
    })
    .map(u => {
      const s = messengerData.settings[u.id] || {};
      return {
        id: u.id,
        displayName: s.username || `${u.name || ''} ${u.surname || ''}`.trim() || u.email,
        profilePicUrl: s.profilePicUrl || '',
        email: u.email,
      };
    })
    .slice(0, 10);
}

// Find user by email (for starting a chat by email)
export function findUserByEmail(email) {
  const u = Object.values(webUsersData.users).find(u => u.email?.toLowerCase() === email.toLowerCase());
  if (!u) return null;
  const s = messengerData.settings[u.id] || {};
  return {
    id: u.id,
    displayName: s.username || `${u.name} ${u.surname || ''}`.trim() || u.email,
    profilePicUrl: s.profilePicUrl || '',
    email: u.email,
  };
}

// Get minimal user info for a list of user IDs (for building inbox contact list)
export function getUserInfoBulk(userIds) {
  return userIds.map(id => {
    const u = webUsersData.users[id];
    if (!u) return { id, displayName: 'Unknown', profilePicUrl: '', email: '' };
    const s = messengerData.settings[id] || {};
    return {
      id,
      displayName: s.username || `${u.name} ${u.surname || ''}`.trim() || u.email,
      profilePicUrl: s.profilePicUrl || '',
      email: u.email,
    };
  });
}

// ── Pending messages (server stores until recipient fetches) ─────────────
export function storePendingMessage({ from, to, text, clientId }) {
  const msg = {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
    clientId: clientId || null,
    from, to, text: text.slice(0, 5000),
    sentAt: new Date().toISOString(),
    status: 'sent',           // sent → delivered → read
    expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
  };
  messengerData.pending.push(msg);
  saveMessenger();
  return msg;
}

// Fetch and drain pending messages for a recipient (delete after fetch)
export function drainPendingMessages(toUserId) {
  const msgs = messengerData.pending.filter(m => m.to === toUserId);
  messengerData.pending = messengerData.pending.filter(m => m.to !== toUserId);
  if (msgs.length) saveMessenger();
  return msgs;
}

// Mark a specific message as delivered (when recipient receives it)
export function markMessageDelivered(msgId) {
  const msg = messengerData.pending.find(m => m.id === msgId);
  if (msg) {
    msg.status = 'delivered';
    msg.deliveredAt = new Date().toISOString();
    saveMessenger();
    return true;
  }
  return false;
}

// Mark all messages from a sender as read (when recipient opens chat)
export function markMessagesRead(fromUserId, toUserId) {
  let changed = false;
  messengerData.pending.forEach(msg => {
    if (msg.from === fromUserId && msg.to === toUserId && msg.status !== 'read') {
      msg.status = 'read';
      msg.readAt = new Date().toISOString();
      changed = true;
    }
  });
  if (changed) saveMessenger();
  return changed;
}

// Peek pending (for badge count) without draining
export function countPendingMessages(toUserId) {
  return messengerData.pending.filter(m => m.to === toUserId).length;
}

// Count pending per sender for badge numbers in inbox
export function countPendingBySender(toUserId) {
  const counts = {};
  messengerData.pending.filter(m => m.to === toUserId).forEach(m => {
    counts[m.from] = (counts[m.from] || 0) + 1;
  });
  return counts;
}

// ══════════════════════════════════════════════════════════════════════════
//  Startup reload — re-read remaining module-level stores from disk after the
//  Supabase pull, so restored data is visible in memory (not just on disk).
// ══════════════════════════════════════════════════════════════════════════
export function reloadRemainingFromDisk() {
  const freshProof = readJson(path.join(DATA_DIR, 'proofmeta.json'), null);
  if (freshProof && Array.isArray(freshProof.proofs)) {
    proofMeta = freshProof;
    console.log(`[store] ✅ Proofs reloaded: ${proofMeta.proofs.length}`);
  }

  const freshStore = readJson(STORE_FILE, null);
  if (freshStore && freshStore.pairInfo && typeof freshStore.pairInfo === 'object') {
    storeData = freshStore;
    console.log('[store] ✅ Pair info reloaded');
  }

  const freshWa = readJson(WA_FILE, null);
  if (freshWa && Array.isArray(freshWa.knownJids)) {
    waData = freshWa;
    knownJids.clear();
    waData.knownJids.forEach(j => knownJids.add(j));
    console.log(`[store] ✅ WhatsApp JIDs reloaded: ${knownJids.size}`);
  }

  const freshUsage = readJson(USAGE_FILE, null);
  if (freshUsage && typeof freshUsage === 'object' && !Array.isArray(freshUsage)) {
    usageData = freshUsage;
    console.log(`[store] ✅ Usage reloaded: ${Object.keys(usageData).length} users`);
  }

  const freshImages = readJson(IMAGES_FILE, null);
  if (freshImages && Array.isArray(freshImages.queue)) {
    imageStore = freshImages;
    console.log(`[store] ✅ Image queue reloaded: ${imageStore.queue.length}`);
  }

  const freshDocs = readJson(DOC_FILE, null);
  if (freshDocs && Array.isArray(freshDocs.jobs)) {
    docStore = freshDocs;
    console.log(`[store] ✅ Doc jobs reloaded: ${docStore.jobs.length}`);
  }

  const freshMsg = readJson(MESSAGES_FILE, null);
  if (freshMsg && typeof freshMsg === 'object' && !Array.isArray(freshMsg)) {
    msgStore = freshMsg;
    console.log(`[store] ✅ Message history reloaded: ${Object.keys(msgStore).length} chats`);
  }

  const freshWish = readJson(WISHLIST_FILE, null);
  if (freshWish && typeof freshWish === 'object') {
    wishlist = { upgrade: 0, voters: [], ...freshWish };
    console.log(`[store] ✅ Wishlist reloaded: ${wishlist.upgrade} votes`);
  }

  const freshBans = readJson(BANS_FILE, null);
  if (freshBans && freshBans.bans && typeof freshBans.bans === 'object') {
    bansData = freshBans;
    console.log(`[store] ✅ Bans reloaded: ${Object.keys(bansData.bans || {}).length} active`);
  }

  const freshSupport = readJson(SUPPORT_FILE, null);
  if (freshSupport && Array.isArray(freshSupport.messages)) {
    supportData = freshSupport;
    console.log(`[store] ✅ Support messages reloaded: ${supportData.messages.length}`);
  }

  const freshPromo = readJson(PROMO_FILE, null);
  if (freshPromo && freshPromo.links && typeof freshPromo.links === 'object') {
    promoData = freshPromo;
    console.log(`[store] ✅ Promo links reloaded: ${Object.keys(promoData.links || {}).length}`);
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  Recent logins — IN-MEMORY ONLY (deliberately not persisted / no Supabase).
//  A rolling log of the last N successful web logins, for admin visibility.
// ══════════════════════════════════════════════════════════════════════════
const MAX_LOGINS = 300;
let loginLog = []; // [{ id, userId, email, phone, name, at, ip, ua }]

export function recordLogin(user, meta = {}) {
  if (!user) return;
  const name = `${user.name || ''} ${user.surname || ''}`.trim();
  loginLog.unshift({
    id:     `lg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    userId: user.id,
    email:  user.email || '',
    phone:  user.phone || '',
    name:   name || '',
    onboarded: !!user.onboarded,
    plan:   getUserPlan(user.id),
    at:     new Date().toISOString(),
    ip:     meta.ip || '',
    ua:     meta.ua || '',
  });
  if (loginLog.length > MAX_LOGINS) loginLog.length = MAX_LOGINS;
}

export function getRecentLogins(limit = 100) {
  return loginLog.slice(0, limit);
}

export function getLoginCount() { return loginLog.length; }
