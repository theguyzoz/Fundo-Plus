// whatsapp/sessions.js — In-memory session state for Fundo Plus (WATI edition)

const sessions = new Map();           // phone → session object
const SESSION_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const timers   = new Map();

/*
  Session shape:
  {
    phone  : '2637XXXXXXXX',
    mode   : 'auth' | 'menu' | 'resources' | 'chat',
    auth   : { step: 'ask_email'|'ask_password'|'ask_name'|'ask_signup_password'|'ask_confirm_password', email?, name? },
    userId : string | null,    — populated after successful login/signup
    data   : {}                — mode-specific state
  }
*/

export function getSession(phone) {
  return sessions.get(phone) || null;
}

export function setSession(phone, updates) {
  const existing = sessions.get(phone) || { phone, mode: 'auth', auth: { step: 'ask_email' }, userId: null, data: {} };
  sessions.set(phone, { ...existing, ...updates });
  resetTimer(phone);
}

export function clearSession(phone) {
  sessions.delete(phone);
  clearTimer(phone);
}

export function isNewUser(phone) {
  return !sessions.has(phone);
}

function resetTimer(phone) {
  clearTimer(phone);
  const handle = setTimeout(() => {
    sessions.delete(phone);
    timers.delete(phone);
    // Session expired silently — user will restart on next message
  }, SESSION_TIMEOUT_MS);
  timers.set(phone, handle);
}

function clearTimer(phone) {
  if (timers.has(phone)) {
    clearTimeout(timers.get(phone));
    timers.delete(phone);
  }
}
