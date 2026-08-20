// bot.js — FundaPlus Web Server + API Routes v7 (No Firebase)
import express    from 'express';
import http       from 'http';
import { Server } from 'socket.io';
import path       from 'path';
import os         from 'os';
import fs         from 'fs';
import multer     from 'multer';
import { fileURLToPath } from 'url';
import cron       from 'node-cron';
import { v4 as uuidv4 } from 'uuid';

import { handleMessage } from './whatsapp/main.js';
import { syncFromSupabase, syncToSupabase, uploadPaper, deletePaper, getDataStats, getResourcesStats } from './utils/supabase.js';
import { createVerifyToken, consumeToken, cleanTokens } from './utils/verify.js';
import {
  getWebUser, saveWebUser, deleteWebUser,
  addPaper, removePaper, listPapersLocal, getPaperById,
  getPapersTotalBytes, getWishlistCount,
  addWishlistVote, MAX_PAPERS_BYTES,
  incrementPaperUpload, PAPER_UPLOAD_LIMIT,
  getAllWebUsers, banUser, unbanUser,
  getBan, getAllBans, isBanned, resolveAppeal,
  reloadCommunityFromDisk, reloadWebUsersFromDisk, reloadMessengerFromDisk,
  reloadPapersFromDisk, reloadMoneyFromDisk, reloadRemainingFromDisk,
} from './store.js';
import websiteRouter from './website/routes.js';
import { mountAppRoutes, requireAuthOrApp } from './app/index.js';
import { obfuscateMiddleware, serveObfuscated } from './utils/obfuscate.js';
import { requireAuth, reloadSessionsFromDisk } from './website/auth.js';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR   = path.join(__dirname, 'data');
const TEMP_DIR   = path.join(__dirname, 'temp');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PAPERS_DIR = path.join(__dirname, 'data', 'papers');
const DASH_DIR   = path.join(PUBLIC_DIR, 'dashboard');
// AUTH_FOLDER removed — Baileys auth no longer used

[DATA_DIR, TEMP_DIR, path.join(TEMP_DIR,'docs'), DASH_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

// ── Multer ─────────────────────────────────────────────────────────────────
const pdfUpload = multer({
  storage: multer.memoryStorage(),
  limits : { fileSize: 20 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Only PDF files allowed'));
  },
});
const anyUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20*1024*1024 } });

// ── Middleware ─────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const isMultipart = (req.headers['content-type'] || '').includes('multipart/form-data');
  const isFileRoute = (req.path.includes('/upload') && !req.path.includes('/upload-txt')) || req.path.startsWith('/api/admin/files/');
  if (req.method === 'POST' && (isMultipart || isFileRoute)) return next();
  express.json({ limit: '10mb' })(req, res, next);
});
app.use(express.urlencoded({ extended: true }));
app.use(obfuscateMiddleware(PUBLIC_DIR));
// Block direct URL access to admin.html — only /fundopageadmin route serves it
app.use((req, res, next) => {
  if (req.path.toLowerCase() === '/admin.html') return res.status(404).send('Not found');
  next();
});
app.use(express.static(PUBLIC_DIR, {
  etag: false,
  lastModified: false,
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  },
}));

// ── Bot state ──────────────────────────────────────────────────────────────
global.botState = {
  startTime: Date.now(), messagesCount: 0, commandsCount: 0,
  connectedAt: null, phoneNumber: null, status: 'fb_cloud_api',
};

