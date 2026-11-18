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

async function sendText(to, body) {
  const data = await d360("/messages", {
    method: "POST",
    body: { messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { body, preview_url: false } },
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

module.exports = { db, hookToken, safeEqual, d360, sendText, getSetting, setSetting, logEvent, fmtTime, TZ };
