// utils/pdfgen.js — Fundo Plus branded PDF generator
// Cover: single white page, logo centred top, info in label/value rows
// Content: renders stages 1-6 once; if under 12 pages, re-renders those same
//          pages but with every bullet/short point EXPANDED into rich paragraphs.
import PDFDocument from 'pdfkit';
import fs   from 'fs';
import path from 'path';
import https from 'https';
import http  from 'http';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── Brand colours ─────────────────────────────────────────────────────────────
const BRAND_NAVY   = '#0c1445';
const BRAND_BLUE   = '#2952e3';
const BRAND_PURPLE = '#7c3aed';
const BRAND_LIGHT  = '#dde5f7';
const TEXT_COLOR   = '#1a1f3a';
const MUTED        = '#6374a0';

const LOGO_PATH = path.resolve(__dirname, '..', 'images', 'logo.png');

// ── Helpers ───────────────────────────────────────────────────────────────────
function drawMixedLine(doc, line, opts = {}) {
  const parts = line.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  if (parts.length === 1) {
    const isBold = parts[0].startsWith('**') && parts[0].endsWith('**');
    doc.font(isBold ? 'Helvetica-Bold' : 'Helvetica')
       .text(isBold ? parts[0].slice(2, -2) : parts[0], opts);
    doc.font('Helvetica');
    return;
  }
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const isBold = p.startsWith('**') && p.endsWith('**');
    const text = isBold ? p.slice(2, -2) : p;
    const continued = i < parts.length - 1;
    doc.font(isBold ? 'Helvetica-Bold' : 'Helvetica')
       .text(text, { ...opts, continued });
  }
  doc.font('Helvetica');
}

function truncateToWidth(doc, text, maxWidth) {
  if (doc.widthOfString(text) <= maxWidth) return text;
  let truncated = text;
  while (truncated.length > 0 && doc.widthOfString(truncated + '…') > maxWidth) {
    truncated = truncated.slice(0, -1);
  }
  return truncated + '…';
}

