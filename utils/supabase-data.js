import { createClient } from '@supabase/supabase-js';
import fs     from 'fs';
import path   from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { WebSocket } from 'ws';

// Node 20 does not expose WebSocket globally — Supabase Realtime needs it.
if (typeof globalThis.WebSocket === 'undefined') {
  globalThis.WebSocket = WebSocket;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = path.join(__dirname, '..', 'data');

const URL  = process.env.SUPABASE_DATA_URL  || process.env.SUPABASE_URL;
const KEY  =
  process.env.SUPABASE_DATA_SERVICE_KEY     ||
  process.env.SUPABASE_DATA_ANON_KEY        ||
  process.env.SUPABASE_DATA_KEY             ||
  process.env.SUPABASE_SERVICE_KEY          ||
  process.env.SUPABASE_SERVICE_ROLE_KEY     ||
  process.env.SUPABASE_ANON_KEY             ||
  process.env.SUPABASE_KEY;
const BUCKET = process.env.SUPABASE_DATA_BUCKET || 'prok-ai-data';

const LIMIT_BYTES = 800 * 1024 * 1024; // 800 MB hard cap

if (!URL)  console.error('[Supabase:Data] ❌ SUPABASE_DATA_URL not set — sync disabled');
else if (!KEY) console.error('[Supabase:Data] ❌ No key found. Set SUPABASE_DATA_SERVICE_KEY — sync disabled');
else console.log(`[Supabase:Data] ✅ Configured — ${URL.slice(0, 45)} | bucket: ${BUCKET}`);

let _client = null;
function getClient() {
  if (_client) return _client;
  if (!URL || !KEY) return null;
  try {
    _client = createClient(URL, KEY, { auth: { persistSession: false } });
    return _client;
  } catch (e) {
    console.error('[Supabase:Data] createClient failed:', e.message);
    return null;
  }
}

let _bucketReady = false;
async function ensureBucket() {
  if (_bucketReady) return;
  const sb = getClient(); if (!sb) return;
  const { error } = await sb.storage.createBucket(BUCKET, { public: false });
  if (error && !error.message.includes('already exists'))
    console.warn(`[Supabase:Data] createBucket:`, error.message);
  _bucketReady = true;
}

async function getUsedBytes() {
  const sb = getClient(); if (!sb) return 0;
  try {
    const { data, error } = await sb.storage.from(BUCKET).list('', { limit: 10000 });
    if (error || !data) return 0;
    return data.reduce((sum, f) => sum + (f.metadata?.size || 0), 0);
  } catch { return 0; }
}

export async function checkDataCapacity(incomingBytes = 0) {
  const used = await getUsedBytes();
  const available = LIMIT_BYTES - used;
  return {
    used,
    available,
    limitBytes: LIMIT_BYTES,
    usedMB: Math.round(used / 1024 / 1024 * 10) / 10,
    availableMB: Math.round(available / 1024 / 1024 * 10) / 10,
    limitMB: 800,
    withinLimit: available >= incomingBytes,
    pct: Math.min(100, Math.round((used / LIMIT_BYTES) * 1000) / 10),
  };
}

export const MANAGED_FILES = [
  'webusers.json', 'subscriptions.json', 'support.json', 'bans.json',
  'store.json', 'usage.json', 'images.json', 'pdf.json',
  'synced.json', 'premium.json', 'doc.json', 'messages.json',
  'papers.json', 'wishlist.json', 'community.json', 'messenger.json', 'promo_links.json',
  // App sessions & app config — synced so they survive redeploys
  'app.json', 'sessions.json',
  // ZIMSEC exam data — synced so exams/questions/results survive server crashes
  'zimsec-exams.json', 'zimsec-questions.json', 'zimsec-results.json',
  // Notifications & push subscriptions — survive redeploys
  'notifications.json', 'notif_reads.json', 'push_subscriptions.json',
  // Ambassador system — referral links, referrals, exam perms
  'ambassadors.json',
  // WhatsApp pairing state
  'wa.json',
  // Payment proof metadata
  'proofmeta.json',
  // Wallet / money system — balances, in-flight top-ups, withdrawals
  'balances.json', 'pending_deposits.json', 'withdrawals.json',
  // SMTP / mail (admin-configured)
  'smtp.json',
];

// ── Dirty tracking ────────────────────────────────────────────────────────
// Stores a SHA-256 hash of each file as it was last pulled from Supabase
// (or last successfully pushed). A file is only uploaded when its current
// on-disk content differs from that hash — i.e., new data was written locally.
const _pulledHashes = new Map(); // filename → sha256 hex

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Returns true only if the on-disk file differs from its last-pulled hash. */
function isDirty(filename) {
  const fp = path.join(DATA_DIR, filename);
  if (!fs.existsSync(fp)) return false;         // nothing on disk → nothing to push
  const current     = fs.readFileSync(fp, 'utf8');
  const currentHash = sha256(current);
  const pulledHash  = _pulledHashes.get(filename);
  if (pulledHash === undefined) {
    // Never pulled — first deploy or file not yet in bucket.
    // Treat as dirty so real content gets pushed.
    return true;
  }
  return currentHash !== pulledHash;
}

/** Record the hash after a pull or successful push so future checks are accurate. */
function markClean(filename, content) {
  _pulledHashes.set(filename, sha256(content));
}
// ─────────────────────────────────────────────────────────────────────────

// ── Safety guard ──────────────────────────────────────────────────────────
const isEmpty = (v) => {
  if (!v || typeof v !== 'object') return true;
  return Object.values(v).every(x =>
    x === null || x === undefined ||
    (Array.isArray(x) && x.length === 0) ||
    (typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length === 0)
  );
};
// ─────────────────────────────────────────────────────────────────────────

export async function uploadDataFile(filename) {
  const sb = getClient(); if (!sb) return;
  const fp = path.join(DATA_DIR, filename);
  if (!fs.existsSync(fp)) return;
  await ensureBucket();

  const content = fs.readFileSync(fp, 'utf8');

  // Never upload empty stubs — protects real Supabase data on fresh deploys.
  let parsed;
  try { parsed = JSON.parse(content); } catch { return; }
  if (isEmpty(parsed)) {
    console.log(`[Supabase:Data] ⏭  Skipping upload of ${filename} — appears empty (protecting existing data)`);
    return;
  }

  // Only upload if local content has actually changed since the last pull.
  if (!isDirty(filename)) {
    console.log(`[Supabase:Data] ⏭  ${filename} unchanged since last pull — skipping upload`);
    return;
  }

  const buf = Buffer.from(content, 'utf8');

  const cap = await checkDataCapacity(buf.length);
  if (!cap.withinLimit) {
    console.error(`[Supabase:Data] ❌ Storage limit reached (${cap.usedMB} MB / 800 MB) — ${filename} not uploaded`);
    return;
  }

  try {
    const { error } = await sb.storage.from(BUCKET).upload(filename, buf, {
      contentType: 'application/json',
      upsert: true,
    });
    if (error) {
      console.error(`[Supabase:Data] upload(${filename}):`, error.message);
    } else {
      markClean(filename, content); // reset dirty flag after successful push
      console.log(`[Supabase:Data] ✅ ${filename} synced (${cap.usedMB} MB used)`);
    }
  } catch (e) {
    console.error(`[Supabase:Data] upload(${filename}) exception:`, e.message);
  }
}

export async function downloadDataFile(filename) {
  const sb = getClient(); if (!sb) return false;
  await ensureBucket();
  try {
    const { data, error } = await sb.storage.from(BUCKET).download(filename);
    if (error) { console.log(`[Supabase:Data] ${filename} not in bucket (${error.message})`); return false; }
    const text = await data.text();
    JSON.parse(text); // validate — throws if corrupt
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, filename), text, 'utf8');
    markClean(filename, text); // record baseline hash so uploads only fire on new writes
    console.log(`[Supabase:Data] ✅ ${filename} restored`);
    return true;
  } catch (e) {
    console.error(`[Supabase:Data] download(${filename}):`, e.message);
    return false;
  }
}

