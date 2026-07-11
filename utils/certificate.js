/**
 * certificate.js — Fundo Plus Ambassador Certificate Generator
 * Uses PDFKit (already in dependencies). Returns a Buffer.
 */

import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGO_PATH = path.join(__dirname, '..', 'images', 'logo.png');

/**
 * generateAmbassadorCertificate({ name, addedAt })
 * Returns a Promise<Buffer> of the PDF bytes.
 */
export function generateAmbassadorCertificate({ name, addedAt }) {
  return new Promise((resolve, reject) => {

    // ── Helpers ──────────────────────────────────────────────────────────
    const W = 841.89; // A4 landscape width  (pt)
    const H = 595.28; // A4 landscape height (pt)

    const NAVY   = '#0f172a';
    const BLUE   = '#2563eb';
    const GOLD   = '#b45309';
    const GOLD_L = '#fef3c7';
    const MUT    = '#64748b';
    const WHITE  = '#ffffff';
    const BORD   = '#e2e8f5';

    // Format the "since" date
    const since = addedAt
      ? new Date(addedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
      : new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

    const issued = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

    // Simple unique cert ID
    const certId = 'FP-AMB-' + Date.now().toString(36).toUpperCase();

    // ── Doc setup ────────────────────────────────────────────────────────
    const doc = new PDFDocument({
      size: [W, H],       // landscape A4
      margin: 0,
      bufferPages: true,
      info: {
        Title: 'Fundo Plus Ambassador Certificate',
        Author: 'Fundo Plus',
        Subject: `Certificate of Ambassadorship — ${name}`,
      },
    });

    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end',  () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // ── 1. Background ────────────────────────────────────────────────────
    doc.rect(0, 0, W, H).fill('#f8faff');

    // ── 2. Top blue bar ──────────────────────────────────────────────────
    doc.rect(0, 0, W, 10).fill(BLUE);

    // ── 3. Bottom blue bar ───────────────────────────────────────────────
    doc.rect(0, H - 10, W, 10).fill(BLUE);

    // ── 4. Gold accent strip (left) ──────────────────────────────────────
    doc.rect(0, 10, 5, H - 20).fill(GOLD);

    // ── 5. Gold accent strip (right) ─────────────────────────────────────
    doc.rect(W - 5, 10, 5, H - 20).fill(GOLD);

    // ── 6. Outer border ──────────────────────────────────────────────────
    doc.rect(22, 22, W - 44, H - 44)
       .lineWidth(1)
       .stroke(BLUE);

    // Inner thin border
    doc.rect(27, 27, W - 54, H - 54)
       .lineWidth(0.4)
       .stroke(GOLD);

    // ── 7. Logo ──────────────────────────────────────────────────────────
    const logoSize = 52;
    const logoX    = W / 2 - logoSize / 2;
    const logoY    = 52;
    if (fs.existsSync(LOGO_PATH)) {
      doc.image(LOGO_PATH, logoX, logoY, { width: logoSize, height: logoSize });
    }

    // ── 8. Platform name ─────────────────────────────────────────────────
    doc.font('Helvetica-Bold')
       .fontSize(11)
       .fillColor(BLUE)
       .text('FUNDO PLUS', 0, logoY + logoSize + 8, { align: 'center' });

    doc.font('Helvetica')
       .fontSize(7.5)
       .fillColor(MUT)
       .text('fundoplus.up.railway.app', 0, logoY + logoSize + 22, { align: 'center' });

    // ── 9. Divider line ──────────────────────────────────────────────────
    const divY = logoY + logoSize + 38;
    doc.moveTo(W / 2 - 110, divY)
       .lineTo(W / 2 + 110, divY)
       .lineWidth(0.6)
       .stroke(GOLD);

    // ── 10. "Certificate of Ambassadorship" heading ──────────────────────
    doc.font('Helvetica')
       .fontSize(9)
       .fillColor(GOLD)
       .text('CERTIFICATE OF AMBASSADORSHIP', 0, divY + 12, { align: 'center', characterSpacing: 2 });

    // ── 11. "This certifies that" ────────────────────────────────────────
    doc.font('Helvetica')
       .fontSize(11)
       .fillColor(MUT)
       .text('This certifies that', 0, divY + 32, { align: 'center' });

    // ── 12. Name ─────────────────────────────────────────────────────────
    const nameY = divY + 52;
    doc.font('Helvetica-Bold')
       .fontSize(28)
       .fillColor(NAVY)
       .text(name, 60, nameY, { align: 'center', width: W - 120 });

    // Underline below name
    const nameWidth = Math.min(doc.widthOfString(name, { fontSize: 28 }), W - 180);
    doc.moveTo(W / 2 - nameWidth / 2, nameY + 36)
       .lineTo(W / 2 + nameWidth / 2, nameY + 36)
       .lineWidth(0.8)
       .stroke(NAVY);

    // ── 13. Body text ────────────────────────────────────────────────────
    const bodyY = nameY + 50;
    const bodyW = 520;
    const bodyX = W / 2 - bodyW / 2;

    doc.font('Helvetica')
       .fontSize(10.5)
       .fillColor(NAVY)
       .text(
         `has served as a Student Ambassador of the Fundo Plus community since ${since}, ` +
         `demonstrating leadership, peer support, and a commitment to empowering fellow ` +
         `ZIMSEC students through AI-assisted learning.`,
         bodyX, bodyY,
         { align: 'center', width: bodyW, lineGap: 4 }
       );

    // ── 14. Signature section ────────────────────────────────────────────
    const sigY = H - 110;

    // Left — issued by
    const leftX = 90;
    doc.moveTo(leftX, sigY)
       .lineTo(leftX + 130, sigY)
       .lineWidth(0.6)
       .stroke(BORD);
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(NAVY)
       .text('Fundo Plus', leftX, sigY + 6, { width: 130, align: 'center' });
    doc.font('Helvetica').fontSize(7.5).fillColor(MUT)
       .text('Community Project Administrator', leftX, sigY + 17, { width: 130, align: 'center' });

    // Centre — seal ring
    const sealX = W / 2;
    const sealY = sigY + 4;
    doc.circle(sealX, sealY, 28).lineWidth(0.8).stroke(GOLD);
    doc.circle(sealX, sealY, 23).lineWidth(0.3).stroke(GOLD);
    doc.font('Helvetica-Bold').fontSize(5.5).fillColor(GOLD)
       .text('FUNDO PLUS', sealX - 20, sealY - 7, { width: 40, align: 'center' });
    doc.font('Helvetica').fontSize(5).fillColor(GOLD)
       .text('★  AMBASSADOR  ★', sealX - 22, sealY + 1, { width: 44, align: 'center' });
    doc.font('Helvetica').fontSize(4.5).fillColor(GOLD)
       .text('COMMUNITY PROJECT', sealX - 20, sealY + 9, { width: 40, align: 'center' });

    // Right — date
    const rightX = W - 220;
    doc.moveTo(rightX, sigY)
       .lineTo(rightX + 130, sigY)
       .lineWidth(0.6)
       .stroke(BORD);
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(NAVY)
       .text(issued, rightX, sigY + 6, { width: 130, align: 'center' });
    doc.font('Helvetica').fontSize(7.5).fillColor(MUT)
       .text('Date of Issue', rightX, sigY + 17, { width: 130, align: 'center' });

    // ── 15. Certificate ID footer ────────────────────────────────────────
    doc.font('Helvetica').fontSize(6.5).fillColor(MUT)
       .text(
         `Certificate ID: ${certId}  ·  Fundo Plus is an independent community project, not a registered legal entity.  ·  Issued in good faith as a record of voluntary service.`,
         40, H - 28,
         { align: 'center', width: W - 80 }
       );

    doc.end();
  });
}
