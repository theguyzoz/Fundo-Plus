// whatsapp/chat.js — Chat with Fundo AI (WATI edition)

import { sendText }      from './wa.js';
import { gpt4oChat }     from '../utils/gpt-service.js';
import { RETURN_PROMPT } from './menu.js';
import { generatePdf }   from '../utils/pdfgen.js';
import { v4 as uuidv4 }  from 'uuid';
import path              from 'path';
import { fileURLToPath } from 'url';
import fs                from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMP_DIR  = path.join(__dirname, '..', 'temp');

const PDF_TRIGGER_MARKER = '__PROK_MAKE_PDF__';

const SYSTEM_PROMPT = `You are Fundo AI, the friendly AI assistant for Fundo Plus — an educational platform for Zimbabwean students (ZIMSEC O-Level and A-Level).

PERSONALITY: Warm, encouraging, knowledgeable. Speak clearly and simply.

OUTPUT FORMAT (WhatsApp ONLY):
- Use *word* to bold important terms (single asterisk each side — WhatsApp style).
- Plain text only. NO HTML, NO LaTeX, NO markdown headers (##), NO bullet dashes unless listing items.
- Keep answers concise and mobile-friendly.
- If the student wants a PDF (study notes, summary, document), respond ONLY with:
${PDF_TRIGGER_MARKER}
TITLE: <title>
CONTENT:
<full document content with ## headings and bullet points, minimum 800 words>

SCOPE: You can discuss academics, study tips, ZIMSEC subjects.
You CANNOT search the web — tell users if something is outside your knowledge.
Never mention your underlying model. You are Fundo AI by Fundo Plus.`;

const histories = new Map();
const MAX_HISTORY = 12;

function getHistory(phone) {
  if (!histories.has(phone)) histories.set(phone, []);
  return histories.get(phone);
}

function pushHistory(phone, role, content) {
  const h = getHistory(phone);
  h.push({ role, content });
  while (h.length > MAX_HISTORY * 2) h.splice(0, 2);
}

export function clearChatHistory(phone) {
  histories.delete(phone);
}

export async function handleChat(phone, text) {
  const history  = getHistory(phone).map(m => ({ role: m.role, content: m.content }));
  const messages = [...history, { role: 'user', content: text }];

  try {
    const result = await gpt4oChat({
      systemInstruction: SYSTEM_PROMPT,
      messages,
      max_tokens: 1024,
      temperature: 0.8,
    });

    if (!result.success) throw new Error(result.error || 'AI unavailable');

    const reply = result.answer.trim();
    pushHistory(phone, 'user', text);
    pushHistory(phone, 'assistant', reply);

    // PDF generation
    if (reply.includes(PDF_TRIGGER_MARKER)) {
      const trigger = parseTrigger(reply);
      if (trigger) {
        await sendText(phone, '📄 Generating your PDF, one moment...');
        try {
          if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
          const jobId   = uuidv4();
          const outPath = await generatePdf(trigger.title, trigger.content, jobId, TEMP_DIR);
          const pdfBuf  = fs.readFileSync(outPath);
          fs.unlinkSync(outPath);

          // WATI needs a URL — upload to a public temp path if possible,
          // otherwise fall back to sending the text content
          const BASE     = process.env.WEBSITE_URL || 'https://fundaplus.up.railway.app';
          const filename = `${trigger.title.replace(/[^a-zA-Z0-9 ]/g, '').trim() || 'document'}.pdf`;
          const tempName = `${jobId}-${filename}`;
          const pubPath  = path.join(__dirname, '..', 'temp', tempName);
          fs.writeFileSync(pubPath, pdfBuf);
          const fileUrl = `${BASE}/temp/${tempName}`;

          const { sendDocument } = await import('./wa.js');
          await sendDocument(phone, fileUrl, filename, `📄 ${trigger.title}`);
        } catch (pdfErr) {
          console.error('[Chat] PDF gen error:', pdfErr.message);
          await sendText(phone, '⚠️ PDF generation failed. Here is the content:\n\n' + trigger.content.slice(0, 1500));
        }
        await sendText(phone, RETURN_PROMPT);
        return;
      }
    }

    await sendText(phone, reply + RETURN_PROMPT);
  } catch (err) {
    console.error('[Chat] Error:', err.message);
    await sendText(phone, '⚠️ Fundo AI is having trouble responding right now. Please try again.' + RETURN_PROMPT);
  }
}

function parseTrigger(reply) {
  const titleMatch   = reply.match(/TITLE:\s*(.+)/);
  const contentMatch = reply.match(/CONTENT:\n([\s\S]+)/);
  if (!titleMatch || !contentMatch) return null;
  return { title: titleMatch[1].trim(), content: contentMatch[1].trim() };
}