export async function syncFromSupabase() {
  const sb = getClient();
  if (!sb) { console.warn('[Supabase:Data] Not configured — skipping pull'); return; }
  console.log('[Supabase:Data] 🔄 Pulling data files…');
  await ensureBucket();
  for (const f of MANAGED_FILES) await downloadDataFile(f);
  console.log('[Supabase:Data] ✅ Pull complete');
}

export async function syncToSupabase() {
  const sb = getClient();
  if (!sb) { console.warn('[Supabase:Data] Not configured — skipping push'); return; }
  console.log('[Supabase:Data] ⬆️  Checking for changed data files…');
  await ensureBucket();
  for (const f of MANAGED_FILES) await uploadDataFile(f);
  console.log('[Supabase:Data] ✅ Push complete');
}


export async function uploadProofImage(filename, imageBuffer) {
  const sb = getClient(); if (!sb) return null;
  await ensureBucket();
  const ext = filename.split('.').pop().toLowerCase();
  const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
  const contentType = mimeMap[ext] || 'application/octet-stream';
  const storagePath = `payment_proofs/${filename}`;
  try {
    const { error } = await sb.storage.from(BUCKET).upload(storagePath, imageBuffer, {
      contentType,
      upsert: true,
    });
    if (error) { console.error(`[Supabase:Data] uploadProofImage(${filename}):`, error.message); return null; }
    console.log(`[Supabase:Data] ✅ Proof image ${filename} stored in Supabase`);
    return storagePath;
  } catch (e) {
    console.error(`[Supabase:Data] uploadProofImage exception:`, e.message);
    return null;
  }
}

