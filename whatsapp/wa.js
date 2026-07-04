// whatsapp/wa.js — Facebook WhatsApp Cloud API client for Fundo Plus
// Replaces wati.js — all outbound messages go through here.
//
// Required env vars:
//   WA_PHONE_NUMBER_ID  — WhatsApp Phone Number ID from Meta developer console
//   WA_ACCESS_TOKEN     — Permanent system user token (or temp token for dev)
//   WA_VERIFY_TOKEN     — Any string you set in the Facebook webhook config

const BASE = 'https://graph.facebook.com/v21.0';

function phoneId() {
  return process.env.WA_PHONE_NUMBER_ID || '';
}

function token() {
  return process.env.WA_ACCESS_TOKEN || '';
}

if (!phoneId() || !token()) {
  console.warn('⚠️  WA_PHONE_NUMBER_ID or WA_ACCESS_TOKEN not set — WhatsApp features disabled.');
}

// Normalise phone: digits only with country code, no +
function normalisePhone(phone) {
  return String(phone).replace(/\D/g, '');
}

async function post(payload) {
  const url = `${BASE}/${phoneId()}/messages`;
  const res  = await fetch(url, {
    method : 'POST',
    headers: {
      'Content-Type' : 'application/json',
      'Authorization': `Bearer ${token()}`,
    },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) console.error('[WA] API error:', JSON.stringify(json));
  return json;
}

// ── Send a plain text message ─────────────────────────────────────────────
export async function sendText(phone, message) {
  return post({
    messaging_product: 'whatsapp',
    to               : normalisePhone(phone),
    type             : 'text',
    text             : { body: message },
  });
}

// ── Send interactive reply buttons (max 3) ────────────────────────────────
// buttons = [{ text: 'Label' }, ...]
export async function sendButtons(phone, bodyText, buttons) {
  const payload = {
    messaging_product: 'whatsapp',
    to               : normalisePhone(phone),
    type             : 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: buttons.slice(0, 3).map((b, i) => ({
          type : 'reply',
          reply: { id: `btn_${i}`, title: b.text.slice(0, 20) },
        })),
      },
    },
  };
  return post(payload);
}

// ── Send an interactive list message ─────────────────────────────────────
// sections = [{ title, rows: [{ id, title, description }] }]
export async function sendList(phone, bodyText, buttonText, sections) {
  return post({
    messaging_product: 'whatsapp',
    to               : normalisePhone(phone),
    type             : 'interactive',
    interactive: {
      type: 'list',
      body: { text: bodyText },
      action: {
        button  : buttonText || 'Select',
        sections,
      },
    },
  });
}

// ── Send a document by URL ────────────────────────────────────────────────
export async function sendDocument(phone, fileUrl, filename, caption) {
  return post({
    messaging_product: 'whatsapp',
    to               : normalisePhone(phone),
    type             : 'document',
    document: {
      link    : fileUrl,
      filename: filename || 'document.pdf',
      caption : caption  || '',
    },
  });
}
