// whatsapp/wati.js — WATI.io API client for Fundo Plus
// All outbound calls to WATI go through here.

const WATI_BASE  = process.env.WATI_API_ENDPOINT; // e.g. https://live-server-XXXXX.wati.io
const WATI_TOKEN = process.env.WATI_API_TOKEN;     // Bearer token from WATI dashboard

if (!WATI_BASE || !WATI_TOKEN) {
  console.warn('⚠️  WATI_API_ENDPOINT or WATI_API_TOKEN not set — WhatsApp features disabled.');
}

function headers() {
  return {
    'Content-Type' : 'application/json',
    'Authorization': `Bearer ${WATI_TOKEN}`,
  };
}

// Normalise a phone number to the format WATI expects: digits only, with country code, no +
function normalisePhone(phone) {
  return String(phone).replace(/\D/g, '');
}

// ── Send a plain text message ─────────────────────────────────────────────
export async function sendText(phone, message) {
  const url = `${WATI_BASE}/api/v1/sendSessionMessage/${normalisePhone(phone)}`;
  const res  = await fetch(url, {
    method : 'POST',
    headers: headers(),
    body   : JSON.stringify({ messageText: message }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) console.error('[WATI] sendText error:', json);
  return json;
}

// ── Send interactive buttons (max 3 buttons in WATI) ─────────────────────
// buttons = [{ text: 'Button label' }, ...]
export async function sendButtons(phone, bodyText, buttons) {
  const url = `${WATI_BASE}/api/v1/sendInteractiveButtonsMessage?whatsappNumber=${normalisePhone(phone)}`;
  const payload = {
    body: bodyText,
    buttons: buttons.map((b, i) => ({ text: b.text })),
  };
  const res  = await fetch(url, {
    method : 'POST',
    headers: headers(),
    body   : JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) console.error('[WATI] sendButtons error:', json);
  return json;
}

// ── Send a list message (for numbered resource lists) ─────────────────────
// sections = [{ title, rows: [{ id, title, description }] }]
export async function sendList(phone, bodyText, buttonText, sections) {
  const url = `${WATI_BASE}/api/v1/sendInteractiveListMessage?whatsappNumber=${normalisePhone(phone)}`;
  const payload = {
    body      : bodyText,
    buttonText: buttonText || 'Select',
    sections,
  };
  const res  = await fetch(url, {
    method : 'POST',
    headers: headers(),
    body   : JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) console.error('[WATI] sendList error:', json);
  return json;
}

// ── Send a document/file by URL ───────────────────────────────────────────
export async function sendDocument(phone, fileUrl, filename, caption) {
  const url = `${WATI_BASE}/api/v1/sendFileMessage?whatsappNumber=${normalisePhone(phone)}`;
  const payload = {
    mimeType: 'application/pdf',
    fileName: filename,
    url     : fileUrl,
    caption : caption || '',
  };
  const res  = await fetch(url, {
    method : 'POST',
    headers: headers(),
    body   : JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) console.error('[WATI] sendDocument error:', json);
  return json;
}
