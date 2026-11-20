// Receives every WhatsApp event for 5725 4201 from 360dialog:
// client messages, replies typed on the business phone (echoes), history sync and contacts.
// It stores them in Supabase and asks Claude for a suggested reply. It never sends anything.
const { db, hookToken, safeEqual, getSetting, logEvent, insertDraft, sendText } = require("./_lib/common");
const { draftReply, draftRow, hasContent } = require("./_lib/drafter");
const { adText, noteAd } = require("./_lib/ads");

let waitUntil = null;
try { ({ waitUntil } = require("@vercel/functions")); } catch { waitUntil = null; }

const DEBOUNCE_MS = 10000; // wait for the client to finish typing several messages
const digits = (s) => String(s || "").replace(/\D/g, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isoFromTs = (ts) => new Date((Number(ts) || Date.now() / 1000) * 1000).toISOString();

function bodyOf(m) {
  if (!m) return "";
  const cap = (x) => (x?.caption ? ` ${x.caption}` : "");
  switch (m.type) {
    case "text": return m.text?.body || "";
    case "image": return `[Photo]${cap(m.image)}`;
    case "video": return `[Video]${cap(m.video)}`;
    case "document": return `[Document ${m.document?.filename || ""}]${cap(m.document)}`.replace(" ]", "]");
    case "audio": return m.audio?.voice ? "[Voice note]" : "[Audio]";
    case "sticker": return "[Sticker]";
    case "location": {
      const l = m.location || {};
      return `[Location] ${[l.name, l.address].filter(Boolean).join(", ")} https://maps.google.com/?q=${l.latitude},${l.longitude}`.trim();
    }
    case "contacts": return `[Contact card] ${(m.contacts || []).map((c) => `${c.name?.formatted_name || ""} ${(c.phones || []).map((p) => p.phone).join(" ")}`).join("; ")}`;
    case "reaction": return `[Reaction ${m.reaction?.emoji || ""}]`;
    case "button": return m.button?.text || "[Button]";
    case "interactive": return m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || "[Interactive]";
    default: return `[${m.type || "message"}]`;
  }
}
// Clients who tap a Facebook / Instagram "Send WhatsApp message" ad arrive with the ad attached.
function adOf(m) {
  const r = m?.referral;
  if (!r) return "";
  const what = adText(r);
  const src = r.source_type === "post" ? "Facebook post" : "Facebook ad";
  const url = String(r.source_url || "").trim();
  const id = String(r.source_id || "").replace(/[()\]\s]/g, "");
  return `[From ${src}${what ? `: "${what}"` : ""}${/^https?:\/\//.test(url) ? ` ${url.replace(/\s/g, "")}` : ""}${id ? ` (ad ${id})` : ""}] `;
}
function mediaIdOf(m) {
  return m?.[m?.type]?.id || null;
}

// 360dialog normally forwards Meta's format (entry -> changes); also accept a wrapped {event, data} form.
function collectChanges(body) {
  if (!body || typeof body !== "object") return [];
  if (Array.isArray(body.entry)) {
    return body.entry.flatMap((e) => (e.changes || []).map((c) => ({ field: c.field, value: c.value || {} })));
  }
  if (body.data) {
    const inner = collectChanges(body.data);
    if (inner.length) return inner;
    if (body.event) return [{ field: body.event, value: body.data }];
  }
  return [];
}

async function ensureContacts(rows) {
  if (!rows.length) return;
  const byId = new Map();
  rows.forEach((r) => byId.set(r.wa_id, { ...(byId.get(r.wa_id) || {}), ...r }));
  await db().from("wa_contacts").upsert([...byId.values()], { onConflict: "wa_id" });
}

async function insertMessages(rows) {
  if (!rows.length) return [];
  const { data, error } = await db().from("wa_messages").upsert(rows, { onConflict: "id", ignoreDuplicates: true }).select("id");
  if (error) throw error;
  return (data || []).map((r) => r.id);
}

async function refreshLastMessage(waIds) {
  for (const waId of new Set(waIds)) {
    const { data } = await db().from("wa_messages").select("sent_at").eq("wa_id", waId).order("sent_at", { ascending: false }).limit(1);
    if (data?.[0]) await db().from("wa_contacts").update({ last_message_at: data[0].sent_at }).eq("wa_id", waId);
  }
}

