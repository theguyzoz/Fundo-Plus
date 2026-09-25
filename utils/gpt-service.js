// utils/gpt-service.js - Resilient AI service for Fundo Plus.
//
// Primary: GPT-OSS-120B worker proxy. Fallback: Google Gemini (if GEMINI_API_KEY set).
// Hardening: per-call timeouts, 1 retry on retryable errors, circuit breaker,
// per-provider telemetry. System instructions are folded into a leading user
// turn because the primary backend strips the `system` role.
//
// Env overrides (all optional):
//   AI_PRIMARY_URL, AI_PRIMARY_MODEL, AI_PROXY_KEY,
//   GEMINI_API_KEY, GEMINI_MODEL (default gemini-2.0-flash), GEMINI_BASE_URL,
//   AI_TIMEOUT_MS (default 60000), AI_BREAKER_FAILS (default 5),
//   AI_BREAKER_COOLDOWN_MS (default 60000)

const PRIMARY_URL =
  process.env.AI_PRIMARY_URL || 'https://openai.junioralive.workers.dev/v1/chat/completions';
const PRIMARY_MODEL = process.env.AI_PRIMARY_MODEL || 'gpt-oss-120b';
const PRIMARY_KEY =
  process.env.AI_PROXY_KEY || 'ish-7f9e2c1b-5c8a-4b0f-9a7d-1e5c3b2a9f74';

const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const GEMINI_BASE =
  process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';

const DEFAULT_TIMEOUT_MS = parseInt(process.env.AI_TIMEOUT_MS || '60000', 10) || 60000;
const BREAKER_THRESHOLD = parseInt(process.env.AI_BREAKER_FAILS || '5', 10) || 5;
const BREAKER_COOLDOWN_MS =
  parseInt(process.env.AI_BREAKER_COOLDOWN_MS || '60000', 10) || 60000;

// --- circuit breaker + telemetry (in-memory, per process) ---
const stats = {
  primary: { fails: 0, openedAt: 0, lastError: '', lastOkAt: 0, lastLatencyMs: 0, calls: 0 },
  gemini: { fails: 0, lastError: '', lastOkAt: 0, lastLatencyMs: 0, calls: 0 },
};

function breakerOpen() {
  const p = stats.primary;
  if (p.fails < BREAKER_THRESHOLD) return false;
  if (Date.now() - p.openedAt > BREAKER_COOLDOWN_MS) return false; // half-open: allow a probe
  return true;
}

function recordOk(which, ms) {
  const s = stats[which];
  s.calls += 1;
  s.fails = 0;
  s.lastOkAt = Date.now();
  s.lastLatencyMs = ms;
  s.lastError = '';
  if (which === 'primary') s.openedAt = 0;
}

function recordFail(which, err) {
  const s = stats[which];
  s.calls += 1;
  s.fails += 1;
  s.lastError = String(err || 'unknown error').slice(0, 200);
  if (which === 'primary' && s.fails >= BREAKER_THRESHOLD && !s.openedAt) {
    s.openedAt = Date.now();
  }
}

