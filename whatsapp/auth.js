// whatsapp/auth.js — Login / Sign-up flow over WhatsApp (WATI edition)
// Flow:
//   1. Ask for email
//   2a. Email found → ask password → verify → done
//   2b. Email not found → offer login retry OR create account
//   3. Create account: ask name → ask password → ask confirm password → create

import { sendText, sendButtons } from './wa.js';
import { setSession }            from './sessions.js';
import {
  verifyLogin, createUser, isEmailAllowed,
} from '../store.js';

const WEBSITE_URL = process.env.WEBSITE_URL || 'https://fundaplus.up.railway.app';

// ── Entry point: called when mode === 'auth' ──────────────────────────────
export async function handleAuth(phone, text, session) {
  const step = session.auth?.step || 'ask_email';

  switch (step) {
    case 'ask_email':      return askEmail(phone, text, session);
    case 'ask_password':   return askPassword(phone, text, session);
    case 'email_notfound': return emailNotFound(phone, text, session);
    case 'ask_name':       return askName(phone, text, session);
    case 'ask_signup_pass':return askSignupPass(phone, text, session);
    case 'ask_confirm':    return askConfirm(phone, text, session);
    default:
      await startAuth(phone);
  }
}

// ── Send the initial welcome + ask email ─────────────────────────────────
export async function startAuth(phone) {
  await sendText(phone,
    `👋 *Welcome to Fundo Plus!*\n\nYour smart study companion for ZIMSEC O-Level & A-Level.\n\nPlease enter your *email address* to sign in, or type *NEW* to create a free account.`
  );
}

// ── Step 1: Received email ────────────────────────────────────────────────
async function askEmail(phone, text, session) {
  const trimmed = text.trim().toLowerCase();

  // User wants to create a new account
  if (trimmed === 'new') {
    setSession(phone, { auth: { step: 'ask_name' }, data: {} });
    await sendText(phone, `📝 *Create your Fundo Plus account*\n\nEnter your *full name*:`);
    return;
  }

  // Basic email validation
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRe.test(trimmed)) {
    await sendText(phone, `⚠️ That doesn't look like a valid email address.\n\nPlease enter your email, or type *NEW* to create an account.`);
    return;
  }

  if (!isEmailAllowed(trimmed)) {
    await sendText(phone, `⚠️ Only popular email providers are supported (Gmail, Outlook, Yahoo, iCloud, etc.).\n\nPlease use a supported email address.`);
    return;
  }

  // Check if email exists in webusers
  const { store } = await import('../store.js');
  // We use verifyLogin with wrong password to detect existence — 
  // better: scan users directly via a helper
  const exists = await emailExistsInStore(trimmed);

  if (exists) {
    setSession(phone, { auth: { step: 'ask_password', email: trimmed }, data: {} });
    await sendText(phone, `✅ Account found for *${trimmed}*.\n\nPlease enter your *password*:`);
  } else {
    setSession(phone, { auth: { step: 'email_notfound', email: trimmed }, data: {} });
    await sendButtons(phone,
      `❓ We couldn't find an account with *${trimmed}*.\n\nWhat would you like to do?`,
      [
        { text: 'Try a different email' },
        { text: 'Create a new account'  },
      ]
    );
  }
}

// ── Step 2a: Got password for existing account ────────────────────────────
async function askPassword(phone, text, session) {
  const { email } = session.auth;
  const password  = text.trim();

  if (!password || password.length < 4) {
    await sendText(phone, `⚠️ Password seems too short. Please try again:`);
    return;
  }

  const user = verifyLogin({ email, password });
  if (!user) {
    await sendText(phone, `❌ Incorrect password for *${email}*.\n\nPlease try again, or type *RESET* to restart:`);
    return;
  }

  // Success
  setSession(phone, { mode: 'menu', auth: { step: 'done' }, userId: user.id, data: {} });
  await sendText(phone, `✅ *Logged in successfully!*\nWelcome back, *${user.name || user.email}* 👋`);
  // Show the main menu
  const { sendMainMenu } = await import('./menu.js');
  await sendMainMenu(phone);
}

