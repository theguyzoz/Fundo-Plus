import path from 'path';

export const CATBOX_MAX_BYTES = 50 * 1024 * 1024;
export const CATBOX_API = 'https://catbox.moe/user/api.php';

const BLOCKED_EXT = new Set([
  'exe', 'scr', 'cpl', 'doc', 'jar', 'bat', 'cmd', 'com', 'pif', 'msi', 'js', 'html', 'htm', 'svg',
]);

export function classifyMedia(mime, filename) {
  const m = String(mime || '').toLowerCase();
  const ext = String(filename || '').split('.').pop().toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (ext === 'docx' || m.includes('wordprocessingml.document')) return 'docx';
  if (m.startsWith('audio/')) return 'audio';
  return 'file';
}

export function assertAllowedMedia(mime, filename, size) {
  if (size != null && size > CATBOX_MAX_BYTES) {
    return `File too large (max ${Math.round(CATBOX_MAX_BYTES / (1024 * 1024))} MB)`;
  }
  const ext = String(filename || '').split('.').pop().toLowerCase();
  if (BLOCKED_EXT.has(ext)) return 'This file type is not allowed';
  const kind = classifyMedia(mime, filename);
  if (!['image', 'video', 'pdf', 'docx'].includes(kind)) {
    return 'Only images, video, PDF, and DOCX are allowed';
  }
  return null;
}

export function safeFilename(name) {
  const base = path.basename(String(name || 'file')).replace(/[^\w.\- ()[\]]+/g, '_').slice(0, 80);
  return base || 'file';
}

/** Upload a buffer to catbox.moe. Returns https://files.catbox.moe/... or throws. */
export async function uploadToCatbox(buffer, filename, mime) {
  const form = new FormData();
  form.append('reqtype', 'fileupload');
  const userhash = process.env.CATBOX_USERHASH;
  if (userhash) form.append('userhash', userhash);
  const blob = new Blob([buffer], { type: mime || 'application/octet-stream' });
  form.append('fileToUpload', blob, safeFilename(filename));
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 180_000);
  try {
    const r = await fetch(CATBOX_API, { method: 'POST', body: form, signal: ctrl.signal });
    const text = (await r.text()).trim();
    if (!r.ok || !/^https?:\/\/files\.catbox\.moe\//i.test(text)) {
      throw new Error(text.slice(0, 180) || `Catbox HTTP ${r.status}`);
    }
    return text;
  } finally {
    clearTimeout(t);
  }
}
