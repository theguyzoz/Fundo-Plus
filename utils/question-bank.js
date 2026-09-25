// utils/question-bank.js - Curated ZIMSEC question bank.
//
// JSON files in /bank ship with the repo (NOT in gitignored data/), so quizzes
// can be served with zero AI calls — and zero quota. AI-generated stockpile
// items can be appended later via addQuestions() (source: 'ai-stockpile').

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BANK_DIR = path.join(__dirname, '..', 'bank');
const HISTORY_FILE = path.join(__dirname, '..', 'data', 'bank-history.json');

const DIFFS = ['easy', 'medium', 'hard'];
const ALIASES = {
  maths: 'mathematics',
  math: 'mathematics',
  bio: 'biology',
  eng: 'english',
  englishlanguage: 'english',
};

let cache = null;

export function loadBank(force = false) {
  if (cache && !force) return cache;
  const subjects = [];
  if (fs.existsSync(BANK_DIR)) {
    for (const f of fs.readdirSync(BANK_DIR).filter((f) => f.endsWith('.json'))) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(BANK_DIR, f), 'utf8'));
        const questions = (raw.questions || []).filter(validBankItem);
        subjects.push({
          subject: String(raw.subject || f.replace(/\.json$/, '')),
          level: String(raw.level || 'O-Level'),
          file: f,
          questions,
        });
      } catch (e) {
        console.warn('[bank] skipping', f, '-', e.message);
      }
    }
  }
  cache = { subjects };
  return cache;
}

export function reloadBank() {
  return loadBank(true);
}

function validBankItem(q) {
  if (!q || typeof q.question !== 'string' || q.question.trim().length < 5) return false;
  if (q.type !== 'mcq' && q.type !== 'short') return false;
  if (typeof q.answer !== 'string' || !q.answer.trim()) return false;
  if (q.type === 'mcq') {
    const opts = q.options || {};
    const keys = ['A', 'B', 'C', 'D'].filter((k) => opts[k] && String(opts[k]).trim());
    if (keys.length < 2) return false;
    if (!keys.includes(String(q.answer).trim().toUpperCase())) return false;
    const vals = keys.map((k) => String(opts[k]).trim().toLowerCase());
    if (new Set(vals).size !== vals.length) return false; // dup options break shuffle remap
  }
  return true;
}

/** Fuzzy subject match: exact, alias, then prefix. Returns canonical name or null. */
export function matchSubject(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return null;
  const { subjects } = loadBank();
  for (const s of subjects) {
    if (s.subject.toLowerCase() === n) return s.subject;
  }
  const alias = ALIASES[n.replace(/\s+/g, '')] || ALIASES[n];
  if (alias) {
    const hit = subjects.find((s) => s.subject.toLowerCase() === alias);
    if (hit) return hit.subject;
  }
  for (const s of subjects) {
    const sl = s.subject.toLowerCase();
    if (sl.startsWith(n) || n.startsWith(sl)) return s.subject;
  }
  return null;
}

/** Metadata for UIs (subjects, topics, counts — never answers). */
export function getBankMeta() {
  const { subjects } = loadBank();
  return subjects.map((s) => {
    const topics = {};
    for (const q of s.questions) {
      const t = q.topic || 'General';
      topics[t] = topics[t] || { topic: t, total: 0, mcq: 0, short: 0 };
      topics[t].total += 1;
      topics[t][q.type] += 1;
    }
    return {
      subject: s.subject,
      level: s.level,
      total: s.questions.length,
      topics: Object.values(topics).sort((a, b) => a.topic.localeCompare(b.topic)),
    };
  });
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function loadHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveHistory(h) {
  try {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(h));
  } catch (e) {
    console.warn('[bank] history write:', e.message);
  }
}

/** Remember served bank ids per user (cap 300) so quizzes stay fresh. */
export function recordServed(uid, bankIds) {
  if (!uid || !bankIds || !bankIds.length) return;
  const h = loadHistory();
  const arr = [...(h[uid] || [])];
  for (const id of bankIds) {
    const i = arr.indexOf(id);
    if (i >= 0) arr.splice(i, 1);
    arr.push(id);
  }
  h[uid] = arr.slice(-300);
  saveHistory(h);
}

/**
 * Pick bank questions in quiz shape ({id,type,question,options,answer,explanation,
 * bankId,topic}). MCQ options are shuffled per serving with the answer remapped.
 */