// ── Admin ──────────────────────────────────────────────────────────────────
const ADMIN_PASSWORD = 'smarttech@#2';
const adminSessions  = new Set();
function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (!token || !adminSessions.has(token)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── Cron jobs ──────────────────────────────────────────────────────────────
let _syncReady = false;
cron.schedule('*/2 * * * *', async () => { if (_syncReady) await syncToSupabase(); });
cron.schedule('0 * * * *',   cleanTokens);
cron.schedule('0 * * * *',   cleanTokens);
cron.schedule('*/30 * * * *', () => {
  try {
    const now = Date.now();
    const cleanDir = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const f of fs.readdirSync(dir)) {
        const fp = path.join(dir, f);
        try { if (fs.statSync(fp).isFile() && now - fs.statSync(fp).mtimeMs > 3600_000) fs.unlinkSync(fp); } catch {}
      }
    };
    cleanDir(TEMP_DIR);
    cleanDir(path.join(TEMP_DIR,'docs'));
  } catch {}
});

// ═══════════════════════════════════════════════════════════════════════════
//  WEBSITE ROUTES (login, onboarding, dashboard API, AI chat, quiz)
// ═══════════════════════════════════════════════════════════════════════════
app.use('/', websiteRouter);
mountAppRoutes(app);

// ═══════════════════════════════════════════════════════════════════════════
//  PUBLIC ROUTES
// ═══════════════════════════════════════════════════════════════════════════
app.get('/health', (req,res) => res.status(200).send('OK'));

app.get('/api/status', async (req,res) => {
  const bs     = global.botState || {};
  const uptime = Math.floor((Date.now() - (bs.startTime || Date.now())) / 1000);
  const mem    = process.memoryUsage();
  res.json({
    bot: {
      status:        bs.status        || 'fb_cloud_api',
      phone:         bs.phoneNumber   || '—',
      connectedAt:   bs.connectedAt   || null,
      messagesCount: bs.messagesCount || 0,
      commandsCount: bs.commandsCount || 0,
    },
    server: {
      uptime, uptimeHuman: formatUptime(uptime),
      platform:    os.platform(),
      nodeVersion: process.version,
      cpus:        os.cpus().length,
      totalMem:    formatBytes(os.totalmem()),
      freeMem:     formatBytes(os.freemem()),
      heapUsed:    formatBytes(mem.heapUsed),
    },
    supabase: {
      data: {
        configured: !!(process.env.SUPABASE_DATA_URL || process.env.SUPABASE_URL),
        ...(await getDataStats().catch(() => ({}))),
      },
      resources: {
        configured: !!process.env.SUPABASE_RESOURCES_URL,
        ...(await getResourcesStats().catch(() => ({}))),
      },
    },
  });
});

// Resource listing
app.get('/api/resources', requireAuth, (req,res) => {
  res.json({ papers: listPapersLocal() });
});

