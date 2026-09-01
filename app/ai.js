// app/ai.js — App AI chat route
// POST /api/app/chat  { message }
// Enforces daily aiMsg limit per plan. Stops the request when limit is hit.

import { Router } from 'express';
import {
  getPlanLimits,
  getFullUsage,
  incrementChatUsage,
} from '../store.js';
import { requireAppAuth } from './auth.js';
import { gpt4oChat } from '../utils/gpt-service.js';

const router = Router();

// Per-user in-memory chat history (max 12 turns = 24 messages)
const histories = new Map();
const MAX_TURNS = 12;

const APP_SYSTEM = `You are Fundo AI, the intelligent study assistant powering Fundo Plus — an education platform for Zimbabwean students, built by XTech.

You are running inside the Fundo Plus Android app. Keep responses concise and plain-text friendly (no HTML). You may use simple markdown: **bold**, bullet lists, numbered lists.

MATHEMATICS — use plain LaTeX notation:
- Inline: $x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$
- Display: $$\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}$$

SUBJECTS: ZIMSEC O-Level and A-Level — Maths, Physics, Chemistry, Biology, Accounts, Commerce, History, Geography, English, Shona, Ndebele and more.

Be encouraging — many users are preparing for exams. You cannot recall previous sessions beyond the current chat.`;

function getHistory(uid) {
  if (!histories.has(uid)) histories.set(uid, []);
  return histories.get(uid);
}

function pushHistory(uid, role, content) {
  const h = getHistory(uid);
  h.push({ role, content });
  // Keep at most MAX_TURNS pairs
  while (h.length > MAX_TURNS * 2) h.splice(0, 2);
}

// ── POST /api/app/chat ─────────────────────────────────────────────────────
router.post('/chat', requireAppAuth, async (req, res) => {
  const { message } = req.body || {};
  if (!message || !message.trim()) return res.status(400).json({ error: 'No message' });

  const uid      = req.user.id;
  const isLinked = !!req.user.jid;
  const limits   = getPlanLimits(uid, isLinked);
  const usage    = getFullUsage(uid);

  // ── Limit check ──────────────────────────────────────────────────────────
  const aiLimit = limits.aiMsg === 'unlimited' ? Infinity : Number(limits.aiMsg);
  if (isFinite(aiLimit) && (usage.chat || 0) >= aiLimit) {
    return res.status(429).json({
      error: `Daily AI message limit reached (${aiLimit}). Upgrade your plan for more.`,
      limitReached: true,
    });
  }

  // ── Build messages array ──────────────────────────────────────────────────
  const history  = getHistory(uid);
  const messages = [
    ...history,
    { role: 'user', content: message.trim() },
  ];

  try {
    const result = await gpt4oChat({
      systemInstruction: APP_SYSTEM,
      messages,
      temperature: 0.8,
      max_tokens: 1500,
    });

    if (!result.success) throw new Error(result.error || 'GPT failed');

    const reply = (result.answer || '').trim();
    if (!reply) throw new Error('Empty response');

    // Persist history and increment usage
    pushHistory(uid, 'user',      message.trim());
    pushHistory(uid, 'assistant', reply);
    incrementChatUsage(uid);

    // Return updated usage so the app can refresh counters
    const updatedUsage = getFullUsage(uid);
    const remaining = isFinite(aiLimit) ? Math.max(0, aiLimit - updatedUsage.chat) : 'unlimited';

    res.json({ ok: true, reply, remaining });
  } catch (err) {
    console.error('[app/ai] chat error:', err.message);
    res.status(500).json({ error: 'Fundo AI is temporarily unavailable. Please try again.' });
  }
});

// ── POST /api/app/chat/clear — reset in-memory history for this user ───────
router.post('/chat/clear', requireAppAuth, (req, res) => {
  histories.delete(req.user.id);
  res.json({ ok: true });
});

export default router;
