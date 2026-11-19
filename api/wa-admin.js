// Everything the Suite's WhatsApp tab does goes through here, protected by the SUITE_PASSWORD
// set in Vercel. The browser never sees the WhatsApp, Claude or Supabase secret keys.
const { db, hookToken, safeEqual, d360, sendText, downloadMedia, uploadMedia, sendDocument, insertDraft, getSetting, setSetting, logEvent } = require("./_lib/common");
const { draftReply, draftRow } = require("./_lib/drafter");

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
  return { contact, messages: (messages || []).reverse(), draft: drafts?.[0] || null, referral: await getReferral(waId), money: await paymentSummary(waId) };
}

const LATE = "This client last wrote more than 24 hours ago, so WhatsApp won't let us send a normal message. Reply from the phone instead, or wait for the client to write again.";
const norm = (t) => String(t || "").replace(/\s+/g, " ").trim();

function priceListUrl() {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || "paving-mauritius-suite.vercel.app";
  return `https://${host}/price-list.pdf`;
}

async function storeOut(waId, id, type, text) {
  await db().from("wa_messages").upsert({
    id, wa_id: waId, direction: "out", source: "suite", type, body: text, status: "sent", sent_at: new Date().toISOString(),
  }, { onConflict: "id", ignoreDuplicates: true });
}

// When the team changes a suggestion before sending, keep the before/after so the bot learns from it.
async function learnFrom(waId, draft, sentText) {
  if (!draft || !draft.body || norm(draft.body) === norm(sentText)) return;
  const { data: last } = await db().from("wa_messages").select("body").eq("wa_id", waId).eq("direction", "in").order("sent_at", { ascending: false }).limit(3);
  const client = (last || []).reverse().map((m) => m.body).join(" / ");
  const examples = await getSetting("examples", []);
  const list = Array.isArray(examples) ? examples : [];
  list.push({ client: client.slice(0, 400), bot: draft.body.replace(/\n---\n/g, " | ").slice(0, 600), team: String(sentText).replace(/\n---\n/g, " | ").slice(0, 600), at: new Date().toISOString() });
  await setSetting("examples", list.slice(-30));
}

// ---- Layer referral template (Ravin) ----
// Two templates: the referral itself, then a payment update when the client pays.
const TEMPLATES = {
  referral: {
    name: "layer_referral",
    body: "Hello bro, Paving Mauritius has just referred a client to you for laying.\nClient: {{1}}\nNumber: {{2}}\nLocation: {{3}}\nProduct: {{4}}\nArea: {{5}}\nThank you!",
    example: ["Jean Dupont", "+230 5762 9412", "Curepipe", "Pavers 200x100x60mm, Light Grey", "20 m2"],
  },
  payment: {
    name: "layer_payment_update",
    body: "Hello bro, payment update for the client we referred to you.\nClient: {{1}}\nNumber: {{2}}\nPayment: {{3}}\nArea given to us: {{4}}\nIf the area on site is different, please let us know before delivery. Thank you!",
    example: ["Jean Dupont", "+230 5762 9412", "Paid in full", "20 m2"],
  },
};
const PAYMENT_STATUSES = ["Deposit paid", "Half paid", "Fully paid"];

async function templateStatuses() {
  const data = await d360("/v1/configs/templates?limit=200");
  const list = data?.waba_templates || data?.data || [];
  const out = {};
  for (const [key, t] of Object.entries(TEMPLATES)) {
    const found = list.find((x) => x.name === t.name);
    out[key] = found ? String(found.status || "submitted").toLowerCase() : "missing";
  }
  return out;
}

async function createMissingTemplates() {
  const status = await templateStatuses();
  const created = [];
  for (const [key, t] of Object.entries(TEMPLATES)) {
    if (status[key] !== "missing") continue;
    await d360("/v1/configs/templates", {
      method: "POST",
      body: {
        name: t.name, category: "UTILITY", language: "en", allow_category_change: true,
        components: [{ type: "BODY", text: t.body, example: { body_text: [t.example] } }],
      },
    });
    created.push(t.name);
  }
  return created;
}

const tplText = (t) => String(t || "").replace(/\s+/g, " ").trim().slice(0, 120) || "not given";
function prettyNumber(waId) {
  if (!waId.startsWith("230")) return `+${waId}`;
  const local = waId.slice(3);
  return `+230 ${local.slice(0, 4)} ${local.slice(4)}`.trim();
}

async function sendLayerTemplate(key, params) {
  const ravin = String(await getSetting("ravin_number", "") || "").replace(/\D/g, "");
  if (!ravin) throw new Error("Ravin's number isn't saved in Setup");
  const t = TEMPLATES[key];
  const data = await d360("/messages", {
    method: "POST",
    body: {
      messaging_product: "whatsapp", recipient_type: "individual", to: ravin, type: "template",
      template: { name: t.name, language: { code: "en" }, components: [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }] },
    },
  });
  const id = data?.messages?.[0]?.id || `local-${Date.now()}`;
  await db().from("wa_contacts").upsert({ wa_id: ravin, name: "Ravin (layer)", is_staff: true }, { onConflict: "wa_id" });
  await storeOut(ravin, id, "template", t.body.replace(/\{\{(\d)\}\}/g, (_, n) => params[Number(n) - 1]));
  return id;
}

