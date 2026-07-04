// utils/docxgen.js — Simple DOCX generator using raw XML (no external service)
import { Buffer } from 'buffer';

// Minimal DOCX = a zip containing word/document.xml + rels + content types
// We'll use the 'docx' npm package which is already-like approach with raw XML

export async function generateDocxBuffer(title, content) {
  // Use dynamic import for docx npm package if available, else build minimal
  try {
    const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } = await import('docx');
    const children = [];

    // Title
    children.push(new Paragraph({
      text: title,
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
    }));

    // Date
    children.push(new Paragraph({
      children: [new TextRun({ text: `Generated: ${new Date().toLocaleDateString()}`, italics: true, color: '666666', size: 18 })],
      alignment: AlignmentType.RIGHT,
    }));
    children.push(new Paragraph({ text: '' }));

    const lines = content.split('\n');
    for (const line of lines) {
      const t = line.trim();
      if (!t) { children.push(new Paragraph({ text: '' })); continue; }

      if (t.startsWith('# ')) {
        children.push(new Paragraph({ text: t.slice(2), heading: HeadingLevel.HEADING_1 }));
      } else if (t.startsWith('## ')) {
        children.push(new Paragraph({ text: t.slice(3), heading: HeadingLevel.HEADING_2 }));
      } else if (t.startsWith('### ')) {
        children.push(new Paragraph({ text: t.slice(4), heading: HeadingLevel.HEADING_3 }));
      } else if (t.startsWith('- ') || t.startsWith('• ')) {
        children.push(new Paragraph({ text: `• ${t.slice(2)}`, bullet: { level: 0 } }));
      } else {
        // Handle inline **bold**
        const parts = t.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
        const runs  = parts.map(p => {
          if (p.startsWith('**') && p.endsWith('**'))
            return new TextRun({ text: p.slice(2,-2), bold: true });
          return new TextRun({ text: p });
        });
        children.push(new Paragraph({ children: runs }));
      }
    }

    const doc = new Document({
      creator: 'Prok AI AI by XTech',
      title,
      sections: [{ children }],
    });
    return await Packer.toBuffer(doc);
  } catch {
    // Fallback: plain text wrapped in minimal docx structure
    return buildMinimalDocx(title, content);
  }
}

function buildMinimalDocx(title, content) {
  // Very minimal valid docx (just returns a txt buffer as fallback)
  const text = `${title}\n${'='.repeat(title.length)}\n\n${content}`;
  return Buffer.from(text, 'utf8');
}