export function pickQuestions({ subject, topic = '', count = 10, style = 'mixed', difficulty = 'mixed', uid = null } = {}) {
  const { subjects } = loadBank();
  const subj = subjects.find((s) => s.subject === subject);
  if (!subj) return [];
  const t = String(topic || '').trim().toLowerCase();

  let pool = subj.questions.filter(
    (q) => !t || (q.topic || '').toLowerCase() === t || (q.topic || '').toLowerCase().includes(t)
  );
  if (style === 'mcq') pool = pool.filter((q) => q.type === 'mcq');
  else if (style === 'short') pool = pool.filter((q) => q.type === 'short');
  if (DIFFS.includes(difficulty)) {
    const atLevel = pool.filter((q) => (q.difficulty || 'medium') === difficulty);
    if (atLevel.length) pool = atLevel; // else fall back to all difficulties
  }
  if (!pool.length) return [];

  // Prefer questions this user hasn't seen (exclude unless pool too small).
  const want = Math.max(1, Math.min(20, parseInt(count, 10) || 10));
  if (uid) {
    const recent = new Set(loadHistory()[uid] || []);
    const fresh = pool.filter((q) => !recent.has(q.id));
    if (fresh.length >= Math.min(want, pool.length)) pool = fresh;
  }

  // Order: interleave mcq/short for mixed style, else shuffle.
  let ordered;
  if (style === 'mixed') {
    const mcq = shuffle(pool.filter((q) => q.type === 'mcq'));
    const short = shuffle(pool.filter((q) => q.type === 'short'));
    ordered = [];
    while (mcq.length || short.length) {
      if (mcq.length) ordered.push(mcq.pop());
      if (short.length) ordered.push(short.pop());
    }
  } else {
    ordered = shuffle([...pool]);
  }

  return ordered.slice(0, want).map(toQuizShape);
}

function toQuizShape(q) {
  if (q.type === 'mcq') {
    const keys = ['A', 'B', 'C', 'D'].filter((k) => q.options[k] && String(q.options[k]).trim());
    const correctVal = String(q.options[String(q.answer).trim().toUpperCase()]).trim();
    const vals = shuffle(keys.map((k) => String(q.options[k]).trim()));
    const letters = ['A', 'B', 'C', 'D'];
    const options = {};
    vals.forEach((v, i) => {
      options[letters[i]] = v;
    });
    return {
      id: q.id,
      bankId: q.id,
      topic: q.topic || '',
      type: 'mcq',
      question: q.question,
      options,
      answer: letters[vals.indexOf(correctVal)],
      explanation: q.explanation || '',
    };
  }
  return {
    id: q.id,
    bankId: q.id,
    topic: q.topic || '',
    type: 'short',
    question: q.question,
    options: {},
    answer: q.answer,
    explanation: q.explanation || '',
  };
}

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'subject';
}

/**
 * Append questions to the bank (admin import / future nightly stockpiler).
 * Validates strictly, dedupes by id + question text, persists to bank/*.json.
 */
export function addQuestions(subject, level, questions) {
  subject = String(subject || '').trim();
  if (!subject) throw new Error('subject required');
  if (!Array.isArray(questions) || !questions.length) throw new Error('non-empty questions[] required');

  const clean = questions.map((q) => {
    const item = {
      id: String(q.id || '').trim() || `${slug(subject)}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`,
      topic: String(q.topic || 'General').trim().slice(0, 60) || 'General',
      type: q.type,
      difficulty: DIFFS.includes(q.difficulty) ? q.difficulty : 'medium',
      question: String(q.question || '').trim(),
      options:
        q.options && typeof q.options === 'object'
          ? { A: q.options.A, B: q.options.B, C: q.options.C, D: q.options.D }
          : {},
      answer: String(q.answer || '').trim(),
      explanation: String(q.explanation || '').trim().slice(0, 600),
      source: String(q.source || 'curated').trim().slice(0, 40) || 'curated',
    };
    if (!validBankItem(item)) throw new Error('invalid question: ' + (item.question.slice(0, 60) || '(empty)'));
    return item;
  });

  const fp = path.join(BANK_DIR, slug(subject) + '.json');
  let data = { subject, level: String(level || 'O-Level'), questions: [] };
  if (fs.existsSync(fp)) {
    try {
      data = JSON.parse(fs.readFileSync(fp, 'utf8'));
    } catch {
      data = { subject, level: String(level || 'O-Level'), questions: [] };
    }
    data.questions = Array.isArray(data.questions) ? data.questions : [];
  }
  const seenQ = new Set(data.questions.map((q) => String(q.question).trim().toLowerCase()));
  const seenId = new Set(data.questions.map((q) => q.id));
  let added = 0;
  let skipped = 0;
  for (const item of clean) {
    if (seenQ.has(item.question.toLowerCase()) || seenId.has(item.id)) {
      skipped += 1;
      continue;
    }
    seenQ.add(item.question.toLowerCase());
    seenId.add(item.id);
    data.questions.push(item);
    added += 1;
  }
  fs.mkdirSync(BANK_DIR, { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(data, null, 2));
  reloadBank();
  return { added, skipped, subject: data.subject, total: data.questions.length };
}
