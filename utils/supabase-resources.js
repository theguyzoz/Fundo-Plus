import { createClient } from '@supabase/supabase-js';
import fs   from 'fs';
import path from 'path';
import { WebSocket } from 'ws';

if (typeof globalThis.WebSocket === 'undefined') {
  globalThis.WebSocket = WebSocket;
}
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const URL  = process.env.SUPABASE_RESOURCES_URL;
const KEY  =
  process.env.SUPABASE_RESOURCES_SERVICE_KEY  ||
  process.env.SUPABASE_RESOURCES_ANON_KEY     ||
  process.env.SUPABASE_RESOURCES_KEY;
const BUCKET = process.env.SUPABASE_RESOURCES_BUCKET || 'resources';

const LIMIT_BYTES = 800 * 1024 * 1024; // 800 MB hard cap

if (!URL)  console.error('[Supabase:Resources] ❌ SUPABASE_RESOURCES_URL not set — storage disabled');
else if (!KEY) console.error('[Supabase:Resources] ❌ No key found. Set SUPABASE_RESOURCES_SERVICE_KEY — storage disabled');
else console.log(`[Supabase:Resources] ✅ Configured — ${URL.slice(0, 45)} | bucket: ${BUCKET}`);

let _client = null;
function getClient() {
  if (_client) return _client;
  if (!URL || !KEY) return null;
  try {
    _client = createClient(URL, KEY, { auth: { persistSession: false } });
    return _client;
  } catch (e) {
    console.error('[Supabase:Resources] createClient failed:', e.message);
    return null;
  }
}

let _bucketReady = false;
async function ensureBucket() {
  if (_bucketReady) return;
  const sb = getClient(); if (!sb) return;
  const { error } = await sb.storage.createBucket(BUCKET, { public: true });
  if (error && !error.message.includes('already exists'))
    console.warn(`[Supabase:Resources] createBucket:`, error.message);
  _bucketReady = true;
}

async function getUsedBytes() {
  const sb = getClient(); if (!sb) return 0;
  try {
    const { data, error } = await sb.storage.from(BUCKET).list('', { limit: 10000 });
    if (error || !data) return 0;
    return data.reduce((sum, f) => sum + (f.metadata?.size || 0), 0);
  } catch { return 0; }
}

export async function checkResourcesCapacity(incomingBytes = 0) {
  const used = await getUsedBytes();
  const available = LIMIT_BYTES - used;
  const withinLimit = available >= incomingBytes;
  return {
    used,
    available,
    limitBytes: LIMIT_BYTES,
    usedMB: Math.round(used / 1024 / 1024 * 10) / 10,
    availableMB: Math.round(available / 1024 / 1024 * 10) / 10,
    limitMB: 800,
    withinLimit,
    pct: Math.min(100, Math.round((used / LIMIT_BYTES) * 1000) / 10),
  };
}

export async function uploadResource(filename, buffer, mimetype = 'application/pdf') {
  const sb = getClient();
  if (!sb) throw new Error('Supabase Resources not configured');
  await ensureBucket();

  const cap = await checkResourcesCapacity(buffer.length);
  if (!cap.withinLimit) {
    throw new Error(
      `Storage limit reached (${cap.usedMB} MB / 800 MB used). ` +
      `File is ${Math.round(buffer.length / 1024)} KB but only ${cap.availableMB} MB remaining.`
    );
  }

  const { error } = await sb.storage.from(BUCKET).upload(filename, buffer, {
    contentType: mimetype,
    upsert: false,
  });
  if (error) throw new Error(error.message);

  const { data: pub } = sb.storage.from(BUCKET).getPublicUrl(filename);
  console.log(`[Supabase:Resources] ✅ Uploaded: ${filename} (${Math.round(buffer.length / 1024)} KB) — ${cap.usedMB} MB used`);
  return pub.publicUrl;
}

export async function deleteResource(filename) {
  const sb = getClient(); if (!sb) return;
  const { error } = await sb.storage.from(BUCKET).remove([filename]);
  if (error) console.warn('[Supabase:Resources] delete:', error.message);
  else console.log(`[Supabase:Resources] 🗑 Deleted: ${filename}`);
}

export async function listResources() {
  const sb = getClient(); if (!sb) return [];
  await ensureBucket();
  const { data, error } = await sb.storage.from(BUCKET).list('', { limit: 1000 });
  if (error) { console.warn('[Supabase:Resources] list:', error.message); return []; }
  return (data || []).map(f => ({
    name: f.name,
    size: f.metadata?.size || 0,
    createdAt: f.created_at,
    url: getClient().storage.from(BUCKET).getPublicUrl(f.name).data.publicUrl,
  }));
}

export async function getResourceUrl(filename) {
  const sb = getClient(); if (!sb) return null;
  const { data } = sb.storage.from(BUCKET).getPublicUrl(filename);
  return data?.publicUrl || null;
}

export async function getResourcesStats() {
  return checkResourcesCapacity(0);
}

/** Push a tiny file to the papers/resources bucket then delete it after 24h — keeps the cloud warm. */
export async function papersKeepAlivePing() {
  const sb = getClient();
  if (!sb) {
    console.warn('[Supabase:Resources] keepalive skipped — not configured');
    return false;
  }
  const stamp = new Date().toISOString();
  const filename = `_keepalive/ping-${Date.now()}.txt`;
  const buf = Buffer.from(`Fundo Plus papers keepalive\n${stamp}\n`, 'utf8');
  try {
    await uploadResource(filename, buf, 'text/plain');
    console.log(`[Supabase:Resources] ☁ keepalive uploaded ${filename}`);
    setTimeout(() => {
      deleteResource(filename).catch(() => {});
    }, 24 * 60 * 60 * 1000);
    // also drop any keepalive older than 24h now
    try {
      const { data } = await sb.storage.from(BUCKET).list('_keepalive', { limit: 100 });
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      const old = (data || []).filter(f => {
        const t = new Date(f.created_at || 0).getTime();
        return t && t < cutoff;
      }).map(f => `_keepalive/${f.name}`);
      if (old.length) await sb.storage.from(BUCKET).remove(old);
    } catch {}
    return true;
  } catch (e) {
    console.warn('[Supabase:Resources] keepalive failed:', e.message);
    return false;
  }
}
