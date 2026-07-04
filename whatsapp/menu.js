// whatsapp/menu.js — Main menu builder (WATI edition)

import { sendText, sendButtons } from './wa.js';

export const RETURN_PROMPT = '\n\nType *0* to return to the main menu.';

// ── Send the main menu with interactive buttons ───────────────────────────
export async function sendMainMenu(phone) {
  await sendButtons(phone,
    `📚 *Fundo Plus — Main Menu*\n\nWhat would you like to do?`,
    [
      { text: '📄 Download Past Papers' },
      { text: '💬 Chat with Fundo AI'   },
    ]
  );
}

// ── Check if a message is a "return to menu" trigger ─────────────────────
export function isMenuTrigger(text) {
  const t = text.trim().toLowerCase();
  return t === '0' || t === 'menu' || t === 'main menu' || t === 'back';
}
