// app/main.js — App main API routes
// GET /api/app/me        — user profile + usage + limits
// GET /api/app/papers    — list past papers
// GET /api/app/papers/:id/download — get download URL for a paper
// POST /api/app/logout   — handled in auth.js (re-exported here for convenience)

import { Router } from 'express';
import {
  getPlanLimits,
  getFullUsage,
  canDownloadPaper,
  incrementPaperDl,
  listPapersLocal,
  isBanned,
} from '../store.js';
import { requireAppAuth } from './auth.js';

const router = Router();

// ── GET /api/app/me ────────────────────────────────────────────────────────
// Returns user profile, current plan, usage today, and limits.
router.get('/me', requireAppAuth, (req, res) => {
  const uid     = req.user.id;
  const isLinked = !!req.user.jid;
  const limits  = getPlanLimits(uid, isLinked);
  const raw     = getFullUsage(uid);

  // Paper DL: count downloads in the current 6-hour window
  const now = Date.now();
  const SIX = 6 * 3600 * 1000;
  const wins = (raw.paperDlWindows || []).filter(w => now - w.windowStart < SIX);
  const paperDlUsed = wins.length ? wins[wins.length - 1].count : 0;

  const usage = {
    chat:    raw.chat         || 0,
    quiz:    raw.quizzes      || 0,
    paperDl: paperDlUsed,
    pdf:     raw.pdf          || 0,
    projects: raw.projectsTotal || 0,
  };

  res.json({
    ok: true,
    user: sanitize(req.user),
    plan:   limits.plan,
    limits: {
      aiMsg:   limits.aiMsg,
      quiz:    limits.quizzes,
      paperDl: limits.paperDl,
      pdf:     limits.pdfExports,
      projects: limits.projects,
    },
    usage,
  });
});

// ── GET /api/app/papers ────────────────────────────────────────────────────
router.get('/papers', requireAppAuth, (req, res) => {
  const raw    = listPapersLocal();
  const papers = Array.isArray(raw) ? raw : (raw && raw.papers ? raw.papers : []);
  res.json({ ok: true, papers });
});

// ── GET /api/app/papers/:id/download ─────────────────────────────────────
// Checks the paper-download limit then returns the URL.
router.get('/papers/:id/download', requireAppAuth, (req, res) => {
  const uid    = req.user.id;
  const raw    = listPapersLocal();
  const papers = Array.isArray(raw) ? raw : (raw && raw.papers ? raw.papers : []);
  const paper  = papers.find(p => String(p.id || p._id) === req.params.id);

  if (!paper) return res.status(404).json({ error: 'Paper not found' });

  const isLinked = !!req.user.jid;
  const limits   = getPlanLimits(uid, isLinked);

  if (!canDownloadPaper(uid, limits)) {
    return res.status(429).json({
      error: `Paper download limit reached (${limits.paperDl} per 6 hrs). Upgrade for more.`,
    });
  }

  incrementPaperDl(uid);
  const url = paper.publicUrl || paper.url || paper.fileUrl || null;
  if (!url) return res.status(404).json({ error: 'No download URL for this paper' });
  res.json({ ok: true, url });
});

// ── Shared sanitise helper ─────────────────────────────────────────────────
function sanitize(user) {
  if (!user) return null;
  const { passwordHash, pendingToken, pendingOtp, otpCreatedAt, ...safe } = user;
  return safe;
}

export default router;