// ── Step 2b: Email not found — button response ────────────────────────────
async function emailNotFound(phone, text, session) {
  const t = text.trim().toLowerCase();

  if (t.includes('different') || t.includes('try') || t === '1') {
    setSession(phone, { auth: { step: 'ask_email' }, data: {} });
    await sendText(phone, `Please enter your *email address*:`);
    return;
  }

  if (t.includes('create') || t.includes('new') || t === '2') {
    setSession(phone, { auth: { step: 'ask_name', email: session.auth.email }, data: {} });
    await sendText(phone, `📝 *Create your Fundo Plus account*\n\nEnter your *full name*:`);
    return;
  }

  // Fallback — show buttons again
  await sendButtons(phone,
    `Please choose an option:`,
    [
      { text: 'Try a different email' },
      { text: 'Create a new account'  },
    ]
  );
}

// ── Step 3: Sign-up — collect name ───────────────────────────────────────
async function askName(phone, text, session) {
  const name = text.trim();
  if (!name || name.length < 2) {
    await sendText(phone, `⚠️ Please enter a valid full name (at least 2 characters):`);
    return;
  }
  setSession(phone, { auth: { ...session.auth, step: 'ask_signup_email', name } });
  await sendText(phone, `👍 Hi *${name}*!\n\nNow enter your *email address*:`);
}

// ── Step 3b: Sign-up — collect email (if they started with NEW) ──────────
export async function handleSignupEmailStep(phone, text, session) {
  const trimmed = text.trim().toLowerCase();
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!emailRe.test(trimmed)) {
    await sendText(phone, `⚠️ Invalid email address. Please try again:`);
    return;
  }
  if (!isEmailAllowed(trimmed)) {
    await sendText(phone, `⚠️ Only popular email providers supported. Please use Gmail, Outlook, Yahoo, or iCloud.`);
    return;
  }
  const exists = await emailExistsInStore(trimmed);
  if (exists) {
    await sendText(phone, `⚠️ That email is already registered. Please sign in instead, or type *RESET* to restart.`);
    return;
  }
  setSession(phone, { auth: { ...session.auth, step: 'ask_signup_pass', email: trimmed } });
  await sendText(phone, `✅ Email set.\n\nNow choose a *password* (min 6 characters):`);
}

// ── Step 4: Sign-up — collect password ───────────────────────────────────
async function askSignupPass(phone, text, session) {
  // Handle the signup_email step inline
  if (session.auth.step === 'ask_signup_email') {
    return handleSignupEmailStep(phone, text, session);
  }

  const password = text.trim();
  if (!password || password.length < 6) {
    await sendText(phone, `⚠️ Password must be at least 6 characters. Please try again:`);
    return;
  }
  setSession(phone, { auth: { ...session.auth, step: 'ask_confirm', password } });
  await sendText(phone, `🔒 *Confirm your password* — type it again:`);
}

// ── Step 5: Sign-up — confirm password ───────────────────────────────────
async function askConfirm(phone, text, session) {
  const { name, email, password } = session.auth;

  if (text.trim() !== password) {
    await sendText(phone, `❌ Passwords don't match. Please enter your password again:`);
    setSession(phone, { auth: { ...session.auth, step: 'ask_signup_pass', password: undefined } });
    return;
  }

  const result = createUser({ email, phone, password, name });
  if (!result.ok) {
    await sendText(phone, `⚠️ Could not create account: ${result.error}\n\nType *RESET* to start over.`);
    return;
  }

  setSession(phone, { mode: 'menu', auth: { step: 'done' }, userId: result.id, data: {} });
  await sendText(phone,
    `🎉 *Account created!*\n\nWelcome to Fundo Plus, *${name}*!\n\nYou can also sign in at ${WEBSITE_URL}`
  );
  const { sendMainMenu } = await import('./menu.js');
  await sendMainMenu(phone);
}

// ── Helper: check if an email exists in webusers ─────────────────────────
async function emailExistsInStore(email) {
  const { getAllWebUsers } = await import('../store.js');
  const users = getAllWebUsers ? getAllWebUsers() : [];
  const lower = email.toLowerCase();
  if (Array.isArray(users)) {
    return users.some(u => u.email?.toLowerCase() === lower);
  }
  // getAllWebUsers might return an object
  return Object.values(users).some(u => u.email?.toLowerCase() === lower);
}
