// Ravin (our main layer) referrals: the WhatsApp templates, the record of who was referred,
// and spotting Ravin's number in any message the team sends (from the Suite or the phone).
const { db, d360, getSetting, setSetting, logEvent } = require("./common");

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
  sales: {
    name: "sales_manager_lead",
    body: "Hey Paving: a client needs our Sales Manager to contact them.\nClient: {{1}}\nNumber: {{2}}\nDetails: {{3}}\nPlease contact them soon. Thank you!",
    example: ["Jsd Battery Centre Ltd", "+230 5767 5024", "About 190 m2, slabs 600x300 Light Grey + 300x300 Dark Grey"],
  },
  breakdownCheck: {
    name: "breakdown_check",
    body: "Hey Paving: the factory breakdown reported on {{1}} ({{2}}) isn't marked as repaired yet. Is it repaired? Reply \"repaired\" or tell me what's still wrong.",
    example: ["24 Nov", "mixer motor"],
  },
  breakdownAlert: {
    name: "breakdown_alert",
    body: "Hey Paving: no answer about the factory breakdown reported on {{1}} ({{2}}). I asked {{3}} this morning and it isn't marked as repaired yet.",
    example: ["24 Nov", "mixer motor", "Julien"],
  },
  missed: {
    name: "missed_call",
    body: "Hello, this is Paving Mauritius Ltd. Sorry we missed your call! How can we help you? You can reply here on WhatsApp.",
    example: null,
  },
};

const tplText = (t) => String(t || "").replace(/\s+/g, " ").trim().slice(0, 120) || "not given";

function prettyNumber(waId) {
  if (!waId.startsWith("230")) return `+${waId}`;
  const local = waId.slice(3);
  return `+230 ${local.slice(0, 4)} ${local.slice(4)}`.trim();
}

async function storeOut(waId, id, type, text) {
  await db().from("wa_messages").upsert({
    id, wa_id: waId, direction: "out", source: "suite", type, body: text, status: "sent", sent_at: new Date().toISOString(),
  }, { onConflict: "id", ignoreDuplicates: true });
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

// A message to someone on the team (Julien, Iswarren): normal text while their 24-hour window is
// open, otherwise the approved template with the same words.
async function sendTeamMessage(to, key, params) {
  const num = String(to || "").replace(/\D/g, "");
  if (!num) throw new Error("No number saved for this message");
  const t = TEMPLATES[key];
  const text = t.body.replace(/\{\{(\d)\}\}/g, (_, n) => params[Number(n) - 1]);
  const { data: c } = await db().from("wa_contacts").select("last_inbound_at").eq("wa_id", num).maybeSingle();
  const open = c?.last_inbound_at && Date.now() - new Date(c.last_inbound_at) < 23 * 3600 * 1000;
  let id = null;
  if (open) {
    try {
      const data = await d360("/messages", { method: "POST", body: { messaging_product: "whatsapp", recipient_type: "individual", to: num, type: "text", text: { body: text } } });
      id = data?.messages?.[0]?.id || null;
    } catch { id = null; }
  }
  if (!id) {
    const data = await d360("/messages", {
      method: "POST",
      body: { messaging_product: "whatsapp", recipient_type: "individual", to: num, type: "template",
        template: { name: t.name, language: { code: "en" }, components: [{ type: "body", parameters: params.map((x) => ({ type: "text", text: String(x || "").replace(/\s+/g, " ").trim().slice(0, 300) || "not given" })) }] } },
    });
    id = data?.messages?.[0]?.id || `local-${Date.now()}`;
  }
  await storeOut(num, id, open ? "text" : "template", text);
  return id;
}

// Big orders and contractors: when "our Sales Manager will contact you" goes to a client,
// the Sales Manager (Julien) gets the client's details on WhatsApp. Once per client per week.
const SALES_RE = /sales\s*manager/i;
async function notifySalesManager(waId, sentText, details) {
  if (!SALES_RE.test(String(sentText || ""))) return null;
  const map = await getSetting("sales_handovers", {});
  const done = map && typeof map === "object" ? map : {};
  if (done[waId] && Date.now() - new Date(done[waId]) < 7 * 24 * 3600 * 1000) return null;
  const to = await getSetting("sales_manager_number", "23058212040");
  const { data: c } = await db().from("wa_contacts").select("name,profile_name").eq("wa_id", waId).maybeSingle();
  const id = await sendTeamMessage(to, "sales", [c?.name || c?.profile_name || "Client", prettyNumber(waId), String(details || "").replace(/\s+/g, " ").slice(0, 300) || "see the chat in the Suite"]);
  done[waId] = new Date().toISOString();
  const keys = Object.keys(done);
  if (keys.length > 500) keys.slice(0, keys.length - 500).forEach((k) => delete done[k]);
  await setSetting("sales_handovers", done);
  await logEvent("sales_handover", { wa_id: waId });
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

// Tells Ravin about a client we referred (no payment info yet; that comes later as an update).
async function notifyRavin(waId, referral) {
  await sendLayerTemplate("referral", [tplText(referral.client_name), prettyNumber(waId), tplText(referral.location), tplText(referral.product), tplText(referral.area)]);
  await saveReferral(waId, referral);
}

// Does this text give out Ravin's number? (spaces, dots and dashes between digits allowed)
async function ravinLocal() {
  const r = String(await getSetting("ravin_number", "") || "").replace(/\D/g, "");
  return r.length >= 8 ? r.slice(-8) : "";
}
function textMentions(text, local) {
  if (!local || !text) return false;
  return String(text).replace(/(\d)[\s.\-]+(?=\d)/g, "$1").includes(local);
}
async function mentionsRavin(text) {
  return textMentions(text, await ravinLocal());
}

// Reads the chat to fill the referral (name, location, product, area) when the team gave Ravin's
// number themselves. Falls back to the contact's name if Claude can't be reached.
async function extractReferral(waId) {
  const [{ data: contact }, { data: msgs }] = await Promise.all([
    db().from("wa_contacts").select("name,profile_name").eq("wa_id", waId).maybeSingle(),
    db().from("wa_messages").select("direction,body").eq("wa_id", waId).order("sent_at", { ascending: false }).limit(40),
  ]);
  const fallback = { client_name: contact?.name || contact?.profile_name || "", location: "", product: "", area: "" };
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return fallback;
  const chat = (msgs || []).reverse().map((m) => `${m.direction === "in" ? "Client" : "Us"}: ${String(m.body || "").slice(0, 400)}`).join("\n");
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: process.env.BOT_MODEL || "claude-sonnet-5-5", max_tokens: 300,
        messages: [{ role: "user", content: `From this WhatsApp chat between a paving supplier ("Us") and a client, extract for a referral to our layer. Reply with ONLY JSON {"client_name":"","location":"","product":"","area":""}: client_name = the client's name or company, location = area/town/address of the job, product = product and colour (e.g. "Pavers 200x100x60mm, Light Grey"), area = surface in m2 if known. Leave unknown fields empty.\nClient's WhatsApp name: ${fallback.client_name}\n\n${chat}` }],
      }),
    });
    const data = await res.json();
    const text = (data?.content || []).map((c) => c.text || "").join("");
    const j = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    const f = (v) => String(v || "").replace(/\s+/g, " ").trim().slice(0, 120);
    return { client_name: f(j.client_name) || fallback.client_name, location: f(j.location), product: f(j.product), area: f(j.area) };
  } catch {
    return fallback;
  }
}