function wrapTextToLines(doc, text, maxWidth, fontSize) {
  doc.fontSize(fontSize).font('Helvetica-Bold');
  const words = text.split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (doc.widthOfString(test) > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// ── Pixabay ───────────────────────────────────────────────────────────────────
function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    proto.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadBuffer(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function fetchPixabayImages(query, apiKey) {
  if (!apiKey) return [];
  try {
    const q = encodeURIComponent(query);
    const url = `https://pixabay.com/api/?key=${apiKey}&q=${q}&image_type=photo&orientation=horizontal&per_page=5&safesearch=true`;
    const buf = await downloadBuffer(url);
    const data = JSON.parse(buf.toString('utf8'));
    if (!data.hits || data.hits.length === 0) return [];
    return data.hits.slice(0, 2).map(h => h.webformatURL || h.largeImageURL);
  } catch (e) {
    console.warn('[pdfgen] Pixabay fetch failed:', e.message);
    return [];
  }
}

async function downloadImages(urls, outDir) {
  const paths = [];
  for (let i = 0; i < Math.min(urls.length, 2); i++) {
    try {
      const buf = await downloadBuffer(urls[i]);
      const tmpPath = path.join(outDir, `img_${Date.now()}_${i}.jpg`);
      fs.writeFileSync(tmpPath, buf);
      paths.push(tmpPath);
    } catch (e) {
      console.warn('[pdfgen] Image download failed:', e.message);
    }
  }
  return paths;
}

// ── Table helpers ─────────────────────────────────────────────────────────────
function isTableSep(line) { return /^\|[\s\-:|]+\|/.test(line.trim()); }

function parseTable(tableLines) {
  const rows = tableLines
    .filter(l => !isTableSep(l))
    .map(l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim()));
  if (rows.length < 1) return null;
  return { headers: rows[0], rows: rows.slice(1) };
}

// ── Preprocess raw lines into tokens ─────────────────────────────────────────
function preprocessLines(rawLines) {
  const result = [];
  let i = 0;
  while (i < rawLines.length) {
    const line = rawLines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.length > 2) {
      const tableLines = [];
      while (i < rawLines.length && rawLines[i].trim().startsWith('|')) {
        tableLines.push(rawLines[i]);
        i++;
      }
      if (tableLines.length >= 2) result.push({ type: 'table', lines: tableLines });
      else for (const tl of tableLines) result.push({ type: 'text', line: tl });
    } else {
      result.push({ type: 'text', line });
      i++;
    }
  }
  return result;
}

// ── Expand a short bullet/point into a full rich paragraph ───────────────────
// e.g. "Work efficiency - work is made easier"
// → "Work efficiency is a key aspect... This is important because work is made
//    easier, which directly impacts... By applying this in Zimbabwe..."
function expandToRichParagraph(rawText, stageHeading, meta) {
  // Strip leading bullet/numbering chars
  const clean = rawText
    .replace(/^(\-|\•|\*|\d+\.)\s+/, '')
    .replace(/\*\*/g, '')
    .trim();

  if (!clean || clean.length < 4) return null;

  const subject = meta.subject || 'this subject';
  const level   = meta.level   || 'O-Level';
  const school  = meta.school  || 'school';

  // Try to split on common "label - description" patterns
  const splitMatch = clean.match(/^(.+?)(?:\s*[-–—:]\s*)(.+)$/);
  const label = splitMatch ? splitMatch[1].trim() : clean.split(' ').slice(0, 5).join(' ');
  const brief = splitMatch ? splitMatch[2].trim() : '';

  // Pick varied sentence openers so paragraphs don't all sound the same
  const seed = clean.length + stageHeading.length; // deterministic variety
  const openers = [
    `${label} is one of the most important considerations within this stage of the project.`,
    `A key point to understand in this section is ${label.toLowerCase()}.`,
    `${label} plays a central role in the success of this project.`,
    `When examining ${stageHeading}, ${label.toLowerCase()} stands out as a critical factor that cannot be overlooked.`,
  ];
  const opener = openers[seed % openers.length];

  const elaboration = brief
    ? `This means that ${brief.toLowerCase()}. Understanding this concept in full is essential because it influences every decision made throughout the project and directly determines how effective the final outcome will be.`
    : `Understanding this concept fully is essential because it underpins the practical and theoretical foundations of the project, and directly influences the quality of results achieved.`;

  const closer = [
    `In the Zimbabwean school context, this point is particularly significant because it affects how students and teachers at ${school} approach ${subject} work daily. By addressing this thoroughly, the project demonstrates the kind of higher-order thinking and practical awareness that ZIMSEC ${level} examiners look for in high-quality submissions.`,
    `For ${level} ${subject} students in Zimbabwe, applying this understanding leads to more informed decisions and stronger, more credible project outcomes. Schools that recognise this are better positioned to achieve measurable improvements in both student performance and overall learning quality.`,
    `This aligns directly with the ZIMSEC ${level} ${subject} curriculum objectives, ensuring the project meets the required academic standards while remaining relevant and practical within the Zimbabwean educational environment. Failing to account for this would weaken the project's overall argument and reduce its value to stakeholders.`,
    `By recognising and acting on this point, students demonstrate a mature understanding of how theoretical knowledge connects to real-world practice in Zimbabwe. This is exactly what distinguishes a competent ${level} project from an outstanding one in the eyes of ZIMSEC evaluators.`,
  ][seed % 4];

  return `${opener} ${elaboration} ${closer}`;
}

// ── Cover Page ────────────────────────────────────────────────────────────────
function drawCoverPage(doc, meta) {
  const W = doc.page.width;
  const H = doc.page.height;
  doc.rect(0, 0, W, H).fill('#ffffff');

  const logoW = 120, logoH = 120;
  const logoX = (W - logoW) / 2, logoY = 40;
  if (fs.existsSync(LOGO_PATH)) {
    try { doc.image(LOGO_PATH, logoX, logoY, { width: logoW, height: logoH, fit: [logoW, logoH] }); }
    catch (e) { console.warn('[pdfgen] Logo load failed:', e.message); }
  }

  const divY = logoY + logoH + 18;
  doc.moveTo(W * 0.2, divY).lineTo(W * 0.8, divY).lineWidth(1.5).strokeColor(BRAND_BLUE).stroke();

  const MARGIN = 70;
  const CONTENT_W = W - MARGIN * 2;
  let y = divY + 22;

  const titleLines = wrapTextToLines(doc, meta.title || 'Untitled Project', CONTENT_W, 22);
  doc.fontSize(22).font('Helvetica-Bold').fillColor(BRAND_NAVY);
  for (const line of titleLines.slice(0, 4)) {
    doc.text(line, MARGIN, y, { width: CONTENT_W, align: 'center', lineBreak: false });
    y += 30;
  }

  y += 20;
  doc.moveTo(MARGIN, y).lineTo(W - MARGIN, y).lineWidth(0.5).strokeColor(BRAND_LIGHT).stroke();
  y += 18;

  const infoRows = [
    { label: 'Name',          value: meta.student  },
    { label: 'School',        value: meta.school   },
    { label: 'District',      value: meta.district },
    { label: 'Subject',       value: meta.subject  },
    { label: 'Level',         value: meta.level    },
    { label: 'Academic Year', value: meta.year     },
  ];
  if (meta.teacher) infoRows.push({ label: 'Supervisor', value: meta.teacher });

  const labelX = MARGIN, valueX = W / 2 + 10;
  const ROW_H = 32, labelW = W / 2 - MARGIN - 20;

  for (const row of infoRows) {
    if (!row.value) continue;
    doc.fontSize(10).font('Helvetica-Bold').fillColor(MUTED)
       .text(row.label + '.', labelX, y, { width: labelW, align: 'left', lineBreak: false });
    const dotStart = labelX + doc.widthOfString(row.label + '.', { fontSize: 10 }) + 6;
    const dotEnd = valueX - 10, dotY = y + 7;
    doc.moveTo(dotStart, dotY).lineTo(dotEnd, dotY).lineWidth(0.4).dash(2, { space: 3 }).strokeColor('#c8d6f0').stroke();
    doc.undash();
    doc.fontSize(11).font('Helvetica-Bold').fillColor(TEXT_COLOR)
       .text(`(${row.value})`, valueX, y - 1, { width: W - valueX - MARGIN, align: 'left', lineBreak: false });
    y += ROW_H;
  }

  y += 20;
  doc.moveTo(MARGIN, y).lineTo(MARGIN + 160, y).lineWidth(0.7).strokeColor('#94a3b8').stroke();
  doc.fontSize(7.5).font('Helvetica').fillColor(MUTED).text('Student Signature', MARGIN, y + 5, { lineBreak: false });
  doc.moveTo(W / 2 + 20, y).lineTo(W / 2 + 180, y).lineWidth(0.7).strokeColor('#94a3b8').stroke();
  doc.fontSize(7.5).font('Helvetica').fillColor(MUTED).text('Supervisor Signature', W / 2 + 20, y + 5, { lineBreak: false });

  doc.rect(0, H - 36, W, 36).fill('#f8fafc');
  doc.moveTo(0, H - 36).lineTo(W, H - 36).lineWidth(0.5).strokeColor(BRAND_LIGHT).stroke();
  doc.fontSize(7).font('Helvetica').fillColor(MUTED)
     .text(`Generated by Fundo Plus  ·  fundo.plus  ·  ${new Date().toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' })}`,
           0, H - 22, { align: 'center', width: W, lineBreak: false });
  doc.fillColor(TEXT_COLOR).fillOpacity(1);
}

// ── Inner page chrome ─────────────────────────────────────────────────────────
function drawInnerHeader(doc, meta) {
  const W = doc.page.width;
  doc.save();
  doc.rect(0, 0, W, 36).fill(BRAND_NAVY);
  doc.fontSize(10).font('Helvetica-Bold').fillColor('#ffffff').text('Fundo Plus', 50, 12, { lineBreak: false });
  const titleStr = truncateToWidth(doc.fontSize(8).font('Helvetica').fillColor(BRAND_LIGHT), meta.title || '', W - 200);
  doc.text(titleStr, 130, 14, { lineBreak: false });
  doc.fontSize(7).font('Helvetica-Bold').fillColor(BRAND_PURPLE)
     .text(meta.level || 'O-Level', W - 100, 14, { width: 70, align: 'right', lineBreak: false });
  doc.restore();
  doc.fillColor(TEXT_COLOR);
}

function drawInnerFooter(doc, pageNum, totalPages, meta) {
  const W = doc.page.width, H = doc.page.height;
  doc.save();
  const y = H - 38;
  doc.rect(0, y, W, 38).fill('#f0f4ff');
  doc.moveTo(0, y).lineTo(W, y).lineWidth(0.5).strokeColor(BRAND_LIGHT).stroke();
  doc.fontSize(7.5).font('Helvetica').fillColor(MUTED)
     .text(`${meta.student || 'Student'}  ·  ${meta.school || 'School'}  ·  Generated by Fundo Plus`, 50, y + 13, { lineBreak: false });
  doc.font('Helvetica-Bold').fillColor(BRAND_NAVY)
     .text(`Page ${pageNum} of ${totalPages}`, W - 120, y + 13, { width: 80, align: 'right', lineBreak: false });
  doc.restore();
  doc.fillColor(TEXT_COLOR);
}

// ── Table renderer ────────────────────────────────────────────────────────────
function drawTable(doc, tableData, MARGIN, CONTENT_W, BOT_Y) {
  const { headers, rows } = tableData;
  const colCount = headers.length;
  const colW = CONTENT_W / colCount;
  const rowH = 22, headerH = 26;
  const totalH = headerH + rows.length * rowH + 16;
  if (doc.y + totalH > BOT_Y) { doc.addPage(); doc.y = 50; doc.x = MARGIN; }
  const startY = doc.y, startX = MARGIN;
  doc.rect(startX, startY, CONTENT_W, headerH).fill(BRAND_NAVY);
  for (let i = 0; i < headers.length; i++) {
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#ffffff')
       .text(headers[i], startX + colW * i + 6, startY + 9, { width: colW - 12, lineBreak: false, ellipsis: true });
  }
  for (let r = 0; r < rows.length; r++) {
    const ry = startY + headerH + r * rowH;
    doc.rect(startX, ry, CONTENT_W, rowH).fill(r % 2 === 0 ? '#f0f4ff' : '#ffffff');
    doc.moveTo(startX, ry).lineTo(startX + CONTENT_W, ry).lineWidth(0.3).strokeColor(BRAND_LIGHT).stroke();
    for (let c = 0; c < colCount; c++) {
      const cell = (rows[r][c] || '').replace(/\*\*/g, '');
      doc.fontSize(8).font('Helvetica').fillColor(TEXT_COLOR)
         .text(cell, startX + colW * c + 6, ry + 7, { width: colW - 12, lineBreak: false, ellipsis: true });
    }
  }
  const tableH = headerH + rows.length * rowH;
  doc.rect(startX, startY, CONTENT_W, tableH).lineWidth(0.5).strokeColor(BRAND_BLUE).stroke();
  for (let i = 1; i < colCount; i++) {
    doc.moveTo(startX + colW * i, startY).lineTo(startX + colW * i, startY + tableH).lineWidth(0.3).strokeColor(BRAND_LIGHT).stroke();
  }
  doc.y = startY + tableH + 14; doc.x = MARGIN;
  doc.fillColor(TEXT_COLOR);
}

// ── Image pair renderer ───────────────────────────────────────────────────────
function drawImagePair(doc, imgPaths, MARGIN, CONTENT_W, BOT_Y) {
  if (!imgPaths || imgPaths.length === 0) return;
  const GAP = 12, imgH = 160;
  const imgW = imgPaths.length === 2 ? (CONTENT_W - GAP) / 2 : CONTENT_W;
  if (doc.y + imgH + 30 > BOT_Y) { doc.addPage(); doc.y = 50; doc.x = MARGIN; }
  const startY = doc.y;
  for (let i = 0; i < imgPaths.length; i++) {
    const x = MARGIN + i * (imgW + GAP);
    try {
      doc.save();
      doc.rect(x, startY, imgW, imgH).clip();
      doc.image(imgPaths[i], x, startY, { width: imgW, height: imgH, cover: [imgW, imgH], align: 'center', valign: 'center' });
      doc.restore();
      doc.rect(x, startY, imgW, imgH).lineWidth(0.5).strokeColor(BRAND_LIGHT).stroke();
    } catch (e) {
      doc.rect(x, startY, imgW, imgH).fill('#f0f4ff');
      doc.fontSize(8).font('Helvetica').fillColor(MUTED)
         .text('[Image]', x, startY + imgH / 2 - 5, { width: imgW, align: 'center', lineBreak: false });
    }
  }
  doc.rect(MARGIN, startY + imgH, CONTENT_W, 18).fill('#f0f4ff');
  doc.fontSize(7).font('Helvetica').fillColor(MUTED)
     .text('Figure: Relevant imagery sourced from Pixabay (CC0)', MARGIN + 8, startY + imgH + 6, { width: CONTENT_W - 16, lineBreak: false });
  doc.y = startY + imgH + 22; doc.x = MARGIN;
}

// ── Core line renderer (shared by both normal and expanded passes) ─────────────
function renderTokenToDoc(doc, token, MARGIN, CONTENT_W, BOT_Y, coverMeta, TOP_Y) {
  function ensureSpace(needed = 30) {
    if (doc.y + needed > BOT_Y) {
      doc.addPage();
      drawInnerHeader(doc, coverMeta);
      doc.y = TOP_Y + 6; doc.x = MARGIN;
      doc.fontSize(11).font('Helvetica').fillColor(TEXT_COLOR);
    }
  }

  if (token.type === 'table') {
    const tableData = parseTable(token.lines);
    if (tableData) { doc.moveDown(0.5); drawTable(doc, tableData, MARGIN, CONTENT_W, BOT_Y); doc.moveDown(0.5); }
    return;
  }

  const line = token.line;
  const t = line.trim();
  if (!t) { ensureSpace(10); doc.moveDown(0.35); return; }

  if (t.startsWith('# ')) {
    ensureSpace(50);
    doc.moveDown(0.7);
    doc.rect(MARGIN, doc.y, CONTENT_W, 30).fill('#eff6ff');
    doc.fontSize(14).font('Helvetica-Bold').fillColor(BRAND_NAVY)
       .text(t.slice(2), MARGIN + 10, doc.y - 28 + 8, { width: CONTENT_W - 16, lineBreak: false });
    doc.y += 6; doc.x = MARGIN;
    doc.moveDown(0.5);
    doc.fontSize(11).font('Helvetica').fillColor(TEXT_COLOR);
  } else if (t.startsWith('## ')) {
    ensureSpace(40);
    doc.moveDown(0.5);
    doc.fontSize(13).font('Helvetica-Bold').fillColor(BRAND_BLUE).text(t.slice(3), MARGIN, doc.y, { width: CONTENT_W });
    doc.moveDown(0.15);
    doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + 100, doc.y).lineWidth(1.5).strokeColor(BRAND_LIGHT).stroke();
    doc.moveDown(0.4);
    doc.fontSize(11).font('Helvetica').fillColor(TEXT_COLOR);
  } else if (t.startsWith('### ')) {
    ensureSpace(30);
    doc.moveDown(0.3);
    doc.fontSize(11.5).font('Helvetica-Bold').fillColor(BRAND_NAVY).text(t.slice(4), MARGIN, doc.y, { width: CONTENT_W });
    doc.moveDown(0.25);
    doc.fontSize(11).font('Helvetica').fillColor(TEXT_COLOR);
  } else if (/^(\-|\•|\*)?\s*$/.test(t)) {
    // empty bullet — skip
  } else if (/^(\-|\•|\*)\s/.test(t)) {
    ensureSpace(24);
    const bullet = t.slice(2).trim();
    doc.circle(MARGIN + 5, doc.y + 5, 2.5).fill(BRAND_BLUE);
    doc.x = MARGIN + 16;
    if (bullet.includes('**')) {
      drawMixedLine(doc, bullet, { width: CONTENT_W - 16, indent: 0, lineGap: 2 });
    } else {
      doc.fontSize(11).font('Helvetica').fillColor(TEXT_COLOR).text(bullet, MARGIN + 16, doc.y, { width: CONTENT_W - 16, lineGap: 2 });
    }
    doc.x = MARGIN;
  } else if (/^\d+\.\s/.test(t)) {
    ensureSpace(24);
    const num  = t.match(/^(\d+)\./)[1];
    const rest = t.replace(/^\d+\.\s/, '').trim();
    doc.fontSize(11).font('Helvetica-Bold').fillColor(BRAND_BLUE).text(`${num}.`, MARGIN, doc.y, { continued: true, lineBreak: false });
    doc.font('Helvetica').fillColor(TEXT_COLOR).text(` ${rest}`, { width: CONTENT_W - 20, lineGap: 2 });
  } else if (t.startsWith('---') || t.startsWith('===')) {
    ensureSpace(16);
    doc.moveDown(0.3);
    doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + CONTENT_W, doc.y).lineWidth(0.5).strokeColor(BRAND_LIGHT).stroke();
    doc.moveDown(0.3);
  } else if (t.startsWith('> ')) {
    ensureSpace(36);
    doc.rect(MARGIN, doc.y, 3, 20).fill(BRAND_PURPLE);
    doc.fontSize(10.5).font('Helvetica').fillColor(MUTED).text(t.slice(2), MARGIN + 12, doc.y, { width: CONTENT_W - 12, lineGap: 2 });
    doc.x = MARGIN;
  } else if (t.includes('**')) {
    ensureSpace(22);
    drawMixedLine(doc, t, { width: CONTENT_W, lineGap: 3 });
    doc.x = MARGIN;
  } else {
    ensureSpace(22);
    doc.fontSize(11).font('Helvetica').fillColor(TEXT_COLOR).text(t, MARGIN, doc.y, { width: CONTENT_W, lineGap: 3 });
  }
}