/** Provider health snapshot for /api/ai/status (circuit state, no live probing). */
export function getAiStatus() {
  const open = breakerOpen();
  return {
    ts: new Date().toISOString(),
    degraded: open,
    primary: {
      name: PRIMARY_MODEL,
      up: !open,
      circuitOpen: open,
      consecutiveFails: stats.primary.fails,
      lastError: stats.primary.lastError,
      lastLatencyMs: stats.primary.lastLatencyMs,
      lastOkAt: stats.primary.lastOkAt || null,
      calls: stats.primary.calls,
    },
    fallback: {
      name: GEMINI_MODEL,
      configured: !!GEMINI_KEY,
      consecutiveFails: stats.gemini.fails,
      lastError: stats.gemini.lastError,
      lastLatencyMs: stats.gemini.lastLatencyMs,
      lastOkAt: stats.gemini.lastOkAt || null,
      calls: stats.gemini.calls,
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postJson(url, headers, body, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(t);
  }
}

function retryable(err, status) {
  if (status === 429 || (status >= 500 && status <= 599)) return true;
  const m = String((err && err.message) || err || '').toLowerCase();
  return (
    m.includes('abort') ||
    m.includes('timeout') ||
    m.includes('timed out') ||
    m.includes('fetch failed') ||
    m.includes('econn') ||
    m.includes('socket') ||
    m.includes('network') ||
    m.includes('dns') ||
    m.includes('enotfound')
  );
}

function httpError(status, txt) {
  const e = new Error(`HTTP ${status}: ${String(txt || '').slice(0, 200)}`);
  e.status = status;
  return e;
}

// The primary backend strips `system` messages, so fold every system
// instruction into a leading user turn. Callers keep passing
// `systemInstruction` exactly as before - nothing else changes.
function buildMessages(systemInstruction, messages, message) {
  const sysParts = [];
  if (systemInstruction && String(systemInstruction).trim()) {
    sysParts.push(String(systemInstruction).trim());
  }
  const rest = [];
  for (const m of messages || []) {
    if (!m) continue;
    if (m.role === 'system' && m.content) sysParts.push(String(m.content).trim());
    else if (m.content != null && String(m.content).trim()) {
      rest.push({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: String(m.content),
      });
    }
  }
  if (message != null && String(message).trim()) {
    rest.push({ role: 'user', content: String(message) });
  }
  if (sysParts.length) {
    rest.unshift({
      role: 'user',
      content: `Instructions - follow these for every reply:\n${sysParts.join('\n\n')}`,
    });
  }
  return rest;
}

async function callPrimary(messageArray, { temperature, top_p, top_k, max_tokens, timeoutMs }) {
  const t0 = Date.now();
  const r = await postJson(
    PRIMARY_URL,
    {
      'Content-Type': 'application/json',
      Origin: 'https://ish.chat',
      Referer: 'https://ish.chat/',
      'User-Agent': 'Mozilla/5.0',
      'x-proxy-key': PRIMARY_KEY,
    },
    {
      model: PRIMARY_MODEL,
      messages: messageArray,
      temperature,
      top_p,
      top_k,
      max_tokens,
      stream: false,
    },
    timeoutMs
  );
  if (!r.ok) throw httpError(r.status, await r.text().catch(() => ''));
  const data = await r.json().catch(() => null);
  const answer = data?.choices?.[0]?.message?.content;
  if (!answer || !String(answer).trim()) throw new Error('Primary AI returned an empty response');
  return { answer: String(answer), ms: Date.now() - t0 };
}

async function callGemini(messageArray, { temperature, top_p, max_tokens, timeoutMs }) {
  const t0 = Date.now();
  const contents = messageArray.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const url = `${GEMINI_BASE}/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`;
  const r = await postJson(
    url,
    { 'Content-Type': 'application/json' },
    {
      contents,
      generationConfig: {
        temperature,
        topP: top_p,
        maxOutputTokens: max_tokens,
      },
    },
    timeoutMs
  );
  if (!r.ok) throw httpError(r.status, await r.text().catch(() => ''));
  const data = await r.json().catch(() => null);
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const answer = parts.map((p) => p.text || '').join('');
  if (!answer || !answer.trim()) throw new Error('Gemini returned an empty response');
  return { answer: String(answer), ms: Date.now() - t0 };
}

/**
 * Resilient chat completion.
 * @param {{ message?: string, messages?: Array, systemInstruction?: string,
 *   temperature?: number, top_p?: number, top_k?: number, max_tokens?: number,
 *   timeoutMs?: number }} config
 * @returns {Promise<{ success: boolean, answer?: string, error?: string,
 *   model?: string, via?: 'primary'|'gemini', aiDown?: boolean }>}
 */
export async function gpt4oChat(config = {}) {
  const {
    message,
    messages = [],
    systemInstruction = '',
    temperature = 0.7,
    top_p = 0.7,
    top_k = 40,
    max_tokens = 512,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = config;

  const messageArray = buildMessages(systemInstruction, messages, message);
  if (!messageArray.length) {
    return { success: false, error: 'No message or conversation history provided' };
  }

  const opts = { temperature, top_p, top_k, max_tokens, timeoutMs };

  // PRIMARY (skipped while the circuit is open - fail fast to fallback)
  if (!breakerOpen()) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { answer, ms } = await callPrimary(messageArray, opts);
        recordOk('primary', ms);
        return { success: true, answer, model: PRIMARY_MODEL, via: 'primary' };
      } catch (e) {
        if (attempt === 0 && retryable(e, e.status)) {
          await sleep(800);
          continue;
        }
        recordFail('primary', e.message);
        break;
      }
    }
  }

  // FALLBACK: Gemini (only if configured)
  if (GEMINI_KEY) {
    try {
      const { answer, ms } = await callGemini(messageArray, opts);
      recordOk('gemini', ms);
      return { success: true, answer, model: GEMINI_MODEL, via: 'gemini' };
    } catch (e) {
      recordFail('gemini', e.message);
    }
  }

  const err = stats.primary.lastError || 'AI service unavailable';
  console.error('[GPT Service] all providers failed:', err);
  return {
    success: false,
    aiDown: true,
    error: /^HTTP 4/.test(err) ? err : `AI temporarily unavailable (${err.slice(0, 140)}). Please try again shortly.`,
  };
}

export default gpt4oChat;
