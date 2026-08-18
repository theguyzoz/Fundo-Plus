/**
 * utils/paynow.js — Paynow Zimbabwe integration (ESM).
 *
 * Hash algorithm verified against the official Paynow NodeJS SDK:
 *   github.com/paynow/Paynow-NodeJS-SDK
 *
 * Key rules:
 *  - Hash = SHA512( concat(all field values except "hash", in insertion order) + integrationKey.toLowerCase() )
 *  - Result is uppercased hex.
 *  - For initiate: field order is resulturl, returnurl, reference, amount, id, additionalinfo,
 *    authemail, phone, method, status.
 *  - For status updates (webhook + poll): hash all fields as they arrive (except "hash"), same algorithm.
 */

import crypto from 'crypto';

function sha512Upper(str) {
  return crypto.createHash('sha512').update(str, 'utf8').digest('hex').toUpperCase();
}

/**
 * Generate a Paynow hash.
 * @param {Object} fields - ordered plain object of all fields (hash key excluded automatically)
 * @param {string} integrationKey
 */
export function generateHash(fields, integrationKey) {
  let str = '';
  for (const key of Object.keys(fields)) {
    if (key.toLowerCase() !== 'hash') {
      str += (fields[key] == null ? '' : String(fields[key]));
    }
  }
  str += integrationKey.toLowerCase();
  return sha512Upper(str);
}

/**
 * Parse Paynow's URL-encoded response string into a plain object (preserves field order).
 */
export function parseResponse(text) {
  const obj = {};
  for (const pair of String(text || '').split('&')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const k = decodeURIComponent(pair.slice(0, eq));
    const v = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '));
    obj[k] = v;
  }
  return obj;
}

const integrationId  = () => process.env.PAYNOW_INTEGRATION_ID  || '';
const integrationKey = () => process.env.PAYNOW_INTEGRATION_KEY || '';
const merchantEmail  = () => process.env.PAYNOW_MERCHANT_EMAIL  || '';
const siteUrl        = () => (process.env.WEBSITE_URL || '').replace(/\/+$/, '');

export function isConfigured() {
  return !!(integrationId() && integrationKey());
}

/**
 * Initiate a Paynow mobile payment (express checkout).
 * @returns {Promise<{ redirectUrl: string|null, pollUrl: string|null, instructions: string|null }>}
 */
export async function createPayment({ amount, method, phone, reference, description }) {
  const id  = integrationId();
  const key = integrationKey();
  if (!id || !key) throw new Error('Paynow is not configured. Set PAYNOW_INTEGRATION_ID and PAYNOW_INTEGRATION_KEY.');

  const base      = siteUrl();
  const returnUrl = `${base}/~/subscription?paid=1`;
  const resultUrl = `${base}/api/paynow/update`;
  const amountStr = parseFloat(amount).toFixed(2);

  // Field order MUST match this exactly — it determines the hash concatenation order.
  const fields = {
    resulturl:      resultUrl,
    returnurl:      returnUrl,
    reference:      reference || 'ref',
    amount:         amountStr,
    id:             id,
    additionalinfo: description || 'Fundo Plus subscription',
    authemail:      merchantEmail(),
    phone:          phone      || '',
    method:         method     || 'ecocash',
    status:         'Message',
  };

  fields.hash = generateHash(fields, key);

  const res = await fetch('https://www.paynow.co.zw/interface/remotetransaction', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams(fields).toString(),
  });

  const text = await res.text();
  const data = parseResponse(text);

  if ((data.status || '').toLowerCase() === 'error') {
    throw new Error(data.error || `Paynow error: ${text.slice(0, 300)}`);
  }

  // Verify Paynow's response hash before trusting the URLs
  const expectedHash = generateHash(data, key);
  if (data.hash && data.hash.toUpperCase() !== expectedHash) {
    throw new Error('Paynow response hash mismatch — possible tampering');
  }

  return {
    redirectUrl:  data.browserurl  || null,
    pollUrl:      data.pollurl     || null,
    instructions: data.instructions || null,
  };
}

/**
 * Verify the hash on a Paynow status-update POST (webhook).
 */
export function verifyUpdate(params) {
  const key = integrationKey();
  if (!key) return false;
  const received = (params.hash || '').toUpperCase();
  if (!received) return false;
  const expected = generateHash(params, key);
  return received === expected;
}

/**
 * Poll Paynow's pollUrl for the latest transaction status.
 * Returns the parsed response object ({ status, reference, paynowreference, amount, ... }).
 */
export async function pollTransaction(pollUrl) {
  const res  = await fetch(pollUrl);
  const text = await res.text();
  return parseResponse(text);
}