// ── EXPANDED token renderer ───────────────────────────────────────────────────
// Like renderTokenToDoc but bullets/short lines become full rich paragraphs.
// Stage headings and long paragraphs pass through unchanged.
function renderTokenExpanded(doc, token, MARGIN, CONTENT_W, BOT_Y, coverMeta, TOP_Y, currentStageHeading) {
  function ensureSpace(needed = 30) {
    if (doc.y + needed > BOT_Y) {
      doc.addPage();
      drawInnerHeader(doc, coverMeta);
      doc.y = TOP_Y + 6; doc.x = MARGIN;
      doc.fontSize(11).font('Helvetica').fillColor(TEXT_COLOR);
    }
  }

  if (token.type === 'table') {
    const tableData = parseTable(token.lines);
    if (tableData) { doc.moveDown(0.5); drawTable(doc, tableData, MARGIN, CONTENT_W, BOT_Y); doc.moveDown(0.5); }
    return;
  }

  const line = token.line;
  const t = line.trim();
  if (!t) { ensureSpace(10); doc.moveDown(0.35); return; }

  // Headings pass through unchanged
  if (t.startsWith('# ') || t.startsWith('## ') || t.startsWith('### ')) {
    renderTokenToDoc(doc, token, MARGIN, CONTENT_W, BOT_Y, coverMeta, TOP_Y);
    return;
  }

  // Tables, dividers, blockquotes pass through
  if (t.startsWith('---') || t.startsWith('===') || t.startsWith('> ')) {
    renderTokenToDoc(doc, token, MARGIN, CONTENT_W, BOT_Y, coverMeta, TOP_Y);
    return;
  }

  // Is this a bullet or a numbered item?
  const isBullet   = /^(\-|\•|\*)\s/.test(t);
  const isNumbered = /^\d+\.\s/.test(t);

  if (isBullet || isNumbered) {
    const rawText = isBullet ? t.slice(2).trim() : t.replace(/^\d+\.\s/, '').trim();
    const rich = expandToRichParagraph(rawText, currentStageHeading, coverMeta);

    if (rich) {
      // Render the original point as a bold label
      const labelText = rawText.replace(/\*\*/g, '').split(/[-–—:]/)[0].trim();
      ensureSpace(60);
      doc.moveDown(0.3);
      doc.fontSize(11).font('Helvetica-Bold').fillColor(BRAND_NAVY)
         .text(labelText, MARGIN, doc.y, { width: CONTENT_W });
      doc.moveDown(0.15);
      // Then the rich elaboration paragraph
      ensureSpace(50);
      doc.fontSize(11).font('Helvetica').fillColor(TEXT_COLOR)
         .text(rich, MARGIN, doc.y, { width: CONTENT_W, lineGap: 4, align: 'justify' });
      doc.moveDown(0.5);
      return;
    }
  }

  // Long paragraphs (already detailed) — pass through as-is
  const wordCount = t.replace(/\*\*/g, '').split(/\s+/).length;
  if (wordCount > 20) {
    renderTokenToDoc(doc, token, MARGIN, CONTENT_W, BOT_Y, coverMeta, TOP_Y);
    return;
  }

  // Short non-bullet lines — expand them too if they look like a point
  if (wordCount >= 4 && wordCount <= 20 && !t.startsWith('#')) {
    const rich = expandToRichParagraph(t, currentStageHeading, coverMeta);
    if (rich) {
      ensureSpace(60);
      doc.moveDown(0.2);
      doc.fontSize(11).font('Helvetica').fillColor(TEXT_COLOR)
         .text(rich, MARGIN, doc.y, { width: CONTENT_W, lineGap: 4, align: 'justify' });
      doc.moveDown(0.4);
      return;
    }
  }

  // Fallback: render normally
  renderTokenToDoc(doc, token, MARGIN, CONTENT_W, BOT_Y, coverMeta, TOP_Y);
}