async function supersedeDrafts(waId) {
  await db().from("wa_drafts").update({ status: "superseded", decided_at: new Date().toISOString() }).eq("wa_id", waId).eq("status", "pending");
}

// After a short pause, write a draft for the latest client message if nobody has answered yet.
async function draftFor(waId, triggerId) {
  try {
    await sleep(DEBOUNCE_MS);
    const latest = async () => (await db().from("wa_messages").select("id,direction").eq("wa_id", waId).order("sent_at", { ascending: false }).limit(1)).data?.[0];
    let last = await latest();
    if (!last || last.id !== triggerId) return; // a newer message arrived, or the team already replied
    const draft = await draftReply(waId);
    last = await latest();
    if (!draft || !last || last.id !== triggerId) return;
    if (!hasContent(draft)) return;
    await supersedeDrafts(waId);
    await insertDraft(draftRow(waId, triggerId, draft));
  } catch (err) {
    await logEvent("draft_error", { wa_id: waId, message: String(err?.message || err) });
    await db().from("wa_drafts").insert({
      wa_id: waId, reply_to: triggerId, body: "", needs_team: true, status: "pending",
      team_note: `The bot could not write a reply this time. Please answer this client yourself. (Reason: ${String(err?.message || err).slice(0, 200)})`, error: String(err?.message || err),
    });
  }
}

async function handle(body) {
  const changes = collectChanges(body);
  if (!changes.length) { await logEvent("unknown", body); return { toDraft: [], resendLater: [] }; }

  const [botEnabled, staffList] = await Promise.all([getSetting("bot_enabled", true), getSetting("staff_numbers", [])]);
  const staff = new Set((Array.isArray(staffList) ? staffList : []).map(digits));
  const toDraft = [];
  const resendLater = [];

  for (const { field, value } of changes) {
    const business = digits(value?.metadata?.display_phone_number);

    if (field === "messages") {
      const names = new Map((value.contacts || []).map((c) => [digits(c.wa_id), c.profile?.name || null]));
      const msgs = value.messages || [];
      if (msgs.length) {
        await ensureContacts(msgs.map((m) => {
          const id = digits(m.from);
          const row = { wa_id: id, last_inbound_at: isoFromTs(m.timestamp), is_staff: staff.has(id) };
          if (names.get(id)) row.profile_name = names.get(id);
          return row;
        }));
        const newIds = await insertMessages(msgs.map((m) => ({
          id: m.id, wa_id: digits(m.from), direction: "in", source: "client", type: m.type,
          body: adOf(m) + bodyOf(m), media_id: mediaIdOf(m), sent_at: isoFromTs(m.timestamp),
        })));
        for (const m of msgs) if (m.referral) {
          await logEvent("ad_referral", { wa_id: digits(m.from), message_id: m.id, referral: m.referral });
          try { await noteAd(m.referral); } catch { /* only for the Setup list */ }
        }
        await refreshLastMessage(msgs.map((m) => digits(m.from)));
        for (const m of msgs) {
          if (!newIds.includes(m.id)) continue; // retry of something we already have
          const id = digits(m.from);
          const { data: c } = await db().from("wa_contacts").select("unread,bot_paused,is_staff").eq("wa_id", id).maybeSingle();
          await db().from("wa_contacts").update({ unread: (c?.unread || 0) + 1 }).eq("wa_id", id);
          if (botEnabled !== false && !c?.bot_paused && !c?.is_staff && !staff.has(id) && m.type !== "reaction") toDraft.push([id, m.id]);
        }
      }
      for (const s of value.statuses || []) {
        await db().from("wa_messages").update({ status: s.status }).eq("id", s.id);
        if (s.status === "failed") {
          await logEvent("send_failed", s);
          const rateLimited = (s.errors || []).some((e) => Number(e.code) === 131056 || Number(e.code) === 130429);
          if (rateLimited) resendLater.push(s.id);
        }
      }
    } else if (field === "smb_message_echoes") {
      // Replies typed on the business phone or JL's linked devices.
      const echoes = value.message_echoes || [];
      if (echoes.length) {
        await ensureContacts(echoes.map((m) => ({ wa_id: digits(m.to) })));
        await insertMessages(echoes.map((m) => ({
          id: m.id, wa_id: digits(m.to), direction: "out", source: "phone", type: m.type,
          body: bodyOf(m), media_id: mediaIdOf(m), sent_at: isoFromTs(m.timestamp),
        })));
        const ids = echoes.map((m) => digits(m.to));
        await refreshLastMessage(ids);
        for (const id of new Set(ids)) {
          await supersedeDrafts(id);
          await db().from("wa_contacts").update({ unread: 0 }).eq("wa_id", id);
        }
      }
    } else if (field === "history") {
      // One-off copy of past chats from the WhatsApp Business app. Stored only, never answered.
      const rows = [];
      for (const h of value.history || []) {
        for (const t of h.threads || []) {
          const client = digits(t.id);
          for (const m of t.messages || []) {
            const out = business ? digits(m.from) === business : digits(m.from) !== client;
            rows.push({
              id: m.id, wa_id: client || digits(out ? m.to : m.from), direction: out ? "out" : "in", source: "history",
              type: m.type, body: bodyOf(m), media_id: mediaIdOf(m), sent_at: isoFromTs(m.timestamp),
              status: m.history_context?.status || null,
            });
          }
        }
      }
      const good = rows.filter((r) => r.id && r.wa_id);
      await ensureContacts([...new Set(good.map((r) => r.wa_id))].map((id) => ({ wa_id: id })));
      for (let i = 0; i < good.length; i += 500) await insertMessages(good.slice(i, i + 500));
      await refreshLastMessage(good.map((r) => r.wa_id));
      await logEvent("history", { chunks: (value.history || []).map((h) => h.metadata || null), messages: good.length });
    } else if (field === "smb_app_state_sync") {
      // Names saved in the business phone's contacts.
      const rows = (value.state_sync || [])
        .filter((s) => s.type === "contact" && s.contact?.phone_number && s.action !== "remove")
        .map((s) => ({ wa_id: digits(s.contact.phone_number), name: s.contact.full_name || s.contact.first_name || null }));
      await ensureContacts(rows);
    } else {
      await logEvent(field || "other", value);
    }
  }
  return { toDraft, resendLater };
}

