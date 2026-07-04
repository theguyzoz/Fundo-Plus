// utils/verify.js — One-time link verification tokens (web ↔ WhatsApp linking)
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR    = path.join(__dirname, '..', 'data');
const TOKENS_FILE = path.join(DATA_DIR, 'tokens.json');
const TOKEN_TTL   = 15 * 60 * 1000; // 15 minutes

function loadTokens() {
  try { if (fs.existsSync(TOKENS_FILE)) return JSON.parse(fs.readFileSync(TOKENS_FILE,'utf8')); } catch {}
  return {};
}
function saveTokens(t) {
  try { fs.writeFileSync(TOKENS_FILE, JSON.stringify(t, null, 2)); } catch {}
}

/** Generate and persist a one-time token for a web user ID */
export function createVerifyToken(uid) {
  const tokens = loadTokens();
  // Revoke any existing token for this uid
  for (const k of Object.keys(tokens)) { if (tokens[k].uid === uid) delete tokens[k]; }

  const token  = crypto.randomBytes(20).toString('hex');
  tokens[token] = { uid, createdAt: Date.now(), used: false };
  saveTokens(tokens);
  return token;
}

/** Consume a token — returns uid if valid, null otherwise */
export function consumeToken(token) {
  const tokens = loadTokens();
  const entry  = tokens[token];
  if (!entry) return null;
  if (entry.used) return null;
  if (Date.now() - entry.createdAt > TOKEN_TTL) {
    delete tokens[token]; saveTokens(tokens); return null;
  }
  entry.used = true;
  saveTokens(tokens);
  return entry.uid;
}

/** Clean expired tokens (call periodically) */
export function cleanTokens() {
  const tokens = loadTokens();
  const now    = Date.now();
  let changed  = false;
  for (const k of Object.keys(tokens)) {
    if (now - tokens[k].createdAt > TOKEN_TTL || tokens[k].used) {
      delete tokens[k]; changed = true;
    }
  }
  if (changed) saveTokens(tokens);
}
