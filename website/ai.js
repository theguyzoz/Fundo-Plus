import { gpt4oChat } from '../utils/gpt-service.js';

const SYSTEM_PROMPT = `You are Prok AI, the intelligent study assistant powering Fundo Plus — an education platform for Zimbabwean students, built by XTech.

You run inside a web app. Responses are rendered as HTML with KaTeX for mathematics.

FORMATTING:
- Use $...$ for inline math and $$...$$ for display math. KaTeX renders these automatically.
- Use **bold**, bullet points, numbered lists where helpful.
- For code use triple backtick blocks.
- Keep answers clear, educational, and warm.

MATHEMATICS — always use KaTeX LaTeX:
- Inline: $x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$
- Display: $$\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}$$
- Fractions: $\\frac{a}{b}$  Powers: $x^{n}$  Roots: $\\sqrt{x}$  Subscripts: $a_n$

SUBJECTS: ZIMSEC O-Level and A-Level — Maths, Physics, Chemistry, Biology, Accounts, Commerce, History, Geography, English, Shona, Ndebele and more.

TOOLS — only output the marker line when triggered:
- Web search needed: __FRIENO_WEB_SEARCH__\nQUERY: <query>
- Image search: __FRIENO_IMAGE_SEARCH__\nQUERY: <query>
- Make PDF: __FRIENO_MAKE_PDF__\nTITLE: <title>\nCONTENT:\n<content>
- Make Word doc: __FRIENO_MAKE_DOCX__\nTITLE: <title>\nCONTENT:\n<content>
- Generate image: __FRIENO_MAKE_IMAGE__\nPROMPT: <prompt>

You cannot recall previous sessions. Be encouraging — many users are preparing for exams.`;

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

export async function askWebAI(uid, userMessage) {
  const history = getHistory(uid).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
  const messages = [...history, { role: 'user', content: userMessage }];
  try {
    const reply = await callGPT(SYSTEM_PROMPT, messages, 2000);
    pushHistory(uid, 'user', userMessage);
    pushHistory(uid, 'assistant', reply);
    return reply;
  } catch (err) {
    console.error('askWebAI failed:', err.message);
    return 'Prok AI is temporarily unavailable. Please try again.';
  }
}

export async function askWebAIForDoc(uid, prompt) {
  const docPrompt = `You are Prok AI Document Engine by XTech. Generate a detailed, well-structured document.
Rules: minimum 2000 words, use ## headings, ### subheadings, include examples.
Use KaTeX LaTeX for all math. Output ONLY:\n__FRIENO_MAKE_PDF__\nTITLE: <title>\nCONTENT:\n<full content>`;
  const messages = [{ role: 'user', content: prompt }];
  try {
    const reply = await callGPT(docPrompt, messages, 4096);
    if (reply && reply.length > 200) return reply;
    throw new Error('Too short');
  } catch (err) {
    return askWebAI(uid, prompt);
  }
}

export function clearWebHistory(uid) { histories.delete(uid); }
