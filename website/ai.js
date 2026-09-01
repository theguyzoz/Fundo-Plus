import { gpt4oChat } from '../utils/gpt-service.js';

const SYSTEM_PROMPT = `You are Fundo AI, the intelligent study assistant powering Fundo Plus — an education platform for Zimbabwean students.

You run inside a web app. Responses are rendered as HTML with KaTeX for mathematics.

FORMATTING:
- Use $...$ for inline math and $$...$$ for display math. KaTeX renders these automatically.
- Use **bold**, bullet points, numbered lists where helpful.
- For code use triple backtick blocks.
- Keep answers clear, educational, and warm.

MATHEMATICS — always use KaTeX LaTeX:
- Inline: $x = \\\\frac{-b \\\\pm \\\\sqrt{b^2 - 4ac}}{2a}$
- Display: $$\\\\int_0^\\\\infty e^{-x^2}\\\\,dx = \\\\frac{\\\\sqrt{\\\\pi}}{2}$$
- Fractions: $\\\\frac{a}{b}$  Powers: $x^{n}$  Roots: $\\\\sqrt{x}$  Subscripts: $a_n$

SUBJECTS: ZIMSEC O-Level and A-Level — Maths, Physics, Chemistry, Biology, Accounts, Commerce, History, Geography, English, Shona, Ndebele and more.

PDF / DOCUMENTS — you CAN create them. Fundo Plus generates the file, hosts it, and the student downloads it. Never say you cannot make, host, attach, or download a PDF. Never refuse a PDF request.

When the user wants a PDF, notes pack, handout, revision booklet, or study document:
1. Write 2–3 short sentences in chat confirming you are creating it (mention it is hosted on Fundo Plus and deleted after 24 hours).
2. Then output EXACTLY this block (no fences):

__FRIENO_MAKE_PDF__
TITLE: <clear title>
CONTENT:
<full document>

CONTENT RULES (same grade as Fundo project generator):
- Minimum ~2,500 words so the PDF is at least 6 pages (aim 8–12).
- Start with # title, then ## and ### headings.
- ZIMSEC-aligned, Zimbabwe examples, exam tips, definitions, worked examples, practice questions with answers, a short recap.
- Use $...$ for math. No preamble like "Sure" inside CONTENT.

TOOLS — only output the marker line when triggered:
- Web search needed: __FRIENO_WEB_SEARCH__\\nQUERY: <query>
- Image search: __FRIENO_IMAGE_SEARCH__\\nQUERY: <query>
- Make PDF: __FRIENO_MAKE_PDF__\\nTITLE: <title>\\nCONTENT:\\n<content>
- Make Word doc: __FRIENO_MAKE_DOCX__\\nTITLE: <title>\\nCONTENT:\\n<content>
- Generate image: __FRIENO_MAKE_IMAGE__\\nPROMPT: <prompt>

You cannot recall previous sessions. Be encouraging — many users are preparing for exams.`;

const PDF_EXPAND_PROMPT = `You are Fundo AI Document Engine for Fundo Plus.
Write a high-grade ZIMSEC study PDF body. Output ONLY:

__FRIENO_MAKE_PDF__
TITLE: <title>
CONTENT:
<document>

Rules:
- At least 2,500 words (6+ PDF pages; prefer 8–12).
- # / ## / ### headings, Zimbabwe context, definitions, worked examples, practice Q&A, exam tips, recap.
- $LaTeX$ for maths. No chat, no apology, no "I cannot".`;

const histories = new Map();
const MAX_HISTORY = 12;

function getHistory(uid) {
  if (!histories.has(uid)) histories.set(uid, []);
  return histories.get(uid);
}
function pushHistory(uid, role, content) {
  const h = getHistory(uid);
  h.push({ role, content });
  while (h.length > MAX_HISTORY * 2) h.splice(0, 2);
}

async function callGPT(system, messages, max_tokens = 1500) {
  const result = await gpt4oChat({ systemInstruction: system, messages, temperature: 0.8, top_p: 0.95, top_k: 40, max_tokens });
  if (!result.success) throw new Error(result.error || 'GPT failed');
  const reply = result.answer;
  if (!reply || typeof reply !== 'string' || !reply.trim()) throw new Error('Empty response');
  return reply.trim();
}

export function wantsPdf(msg) {
  return /\b(pdf|handout|revision (pack|booklet)|study (notes|pack|document)|make (me )?(a )?(document|notes)|generate (me )?(a )?(pdf|document|notes)|export (as |to )?pdf|as a pdf|in pdf)\b/i.test(String(msg || ''));
}

export function looksLikePdfRefusal(text) {
  return /\b(can('t|not)|unable to|don'?t have the (ability|capability)|i (cannot|can't) (create|generate|make|host|provide|attach|upload))\b.{0,80}\b(pdf|file|document|download)\b/i.test(String(text || ''));
}

export function parsePdfMarker(text) {
  const raw = String(text || '');
  const idx = raw.search(/__FRIENO_MAKE_PDF__/i);
  if (idx < 0) return null;
  const block = raw.slice(idx);
  const titleM = block.match(/TITLE:\s*(.+)/i);
  const contentM = block.match(/CONTENT:\s*([\s\S]*)/i);
  const title = (titleM && titleM[1] ? titleM[1] : 'Study notes').trim().slice(0, 120);
  const content = (contentM && contentM[1] ? contentM[1] : '').trim();
  const preface = raw.slice(0, idx).trim();
  return { title, content, preface };
}

export function stripPdfMarker(text) {
  return String(text || '').replace(/__FRIENO_MAKE_PDF__[\s\S]*$/i, '').trim();
}

function wordCount(s) {
  return String(s || '').trim().split(/\s+/).filter(Boolean).length;
}

export async function expandPdfContent(title, seed, userMessage) {
  const messages = [{
    role: 'user',
    content: `Title: ${title || 'Study notes'}\nStudent request: ${userMessage}\n\nDraft to expand (may be empty):\n${(seed || '').slice(0, 4000)}\n\nWrite the full PDF body now.`,
  }];
  const reply = await callGPT(PDF_EXPAND_PROMPT, messages, 4096);
  const parsed = parsePdfMarker(reply);
  if (parsed && wordCount(parsed.content) >= 400) return parsed;
  return { title: title || 'Study notes', content: reply.replace(/__FRIENO_MAKE_PDF__/i, '').replace(/^TITLE:.*$/im, '').replace(/^CONTENT:\s*/im, '').trim(), preface: '' };
}

export async function askWebAI(uid, userMessage) {
  const history = getHistory(uid).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
  const messages = [...history, { role: 'user', content: userMessage }];
  const tokens = wantsPdf(userMessage) ? 4096 : 2000;
  try {
    const reply = await callGPT(SYSTEM_PROMPT, messages, tokens);
    pushHistory(uid, 'user', userMessage);
    pushHistory(uid, 'assistant', stripPdfMarker(reply) || reply);
    return reply;
  } catch (err) {
    console.error('askWebAI failed:', err.message);
    return 'Fundo AI is temporarily unavailable. Please try again.';
  }
}

export async function askWebAIForDoc(uid, prompt) {
  const messages = [{ role: 'user', content: prompt }];
  try {
    const reply = await callGPT(PDF_EXPAND_PROMPT, messages, 4096);
    if (reply && reply.length > 200) return reply;
    throw new Error('Too short');
  } catch (err) {
    return askWebAI(uid, prompt);
  }
}

export function clearWebHistory(uid) { histories.delete(uid); }
