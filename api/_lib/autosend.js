// Automatic sending, switched on or off in Setup (setting "auto_send"). OFF by default:
// until the team switches it on, every suggestion waits for approval as before.
// When on, a suggestion goes out by itself only if nothing in it needs a person (see holdReason).
// Quotations always wait for approval, so the team chooses the bank details each time.
const { db, getSetting, setSetting, logEvent } = require("./common");
const { findProduct } = require("./products");

const MEDIA = ["image", "document", "audio", "video", "sticker", "unsupported"];
const TEAM_ACTIVE_MS = 2 * 3600 * 1000;

async function autoSettings() {
  const s = await getSetting("auto_send", {});
  const o = s && typeof s === "object" ? s : {};
  return { enabled: o.enabled === true, bank: o.bank === "sbm" ? "sbm" : "none" };
}

function mauritiusHour(now = new Date()) {
  return Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: "Indian/Mauritius" }).format(now));
}

// Area a quotation covers, in m² (lines of one design cover the same area, so take the biggest).
function quoteArea(q) {
  return Math.max(0, ...(q?.items || []).map((i) => {
    const p = findProduct(i.desc);
    return p && p.perM2 ? Number(i.qty || 0) / p.perM2 : 0;
  }));
}

// An estimate in text ("about 134 slabs… Rs 32,836.70") counts as a quotation: it waits too.
// Unit prices (Rs 145 per slab) can go out by themselves.
function hasEstimate(text) {
  const t = String(text || "");
  if (/\b(estimat|total|devis|quotation)/i.test(t) && /Rs\.?\s?\d/i.test(t)) return true;
  return [...t.matchAll(/Rs\.?\s?([\d,]+(?:\.\d+)?)/gi)].some((m) => Number(m[1].replace(/,/g, "")) >= 1000);
}

// Why this suggestion must wait for the team, or null if it can go out by itself.
async function approvedOrder(waId) {
  const orders = await getSetting("contact_orders", {});
  const o = orders && orders[waId];
  return o && o.approved && (o.bank === "sbm" || o.bank === "none") && Date.now() - new Date(o.at) < 14 * 86400000 ? o : null;
}
async function consumeOrder(waId) {
  const orders = await getSetting("contact_orders", {});
  if (orders && orders[waId]) { orders[waId].approved = false; await setSetting("contact_orders", orders); }
}

async function holdReason(waId, row, now = new Date(), opts = {}) {
  if (!row) return "no suggestion";
  if (row.needs_team) return "the bot flagged it for the team";
  const x = row.quote || {};
  if (x.payment) return "payment proof";
  if (x.ask_ad) return "which ad";
  if (x.template) return "missed-call template";
  const quotes = Array.isArray(x.quotes) ? x.quotes : [];
  // A quotation the owner ordered himself (his command named the product and the bank) needs no extra approval: one quotation only.
  const order = quotes.length === 1 ? await approvedOrder(waId) : null;
  if (!String(row.body || "").trim() && !quotes.length && !x.attach && !(x.photos || []).length) return "nothing to send";
  if (quotes.length && !order) return "quotation (approve it and choose the bank details)";
  if (!order && hasEstimate(row.body)) return "price estimate for the client's area";
  const h = mauritiusHour(now);
  if (h >= 23 || h < 7) return "night (chat hours end at 11 p.m.)";
  const { data } = await db().from("wa_messages").select("direction,source,type,sent_at").eq("wa_id", waId).order("sent_at", { ascending: false }).limit(60);
  const list = data || []; // newest first
  for (const m of list) {
    if (m.direction === "out") break;
    // After the team picked the ad, the ad click itself (sent as an "unsupported" message) is not a client photo or voice note.
    if (opts.adPicked && m.type === "unsupported") continue;
    if (MEDIA.includes(m.type)) return "the client sent a photo, file or voice note";
  }
  const since = now.getTime() - TEAM_ACTIVE_MS;
  if (list.some((m) => m.direction === "out" && m.source === "phone" && new Date(m.sent_at).getTime() > since)) return "the team is answering this client from the phone";
  return null;
}

// Called right after a new suggestion is saved. Returns what happened, for the logs.
async function autoSend(waId, row, opts = {}) {
  const cfg = await autoSettings();
  if (!cfg.enabled || !row) return null;
  const why = await holdReason(waId, row, new Date(), opts);
  if (why) {
    if (!row.needs_team) await db().from("wa_drafts").update({ team_note: [row.team_note, `(Not sent automatically: ${why}.)`].filter(Boolean).join(" ") }).eq("id", row.id);
    return { held: why };
  }
  // The client may have written again, or the team acted, while the suggestion was being written.
  const { data: fresh } = await db().from("wa_drafts").select("status,quote").eq("id", row.id).maybeSingle();
  if (!fresh || fresh.status !== "pending") return null;
  await db().from("wa_drafts").update({ quote: { ...(fresh.quote || {}), auto: true } }).eq("id", row.id);
  const { send, autoQuote } = require("../wa-admin").internals;
  try {
    const quotes = Array.isArray(fresh.quote?.quotes) ? fresh.quote.quotes : [];
    if (quotes.length) {
      const order = quotes.length === 1 ? await approvedOrder(waId) : null;
      for (let i = 0; i < quotes.length; i += 1) await autoQuote(waId, row.id, quotes[i], i, order ? order.bank : cfg.bank, row.body);
      if (order) await consumeOrder(waId); // used once: the next quotation for this client needs approval again
    } else {
      await send(waId, row.body, row.id);
    }
    await logEvent("auto_sent", { wa_id: waId, draft_id: row.id });
    return { sent: true };
  } catch (err) {
    const msg = String(err?.message || err).slice(0, 300);
    await db().from("wa_drafts").update({ needs_team: true, team_note: [row.team_note, `⚠️ Automatic sending failed, please check and send: ${msg}`].filter(Boolean).join(" ") }).eq("id", row.id);
    await logEvent("auto_send_error", { wa_id: waId, draft_id: row.id, message: msg });
    return { error: msg };
  }
}

module.exports = { autoSettings, holdReason, autoSend, quoteArea, mauritiusHour, hasEstimate };
