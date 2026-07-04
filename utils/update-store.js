// utils/update-store.js — Manages app update.json and APK in Supabase Storage
// update.json shape: { version: "2.13.2", notes: "What's new", force: false, apkUrl: "<public url>" }
// The DroidScript app fetches GET /api/app/update and compares versions.

import { createClient } from '@supabase/supabase-js';
import { WebSocket }    from 'ws';

if (typeof globalThis.WebSocket === 'undefined') globalThis.WebSocket = WebSocket;

const URL    = process.env.SUPABASE_RESOURCES_URL || process.env.SUPABASE_URL;
const KEY    =
  process.env.SUPABASE_RESOURCES_SERVICE_KEY ||
  process.env.SUPABASE_RESOURCES_ANON_KEY    ||
  process.env.SUPABASE_SERVICE_KEY           ||
  process.env.SUPABASE_ANON_KEY              ||
  process.env.SUPABASE_KEY;

const BUCKET      = process.env.SUPABASE_UPDATES_BUCKET || 'app-updates';
const UPDATE_KEY  = 'update.json';
const APK_KEY     = 'FundoPlus.apk';

if (!URL || !KEY) {
  console.warn('[UpdateStore] ⚠️  Supabase not configured — update endpoints will use local fallback');
}

let _client = null;
function getClient() {
  if (_client) return _client;
  if (!URL || !KEY) return null;
  try {
    _client = createClient(URL, KEY, { auth: { persistSession: false } });
    return _client;
  } catch (e) {
    console.error('[UpdateStore] createClient failed:', e.message);
    return null;
  }
}

let _bucketReady = false;
async function ensureBucket() {
  if (_bucketReady) return;
  const sb = getClient(); if (!sb) return;
  const { error } = await sb.storage.createBucket(BUCKET, { public: true });
  if (error && !error.message.includes('already exists'))
    console.warn('[UpdateStore] createBucket:', error.message);
  _bucketReady = true;
}

// ── Upload update.json ──────────────────────────────────────────────────────
export async function uploadUpdateJson(jsonBuffer) {
  const sb = getClient();
  if (!sb) throw new Error('Supabase not configured');
  await ensureBucket();

  // Validate it's parseable JSON with a version field
  let parsed;
  try { parsed = JSON.parse(jsonBuffer.toString('utf8')); } catch {
    throw new Error('Invalid JSON in update file');
  }
  if (!parsed.version) throw new Error('update.json must have a "version" field');

  const { error } = await sb.storage.from(BUCKET).upload(UPDATE_KEY, jsonBuffer, {
    contentType: 'application/json',
    upsert: true,
  });
  if (error) throw new Error(error.message);

  const { data: pub } = sb.storage.from(BUCKET).getPublicUrl(UPDATE_KEY);
  console.log(`[UpdateStore] ✅ update.json uploaded — version ${parsed.version}`);
  return { publicUrl: pub.publicUrl, version: parsed.version };
}

// ── Upload APK file ─────────────────────────────────────────────────────────
export async function uploadApk(apkBuffer, originalName) {
  const sb = getClient();
  if (!sb) throw new Error('Supabase not configured');
  await ensureBucket();

  const { error } = await sb.storage.from(BUCKET).upload(APK_KEY, apkBuffer, {
    contentType: 'application/vnd.android.package-archive',
    upsert: true,
  });
  if (error) throw new Error(error.message);

  const { data: pub } = sb.storage.from(BUCKET).getPublicUrl(APK_KEY);
  const sizeMB = Math.round(apkBuffer.length / 1024 / 1024 * 10) / 10;
  console.log(`[UpdateStore] ✅ APK uploaded — ${originalName} (${sizeMB} MB)`);
  return pub.publicUrl;
}

// ── Fetch current update.json from Supabase ─────────────────────────────────
export async function fetchUpdateJson() {
  const sb = getClient();
  if (!sb) return null;
  await ensureBucket();
  try {
    const { data, error } = await sb.storage.from(BUCKET).download(UPDATE_KEY);
    if (error) return null;
    const text = await data.text();
    const parsed = JSON.parse(text);
    // Inject apkUrl so the app always gets a direct link
    if (!parsed.apkUrl) {
      const { data: pub } = sb.storage.from(BUCKET).getPublicUrl(APK_KEY);
      parsed.apkUrl = pub.publicUrl;
    }
    return parsed;
  } catch {
    return null;
  }
}

// ── Get public URL for the APK (used by admin panel to display download link) ─
export function getApkPublicUrl() {
  const sb = getClient();
  if (!sb) return null;
  const { data } = sb.storage.from(BUCKET).getPublicUrl(APK_KEY);
  return data?.publicUrl || null;
}