// Keeps a record of each referral (for the payment update and Ravin's commission).
async function saveReferral(waId, referral) {
  const list = await getSetting("referrals", []);
  const rows = (Array.isArray(list) ? list : []).filter((r) => r.wa_id !== waId);
  rows.push({ wa_id: waId, ...referral, referred_at: new Date().toISOString(), payments: [] });
  await setSetting("referrals", rows.slice(-300));
}

async function getReferral(waId) {
  const list = await getSetting("referrals", []);
  return (Array.isArray(list) ? list : []).find((r) => r.wa_id === waId) || null;
}

// ---- Quotation totals and confirmed payments, per client ----
async function getMap(key) { const m = await getSetting(key, {}); return m && typeof m === "object" && !Array.isArray(m) ? m : {}; }

async function recordQuote(waId, ref, total) {
  const t = Number(total);
  if (!ref || !(t > 0)) return;
  const map = await getMap("quote_totals");
  map[waId] = { ref: String(ref), total: Math.round(t * 100) / 100, at: new Date().toISOString() };
  const keys = Object.keys(map);
  if (keys.length > 500) keys.sort((a, b) => String(map[a].at).localeCompare(map[b].at)).slice(0, keys.length - 500).forEach((k) => delete map[k]);
  await setSetting("quote_totals", map);
}

async function paymentSummary(waId) {
  const [quotes, pays] = await Promise.all([getMap("quote_totals"), getMap("payments")]);
  const quote = quotes[waId] || null;
  const payments = Array.isArray(pays[waId]) ? pays[waId] : [];
  const paid = payments.reduce((sum, p) => sum + Number(p.amount || 0), 0);
  const pct = quote ? Math.round((paid / quote.total) * 100) : null;
  return { quote, payments, paid: Math.round(paid * 100) / 100, pct };
}

// The team has checked the bank: record the payment and, if the client was referred, tell Ravin the %.
async function confirmPayment(waId, amount, draftId) {
  const amt = Math.round(Number(amount) * 100) / 100;
  if (!(amt > 0)) throw new Error("Enter the amount received");
  const pays = await getMap("payments");
  pays[waId] = [...(Array.isArray(pays[waId]) ? pays[waId] : []), { amount: amt, at: new Date().toISOString() }];
  await setSetting("payments", pays);
  const summary = await paymentSummary(waId);
  const ref = await getReferral(waId);
  let ravin = "not_referred";
  let warning = null;
  if (ref) {
    if (summary.pct !== null && summary.pct > 100) {
      ravin = "held";
      warning = `Payments add up to ${summary.pct}% of the quotation, more than the total. Ravin wasn't told; check the amounts.`;
    } else {
      const text = summary.pct !== null ? `${summary.pct}% paid` : `Rs ${summary.paid.toLocaleString("en-MU")} paid`;
      try { await sendPaymentUpdate(waId, text); ravin = "told"; }
      catch (e) { ravin = "failed"; warning = `Payment recorded, but Ravin couldn't be told: ${String(e.message || e)}`; }
    }
  }
  return { ok: true, ...summary, ravin, warning };
}

async function sendPaymentUpdate(waId, status) {
  if (!PAYMENT_STATUSES.includes(status) && !/(% paid|^Rs [\d,.]+ paid)$/.test(String(status))) throw new Error("Unknown payment status");
  const list = await getSetting("referrals", []);
  const rows = Array.isArray(list) ? list : [];
  const ref = rows.find((r) => r.wa_id === waId);
  if (!ref) throw new Error("This client wasn't referred to Ravin from the Suite");
  await sendLayerTemplate("payment", [tplText(ref.client_name), prettyNumber(waId), status, tplText(ref.area)]);
  ref.payments = [...(ref.payments || []), { status, at: new Date().toISOString() }];
  await setSetting("referrals", rows);
  return ref;
}

// Tells Ravin about a client we referred (no payment info yet; that comes later as an update).
async function notifyRavin(waId, referral) {
  await sendLayerTemplate("referral", [tplText(referral.client_name), prettyNumber(waId), tplText(referral.location), tplText(referral.product), tplText(referral.area)]);
  await saveReferral(waId, referral);
}