// ── Render all tokens (first pass — normal) ───────────────────────────────────
function renderContentTokens(doc, tokens, coverMeta, MARGIN, CONTENT_W, TOP_Y, BOT_Y, imagePaths) {
  doc.addPage();
  drawInnerHeader(doc, coverMeta);
  doc.y = TOP_Y; doc.x = MARGIN;

  doc.fontSize(8).font('Helvetica').fillColor(MUTED)
     .text(`Generated: ${new Date().toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short' })}   ·   ${coverMeta.subject || ''}   ·   ${coverMeta.level || ''}`,
           MARGIN, TOP_Y, { width: CONTENT_W, align: 'right', lineBreak: false });
  doc.y = TOP_Y + 20; doc.x = MARGIN;

  doc.fontSize(18).font('Helvetica-Bold').fillColor(BRAND_NAVY).text(coverMeta.title || '', MARGIN, doc.y, { width: CONTENT_W });
  doc.moveDown(0.3);
  doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + CONTENT_W, doc.y).lineWidth(2).strokeColor(BRAND_BLUE).stroke();
  doc.moveDown(0.8);
  doc.fontSize(11).font('Helvetica').fillColor(TEXT_COLOR);

  if (imagePaths.length > 0) {
    doc.moveDown(0.4);
    drawImagePair(doc, imagePaths, MARGIN, CONTENT_W, BOT_Y);
    doc.moveDown(0.5);
    doc.fontSize(11).font('Helvetica').fillColor(TEXT_COLOR);
  }

  for (const token of tokens) {
    renderTokenToDoc(doc, token, MARGIN, CONTENT_W, BOT_Y, coverMeta, TOP_Y);
  }
}

