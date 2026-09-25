// utils/ai-fallback.js - Offline fallbacks used when every AI provider is down.
//
// These are deliberately honest, extractive backups - no hallucinated facts:
//  - markShortAnswerLocal: keyword-overlap partial credit vs the model answer.
//  - generateQuizOffline: fill-in-the-blank questions built from the notes.
// Callers must label results as offline (see `offline: true` flags).

const STOP = new Set(
  ('a,an,the,and,or,but,if,then,else,for,to,of,in,on,at,by,with,from,as,is,are,was,were,' +
    'be,been,being,it,its,this,that,these,those,he,she,they,we,you,i,his,her,their,our,' +
    'your,my,me,him,us,them,do,does,did,done,have,has,had,having,will,would,can,could,' +
    'should,shall,may,might,must,not,no,yes,so,such,than,too,very,just,also,only,there,' +
    'here,when,where,which,who,whom,what,why,how,all,any,both,each,every,some,more,most,' +
    'other,into,out,up,down,over,under,again,once,during,before,after,above,below,between,' +
    'through,while,because,until,although,though,however,therefore,hence,thus,per,via,' +
    'within,without,often,usually,always,never,sometimes,well,much,many,following,using,' +
    'used,based,known,called,including,example,examples,part,parts,form,forms,process,' +
    'different,number,one,two,first,second,day,today').split(',')
);

function tokens(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function escRx(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Offline short-answer marking: F1 keyword overlap between the student answer
 * and the model answer. Partial credit, never a silent zero.
 */
export function markShortAnswerLocal(modelAnswer, studentAnswer) {
  const given = String(studentAnswer || '').trim();
  if (!given) return { score: 0, feedback: 'No answer provided.', offline: true };

  const model = tokens(modelAnswer);
  const stud = tokens(given);
  if (!model.length) {
    return {
      score: 0.5,
      feedback: 'AI examiner offline — half credit for attempting. Compare with the model answer.',
      offline: true,
    };
  }
  const mSet = new Set(model);
  const hit = stud.filter((w) => mSet.has(w)).length;
  const precision = hit / Math.max(1, stud.length);
  const recall = hit / Math.max(1, model.length);
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  let score = f1;
  if (hit === model.length && stud.length <= model.length + 3) score = Math.max(score, 0.9);
  score = Math.round(Math.min(1, score) * 100) / 100;
  const pct = Math.round(score * 100);

  const tail = 'AI examiner offline — keyword match, compare with the model answer.';
  const feedback =
    score >= 0.7
      ? `Good coverage of the key points (${pct}% match). ${tail}`
      : score >= 0.4
        ? `Partial match (${pct}% of key terms). ${tail}`
        : `Low match (${pct}% of key terms found). ${tail}`;
  return { score, feedback, offline: true };
}

/**
 * Offline quiz generation: fill-in-the-blank questions extracted from the
 * study material. MCQ distractors come from other key terms in the same text.
 * Returns { questions, offline: true }. Questions use the same shape as the
 * AI parser (id/type/question/options/answer/explanation).
 */
export function generateQuizOffline(text, count = 10, style = 'mixed') {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  const sentences = clean
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.split(' ').length >= 6 && s.length < 400);

  const freq = new Map();
  for (const w of tokens(clean)) freq.set(w, (freq.get(w) || 0) + 1);
  const pool = [...freq.entries()]
    .filter(([w]) => w.length > 3)
    .sort((a, b) => b[1] - a[1])
    .map(([w]) => w);

  const scored = sentences
    .map((s) => ({ s, sc: tokens(s).reduce((a, w) => a + (freq.get(w) || 0), 0) }))
    .sort((a, b) => b.sc - a.sc);

  const want = Math.max(1, Math.min(20, parseInt(count, 10) || 10));
  const wantMcq = style === 'mcq' ? want : style === 'short' ? 0 : Math.ceil(want / 2);
  const questions = [];
  const usedKeys = new Set();

  for (const { s } of scored) {
    if (questions.length >= want) break;
    const cands = tokens(s).filter((w) => pool.includes(w) && !usedKeys.has(w));
    if (!cands.length) continue;
    cands.sort((a, b) => (freq.get(b) || 0) - (freq.get(a) || 0));
    let key = '', blanked = s;
    for (const c of cands) {
      // standalone word only - never half of a hyphenated compound
      const b = s.replace(new RegExp(`(?<![A-Za-z0-9-])${escRx(c)}(?![A-Za-z0-9-])`, 'i'), '______');
      if (b !== s) { key = c; blanked = b; break; }
    }
    if (!key) continue;
    usedKeys.add(key);

    const mcqCount = questions.filter((q) => q.type === 'mcq').length;
    if (mcqCount < wantMcq && pool.length >= 4) {
      const distract = shuffle(pool.filter((w) => w !== key)).slice(0, 3);
      if (distract.length < 3) continue;
      const opts = shuffle([key, ...distract]);
      const letters = ['A', 'B', 'C', 'D'];
      const options = {};
      opts.forEach((o, i) => { options[letters[i]] = o; });
      questions.push({
        id: 'q' + (questions.length + 1),
        type: 'mcq',
        question: `Fill in the blank: ${blanked}`,
        options,
        answer: letters[opts.indexOf(key)],
        explanation: `From your notes: "${s.slice(0, 200)}"`,
      });
    } else {
      questions.push({
        id: 'q' + (questions.length + 1),
        type: 'short',
        question: `Fill in the blank: ${blanked}`,
        options: {},
        answer: key,
        explanation: `From your notes: "${s.slice(0, 200)}"`,
      });
    }
  }
  return { questions: questions.slice(0, want), offline: true };
}

/** Short banner text for degraded-mode UI notices. */
export function aiDownNotice() {
  return 'AI is in offline mode right now — answers may be simpler than usual.';
}