// ─── Quiz upload (extract PDF text) ───────────────────────────────────────
app.post('/api/quiz/upload', requireAuth, pdfUpload.single('file'), async (req,res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file received' });
    const pdfParse = (await import('pdf-parse')).default;
    const parsed   = await pdfParse(file.buffer);
    const quizId   = uuidv4();
    const fp       = path.join(TEMP_DIR, `quiz-${quizId}.txt`);
    fs.writeFileSync(fp, parsed.text, 'utf8');
    res.json({ quizId, text: parsed.text, pageCount: parsed.numpages, charCount: parsed.text.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Papers (feature routes) ───────────────────────────────────────────────
app.post('/api/papers/upload', requireAuth, pdfUpload.single('file'), async (req,res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file uploaded' });
    if (getPapersTotalBytes()+file.size > MAX_PAPERS_BYTES)
      return res.status(400).json({ error: 'Storage limit reached (500 MB).' });
    if (!incrementPaperUpload(req.user.id))
      return res.status(429).json({ error: `Daily upload limit (${PAPER_UPLOAD_LIMIT}/day) reached.`, limitReached: true });
    const filename = `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9.\-_]/g,'_')}`;
    if (!fs.existsSync(PAPERS_DIR)) fs.mkdirSync(PAPERS_DIR, { recursive: true });
    fs.writeFileSync(path.join(PAPERS_DIR, filename), file.buffer);
    let publicUrl = '';
    try { publicUrl = await uploadPaper(filename, file.buffer, file.mimetype); } catch(e) { console.warn('[Papers]', e.message); }
    const paper = addPaper({ filename, originalName: file.originalname, size: file.size,
      uploadedBy: req.user.id, publicUrl,
      subject: req.body.subject||'General', description: req.body.description||'' });
    res.json({ ok: true, paper });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/papers/public-upload', requireAuth, pdfUpload.single('file'), async (req,res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file uploaded' });
    if (getPapersTotalBytes()+file.size > MAX_PAPERS_BYTES)
      return res.status(400).json({ error: 'Storage limit reached.' });
    const filename = `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9.\-_]/g,'_')}`;
    if (!fs.existsSync(PAPERS_DIR)) fs.mkdirSync(PAPERS_DIR, { recursive: true });
    fs.writeFileSync(path.join(PAPERS_DIR, filename), file.buffer);
    let publicUrl = '';
    try { publicUrl = await uploadPaper(filename, file.buffer, file.mimetype); } catch(e) { console.warn('[PublicUpload] Supabase skipped:', e.message); }
    const paper = addPaper({ filename, originalName: req.body.title||file.originalname,
      size: file.size, uploadedBy: req.user?.id||'web', publicUrl,
      subject: req.body.subject||'General', description: req.body.description||'',
      level: req.body.level||'', year: req.body.year||'' });
    res.json({ ok: true, paper });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Proxy: download or preview a paper via server URL ─────────────────────
// GET /api/papers/file/:filename?mode=download  → force download
// GET /api/papers/file/:filename                → inline preview
// ── Paper cache: tracks last-access per file, evicts after 30 min of inactivity ──
const PAPER_CACHE_TTL = 30 * 60 * 1000; // 30 minutes
const paperLastAccess = new Map();       // filename → timestamp

function touchPaperCache(filename) {
  paperLastAccess.set(filename, Date.now());
}

function evictStalePaperCache() {
  const now = Date.now();
  for (const [filename, lastAccess] of paperLastAccess.entries()) {
    if (now - lastAccess >= PAPER_CACHE_TTL) {
      const localPath = path.join(PAPERS_DIR, filename);
      try {
        if (fs.existsSync(localPath)) {
          fs.unlinkSync(localPath);
          console.log(`[Papers] Evicted stale cache: ${filename}`);
        }
      } catch (e) {
        console.warn(`[Papers] Evict failed for ${filename}:`, e.message);
      }
      paperLastAccess.delete(filename);
    }
  }
}

// Check for stale files every 5 minutes
setInterval(evictStalePaperCache, 5 * 60 * 1000);

// GET /api/papers/file/:filename?mode=download  → force download
// GET /api/papers/file/:filename                → inline preview
// On first request: fetches from Supabase, caches locally.
// Cache evicted after 30 min of no requests for that file.
app.get('/api/papers/file/:filename', requireAuthOrApp, async (req, res) => {
  const filename  = path.basename(req.params.filename);
  const mode      = req.query.mode === 'download' ? 'attachment' : 'inline';
  const localPath = path.join(PAPERS_DIR, filename);

  // 1. Serve from local cache — reset inactivity timer on each hit
  if (fs.existsSync(localPath)) {
    touchPaperCache(filename);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${mode}; filename="${filename}"`);
    res.setHeader('X-Served-By', 'local-cache');
    return fs.createReadStream(localPath).pipe(res);
  }

  // 2. Look up Supabase URL from paper record
  const paper = getPaperById
    ? getPaperById(filename.replace(/\.pdf$/i, '')) || listPapersLocal().find(p => p.filename === filename)
    : listPapersLocal().find(p => p.filename === filename);

  const { getResourceUrl } = await import('./utils/supabase-resources.js');
  const supabaseUrl = paper?.publicUrl || await getResourceUrl(filename).catch(() => null);

  if (!supabaseUrl) {
    return res.status(404).json({ error: 'File not found in storage' });
  }

  // 3. Fetch from Supabase, cache locally, start inactivity timer
  try {
    console.log(`[Papers] Downloading from Supabase: ${filename}`);
    const upstream = await fetch(supabaseUrl);
    if (!upstream.ok) return res.status(404).json({ error: 'File not available in storage' });

    const buf = Buffer.from(await upstream.arrayBuffer());
    if (!fs.existsSync(PAPERS_DIR)) fs.mkdirSync(PAPERS_DIR, { recursive: true });
    fs.writeFileSync(localPath, buf);
    touchPaperCache(filename);
    console.log(`[Papers] Cached: ${filename} (${Math.round(buf.length / 1024)} KB) — evicts after 30 min inactivity`);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${mode}; filename="${filename}"`);
    res.setHeader('X-Served-By', 'supabase-fresh');
    res.send(buf);
  } catch (e) {
    console.error('[Papers] Supabase fetch failed:', e.message);
    res.status(502).json({ error: 'Failed to fetch file from storage' });
  }
});

// ── Public paper URL (server-owned, authenticated preview link) ───────────
// GET /api/papers/:id/url  → returns { downloadUrl, previewUrl } using server's own URLs
app.get('/api/papers/:id/url', requireAuth, (req, res) => {
  const paper = listPapersLocal().find(p => p.id === req.params.id);
  if (!paper) return res.status(404).json({ error: 'Paper not found' });
  const base = process.env.WEBSITE_URL || `${req.protocol}://${req.get('host')}`;
  res.json({
    ok: true,
    previewUrl:  `${base}/api/papers/file/${encodeURIComponent(paper.filename)}`,
    downloadUrl: `${base}/api/papers/file/${encodeURIComponent(paper.filename)}?mode=download`,
    filename: paper.filename,
    originalName: paper.originalName,
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  FACEBOOK WHATSAPP CLOUD API WEBHOOK
// ═══════════════════════════════════════════════════════════════════════════

// Facebook sends a GET to verify the webhook endpoint on first setup.
// Set Callback URL to: https://<your-domain>/api/wa/webhook
// Set Verify Token to the value of WA_VERIFY_TOKEN env var.

const WA_VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN || '';

app.get('/api/wa/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === WA_VERIFY_TOKEN) {
    console.log('[WA webhook] Verified by Facebook ✅');
    return res.status(200).send(challenge);
  }
  res.status(403).json({ error: 'Verification failed' });
});

// Facebook POSTs inbound messages here.
app.post('/api/wa/webhook', async (req, res) => {
  // Acknowledge immediately — Facebook expects a fast 200
  res.sendStatus(200);

  try {
    global.botState.messagesCount++;
    await handleMessage(req.body);
  } catch (err) {
    console.error('[WA webhook] Error:', err);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/admin/login', (req,res) => {
  const { password } = req.body;
  if (!password || password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
  const token = `cgt-${Date.now()}-${Math.random().toString(36).slice(2,10)}`;
  adminSessions.add(token);
  setTimeout(() => adminSessions.delete(token), 12*3600_000);
  res.json({ ok: true, token });
});
app.post('/api/admin/logout', (req,res) => {
  const token = req.headers['x-admin-token'];
  if (token) adminSessions.delete(token);
  res.json({ ok: true });
});

const ALLOWED_FILES = ['webusers.json','store.json','wa.json','usage.json','images.json','pdf.json','synced.json','premium.json','doc.json','messages.json','papers.json','wishlist.json','bans.json'];

app.get('/api/admin/files',      requireAdmin, (req,res) => {
  const files = ALLOWED_FILES.filter(f=>fs.existsSync(path.join(DATA_DIR,f)))
    .map(f=>{ const s=fs.statSync(path.join(DATA_DIR,f)); return { name:f, size:s.size, modified:s.mtime }; });
  res.json({ files });
});
app.get('/api/admin/files/:name', requireAdmin, (req,res) => {
  const {name}=req.params;
  if (!ALLOWED_FILES.includes(name)) return res.status(400).json({ error: 'Not allowed' });
  const fp=path.join(DATA_DIR,name);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type','application/json');
  res.setHeader('Content-Disposition',`attachment; filename="${name}"`);
  res.send(fs.readFileSync(fp));
});
app.post('/api/admin/files/:name', requireAdmin, express.raw({ type:'*/*', limit:'10mb' }), (req,res) => {
  const {name}=req.params;
  if (!ALLOWED_FILES.includes(name)) return res.status(400).json({ error: 'Not allowed' });
  try {
    const text  = Buffer.isBuffer(req.body)?req.body.toString('utf8'):JSON.stringify(req.body);
    const clean = text.replace(/^\uFEFF/,'').trim();
    JSON.parse(clean);
    fs.writeFileSync(path.join(DATA_DIR,name),clean,'utf8');
    res.json({ ok: true });
  } catch(e) { res.status(400).json({ error: 'Invalid JSON: '+e.message }); }
});
app.delete('/api/admin/files/:name', requireAdmin, (req,res) => {
  const {name}=req.params;
  const deletable=['usage.json','images.json','pdf.json','doc.json'];
  if (!deletable.includes(name)) return res.status(400).json({ error: 'Cannot delete' });
  const fp=path.join(DATA_DIR,name);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
  fs.unlinkSync(fp); res.json({ ok: true });
});
app.delete('/api/admin/papers/:id', requireAdmin, async (req,res) => {
  const paper=(listPapersLocal()).find(p=>p.id===req.params.id);
  if (!paper) return res.status(404).json({ error: 'Not found' });
  try { await deletePaper(paper.filename); } catch {}
  removePaper(req.params.id); res.json({ ok: true });
});
app.get('/api/admin/papers',   requireAdmin, (req,res) => res.json({ papers:listPapersLocal(), totalBytes:getPapersTotalBytes(), limitBytes:MAX_PAPERS_BYTES }));
app.get('/api/admin/users',    requireAdmin, (req,res) => {
  const users = getAllWebUsers();
  // Strip password hashes from admin view
  const safe = Object.fromEntries(Object.entries(users).map(([id,u])=>{
    const { passwordHash, ...rest } = u; return [id, rest];
  }));
  res.json({ users: safe, count: Object.keys(safe).length });
});
app.get('/api/admin/usage',    requireAdmin, (req,res) => { const fp=path.join(DATA_DIR,'usage.json'); res.json(fs.existsSync(fp)?JSON.parse(fs.readFileSync(fp,'utf8')):{}); });
app.get('/api/admin/messages', requireAdmin, (req,res) => { const fp=path.join(DATA_DIR,'messages.json'); res.json(fs.existsSync(fp)?JSON.parse(fs.readFileSync(fp,'utf8')):{}); });
app.get('/api/admin/wishlist', requireAdmin, (req,res) => { const fp=path.join(DATA_DIR,'wishlist.json'); res.json(fs.existsSync(fp)?JSON.parse(fs.readFileSync(fp,'utf8')):{upgrade:0,voters:[]}); });
app.get('/api/admin/server',   requireAdmin, (req,res) => {
  const uptime=Math.floor((Date.now()-global.botState.startTime)/1000);
  const mem=process.memoryUsage();
  res.json({ uptime:formatUptime(uptime), platform:os.platform(), arch:os.arch(),
    nodeVersion:process.version, hostname:os.hostname(), cpus:os.cpus().length,
    totalMem:formatBytes(os.totalmem()), freeMem:formatBytes(os.freemem()),
    heapUsed:formatBytes(mem.heapUsed), heapTotal:formatBytes(mem.heapTotal), loadAvg:os.loadavg() });
});
app.post('/api/admin/sync',    requireAdmin, async (req,res) => {
  try { await syncToSupabase(); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: User & Ban Management ───────────────────────────────────────────
app.get('/api/admin/users/search', requireAdmin, (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  const all = getAllWebUsers();
  const bans = getAllBans();
  let users = Object.values(all).map(u => {
    const { passwordHash, pendingToken, ...safe } = u;
    return { ...safe, banned: !!bans[u.id], banInfo: bans[u.id] || null };
  });
  if (q) users = users.filter(u =>
    u.email?.toLowerCase().includes(q) ||
    u.phone?.includes(q) ||
    u.name?.toLowerCase().includes(q) ||
    u.surname?.toLowerCase().includes(q) ||
    u.id?.includes(q)
  );
  res.json({ users, count: users.length });
});

app.get('/api/admin/bans', requireAdmin, (req, res) => {
  const bans = getAllBans();
  const all  = getAllWebUsers();
  const result = Object.values(bans).map(ban => {
    const user = all[ban.userId];
    return { ...ban, email: user?.email || '—', name: (user?.name || '') + ' ' + (user?.surname || '') };
  });
  res.json({ bans: result, count: result.length });
});

app.post('/api/admin/ban', requireAdmin, (req, res) => {
  const { userId, reason } = req.body || {};
  if (!userId || !reason) return res.status(400).json({ error: 'userId and reason required' });
  if (!getWebUser(userId)) return res.status(404).json({ error: 'User not found' });
  banUser(userId, reason, 'admin');
  res.json({ ok: true });
});

app.post('/api/admin/unban', requireAdmin, (req, res) => {
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId required' });
  unbanUser(userId);
  res.json({ ok: true });
});

app.post('/api/admin/appeals/:userId/resolve', requireAdmin, (req, res) => {
  const { userId } = req.params;
  const { decision } = req.body || {};
  if (!['approved','rejected'].includes(decision)) return res.status(400).json({ error: 'decision must be approved or rejected' });
  const ok = resolveAppeal(userId, decision);
  if (!ok) return res.status(404).json({ error: 'No active ban for this user' });
  res.json({ ok: true });
});

app.get('/api/admin/appeals', requireAdmin, (req, res) => {
  const bans = getAllBans();
  const all  = getAllWebUsers();
  const pending = Object.values(bans)
    .filter(b => b.appealStatus === 'pending')
    .map(b => {
      const user = all[b.userId];
      return { ...b, email: user?.email || '—', name: (user?.name||'')+' '+(user?.surname||'') };
    });
  res.json({ appeals: pending, count: pending.length });
});



// ═══════════════════════════════════════════════════════════════════════════
//  PAGE ROUTES
// ═══════════════════════════════════════════════════════════════════════════
app.get('/',             (req,res) => res.sendFile(path.join(PUBLIC_DIR,'index.html')));
app.get('/resources',    (req,res) => res.sendFile(path.join(PUBLIC_DIR,'resources.html')));
app.get('/banned',       (req,res) => serveObfuscated(path.join(PUBLIC_DIR,'banned.html'))(req,res));
app.get('/fundopageadmin', (req,res) => res.sendFile(path.join(PUBLIC_DIR,'admin.html')));
app.get('/redeem/:code', (req,res) => res.sendFile(path.join(PUBLIC_DIR,'redeem.html')));
// Legacy redirect
app.get('/dashboard',    (req,res) => res.redirect('/~'));
app.get('/ac',           (req,res) => res.redirect('/~/account'));
// SPA catch-all
app.get('*', (req,res,next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(PUBLIC_DIR,'index.html'));
});

// ═══════════════════════════════════════════════════════════════════════════
//  SOCKET.IO + MESSENGER REAL-TIME
// ═══════════════════════════════════════════════════════════════════════════
const messengerSockets = new Map(); // userId → Set of sockets

io.on('connection', (socket) => {
  socket.emit('status', buildStatusPayload());

  // ── Messenger real-time ────────────────────────────────────────────────
  socket.on('messenger:join', (userId) => {
    if (!userId) return;
    socket.userId = userId;
    if (!messengerSockets.has(userId)) messengerSockets.set(userId, new Set());
    messengerSockets.get(userId).add(socket);
    socket.join(`messenger:${userId}`);
  });

  socket.on('messenger:leave', (userId) => {
    if (!userId) return;
    const set = messengerSockets.get(userId);
    if (set) {
      set.delete(socket);
      if (set.size === 0) messengerSockets.delete(userId);
    }
    socket.leave(`messenger:${userId}`);
  });

  socket.on('disconnect', () => {
    if (socket.userId) {
      const set = messengerSockets.get(socket.userId);
      if (set) {
        set.delete(socket);
        if (set.size === 0) messengerSockets.delete(socket.userId);
      }
    }
  });
});

// Helper to push real-time message to a user
function emitMessengerMessage(toUserId, message) {
  const room = `messenger:${toUserId}`;
  io.to(room).emit('messenger:new-message', message);
}

global.emitMessengerMessage = emitMessengerMessage;

function emitStatus()         { io.emit('status', buildStatusPayload()); }
function buildStatusPayload() {
  return { status: global.botState.status, phone: global.botState.phoneNumber,
           messages: global.botState.messagesCount,
           commands: global.botState.commandsCount, connectedAt: global.botState.connectedAt };
}
global.emitStatus = emitStatus;

function formatUptime(s) {
  const d=Math.floor(s/86400),h=Math.floor((s%86400)/3600),m=Math.floor((s%3600)/60),sec=s%60;
  return `${d}d ${h}h ${m}m ${sec}s`;
}
function formatBytes(b) {
  if(b<1024)return b+' B'; if(b<1048576)return(b/1024).toFixed(1)+' KB';
  if(b<1073741824)return(b/1048576).toFixed(1)+' MB'; return(b/1073741824).toFixed(1)+' GB';
}

export async function startWebServer(port) {
  console.log('\n🔐 ENV CHECK:');
  console.log(`   SUPABASE_URL: ${process.env.SUPABASE_URL ? '✅ SET' : '⚠️  MISSING — sync disabled'}`);
  console.log(`   HF_TOKEN: ${process.env.HF_TOKEN ? '✅ SET' : '⚠️  MISSING — image gen disabled'}\n`);
  await syncFromSupabase();
  reloadCommunityFromDisk();   // ✅ Re-read community.json now that Supabase has restored it
  reloadWebUsersFromDisk();    // ✅ Re-read webusers.json — sessions auth depends on this
  reloadMessengerFromDisk();   // ✅ Re-read messenger.json — pending messages and settings
  reloadSessionsFromDisk();    // ✅ Re-read sessions.json — restores logged-in users
  reloadPapersFromDisk();      // ✅ Re-read papers.json — restored papers visible in memory
  reloadMoneyFromDisk();       // ✅ Re-read wallet/subscription files — restored balances visible
  reloadRemainingFromDisk();   // ✅ Re-read bans, promo links, usage, wishlist, support, proofs, JIDs, etc.
  _syncReady = true; // ✅ Only start pushing after we've pulled real data
  console.log('[Sync] ✅ Initial pull complete — cron sync now active');
  server.listen(port, '0.0.0.0', () => {
    console.log(`✅  FundaPlus on 0.0.0.0:${port}`);
    console.log(`🌐  Home       → http://localhost:${port}/`);
    console.log(`🔐  Login      → http://localhost:${port}/login`);
    console.log(`📋  Dashboard  → http://localhost:${port}/~`);
    console.log(`🔧  Admin      → http://localhost:${port}/fundopageadmin`);
    console.log(`🗺️  Sitemap    → http://localhost:${port}/sitemap.xml`);
  });
  server.on('error', e => { console.error('❌ Server error:', e.message); process.exit(1); });
}
export { emitStatus };