// A message from the Suite that WhatsApp dropped for sending too fast: send it again once, 8 s later.
async function resendFailed(messageId) {
  try {
    await sleep(8000);
    const { data: m } = await db().from("wa_messages").select("*").eq("id", messageId).maybeSingle();
    if (!m || m.source !== "suite" || m.type !== "text" || !m.body || m.status === "resent") return;
    const id = await sendText(m.wa_id, m.body);
    await db().from("wa_messages").upsert({ id, wa_id: m.wa_id, direction: "out", source: "suite", type: "text", body: m.body, status: "sent", sent_at: new Date().toISOString() }, { onConflict: "id", ignoreDuplicates: true });
    await db().from("wa_messages").update({ status: "resent" }).eq("id", m.id);
  } catch (err) {
    await logEvent("resend_failed", { message_id: messageId, message: String(err?.message || err) });
  }
}

module.exports = async function handler(req, res) {
  if (req.method === "GET") return res.status(200).send("ok");
  if (req.method !== "POST") return res.status(405).end();

  const token = req.headers["x-hook-token"] || req.query?.token;
  if (!safeEqual(token, hookToken())) return res.status(401).json({ error: "bad token" });

  let toDraft = [];
  let resendLater = [];
  try {
    ({ toDraft, resendLater } = await handle(req.body));
  } catch (err) {
    await logEvent("webhook_error", { message: String(err?.message || err), body: req.body });
  }

  const jobs = Promise.all([
    ...toDraft.map(([waId, msgId]) => draftFor(waId, msgId)),
    ...resendLater.map((id) => resendFailed(id)),
  ]);
  if (waitUntil) {
    waitUntil(jobs);
    return res.status(200).json({ ok: true });
  }
  await jobs;
  return res.status(200).json({ ok: true });
};

module.exports.config = { maxDuration: 60 };
