// Everything the Suite's WhatsApp tab does goes through here, protected by the SUITE_PASSWORD
// set in Vercel. The browser never sees the WhatsApp, Claude or Supabase secret keys.
const { db, hookToken, safeEqual, d360, sendText, downloadMedia, uploadMedia, sendDocument, insertDraft, getSetting, setSetting, logEvent } = require("./_lib/common");
const { draftReply } = require("./_lib/drafter");

const digits = (s) => String(s || "").replace(/\D/g, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function siteUrl(req) {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || req.headers["x-forwarded-host"] || req.headers.host;
  return `https://${host}`;
}

async function listChats() {
  const [{ data: contacts, error }, { data: drafts }] = await Promise.all([
    db().from("wa_contacts").select("wa_id,name,profile_name,unread,bot_paused,is_staff,last_message_at")
      .not("last_message_at", "is", null).order("last_message_at", { ascending: false }).limit(200),
    db().from("wa_drafts").select("wa_id,needs_team").eq("status", "pending"),
  ]);
  if (error) throw error;
  const pending = new Map();
  (drafts || []).forEach((d) => pending.set(d.wa_id, { needs_team: d.needs_team || pending.get(d.wa_id)?.needs_team }));
  const ids = (contacts || []).map((c) => c.wa_id);
  const lastBodies = new Map();
  if (ids.length) {
    const { data: last } = await db().from("wa_messages").select("wa_id,body,direction,sent_at")
      .in("wa_id", ids.slice(0, 60)).order("sent_at", { ascending: false }).limit(600);
    (last || []).forEach((m) => { if (!lastBodies.has(m.wa_id)) lastBodies.set(m.wa_id, m); });
  }
  return (contacts || []).map((c) => ({
    ...c,
    last: lastBodies.get(c.wa_id) || null,
    pending: pending.has(c.wa_id),
    needs_team: Boolean(pending.get(c.wa_id)?.needs_team),
  }));
}

async function getChat(waId) {
  const [{ data: contact }, { data: messages }, { data: drafts }] = await Promise.all([
    db().from("wa_contacts").select("*").eq("wa_id", waId).maybeSingle(),
    db().from("wa_messages").select("id,direction,source,type,body,media_id,status,sent_at").eq("wa_id", waId).order("sent_at", { ascending: false }).limit(150),
    db().from("wa_drafts").select("*").eq("wa_id", waId).eq("status", "pending").order("created_at", { ascending: false }).limit(1),
  ]);
  await db().from("wa_contacts").update({ unread: 0 }).eq("wa_id", waId);
  return { contact, messages: (messages || []).reverse(), draft: drafts?.[0] || null };
}

async function send(waId, body, draftId) {
  const text = String(body || "").trim();
  if (!text) throw new Error("Message is empty");
  try {
    const id = await sendText(waId, text);
    await db().from("wa_messages").upsert({
      id, wa_id: waId, direction: "out", source: "suite", type: "text", body: text, status: "sent", sent_at: new Date().toISOString(),
    }, { onConflict: "id", ignoreDuplicates: true });
    await db().from("wa_contacts").update({ last_message_at: new Date().toISOString(), unread: 0 }).eq("wa_id", waId);
    await db().from("wa_drafts").update({ status: "superseded", decided_at: new Date().toISOString() })
      .eq("wa_id", waId).eq("status", "pending").neq("id", draftId || 0);
    if (draftId) await db().from("wa_drafts").update({ status: "sent", body: text, decided_at: new Date().toISOString() }).eq("id", draftId);
    return { ok: true, id };
  } catch (err) {
    if (draftId) await db().from("wa_drafts").update({ error: String(err.message || err) }).eq("id", draftId);
    // 131047 = more than 24 hours since the client last wrote: WhatsApp only allows approved templates.
    const late = JSON.stringify(err.data || "").includes("131047");
    throw new Error(late
      ? "This client last wrote more than 24 hours ago, so WhatsApp won't let us send a normal message. Reply from the phone instead, or wait for the client to write again."
      : String(err.message || err));
  }
}

async function redraft(waId) {
  const draft = await draftReply(waId);
  if (!draft) throw new Error("No messages in this chat yet");
  await db().from("wa_drafts").update({ status: "superseded", decided_at: new Date().toISOString() }).eq("wa_id", waId).eq("status", "pending");
  const { data: last } = await db().from("wa_messages").select("id").eq("wa_id", waId).eq("direction", "in").order("sent_at", { ascending: false }).limit(1);
  return insertDraft({
    wa_id: waId, reply_to: last?.[0]?.id || null, body: draft.reply, needs_team: draft.needs_team, team_note: draft.team_note || null,
    ...(draft.quote ? { quote: draft.quote } : {}),
  });
}

// Sends a PDF made in the Suite (an approved quotation) to the client.
async function sendPdf(waId, { filename, data, caption, draftId }) {
  const name = String(filename || "Quotation.pdf").replace(/[^\w.\-]/g, "_");
  const buf = Buffer.from(String(data || ""), "base64");
  if (buf.length < 100 || buf.slice(0, 4).toString() !== "%PDF") throw new Error("The PDF could not be created");
  const text = String(caption || "").trim();
  try {
    const mediaId = await uploadMedia(buf, "application/pdf", name);
    const id = await sendDocument(waId, mediaId, name, text);
    const now = new Date().toISOString();
    await db().from("wa_messages").upsert({
      id, wa_id: waId, direction: "out", source: "suite", type: "document", media_id: mediaId,
      body: `[Document ${name}]${text ? ` ${text}` : ""}`, status: "sent", sent_at: now,
    }, { onConflict: "id", ignoreDuplicates: true });
    await db().from("wa_contacts").update({ last_message_at: now, unread: 0 }).eq("wa_id", waId);
    await db().from("wa_drafts").update({ status: "superseded", decided_at: now }).eq("wa_id", waId).eq("status", "pending").neq("id", draftId || 0);
    if (draftId) await db().from("wa_drafts").update({ status: "sent", body: text, decided_at: now }).eq("id", draftId);
    return { ok: true, id };
  } catch (err) {
    const late = JSON.stringify(err.data || "").includes("131047");
    throw new Error(late
      ? "This client last wrote more than 24 hours ago, so WhatsApp won't let us send the quotation now. Send it from the phone, or wait for the client to write again."
      : String(err.message || err));
  }
}

async function connectWebhook(req) {
  const url = `${siteUrl(req)}/api/wa-webhook`;
  await d360("/v1/configs/webhook", { method: "POST", body: { url, headers: { "X-Hook-Token": hookToken() } } });
  return { ok: true, url };
}

async function status(req) {
  const out = { keys: {
    whatsapp: Boolean(process.env.D360_API_KEY),
    claude: Boolean(process.env.ANTHROPIC_API_KEY),
    database: Boolean(process.env.SUPABASE_SECRET_KEY),
  } };
  try {
    const { error } = await db().from("wa_settings").select("key").limit(1);
    if (error) throw new Error(error.message);
    out.bot_enabled = await getSetting("bot_enabled", true);
    out.staff_numbers = await getSetting("staff_numbers", []);
    out.tables = true;
  } catch (err) { out.tables = false; out.table_error = String(err.message || err); }
  try {
    const hook = await d360("/v1/configs/webhook");
    out.webhook_url = hook?.url || null;
    out.webhook_ok = hook?.url === `${siteUrl(req)}/api/wa-webhook`;
  } catch (err) { out.webhook_ok = false; out.webhook_error = String(err.message || err); }
  return out;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  const expected = process.env.SUITE_PASSWORD;
  if (!expected) return res.status(503).json({ error: "SUITE_PASSWORD is not set in Vercel yet." });
  if (!safeEqual(req.headers["x-suite-password"], expected)) {
    await sleep(1200); // slow down guessing
    return res.status(401).json({ error: "Wrong password" });
  }

  const { action, wa_id: rawId, body, draft_id: draftId, value } = req.body || {};
  const waId = digits(rawId);
  try {
    switch (action) {
      case "status": return res.json(await status(req));
      case "chats": return res.json({ chats: await listChats(), bot_enabled: await getSetting("bot_enabled", true) });
      case "chat": return res.json(await getChat(waId));
      case "send": return res.json(await send(waId, body, draftId));
      case "send_pdf": return res.json(await sendPdf(waId, { filename: req.body.filename, data: req.body.data, caption: body, draftId }));
      case "discard":
        await db().from("wa_drafts").update({ status: "discarded", decided_at: new Date().toISOString() }).eq("id", draftId);
        return res.json({ ok: true });
      case "redraft": return res.json({ draft: await redraft(waId) });
      case "pause_contact":
        await db().from("wa_contacts").update({ bot_paused: Boolean(value) }).eq("wa_id", waId);
        return res.json({ ok: true });
      case "bot_enabled":
        await setSetting("bot_enabled", Boolean(value));
        return res.json({ ok: true });
      case "staff_numbers":
        await setSetting("staff_numbers", (Array.isArray(value) ? value : []).map(digits).filter(Boolean));
        return res.json({ ok: true });
      case "connect_webhook": return res.json(await connectWebhook(req));
      case "media": {
        const { data: msg } = await db().from("wa_messages").select("media_id").eq("id", String(req.body.message_id || "")).maybeSingle();
        if (!msg?.media_id) throw new Error("No photo or file on this message");
        const file = await downloadMedia(msg.media_id);
        if (file.size > 8 * 1024 * 1024) throw new Error("File too large to show here; open it on the phone");
        return res.json({ mime: file.mime, data: file.base64 });
      }
      default: return res.status(400).json({ error: "Unknown action" });
    }
  } catch (err) {
    await logEvent("admin_error", { action, message: String(err?.message || err) });
    return res.status(500).json({ error: String(err?.message || err) });
  }
};
