// Shared helpers for the WhatsApp bot (server side only).
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const D360_BASE = "https://waba-v2.360dialog.io";
const SUPABASE_URL = process.env.SUPABASE_URL || "https://hpmmyateiscpvvgkanhf.supabase.co";
const TZ = "Indian/Mauritius";

let _db = null;
function db() {
  if (!_db) {
    if (!process.env.SUPABASE_SECRET_KEY) throw new Error("SUPABASE_SECRET_KEY is not set in Vercel");
    _db = createClient(SUPABASE_URL.replace(/\/+$/, "").replace(/\/rest\/v1$/, ""), process.env.SUPABASE_SECRET_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _db;
}

// Secret token that 360dialog sends back on every webhook call, so nobody else can post fake messages.
// Derived from keys that only exist in Vercel, so no extra setting is needed.
function hookToken() {
  const seed = `${process.env.D360_API_KEY || ""}|${process.env.SUPABASE_SECRET_KEY || ""}|paving-hook`;
  return crypto.createHash("sha256").update(seed).digest("hex").slice(0, 40);
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

async function d360(path, { method = "GET", body } = {}) {
  const key = process.env.D360_API_KEY;
  if (!key) throw new Error("D360_API_KEY is not set in Vercel");
  const res = await fetch(`${D360_BASE}${path}`, {
    method,
    headers: { "D360-API-KEY": key, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data?.error?.message || data?.meta?.developer_message || data?.raw || `HTTP ${res.status}`;
    const err = new Error(`WhatsApp: ${msg}`);
    err.data = data;
    throw err;
  }
  return data;
}

// WhatsApp allows about 1 message every 6 seconds to the same person (error 131056 if faster),
// so retry rate-limit errors with a growing wait before giving up.
async function sendText(to, body) {
  const waits = [0, 4000, 8000];
  let lastErr;
  for (const wait of waits) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try { return await sendTextOnce(to, body); }
    catch (err) {
      lastErr = err;
      const raw = JSON.stringify(err.data || "") + String(err.message || "");
      if (!/131056|130429|rate limit/i.test(raw)) throw err;
    }
  }
  throw lastErr;
}

async function sendTextOnce(to, body) {
  const data = await d360("/messages", {
    method: "POST",
    // Show the link preview (map picture, Facebook page) whenever the message contains a link.
    body: { messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { body, preview_url: /https?:\/\//i.test(body) } },
  });
  return data?.messages?.[0]?.id || `local-${Date.now()}`;
}

// Downloads a photo or document a client sent. WhatsApp gives a Meta link, which must be
// fetched through 360dialog's host with our key. Returns { mime, base64, size }.
async function downloadMedia(mediaId) {
  const meta = await d360(`/${encodeURIComponent(mediaId)}`);
  if (!meta?.url) throw new Error("No media link");
  const u = new URL(meta.url);
  const res = await fetch(`${D360_BASE}${u.pathname}${u.search}`, { headers: { "D360-API-KEY": process.env.D360_API_KEY } });
  if (!res.ok) throw new Error(`Media download failed (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const mime = String(meta.mime_type || res.headers.get("content-type") || "").split(";")[0].trim();
  return { mime, base64: buf.toString("base64"), size: buf.length };
}

// Saves a bot suggestion. If the "quote" column hasn't been added in Supabase yet,
// the suggestion is still saved without it.
async function insertDraft(row) {
  let res = await db().from("wa_drafts").insert(row).select().single();
  if (res.error && row.quote !== undefined && /quote/i.test(res.error.message || "")) {
    const { quote, ...rest } = row;
    res = await db().from("wa_drafts").insert({ ...rest, team_note: [rest.team_note, quote ? "A quotation was prepared but could not be saved: add the quote column in Supabase." : ""].filter(Boolean).join(" ") || null }).select().single();
  }
  if (res.error) throw res.error;
  return res.data;
}

async function uploadMedia(buffer, mime, filename) {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mime);
  form.append("file", new Blob([buffer], { type: mime }), filename);
  const res = await fetch(`${D360_BASE}/media`, { method: "POST", headers: { "D360-API-KEY": process.env.D360_API_KEY }, body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id) {
    const err = new Error(`WhatsApp upload: ${data?.error?.message || res.status}`);
    err.data = data;
    throw err;
  }
  return data.id;
}

async function sendDocument(to, mediaId, filename, caption) {
  const data = await d360("/messages", {
    method: "POST",
    body: { messaging_product: "whatsapp", recipient_type: "individual", to, type: "document", document: { id: mediaId, filename, caption: caption || undefined } },
  });
  return data?.messages?.[0]?.id || `local-${Date.now()}`;
}

async function getSetting(key, fallback) {
  const { data } = await db().from("wa_settings").select("value").eq("key", key).maybeSingle();
  return data && data.value !== null && data.value !== undefined ? data.value : fallback;
}

async function setSetting(key, value) {
  const { error } = await db().from("wa_settings").upsert({ key, value });
  if (error) throw error;
}

async function logEvent(kind, payload) {
  try { await db().from("wa_events").insert({ kind, payload }); } catch { /* never block on logging */ }
}

function fmtTime(iso) {
  return new Date(iso).toLocaleString("en-GB", { timeZone: TZ, weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

module.exports = { db, hookToken, safeEqual, d360, sendText, downloadMedia, uploadMedia, sendDocument, insertDraft, getSetting, setSetting, logEvent, fmtTime, TZ };
