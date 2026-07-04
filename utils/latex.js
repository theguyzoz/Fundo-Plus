// utils/latex.js — LaTeX → PNG/SVG math visualiser using KaTeX
// Renders LaTeX server-side to SVG, returns as base64 PNG via sharp

import katex from 'katex';
import fs    from 'fs';
import path  from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Render a LaTeX string to SVG markup
 * @param {string} latex — LaTeX expression e.g. "\\frac{a}{b}"
 * @param {object} opts  — { displayMode: bool, fontSize: number }
 * @returns {string} SVG string
 */
export function latexToSvg(latex, opts = {}) {
  const { displayMode = true, fontSize = 20, color = '#111827' } = opts;
  try {
    const html = katex.renderToString(latex, {
      displayMode,
      throwOnError: false,
      output: 'html',
      trust: false,
    });

    // Wrap in an SVG-compatible HTML envelope
    const width  = displayMode ? 700 : 400;
    const height = displayMode ? 120 : 60;

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <foreignObject width="100%" height="100%">
    <div xmlns="http://www.w3.org/1999/xhtml" style="font-size:${fontSize}px;color:${color};padding:16px;font-family:KaTeX_Main,serif;display:flex;align-items:center;justify-content:center;min-height:100%">
      ${html}
    </div>
  </foreignObject>
</svg>`;
    return svg;
  } catch (err) {
    throw new Error('LaTeX render error: ' + err.message);
  }
}

/**
 * Render LaTeX to a clean SVG string (lightweight, no external deps beyond katex)
 * Returns { svg, dataUrl } where dataUrl is a base64 data URI
 */
export function renderLatex(latex, opts = {}) {
  const svg     = latexToSvg(latex, opts);
  const b64     = Buffer.from(svg).toString('base64');
  const dataUrl = `data:image/svg+xml;base64,${b64}`;
  return { svg, dataUrl };
}

/**
 * Parse plain-text math expressions into LaTeX
 * Converts things like "x^2 + y^2 = r^2" → proper LaTeX
 */
export function textToLatex(text) {
  return text
    .replace(/\*\*/g, '^')               // ** → ^
    .replace(/\bsqrt\(([^)]+)\)/g, '\\sqrt{$1}')
    .replace(/\bfrac\(([^,]+),([^)]+)\)/g, '\\frac{$1}{$2}')
    .replace(/\bsum\b/g, '\\sum')
    .replace(/\bint\b/g, '\\int')
    .replace(/\bprod\b/g, '\\prod')
    .replace(/\balpha\b/g, '\\alpha')
    .replace(/\bbeta\b/g, '\\beta')
    .replace(/\bgamma\b/g, '\\gamma')
    .replace(/\bdelta\b/g, '\\delta')
    .replace(/\bpi\b/g, '\\pi')
    .replace(/\binfty\b/g, '\\infty')
    .replace(/\btheta\b/g, '\\theta')
    .replace(/\blambda\b/g, '\\lambda')
    .replace(/\bsigma\b/g, '\\sigma')
    .replace(/\bmu\b/g, '\\mu')
    .replace(/\bsin\b/g, '\\sin')
    .replace(/\bcos\b/g, '\\cos')
    .replace(/\btan\b/g, '\\tan')
    .replace(/\blog\b/g, '\\log')
    .replace(/\bln\b/g, '\\ln')
    .replace(/\blim\b/g, '\\lim')
    .replace(/<=>/g, '\\Leftrightarrow')
    .replace(/=>/g, '\\Rightarrow')
    .replace(/<=/g, '\\leq')
    .replace(/>=/g, '\\geq')
    .replace(/!=/g, '\\neq')
    .replace(/\+-/g, '\\pm')
    .trim();
}