// ── Render all tokens EXPANDED (second pass — if under 12 pages) ─────────────
// This re-renders the SAME content but with bullets/points blown up into paragraphs.
// It replaces the short-form pages, not adds new duplicate stage headings.
function renderContentExpanded(doc, tokens, coverMeta, MARGIN, CONTENT_W, TOP_Y, BOT_Y) {
  doc.addPage();
  drawInnerHeader(doc, coverMeta);
  doc.y = TOP_Y + 10; doc.x = MARGIN;
  doc.fontSize(11).font('Helvetica').fillColor(TEXT_COLOR);

  let currentStageHeading = '';

  for (const token of tokens) {
    // Track current stage heading for context in expansion
    if (token.type === 'text') {
      const t = token.line.trim();
      if (t.startsWith('# ') || t.startsWith('## ')) {
        currentStageHeading = t.replace(/^#+\s/, '');
      }
    }
    renderTokenExpanded(doc, token, MARGIN, CONTENT_W, BOT_Y, coverMeta, TOP_Y, currentStageHeading);
  }
}

// ── References page ───────────────────────────────────────────────────────────
function renderReferencesPage(doc, coverMeta, MARGIN, CONTENT_W, TOP_Y, BOT_Y) {
  doc.addPage();
  drawInnerHeader(doc, coverMeta);
  doc.y = TOP_Y + 16; doc.x = MARGIN;

  doc.rect(MARGIN, doc.y, CONTENT_W, 32).fill('#eff6ff');
  doc.fontSize(14).font('Helvetica-Bold').fillColor(BRAND_NAVY)
     .text('References, Integrity & Acknowledgements', MARGIN + 10, doc.y + 9, { width: CONTENT_W - 20 });
  doc.y += 40; doc.x = MARGIN;
  doc.moveDown(0.4);
  doc.fontSize(11).font('Helvetica').fillColor(TEXT_COLOR);

  const subject = coverMeta.subject || 'Subject';
  const level   = coverMeta.level   || 'O-Level';
  const year    = coverMeta.year    || new Date().getFullYear();
  const teacher = coverMeta.teacher || 'the supervising teacher';
  const school  = coverMeta.school  || 'the school';

  const sections = [
    {
      heading: 'References & Sources',
      body: null,
      items: [
        `Zimbabwe School Examinations Council (ZIMSEC) ${subject} Syllabus — ${level} ${year}`,
        `Ministry of Primary and Secondary Education — National Curriculum Framework for Zimbabwe`,
        `Relevant approved textbooks and academic resources for ${level} ${subject} study`,
        `Teacher guidance, school-based learning materials, and structured study sessions`,
        `Community observations, field visits, and practical project experience`,
      ],
    },
    {
      heading: 'Academic Integrity Statement',
      body:
        `This project represents the original work of the student named on the cover page. ` +
        `All sources consulted have been acknowledged and no section has been reproduced from ` +
        `another student or external source without proper attribution. The student confirms ` +
        `that the ideas, research methods, and conclusions presented in this document are their ` +
        `own, developed under the guidance of their supervising teacher and in line with ZIMSEC ` +
        `${level} project requirements.`,
    },
    {
      heading: 'Acknowledgements',
      body:
        `The student wishes to express sincere gratitude to ${teacher} for invaluable guidance ` +
        `and patient support throughout every stage of this project. Special appreciation goes ` +
        `to ${school} for providing access to the necessary resources, facilities, and learning ` +
        `environment that made this work possible. Thanks also to family members, classmates, ` +
        `and community members who contributed feedback, participated in surveys, and offered ` +
        `encouragement during the research and writing process.`,
    },
    {
      heading: 'Declaration',
      body:
        `I declare that this project is my own original work and has been submitted in partial ` +
        `fulfilment of the requirements for the ${level} ${subject} examination conducted by ` +
        `ZIMSEC. I understand the consequences of academic dishonesty and affirm that this ` +
        `submission complies with all relevant ZIMSEC guidelines and regulations.`,
    },
  ];

  for (const sec of sections) {
    if (doc.y + 60 > BOT_Y) break;
    doc.moveDown(0.4);
    doc.fontSize(12).font('Helvetica-Bold').fillColor(BRAND_BLUE)
       .text(sec.heading, MARGIN, doc.y, { width: CONTENT_W });
    doc.moveDown(0.2);
    doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + 80, doc.y).lineWidth(1).strokeColor(BRAND_LIGHT).stroke();
    doc.moveDown(0.3);
    doc.fontSize(11).font('Helvetica').fillColor(TEXT_COLOR);

    if (sec.items) {
      for (let i = 0; i < sec.items.length; i++) {
        if (doc.y + 20 > BOT_Y) break;
        doc.fontSize(11).font('Helvetica').fillColor(TEXT_COLOR)
           .text(`${i + 1}. ${sec.items[i]}`, MARGIN, doc.y, { width: CONTENT_W, lineGap: 4 });
      }
    }
    if (sec.body) {
      if (doc.y + 40 > BOT_Y) break;
      doc.fontSize(11).font('Helvetica').fillColor(TEXT_COLOR)
         .text(sec.body, MARGIN, doc.y, { width: CONTENT_W, lineGap: 4, align: 'justify' });
    }
    doc.moveDown(0.6);
  }
}

