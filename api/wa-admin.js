// Everything the Suite's WhatsApp tab does goes through here, protected by the team login (Supabase Auth)
// (wa_settings.team_emails). The browser never sees the WhatsApp, Claude or Supabase secret keys.
const { splitReply, replyTarget, db, hookToken, missedCallToken, safeEqual, d360, sendText, downloadMedia, uploadMedia, sendDocument, insertDraft, getSetting, setSetting, logEvent } = require("./_lib/common");
const { draftReply, draftRow } = require("./_lib/drafter");
const { autoSettings, autoSend } = require("./_lib/autosend");
const { getAds, describeAd, deleteAd, pickedAds, pickAd, resolveAd } = require("./_lib/ads");
const { albums, addPhoto, deletePhoto, getPhotos, albumPhotos, knownAlbums } = require("./_lib/photos");
const { TEMPLATES, tplText, prettyNumber, storeOut, notifySalesManager, sendLayerTemplate, getReferral, notifyRavin, mentionsRavin, autoRefer, pastRavinMentions } = require("./_lib/referrals");

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
  const list = (messages || []).reverse();
  const [ads, picks] = await Promise.all([getAds(), pickedAds()]);
  const ad = resolveAd(list, picks[waId], ads);
  const design = ad ? ads[ad.key]?.design || "" : "";
  let draft = drafts?.[0] || null;
  // "Which ad?" buttons: the ads the team has described, newest first.
  const adChoices = draft?.quote?.ask_ad
    ? Object.entries(ads).filter(([, a]) => a && a.design).sort((a, b) => String(b[1].first_seen || "").localeCompare(String(a[1].first_seen || ""))).slice(0, 8).map(([key, a]) => ({ key, label: a.label, design: a.design }))
    : [];
  // The "new ad" warning is out of date once the team has described the ad.
  if (draft && design && draft.team_note) draft = { ...draft, team_note: draft.team_note.replace(/📢 New ad: tell the bot what's in it \(box above\), then it can quote\.\s*/, "").trim() || null };
  return { contact, messages: list, draft, referral: await getReferral(waId), money: await paymentSummary(waId), ad: ad ? { ...ad, design } : null, ad_choices: adChoices };
}

const LATE = "This client last wrote more than 24 hours ago, so WhatsApp won't let us send a normal message. Reply from the phone instead, or wait for the client to write again.";
const norm = (t) => String(t || "").replace(/\s+/g, " ").trim();

function priceListUrl() {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || "paving-mauritius-suite.vercel.app";
  return `https://${host}/price-list.pdf`;
}


// When the team changes a suggestion before sending, keep the before/after so the bot learns from it.
async function learnFrom(waId, rawDraft, rawSent) {
  const noQuotes = (t) => String(t || "").split(/\n---\n/).map((p) => splitReply(p).text).join("\n---\n");
  const draft = rawDraft && { ...rawDraft, body: noQuotes(rawDraft.body) };
  const sentText = noQuotes(rawSent);
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
  const failed = [];
  for (const [key, t] of Object.entries(TEMPLATES)) {
    if (status[key] !== "missing") continue;
    // One refused template must not stop the others.
    try {
      await d360("/v1/configs/templates", {
        method: "POST",
        body: {
          name: t.name, category: "UTILITY", language: "en", allow_category_change: true,
          components: [{ type: "BODY", text: t.body, ...(t.example ? { example: { body_text: [t.example] } } : {}) }],
        },
      });
      created.push(t.name);
    } catch (e) {
      failed.push(`${t.name}: ${String(e.message || e).slice(0, 200)}`);
      await logEvent("template_create_failed", { name: t.name, message: String(e.message || e), data: e.data || null });
    }
  }
  return { created, failed };
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


// Sends one suggestion: its short messages in order, then the price list if attached.
// Sends the photos of one or more albums (a few each), spaced out for WhatsApp's per-person limit.
// oneEach: one photo per album with the album name as caption (to let the client choose a design).
async function sendAlbums(waId, names, waitFirst, oneEach = false) {
  const ids = [];
  let first = !waitFirst;
  let total = 0;
  for (const album of names) {
    const photos = await albumPhotos(album, oneEach ? 1 : undefined);
    for (let i = 0; i < photos.length; i += 1) {
      const p = photos[i];
      if (total >= 4) break;
      if (!first) await sleep(6500);
      first = false;
      const caption = oneEach && i === 0 ? album.replace(/^Two-colour design – /, "") : "";
      const data = await d360("/messages", {
        method: "POST",
        body: { messaging_product: "whatsapp", recipient_type: "individual", to: waId, type: "image", image: { link: p.url, ...(caption ? { caption } : {}) } },
      });
      const id = data?.messages?.[0]?.id || `local-${Date.now()}`;
      await storeOut(waId, id, "image", `[Photo] ${album}`);
      ids.push(id);
      total += 1;
    }
  }
  return ids;
}

async function send(waId, body, draftId, photosWanted) {
  const parts = String(body || "").split(/\n---\n/).map((t) => t.trim()).filter(Boolean);
  let draft = null;
  if (draftId) ({ data: draft } = await db().from("wa_drafts").select("*").eq("id", draftId).maybeSingle());
  const attach = draft?.quote?.attach || null;
  // The team can untick albums the bot suggested; without a list from the Suite, the bot's choice stands.
  const designs = draft?.quote?.photo_mode === "designs";
  const photoAlbums = await knownAlbums(Array.isArray(photosWanted) ? photosWanted : draft?.quote?.photos || [], designs ? 4 : 2);
  const photosAfter = String(draft?.quote?.photos_after || "").trim();
  const suggested = draft ? { body: draft.body } : null; // keep the bot's original wording
  if (!parts.length && !attach && !photoAlbums.length) throw new Error("Message is empty");
  const ids = [];
  try {
    if (draft?.quote?.template === "missed_call") {
      // The caller may never have written to us: outside the 24-hour window only the approved template can go.
      const { data: c } = await db().from("wa_contacts").select("last_inbound_at").eq("wa_id", waId).maybeSingle();
      const open = c?.last_inbound_at && Date.now() - new Date(c.last_inbound_at) < 23 * 3600 * 1000;
      if (!open) {
        const t = TEMPLATES.missed;
        const data = await d360("/messages", {
          method: "POST",
          body: { messaging_product: "whatsapp", recipient_type: "individual", to: waId, type: "template", template: { name: t.name, language: { code: "en" } } },
        });
        const id = data?.messages?.[0]?.id || `local-${Date.now()}`;
        await storeOut(waId, id, "template", t.body);
        const now = new Date().toISOString();
        await db().from("wa_contacts").update({ last_message_at: now, unread: 0 }).eq("wa_id", waId);
        await db().from("wa_drafts").update({ status: "sent", body: t.body, decided_at: now }).eq("id", draftId);
        return { ok: true, ids: [id] };
      }
    }
    for (let i = 0; i < parts.length; i += 1) {
      if (i > 0) await sleep(6500); // WhatsApp allows about one message every 6 seconds to the same person
      const { quote, text } = splitReply(parts[i]);
      if (!text) continue;
      const id = await sendText(waId, text, await replyTarget(waId, quote));
      await storeOut(waId, id, "text", text);
      ids.push(id);
    }
    if (attach === "price_list") {
      if (parts.length) await sleep(6500);
      const data = await d360("/messages", {
        method: "POST",
        body: { messaging_product: "whatsapp", recipient_type: "individual", to: waId, type: "document", document: { link: priceListUrl(), filename: "Paving Mauritius - Price list.pdf" } },
      });
      const id = data?.messages?.[0]?.id || `local-${Date.now()}`;
      await storeOut(waId, id, "document", "[Document Price list.pdf]");
      ids.push(id);
    }
    if (photoAlbums.length) {
      const sentPhotos = await sendAlbums(waId, photoAlbums, ids.length > 0, designs);
      ids.push(...sentPhotos);
      if (photosAfter && sentPhotos.length) {
        await sleep(6500);
        const id = await sendText(waId, photosAfter);
        await storeOut(waId, id, "text", photosAfter);
        ids.push(id);
      }
    }
    let warning = null;
    let referralSent = false;
    if (draft?.quote?.referral) {
      try { await notifyRavin(waId, draft.quote.referral); referralSent = true; }
      catch (e) { warning = `The client got Ravin's number, but Ravin couldn't be told: ${String(e.message || e)}`; await logEvent("referral_failed", { wa_id: waId, message: String(e.message || e) }); }
    } else if (await mentionsRavin(parts.join("\n"))) {
      // The team typed Ravin's number themselves: Ravin still has to hear about the client.
      try { referralSent = Boolean(await autoRefer(waId, "suite")); }
      catch (e) { warning = `The client got Ravin's number, but Ravin couldn't be told: ${String(e.message || e)}`; }
    }
    try { await notifySalesManager(waId, parts.join("\n"), draft?.team_note); }
    catch (e) { warning = [warning, `The Sales Manager couldn't be told on WhatsApp: ${String(e.message || e)}`].filter(Boolean).join(" "); await logEvent("sales_handover_failed", { wa_id: waId, message: String(e.message || e) }); }
    const now = new Date().toISOString();
    const sentText = parts.join("\n---\n");
    await db().from("wa_contacts").update({ last_message_at: now, unread: 0 }).eq("wa_id", waId);
    await db().from("wa_drafts").update({ status: "superseded", decided_at: now }).eq("wa_id", waId).eq("status", "pending").neq("id", draftId || 0);
    if (draftId) {
      // Keep the bot's own wording next to what was really sent (for the review export).
      const keep = draft && !draft.quote?.original ? { quote: { ...(draft.quote || {}), original: draft.body } } : {};
      await db().from("wa_drafts").update({ status: "sent", body: sentText, decided_at: now, ...keep }).eq("id", draftId);
      if (!draft?.quote?.template) { try { await learnFrom(waId, suggested, sentText); } catch { /* learning must never block sending */ } }
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

// An automatic quotation: same PDF, number counter and records as approving one in the Suite.
function todayMU() { return new Date().toLocaleDateString("en-CA", { timeZone: "Indian/Mauritius" }); }
async function autoQuote(waId, draftId, q, index, bank, followup) {
  const { buildDocPdf, docPrefix } = await import("./_lib/docpdf.mjs");
  const { data: contact } = await db().from("wa_contacts").select("name,profile_name").eq("wa_id", waId).maybeSingle();
  const calc = (q.items || []).map((i) => {
    const qty = Number(i.qty) || 0;
    const unitPrice = (Number(i.unit_price_incl_vat) || 0) / 1.15;
    return { desc: String(i.desc || "").trim(), qty, unitPrice, total: qty * unitPrice, code: "" };
  }).filter((l) => l.desc && l.qty > 0 && l.unitPrice > 0);
  if (!calc.length) throw new Error("The quotation has no lines with a price");
  const subtotal = calc.reduce((s, l) => s + l.total, 0);
  const vat = subtotal * 0.15;
  const total = subtotal + vat;
  const tagged = (prefix, v) => { const t = String(v || "").trim(); return !t ? "" : new RegExp(`^${prefix}`, "i").test(t) ? t : `${prefix}: ${t}`; };
  const name = q.client_name || contact?.name || contact?.profile_name || "Client";
  const client = { name, address: q.location || "", city: q.city || "", area: "", brn: tagged("BRN", q.brn), vat: tagged("VAT", q.vat_no), contact: `+${waId}`, email: q.email || "" };
  const { data: num, error } = await db().rpc("get_next_ref", { p_doc_type: "Quotation" });
  if (error || num === null || num === undefined) throw new Error("Could not get the next quotation number");
  const ref = `${docPrefix("Quotation")}/${String(num).padStart(3, "0")}`;
  const date = todayMU();
  const doc = await buildDocPdf({ docType: "Quotation", docRef: ref, date, client, toName: name, calcItems: calc, subtotal, vat, total, includeBank: bank === "sbm" });
  const data = Buffer.from(doc.output("arraybuffer")).toString("base64");
  const r = await sendPdf(waId, { filename: `${ref.replace(/\//g, "_")}.pdf`, data, caption: q.caption || "Here is your quotation.", draftId, followup, quoteIndex: index, ref });
  try {
    await db().from("documents").insert({ doc_type: "Quotation", ref, doc_date: date, client_name: name, client_snapshot: client, items: calc, include_bank: bank === "sbm", total });
    if (q.brn || q.location) await db().from("clients").upsert({ name, contact: client.contact, address: client.address, city: client.city, area: "", brn: String(q.brn || ""), vat: String(q.vat_no || ""), email: client.email, updated_at: new Date().toISOString() }, { onConflict: "name" });
  } catch { /* the quotation went out; only the records failed */ }
  await recordQuote(waId, ref, total);
  return { ...r, ref };
}

async function redraft(waId) {
  const draft = await draftReply(waId);
  if (!draft) throw new Error("No messages in this chat yet");
  await db().from("wa_drafts").update({ status: "superseded", decided_at: new Date().toISOString() }).eq("wa_id", waId).eq("status", "pending");
  const { data: last } = await db().from("wa_messages").select("id").eq("wa_id", waId).eq("direction", "in").order("sent_at", { ascending: false }).limit(1);
  return insertDraft(draftRow(waId, last?.[0]?.id, draft));
}

// Sends a PDF made in the Suite (an approved quotation) to the client.
function quotesOf(extras) {
  if (!extras) return [];
  if (Array.isArray(extras.quotes)) return extras.quotes;
  return Array.isArray(extras.items) ? [extras] : [];
}

async function sendPdf(waId, { filename, data, caption, draftId, followup, quoteIndex, ref }) {
  const name = String(filename || "Quotation.pdf").replace(/[^\w.\-]/g, "_");
  const buf = Buffer.from(String(data || ""), "base64");
  if (buf.length < 100 || buf.slice(0, 4).toString() !== "%PDF") throw new Error("The PDF could not be created");
  const text = String(caption || "").trim();
  const after = String(followup || "").split(/\n---\n/).map((t) => t.trim()).filter(Boolean);
  let draft = null;
  if (draftId) ({ data: draft } = await db().from("wa_drafts").select("*").eq("id", draftId).maybeSingle());
  let pdfSent = false;
  // With several quotations in one suggestion, each is sent on its own; the follow-up messages,
  // referral and closing go out with the last one.
  const quotes = quotesOf(draft?.quote);
  const idx = Number(quoteIndex) || 0;
  const sentMap = { ...(draft?.quote?.sent || {}) };
  try {
    const mediaId = await uploadMedia(buf, "application/pdf", name);
    const id = await sendDocument(waId, mediaId, name, text);
    pdfSent = true;
    await db().from("wa_messages").upsert({
      id, wa_id: waId, direction: "out", source: "suite", type: "document", media_id: mediaId,
      body: `[Document ${name}]${text ? ` ${text}` : ""}`, status: "sent", sent_at: new Date().toISOString(),
    }, { onConflict: "id", ignoreDuplicates: true });
    if (draft && quotes.length > 1) {
      sentMap[idx] = String(ref || name);
      const done = quotes.every((_, i) => sentMap[i]);
      if (!done) {
        await db().from("wa_drafts").update({ quote: { ...draft.quote, sent: sentMap } }).eq("id", draftId);
        await db().from("wa_contacts").update({ last_message_at: new Date().toISOString(), unread: 0 }).eq("wa_id", waId);
        return { ok: true, id, remaining: quotes.length - Object.keys(sentMap).length };
      }
    }
    // Answers to the client's other questions go out after the PDF, as separate messages.
    for (const part of after) {
      await sleep(6500);
      const { quote, text } = splitReply(part);
      if (!text) continue;
      const mid = await sendText(waId, text, await replyTarget(waId, quote));
      await storeOut(waId, mid, "text", text);
    }
    let warning = null;
    let referralSent = false;
    if (draft?.quote?.referral) {
      try { await notifyRavin(waId, draft.quote.referral); referralSent = true; }
      catch (e) { warning = `Ravin couldn't be told: ${String(e.message || e)}`; }
    }
    try { await notifySalesManager(waId, [text, ...after].join("\n"), draft?.team_note); }
    catch (e) { warning = [warning, `The Sales Manager couldn't be told on WhatsApp: ${String(e.message || e)}`].filter(Boolean).join(" "); }
    const now = new Date().toISOString();
    await db().from("wa_contacts").update({ last_message_at: now, unread: 0 }).eq("wa_id", waId);
    await db().from("wa_drafts").update({ status: "superseded", decided_at: now }).eq("wa_id", waId).eq("status", "pending").neq("id", draftId || 0);
    if (draftId) await db().from("wa_drafts").update({ status: "sent", body: [text, ...after].join("\n---\n"), decided_at: now, ...(draft && !draft.quote?.original ? { quote: { ...(draft.quote || {}), original: draft.body } } : {}) }).eq("id", draftId);
    return { ok: true, id, warning, referral_sent: referralSent };
  } catch (err) {
    const late = JSON.stringify(err.data || "").includes("131047");
    const msg = late
      ? "This client last wrote more than 24 hours ago, so WhatsApp won't let us send the quotation now. Send it from the phone, or wait for the client to write again."
      : String(err.message || err);
    throw new Error(pdfSent ? `The quotation was sent, but a message after it failed: ${msg}` : msg);
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
    out.ads = Object.entries(await getAds()).map(([key, a]) => ({ key, ...a })).sort((a, b) => String(b.first_seen || "").localeCompare(String(a.first_seen || "")));
    out.ravin_number = await getSetting("ravin_number", "");
    out.auto_send = await autoSettings();
    out.sales_manager_number = await getSetting("sales_manager_number", "23058212040");
    out.owner_number = await getSetting("owner_number", "23057396517");
    out.missed_call_url = `${siteUrl(req)}/api/missed-call?token=${missedCallToken()}&number=`;
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

// ---- Team logins (Supabase Auth). Only emails in wa_settings.team_emails may use the Suite. ----
async function teamEmails() {
  const list = await getSetting("team_emails", []);
  return Array.isArray(list) ? list.map((e) => String(e).toLowerCase()) : [];
}

// Who is calling: only a logged-in team member (Bearer token). The old Suite password no longer
// opens anything; new people are added by a team member in Setup → Team logins.
async function caller(req) {
  const auth = String(req.headers.authorization || "");
  if (!auth.startsWith("Bearer ") || auth.length <= 20) return null;
  const { data, error } = await db().auth.getUser(auth.slice(7));
  const email = String(data?.user?.email || "").toLowerCase();
  if (!error && email && (await teamEmails()).includes(email)) return { email };
  return null;
}

async function findUser(email) {
  for (let page = 1; page <= 10; page += 1) {
    const { data, error } = await db().auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(error.message);
    const hit = (data?.users || []).find((u) => String(u.email || "").toLowerCase() === email);
    if (hit || (data?.users || []).length < 200) return hit || null;
  }
  return null;
}

async function createLogin(rawEmail, password) {
  const email = String(rawEmail || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("Enter a valid email");
  if (String(password || "").length < 8) throw new Error("The password needs at least 8 characters");
  const existing = await findUser(email);
  if (existing) {
    const { error } = await db().auth.admin.updateUserById(existing.id, { password, email_confirm: true });
    if (error) throw new Error(error.message);
  } else {
    const { error } = await db().auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw new Error(error.message);
  }
  const team = await teamEmails();
  if (!team.includes(email)) await setSetting("team_emails", [...team, email]);
  await logEvent("login_saved", { email });
  return { ok: true, email };
}

async function removeLogin(rawEmail, me) {
  const email = String(rawEmail || "").trim().toLowerCase();
  const team = await teamEmails();
  if (me && email === me && team.length === 1) throw new Error("You can't remove the last login");
  await setSetting("team_emails", team.filter((e) => e !== email));
  const user = await findUser(email);
  if (user) await db().auth.admin.deleteUser(user.id);
  await logEvent("login_removed", { email });
  return { ok: true };
}

// A plain-text record of the last days' client chats: every message, and for each bot suggestion
// what the bot wrote, what happened to it (sent / changed / discarded) and its note to the team.
async function reviewExport(days) {
  const since = new Date(Date.now() - Math.min(days, 31) * 86400000).toISOString();
  const [{ data: msgs }, { data: drafts }, { data: contacts }] = await Promise.all([
    db().from("wa_messages").select("wa_id,direction,source,type,body,sent_at").gte("sent_at", since).order("sent_at", { ascending: true }).limit(5000),
    db().from("wa_drafts").select("wa_id,body,team_note,needs_team,status,quote,created_at,decided_at").gte("created_at", since).order("created_at", { ascending: true }).limit(2000),
    db().from("wa_contacts").select("wa_id,name,profile_name,is_staff"),
  ]);
  const people = new Map((contacts || []).map((c) => [c.wa_id, c]));
  const staff = new Set([...(await getSetting("staff_numbers", [])).map(digits), ...(await getSetting("factory_reporters", [])).map(digits)]);
  const t = (iso) => new Date(iso).toLocaleString("en-GB", { timeZone: "Indian/Mauritius", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  const chats = new Map();
  for (const m of msgs || []) {
    if (people.get(m.wa_id)?.is_staff || staff.has(m.wa_id)) continue;
    if (!chats.has(m.wa_id)) chats.set(m.wa_id, []);
    const who = m.direction === "in" ? "CLIENT" : m.source === "phone" ? "TEAM (phone)" : "SENT (Suite)";
    chats.get(m.wa_id).push({ at: m.sent_at, line: `[${t(m.sent_at)}] ${who}: ${String(m.body || `[${m.type}]`).replace(/\n---\n/g, " | ")}` });
  }
  for (const d of drafts || []) {
    if (!chats.has(d.wa_id)) continue;
    const original = d.quote?.original || (d.status === "sent" ? "" : d.body);
    const changed = d.status === "sent" && d.quote?.original && d.quote.original.trim() !== String(d.body || "").trim();
    const fate = d.status === "sent" ? (d.quote?.auto ? "SENT AUTOMATICALLY" : d.quote?.original ? (changed ? "SENT AFTER CHANGES" : "SENT AS WRITTEN") : "SENT") : d.status.toUpperCase();
    const lines = [`[${t(d.created_at)}] BOT SUGGESTION → ${fate}${d.needs_team ? " (flagged for the team)" : ""}`];
    if (original) lines.push(`    bot wrote: ${original.replace(/\n---\n/g, " | ")}`);
    if (changed) lines.push(`    team sent: ${String(d.body).replace(/\n---\n/g, " | ")}`);
    if (d.team_note) lines.push(`    note to team: ${d.team_note}`);
    if (Array.isArray(d.quote?.quotes) && d.quote.quotes.length) lines.push(`    quotations: ${d.quote.quotes.map((q) => q.summary || (q.items || []).map((i) => `${i.qty} × ${i.desc}`).join(" + ")).join(" / ")}`);
    chats.get(d.wa_id).push({ at: d.created_at, line: lines.join("\n") });
  }
  const out = [`Paving Mauritius – WhatsApp chats for review, last ${days} days (exported ${t(new Date().toISOString())})`, ""];
  for (const [waId, items] of chats) {
    const c = people.get(waId);
    out.push(`==== ${c?.name || c?.profile_name || "Client"} (+${waId}) ====`);
    items.sort((a, b) => String(a.at).localeCompare(String(b.at))).forEach((i) => out.push(i.line));
    out.push("");
  }
  return out.join("\n");
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  const who = await caller(req).catch(() => null);
  if (!who) {
    await sleep(1200); // slow down guessing
    return res.status(401).json({ error: "Please log out and log in again." });
  }

  const { action, wa_id: rawId, body, draft_id: draftId, value } = req.body || {};
  if (action === "create_login") {
    try { return res.json(await createLogin(req.body.email, req.body.password)); }
    catch (e) { return res.status(400).json({ error: String(e.message || e) }); }
  }
  if (action === "team") return res.json({ team: await teamEmails() });
  if (action === "remove_login") {
    try { return res.json(await removeLogin(req.body.email, who.email)); }
    catch (e) { return res.status(400).json({ error: String(e.message || e) }); }
  }
  const waId = digits(rawId);
  try {
    switch (action) {
      case "status": return res.json(await status(req));
      case "chats": return res.json({ chats: await listChats(), bot_enabled: await getSetting("bot_enabled", true) });
      case "chat": return res.json(await getChat(waId));
      case "send": return res.json(await send(waId, body, draftId, req.body.photos));
      case "photos": return res.json({ albums: await albums(), photos: await getPhotos() });
      case "upload_photo": return res.json({ ok: true, photo: await addPhoto(req.body.album, req.body.data, req.body.mime) });
      case "delete_photo": await deletePhoto(String(value || "")); return res.json({ ok: true });
      case "send_photos": {
        const names = await knownAlbums([value]);
        if (!names.length) throw new Error("That album has no photos");
        const ids = await sendAlbums(waId, names, false);
        await db().from("wa_contacts").update({ last_message_at: new Date().toISOString(), unread: 0 }).eq("wa_id", waId);
        return res.json({ ok: true, ids });
      }
      case "factory_reporters": {
        if (Array.isArray(req.body.numbers)) {
          const list = [...new Set(req.body.numbers.map((n) => { let d = digits(n); if (d.length === 8) d = `230${d}`; return d; }).filter((d) => d.length >= 10))];
          await setSetting("factory_reporters", list);
          const staff = (await getSetting("staff_numbers", [])).map(digits);
          await setSetting("staff_numbers", [...new Set([...staff, ...list])]); // the bot never drafts client replies to them
          for (const id of list) await db().from("wa_contacts").upsert({ wa_id: id, is_staff: true }, { onConflict: "wa_id" });
        }
        return res.json({ numbers: await getSetting("factory_reporters", []) });
      }
      case "review_export": return res.json({ text: await reviewExport(Number(value) || 7) });
      case "missed_backlog": {
        const mb = require("./_lib/missedbacklog");
        if (value === "send") { const r = await mb.sendBacklog(20); await logEvent("missed_backlog_by", { by: who.email, ...r, failed: r.failed.length }); return res.json({ ok: true, ...r }); }
        return res.json({ calls: await mb.candidates() });
      }
      case "past_referrals": return res.json({ clients: await pastRavinMentions() });
      case "refer_ravin": {
        const referral = await autoRefer(waId, "check");
        return res.json({ ok: true, referral, already: !referral });
      }
      case "referral_payment": return res.json({ ok: true, referral: await sendPaymentUpdate(waId, value) });
      case "send_pdf": {
        const r = await sendPdf(waId, { filename: req.body.filename, data: req.body.data, caption: body, draftId, followup: req.body.followup, quoteIndex: req.body.quote_index, ref: req.body.ref });
        try { await recordQuote(waId, req.body.ref, req.body.total); } catch { /* the quotation went out; the total is only for payment tracking */ }
        return res.json(r);
      }
      case "record_quote": await recordQuote(waId, req.body.ref, req.body.total); return res.json({ ok: true });
      case "confirm_payment": return res.json(await confirmPayment(waId, value, draftId));
      case "resend": {
        const { data: m } = await db().from("wa_messages").select("*").eq("id", String(req.body.message_id || "")).maybeSingle();
        if (!m || m.direction !== "out" || m.type !== "text" || !m.body) throw new Error("Only a text message we sent can be resent");
        const id = await sendText(m.wa_id, m.body);
        await storeOut(m.wa_id, id, "text", m.body);
        await db().from("wa_messages").update({ status: "resent" }).eq("id", m.id);
        return res.json({ ok: true, id });
      }
      case "discard":
        await db().from("wa_drafts").update({ status: "discarded", decided_at: new Date().toISOString() }).eq("id", draftId);
        return res.json({ ok: true });
      case "redraft": return res.json({ draft: await redraft(waId) });
      case "describe_ad": {
        const ad = await describeAd(String(req.body.key || ""), value, { label: req.body.label, url: req.body.url });
        let draft = null;
        if (waId) { try { draft = await redraft(waId); } catch { /* the ad is saved; the team can tap New suggestion */ } }
        return res.json({ ok: true, ad, draft });
      }
      case "delete_ad": await deleteAd(String(value || "")); return res.json({ ok: true });
      case "auto_send": {
        // Switch automatic sending on or off, and choose the bank details on automatic quotations.
        const cur = await autoSettings();
        const next = { enabled: typeof req.body.enabled === "boolean" ? req.body.enabled : cur.enabled, bank: req.body.bank === "sbm" ? "sbm" : req.body.bank === "none" ? "none" : cur.bank, changed_by: who.email, changed_at: new Date().toISOString() };
        await setSetting("auto_send", next);
        await logEvent("auto_send_setting", next);
        return res.json({ ok: true, auto_send: await autoSettings() });
      }
      case "team_numbers": {
        // Who gets the "Sales Manager" alerts and the breakdown alerts.
        const n = (v) => { let d = digits(v); if (d.length === 8) d = `230${d}`; return d; };
        if (req.body.sales_manager !== undefined) { const d = n(req.body.sales_manager); if (d.length < 8) return res.status(400).json({ error: "Check the Sales Manager's number" }); await setSetting("sales_manager_number", d); }
        if (req.body.owner !== undefined) { const d = n(req.body.owner); if (d.length < 8) return res.status(400).json({ error: "Check your number" }); await setSetting("owner_number", d); }
        return res.json({ ok: true });
      }
      case "pick_ad": {
        // The team says which ad a client came from (or "none"); the bot then writes the reply.
        if (!waId) return res.status(400).json({ error: "Which chat?" });
        await pickAd(waId, String(value || ""));
        const draft = await redraft(waId);
        // The team has now confirmed the ad, so the bot's reply goes out by itself (same hold rules as any other reply).
        const auto = await autoSend(waId, draft, { adPicked: true }).catch(() => null);
        return res.json({ ok: true, draft, auto });
      }
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
      case "create_referral_template": { const r = await createMissingTemplates(); return res.json({ ok: true, ...r }); }
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

// Used by automatic sending (api/_lib/autosend.js).
module.exports.internals = { send, sendPdf, autoQuote };