export async function deleteProofImage(filename) {
  const sb = getClient(); if (!sb) return false;
  const storagePath = `payment_proofs/${filename}`;
  try {
    const { error } = await sb.storage.from(BUCKET).remove([storagePath]);
    if (error) { console.error(`[Supabase:Data] deleteProofImage(${filename}):`, error.message); return false; }
    console.log(`[Supabase:Data] 🗑 Proof image ${filename} deleted from Supabase`);
    return true;
  } catch (e) {
    console.error(`[Supabase:Data] deleteProofImage exception:`, e.message);
    return false;
  }
}

export async function getProofImageUrl(filename) {
  const sb = getClient(); if (!sb) return null;
  const storagePath = `payment_proofs/${filename}`;
  try {
    const { data } = sb.storage.from(BUCKET).getPublicUrl(storagePath);
    return data?.publicUrl || null;
  } catch { return null; }
}

export async function getDataStats() {
  return checkDataCapacity(0);
}

// ── ZIMSEC Exam Backup & Expiry Cleanup ──────────────────────────────────────
//
// Uploads a snapshot of a single exam + its questions as a JSON backup to
// Supabase Storage immediately after creation (crash-safe).
// Expired exams are automatically purged 3 hours after their end time.
//
// Backup path in bucket: zimsec_backups/<examId>.json
// This is separate from the main zimsec-exams.json/zimsec-questions.json files
// so each exam has an independent, atomic snapshot for crash recovery.
// ────────────────────────────────────────────────────────────────────────────

const EXAM_BACKUP_PREFIX = 'zimsec_backups/';
const EXAM_EXPIRY_GRACE_MS = 3 * 60 * 60 * 1000; // 3 hours after exam end

/**
 * Upload a single exam backup to Supabase Storage.
 * Call this right after an exam is created or updated.
 * @param {object} exam - The full exam object (includes scheduledAt, durationMins, examEndsAt)
 * @param {Array}  questions - The full questions array (with answers, for admin recovery)
 */
export async function backupExamToSupabase(exam, questions = []) {
  const sb = getClient();
  if (!sb) {
    console.warn('[Supabase:ExamBackup] Not configured — skipping exam backup');
    return false;
  }
  await ensureBucket();

  // Compute examEndsAt from scheduledAt + durationMins (or use explicit field)
  let examEndsAt = exam.examEndsAt || null;
  if (!examEndsAt && exam.scheduledAt) {
    const startMs = new Date(exam.scheduledAt).getTime();
    const durMs   = (parseInt(exam.durationMins) || 60) * 60_000;
    examEndsAt    = new Date(startMs + durMs).toISOString();
  }

  const payload = {
    backedUpAt: new Date().toISOString(),
    exam:      { ...exam, examEndsAt },
    questions,
  };

  const buf      = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
  const filePath = `${EXAM_BACKUP_PREFIX}${exam.id}.json`;

  try {
    const { error } = await sb.storage.from(BUCKET).upload(filePath, buf, {
      contentType: 'application/json',
      upsert: true,
    });
    if (error) {
      console.error(`[Supabase:ExamBackup] ❌ Failed to backup exam ${exam.id}:`, error.message);
      return false;
    }
    console.log(`[Supabase:ExamBackup] ✅ Exam ${exam.id} backed up (examEndsAt: ${examEndsAt})`);
    return true;
  } catch (e) {
    console.error(`[Supabase:ExamBackup] ❌ Exception backing up exam ${exam.id}:`, e.message);
    return false;
  }
}

