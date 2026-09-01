// whatsapp/main.js — Fundo Plus WhatsApp Message Orchestrator (Facebook Cloud API)
// Called by the /api/wa/webhook POST route in bot.js
// Facebook sends a webhook payload for every inbound message.

import { getSession, setSession, clearSession, isNewUser } from './sessions.js';
import { handleAuth, startAuth }                            from './auth.js';
import { sendMainMenu, isMenuTrigger }                      from './menu.js';
import { handleResources, initResourceSession }             from './resources.js';
import { handleChat, clearChatHistory }                     from './chat.js';
import { sendText }                                         from './wa.js';

// ── Parse Facebook Cloud API webhook payload → { phone, text } ───────────
// Facebook sends entries like:
//   body.entry[0].changes[0].value.messages[0]
export function parseFBWebhook(body) {
  try {
    const entry   = body.entry?.[0];
    const change  = entry?.changes?.[0];
    const value   = change?.value;
    const msg     = value?.messages?.[0];

    if (!msg) return { phone: '', text: '' };

    // Phone number is in contacts or from field (digits only, with country code)
    const phone = (value.contacts?.[0]?.wa_id || msg.from || '').replace(/\D/g, '');

    // Extract text from different message types
    let text = '';
    if (msg.type === 'text') {
      text = msg.text?.body || '';
    } else if (msg.type === 'interactive') {
      // Button reply
      if (msg.interactive?.type === 'button_reply') {
        text = msg.interactive.button_reply?.title || '';
      }
      // List reply
      if (msg.interactive?.type === 'list_reply') {
        text = msg.interactive.list_reply?.title || '';
      }
    }

    return { phone, text: text.trim() };
  } catch {
    return { phone: '', text: '' };
  }
}

// ── Main handler ──────────────────────────────────────────────────────────
export async function handleMessage(body) {
  const { phone, text } = parseFBWebhook(body);

  if (!phone || !text) return; // Ignore empty / media-only messages

  // Hard reset: user types RESET at any time
  if (text.toUpperCase() === 'RESET') {
    clearSession(phone);
    clearChatHistory(phone);
    await startAuth(phone);
    return;
  }

  // ── New user — start auth ─────────────────────────────────────────────
  if (isNewUser(phone)) {
    setSession(phone, { phone, mode: 'auth', auth: { step: 'ask_email' }, userId: null, data: {} });
    await startAuth(phone);
    return;
  }

  const session = getSession(phone);
  const mode    = session?.mode || 'auth';

  // ── Auth flow ─────────────────────────────────────────────────────────
  if (mode === 'auth') {
    await handleAuth(phone, text, session);
    return;
  }

  // ── Return-to-menu trigger (type 0 / "menu") ──────────────────────────
  if (isMenuTrigger(text)) {
    if (mode === 'chat') clearChatHistory(phone);
    setSession(phone, { ...session, mode: 'menu', data: {} });
    await sendMainMenu(phone);
    return;
  }

  // ── Menu mode: handle button / text selection ─────────────────────────
  if (mode === 'menu') {
    const t = text.toLowerCase();

    if (t.includes('past paper') || t.includes('download') || t === '1') {
      const data = initResourceSession();
      setSession(phone, { ...session, mode: 'resources', data });
      const updated = await handleResources(phone, text, data);
      setSession(phone, { ...session, mode: 'resources', data: updated });
      return;
    }

    if (t.includes('chat') || t.includes('ai') || t.includes('fundo') || t === '2') {
      setSession(phone, { ...session, mode: 'chat', data: {} });
      await sendText(phone,
        `💬 *Chat with Fundo AI*\n\nHi! I'm Fundo AI, your study assistant 🎓\nAsk me anything — subjects, homework, concepts, or request a PDF document.\n\nType *0* anytime to return to the menu.`
      );
      return;
    }

    // Unrecognised input — re-show menu
    await sendMainMenu(phone);
    return;
  }

  // ── Resources mode ────────────────────────────────────────────────────
  if (mode === 'resources') {
    const data    = session.data || initResourceSession();
    const updated = await handleResources(phone, text, data);
    setSession(phone, { ...session, mode: 'resources', data: updated });
    return;
  }

  // ── Chat mode ─────────────────────────────────────────────────────────
  if (mode === 'chat') {
    await handleChat(phone, text);
    return;
  }

  // Fallback
  setSession(phone, { ...session, mode: 'menu', data: {} });
  await sendMainMenu(phone);
}