// Sends one suggestion: its short messages in order, then the price list if attached.
async function send(waId, body, draftId) {
  const parts = String(body || "").split(/\n---\n/).map((t) => t.trim()).filter(Boolean);
  let draft = null;
  if (draftId) ({ data: draft } = await db().from("wa_drafts").select("*").eq("id", draftId).maybeSingle());
  const attach = draft?.quote?.attach || null;
  const suggested = draft ? { body: draft.body } : null; // keep the bot's original wording
  if (!parts.length && !attach) throw new Error("Message is empty");
  const ids = [];
  try {
    for (let i = 0; i < parts.length; i += 1) {
      if (i > 0) await sleep(1500); // a natural gap between messages
      const id = await sendText(waId, parts[i]);
      await storeOut(waId, id, "text", parts[i]);
      ids.push(id);
    }
    if (attach === "price_list") {
      if (parts.length) await sleep(1000);
      const data = await d360("/messages", {
        method: "POST",
        body: { messaging_product: "whatsapp", recipient_type: "individual", to: waId, type: "document", document: { link: priceListUrl(), filename: "Paving Mauritius - Price list.pdf" } },
      });
      const id = data?.messages?.[0]?.id || `local-${Date.now()}`;
      await storeOut(waId, id, "document", "[Document Price list.pdf]");
      ids.push(id);
    }
    let warning = null;
    let referralSent = false;
    if (draft?.quote?.referral) {
      try { await notifyRavin(waId, draft.quote.referral); referralSent = true; }
      catch (e) { warning = `The client got Ravin's number, but Ravin couldn't be told: ${String(e.message || e)}`; await logEvent("referral_failed", { wa_id: waId, message: String(e.message || e) }); }
    }
    const now = new Date().toISOString();
    const sentText = parts.join("\n---\n");
    await db().from("wa_contacts").update({ last_message_at: now, unread: 0 }).eq("wa_id", waId);
    await db().from("wa_drafts").update({ status: "superseded", decided_at: now }).eq("wa_id", waId).eq("status", "pending").neq("id", draftId || 0);
    if (draftId) {
      await db().from("wa_drafts").update({ status: "sent", body: sentText, decided_at: now }).eq("id", draftId);
      try { await learnFrom(waId, suggested, sentText); } catch { /* learning must never block sending */ }
    }
    return { ok: true, ids, warning, referral_sent: referralSent };
  } catch (err) {
    if (draftId) await db().from("wa_drafts").update({ error: String(err.message || err) }).eq("id", draftId);
    // 131047 = more than 24 hours since the client last wrote: WhatsApp only allows approved templates.
    const late = JSON.stringify(err.data || "").includes("131047");
    const partly = ids.length ? ` (${ids.length} message${ids.length > 1 ? "s" : ""} already went out.)` : "";
    throw new Error((late ? LATE : String(err.message || err)) + partly);
  }
}

async function redraft(waId) {
  const draft = await draftReply(waId);
  if (!draft) throw new Error("No messages in this chat yet");
  await db().from("wa_drafts").update({ status: "superseded", decided_at: new Date().toISOString() }).eq("wa_id", waId).eq("status", "pending");
  const { data: last } = await db().from("wa_messages").select("id").eq("wa_id", waId).eq("direction", "in").order("sent_at", { ascending: false }).limit(1);
  return insertDraft(draftRow(waId, last?.[0]?.id, draft));
}

// Sends a PDF made in the Suite (an approved quotation) to the client.
async function sendPdf(waId, { filename, data, caption, draftId, ref, total }) {
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
    out.examples = await getSetting("examples", []);
    out.ravin_number = await getSetting("ravin_number", "");
    out.tables = true;
  } catch (err) { out.tables = false; out.table_error = String(err.message || err); }
  try { out.templates = await templateStatuses(); }
  catch (err) { out.templates = { error: String(err.message || err) }; }
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
      case "referral_payment": return res.json({ ok: true, referral: await sendPaymentUpdate(waId, value) });
      case "send_pdf": {
        const r = await sendPdf(waId, { filename: req.body.filename, data: req.body.data, caption: body, draftId });
        try { await recordQuote(waId, req.body.ref, req.body.total); } catch { /* the quotation went out; the total is only for payment tracking */ }
        return res.json(r);
      }
      case "record_quote": await recordQuote(waId, req.body.ref, req.body.total); return res.json({ ok: true });
      case "confirm_payment": return res.json(await confirmPayment(waId, value, draftId));
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
      case "ravin_number": {
        const num = digits(value);
        const full = num.length === 8 ? `230${num}` : num;
        if (full.length < 10) throw new Error("Please enter Ravin's full number, e.g. 5xxx xxxx");
        await setSetting("ravin_number", full);
        const staff = await getSetting("staff_numbers", []);
        const list = Array.isArray(staff) ? staff.map(digits) : [];
        if (!list.includes(full)) await setSetting("staff_numbers", [...list, full]); // so the bot never answers him as a client
        await db().from("wa_contacts").upsert({ wa_id: full, name: "Ravin (layer)", is_staff: true }, { onConflict: "wa_id" });
        return res.json({ ok: true, ravin_number: full });
      }
      case "create_referral_template": return res.json({ ok: true, created: await createMissingTemplates() });
      case "delete_example": {
        const list = await getSetting("examples", []);
        await setSetting("examples", (Array.isArray(list) ? list : []).filter((e) => e.at !== String(value || "")));
        return res.json({ ok: true });
      }
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
