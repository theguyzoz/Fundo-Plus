// whatsapp/resources.js — Download Past Papers flow (WATI edition)
// Mirrors the Baileys number-selection UX:
//   ask_filter → show numbered list → user types number → send file link
//   Type 0 at any point to return to menu.

import { sendText, sendList } from './wa.js';
import { listPapersLocal }    from '../store.js';
import { RETURN_PROMPT }      from './menu.js';

const PAGE_SIZE = 15;

export function initResourceSession() {
  return { step: 'ask_filter', filter: null, page: 0, filtered: [] };
}

// ── Entry point ───────────────────────────────────────────────────────────
export async function handleResources(phone, text, sessionData) {
  const step = sessionData.step;

  if (step === 'ask_filter')  return showFilterMenu(phone, sessionData);
  if (step === 'get_filter')  return handleFilterChoice(phone, text, sessionData);
  if (step === 'show_list')   return handleListChoice(phone, text, sessionData);

  return showFilterMenu(phone, sessionData);
}

// ── Step 1: Show level filter ─────────────────────────────────────────────
async function showFilterMenu(phone, sessionData) {
  await sendText(phone,
    `📚 *Download Past Papers*\n\nSelect a level:\n\n1. O-Level\n2. A-Level\n3. Grade 7${RETURN_PROMPT}`
  );
  return { ...sessionData, step: 'get_filter' };
}

// ── Step 2: Handle level choice ───────────────────────────────────────────
async function handleFilterChoice(phone, text, sessionData) {
  const filterMap = { '1': 'olevel', '2': 'alevel', '3': 'g7' };
  const filter    = filterMap[text.trim()];

  if (!filter) {
    await sendText(phone, `Please reply with *1*, *2*, or *3* to select a level.${RETURN_PROMPT}`);
    return sessionData;
  }

  const all      = listPapersLocal();
  const filtered = all.filter(p => {
    const lvl = (p.level || '').toLowerCase();
    if (filter === 'olevel') return lvl.includes('o') || lvl === 'olevel' || lvl === 'o-level';
    if (filter === 'alevel') return lvl.includes('a') || lvl === 'alevel' || lvl === 'a-level';
    if (filter === 'g7')     return lvl.includes('g7') || lvl.includes('grade 7') || lvl.includes('grade7');
    return false;
  });

  const labelMap = { olevel: 'O-Level', alevel: 'A-Level', g7: 'Grade 7' };

  if (filtered.length === 0) {
    await sendText(phone,
      `📭 No resources found for *${labelMap[filter]}* yet.\n\nCheck back soon or visit our website.${RETURN_PROMPT}`
    );
    return { ...sessionData, step: 'ask_filter' };
  }

  const updated = { ...sessionData, filter, filtered, page: 0, step: 'show_list' };
  await sendResourceList(phone, updated);
  return updated;
}

// ── Step 3: Handle numbered selection ────────────────────────────────────
async function handleListChoice(phone, text, sessionData) {
  const trimmed = text.trim();

  // Next page
  if (trimmed === '16') {
    const nextPage = sessionData.page + 1;
    const start    = nextPage * PAGE_SIZE;
    if (start >= sessionData.filtered.length) {
      await sendText(phone, `📭 No more resources on the next page.${RETURN_PROMPT}`);
      return sessionData;
    }
    const updated = { ...sessionData, page: nextPage };
    await sendResourceList(phone, updated);
    return updated;
  }

  const num       = parseInt(trimmed);
  const start     = sessionData.page * PAGE_SIZE;
  const pageItems = sessionData.filtered.slice(start, start + PAGE_SIZE);

  if (isNaN(num) || num < 1 || num > pageItems.length) {
    await sendText(phone,
      `Please reply with a number *1–${pageItems.length}* to download, or *16* for the next page.${RETURN_PROMPT}`
    );
    return sessionData;
  }

  const paper = pageItems[num - 1];
  await sendResourceFile(phone, paper);
  return sessionData; // Stay on the list so they can download more
}

// ── Render the numbered list ──────────────────────────────────────────────
async function sendResourceList(phone, sessionData) {
  const { filtered, page, filter } = sessionData;
  const start     = page * PAGE_SIZE;
  const pageItems = filtered.slice(start, start + PAGE_SIZE);
  const total     = filtered.length;
  const labelMap  = { olevel: 'O-Level', alevel: 'A-Level', g7: 'Grade 7' };
  const label     = labelMap[filter] || '';

  let msg = `📚 *${label} Past Papers* (${total} available)\n\n`;
  pageItems.forEach((p, i) => {
    const size = p.size ? ` _(${(p.size / 1024).toFixed(0)} KB)_` : '';
    msg += `${start + i + 1}. ${p.originalName || p.filename}${size}\n`;
  });

  if (start + PAGE_SIZE < total) {
    msg += `\n_Reply *16* to see more._`;
  }

  msg += `\n\nReply with a number to download.${RETURN_PROMPT}`;
  await sendText(phone, msg);
}

// ── Send file ─────────────────────────────────────────────────────────────
async function sendResourceFile(phone, paper) {
  const { sendDocument } = await import('./wa.js');

  try {
    await sendText(phone, `⏳ Preparing *${paper.originalName || paper.filename}*...`);

    // Prefer a public URL (WATI needs a URL for documents)
    if (paper.publicUrl) {
      await sendDocument(phone, paper.publicUrl, paper.originalName || paper.filename,
        `📄 ${paper.subject || 'Resource'}`);
      await sendText(phone, `✅ Sent!\n\nReply with another number to download more.${RETURN_PROMPT}`);
      return;
    }

    // No public URL — send a fallback message
    const BASE = process.env.WEBSITE_URL || 'https://fundaplus.up.railway.app';
    const link = `${BASE}/api/papers/file/${encodeURIComponent(paper.filename)}?mode=download`;
    await sendText(phone,
      `📎 *${paper.originalName || paper.filename}*\n\nDownload here:\n${link}${RETURN_PROMPT}`
    );
  } catch (err) {
    console.error('[Resources] Send error:', err.message);
    await sendText(phone, `⚠️ Failed to send file. Please try again.${RETURN_PROMPT}`);
  }
}
