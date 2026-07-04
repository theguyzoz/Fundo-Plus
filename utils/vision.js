// utils/vision.js — Image analysis using Tesseract.js (OCR only)
// Uses tesseract.js for local text/OCR extraction from images

import Tesseract from 'tesseract.js';
import sharp from 'sharp';

/**
 * Analyze an image buffer and return a description using Tesseract.js OCR.
 * @param {Buffer} imgBuffer
 * @param {string} [hint] - optional user caption/hint
 * @returns {Promise<string>}
 */
export async function analyzeImage(imgBuffer, hint = '') {
  const results = [];

  // Pre-process image with sharp for better OCR accuracy (if available)
  let processedBuffer = imgBuffer;
  try {
    processedBuffer = await sharp(imgBuffer)
      .resize({ width: 1200, withoutEnlargement: true })
      .grayscale()
      .normalize()
      .toBuffer();
  } catch (_) {
    // sharp not available or failed, use raw buffer
    processedBuffer = imgBuffer;
  }

  // Run Tesseract OCR
  try {
    const { data } = await Tesseract.recognize(processedBuffer, 'eng', {
      logger: () => {}, // silence progress logs
    });
    const text = (data?.text || '').trim();
    if (text.length > 3) {
      results.push(`Text found in image: "${text.slice(0, 800)}"`);
    }
  } catch (err) {
    console.warn('Tesseract OCR failed:', err.message);
  }

  if (results.length === 0) {
    return hint
      ? `User shared an image with caption: "${hint}". No readable text was detected.`
      : 'User shared an image (no readable text detected)';
  }

  return results.join('. ');
}