// Someone on the team gave a client Ravin's number: tell Ravin, once per client.
async function autoRefer(waId, source) {
  const ravin = String(await getSetting("ravin_number", "") || "").replace(/\D/g, "");
  if (!ravin || waId === ravin) return null;
  const staff = (await getSetting("staff_numbers", []) || []).map((n) => String(n).replace(/\D/g, ""));
  const { data: c } = await db().from("wa_contacts").select("is_staff").eq("wa_id", waId).maybeSingle();
  if (c?.is_staff || staff.includes(waId)) return null; // e.g. Julien passing the number to the boss
  if (await getReferral(waId)) return null;
  const referral = await extractReferral(waId);
  try {
    await notifyRavin(waId, { ...referral, via: source });
    await logEvent("referral_auto", { wa_id: waId, source, referral });
    return referral;
  } catch (e) {
    await logEvent("referral_failed", { wa_id: waId, source, message: String(e.message || e) });
    throw e;
  }
}

// Clients given Ravin's number in the last few weeks but never reported to him (for the one-off check).
async function pastRavinMentions(days = 45) {
  const local = await ravinLocal();
  if (!local) return [];
  const ravin = String(await getSetting("ravin_number", "") || "").replace(/\D/g, "");
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const { data } = await db().from("wa_messages").select("wa_id,body,sent_at").eq("direction", "out").gte("sent_at", since).order("sent_at", { ascending: false }).limit(3000);
  const referred = new Set((await getSetting("referrals", []) || []).map((r) => r.wa_id));
  for (const n of await getSetting("staff_numbers", []) || []) referred.add(String(n).replace(/\D/g, ""));
  const { data: staffRows } = await db().from("wa_contacts").select("wa_id").eq("is_staff", true);
  for (const r of staffRows || []) referred.add(r.wa_id);
  const found = new Map();
  for (const m of data || []) {
    if (m.wa_id === ravin || referred.has(m.wa_id) || found.has(m.wa_id)) continue;
    if (textMentions(m.body, local)) found.set(m.wa_id, { wa_id: m.wa_id, sent_at: m.sent_at, text: String(m.body || "").slice(0, 160) });
  }
  const list = [...found.values()];
  if (list.length) {
    const { data: contacts } = await db().from("wa_contacts").select("wa_id,name,profile_name").in("wa_id", list.map((x) => x.wa_id));
    for (const x of list) { const c = (contacts || []).find((k) => k.wa_id === x.wa_id); x.name = c?.name || c?.profile_name || ""; }
  }
  return list;
}

module.exports = { TEMPLATES, tplText, prettyNumber, storeOut, sendTeamMessage, notifySalesManager, sendLayerTemplate, saveReferral, getReferral, notifyRavin, mentionsRavin, autoRefer, pastRavinMentions };