// ── Main export ───────────────────────────────────────────────────────────────
export async function generatePdf(title, content, jobId, outDir, meta = {}, opts = {}) {
  const { pixabayKey } = opts;

  let imagePaths = [];
  if (pixabayKey) {
    const imgUrls = await fetchPixabayImages(`${meta.subject || ''} ${title}`.trim(), pixabayKey);
    if (imgUrls.length > 0) imagePaths = await downloadImages(imgUrls, outDir);
  }

  return new Promise((resolve, reject) => {
    try {
      if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
      const filePath = path.join(outDir, `${jobId}.pdf`);
      const doc = new PDFDocument({ margin: 0, size: 'A4', bufferPages: true });
      const stream = fs.createWriteStream(filePath);
      doc.pipe(stream);

      const coverMeta = { title, ...meta };
      const MARGIN    = 55;
      const CONTENT_W = doc.page.width - MARGIN * 2;
      const TOP_Y     = 50;
      const BOT_Y     = doc.page.height - 52;
      const MIN_PAGES = Math.min(20, Math.max(6, parseInt(opts.minPages, 10) || 12));

      // ── Page 1: Cover ─────────────────────────────────────────────────────
      drawCoverPage(doc, coverMeta);

      // ── Pages 2+: Expanded content starts immediately after cover ─────────
      const rawLines = content.split('\n');
      const tokens   = preprocessLines(rawLines);
      renderContentExpanded(doc, tokens, coverMeta, MARGIN, CONTENT_W, TOP_Y, BOT_Y);

      // ── If still under minimum, add references/integrity page(s) ──────────
      while (doc.bufferedPageRange().count < MIN_PAGES) {
        renderReferencesPage(doc, coverMeta, MARGIN, CONTENT_W, TOP_Y, BOT_Y);
      }

      // ── Footers on all inner pages ─────────────────────────────────────────
      const finalRange = doc.bufferedPageRange();
      const innerTotal = finalRange.count - 1;
      for (let i = 1; i < finalRange.count; i++) {
        doc.switchToPage(finalRange.start + i);
        drawInnerFooter(doc, i, innerTotal, coverMeta);
      }

      doc.end();
      stream.on('finish', () => {
        for (const p of imagePaths) { try { fs.unlinkSync(p); } catch {} }
        resolve(filePath);
      });
      stream.on('error', reject);
    } catch (err) {
      reject(err);
    }
  });
}