/**
 * Restore an exam from a Supabase backup (for crash recovery).
 * Returns { exam, questions } or null if not found.
 * @param {string} examId
 */
export async function restoreExamFromSupabase(examId) {
  const sb = getClient();
  if (!sb) return null;
  await ensureBucket();

  const filePath = `${EXAM_BACKUP_PREFIX}${examId}.json`;
  try {
    const { data, error } = await sb.storage.from(BUCKET).download(filePath);
    if (error) { console.log(`[Supabase:ExamBackup] No backup found for ${examId}`); return null; }
    const text    = await data.text();
    const payload = JSON.parse(text);
    console.log(`[Supabase:ExamBackup] ✅ Restored exam ${examId} from backup`);
    return { exam: payload.exam, questions: payload.questions || [] };
  } catch (e) {
    console.error(`[Supabase:ExamBackup] ❌ Restore failed for ${examId}:`, e.message);
    return null;
  }
}

/**
 * Delete the Supabase backup for a single exam.
 * @param {string} examId
 */
export async function deleteExamBackup(examId) {
  const sb = getClient();
  if (!sb) return false;
  const filePath = `${EXAM_BACKUP_PREFIX}${examId}.json`;
  try {
    const { error } = await sb.storage.from(BUCKET).remove([filePath]);
    if (error) { console.warn(`[Supabase:ExamBackup] Could not delete backup ${examId}:`, error.message); return false; }
    console.log(`[Supabase:ExamBackup] 🗑 Backup deleted for exam ${examId}`);
    return true;
  } catch (e) {
    console.error(`[Supabase:ExamBackup] Exception deleting backup ${examId}:`, e.message);
    return false;
  }
}

/**
 * Scan all exam backups in Supabase and delete those that expired
 * more than 3 hours ago (i.e. examEndsAt + 3h < now).
 * Also removes the backup for any exam that has no examEndsAt (unscheduled),
 * treating deletion as caller's responsibility.
 *
 * Call this on server startup and/or on a periodic schedule.
 */
export async function purgeExpiredExamBackups() {
  const sb = getClient();
  if (!sb) return;
  await ensureBucket();

  const now = Date.now();
  try {
    const { data, error } = await sb.storage.from(BUCKET).list(EXAM_BACKUP_PREFIX, { limit: 1000 });
    if (error || !data) return;

    const toDelete = [];
    for (const file of data) {
      try {
        const filePath = `${EXAM_BACKUP_PREFIX}${file.name}`;
        const { data: dl, error: dlErr } = await sb.storage.from(BUCKET).download(filePath);
        if (dlErr || !dl) continue;

        const text    = await dl.text();
        const payload = JSON.parse(text);
        const endsAt  = payload?.exam?.examEndsAt;
        if (!endsAt) continue; // no end time — leave it

        const endMs = new Date(endsAt).getTime();
        if (now > endMs + EXAM_EXPIRY_GRACE_MS) {
          toDelete.push(filePath);
          console.log(`[Supabase:ExamBackup] 🗑 Scheduling purge: ${file.name} (expired ${Math.round((now - endMs) / 3600000)}h ago)`);
        }
      } catch { /* skip bad files */ }
    }

    if (toDelete.length) {
      const { error: rmErr } = await sb.storage.from(BUCKET).remove(toDelete);
      if (rmErr) console.error('[Supabase:ExamBackup] Purge error:', rmErr.message);
      else console.log(`[Supabase:ExamBackup] ✅ Purged ${toDelete.length} expired exam backup(s)`);
    } else {
      console.log('[Supabase:ExamBackup] ✅ No expired backups to purge');
    }
  } catch (e) {
    console.error('[Supabase:ExamBackup] purgeExpiredExamBackups exception:', e.message);
  }
}
