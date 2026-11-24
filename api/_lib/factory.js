// Factory reports by WhatsApp: Julien or Kailash send the day's production, deliveries out and
// raw material arriving ("today 2000 PB60 LG", a photo of a delivery note…). Claude reads it,
// the entries are added to the factory app's data (table factory_data), and the sender gets a
// short confirmation with the new stock. "Undo" removes the last report.
const { db, getSetting, setSetting, sendText, logEvent } = require("./common");
const { mediaBlocks, parseJson } = require("./drafter");
const { storeOut } = require("./referrals");

// Same codes as the factory app (paving-factory/src/App.jsx). Keep both lists in step.
const PRODUCTS = {
  PB60LG: "Paving Brick 60mm Light Grey", PB60RD: "Paving Brick 60mm Red", PB60TC: "Paving Brick 60mm Terracota",
  PB60DG: "Paving Brick 60mm Dark Grey", PB60BN: "Paving Brick 60mm Brown",
  PB80LG: "Paving Brick 80mm Light Grey",
  PB100LG: "Paving Brick 100mm Light Grey", PB100RD: "Paving Brick 100mm Red", PB100TC: "Paving Brick 100mm Terracota",
  PB100DG: "Paving Brick 100mm Dark Grey", PB100BN: "Paving Brick 100mm Brown", PB100LGR: "Paving Brick 100mm Light Grey Reject",
  PS30LG: "Slab 300x300x60 Light Grey", PS30DG: "Slab 300x300x60 Dark Grey", PS30RD: "Slab 300x300x60 Red", PS30TC: "Slab 300x300x60 Terracota",
  PS63LG: "Slab 600x300x60 Light Grey", PS63DG: "Slab 600x300x60 Dark Grey", PS63RD: "Slab 600x300x60 Red", PS63TC: "Slab 600x300x60 Terracota",
  PS60LG: "Slab 450x450x60 Light Grey", PS60RD: "Slab 450x450x60 Red", PS60TC: "Slab 450x450x60 Terracota",
  PS60DG: "Slab 450x450x60 Dark Grey", PS60BN: "Slab 450x450x60 Brown", PS60LGR: "Slab 450x450x60 Light Grey Reject",
  PS80LG: "Slab 600x600x80 Light Grey", PS80RD: "Slab 600x600x80 Red", PS80TC: "Slab 600x600x80 Terracota",
  PS80DG: "Slab 600x600x80 Dark Grey", PS80BN: "Slab 600x600x80 Brown",
  CB60LG: "Cobble Brick 60mm Light Grey", CB60RD: "Cobble Brick 60mm Red", CB60TC: "Cobble Brick 60mm Terracota",
  CB60DG: "Cobble Brick 60mm Dark Grey", CB60BN: "Cobble Brick 60mm Brown",
  EV120: "Evergreen 400x400x120 Light Grey", EV120R: "Evergreen 400x400x120 Reject",
  KB125LG: "Kerb 450x200x125 Light Grey",
};
const RAW = {
  OPC: "Cement 42.5", RS04: "Rock Sand 0.4", AGG38: "Aggregate 3.8", PCE: "Pocket Cement",
  BFBL: "Bayferrous Black", BFRD: "Bayferrous Red", BFTC: "Bayferrous Terracota", BFYL: "Bayferrous Yellow",
  BFBN: "Bayferrous Brown", BFWH: "Bayferrous White", FIBR: "Reinforcement Fibre",
};

async function readKey(key, fallback) {
  const { data } = await db().from("factory_data").select("value").eq("key", key).maybeSingle();
  return data && data.value !== null && data.value !== undefined ? data.value : fallback;
}
async function writeKey(key, value, by) {
  const { error } = await db().from("factory_data").upsert({ key, value, updated_at: new Date().toISOString(), updated_by: by }, { onConflict: "key" });
  if (error) throw new Error(error.message);
}

const todayMU = () => new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 10);
const num = (v) => Number(String(v ?? "").replace(/[^\d.\-]/g, ""));
const validDate = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(String(d || "")) ? d : todayMU());

async function stockOf(codes) {
  const [opening, production, sales] = await Promise.all([readKey("openingStock", {}), readKey("productionLog", []), readKey("salesLog", [])]);
  const out = {};
  for (const c of codes) {
    let s = Number(opening[c] || 0);
    for (const e of production) if (e.code === c) s += Number(e.qty || 0);
    for (const e of sales) if (e.code === c) s -= Number(e.qty || 0);
    out[c] = s;
  }
  return out;
}

function prompt() {
  return `You record factory reports for Paving Mauritius Ltd from WhatsApp messages sent by staff (English, French or Mauritian Creole, often short: "2000 pb60 lg", "zordi 1500 cobble DG", "40 ton rock sand Akshay", a photo of a delivery note).
Today in Mauritius: ${todayMU()}.
Product codes: ${Object.entries(PRODUCTS).map(([c, n]) => `${c} = ${n}`).join("; ")}.
Colours: LG = Light Grey, DG = Dark Grey (black/gris foncé), RD = Red, TC = Terracotta, BN = Brown. "Pavé"/"PB"/"brick" = paving brick; "slab"/"dalle"; "cobble"; "evergreen"/"grass".
Raw material codes: ${Object.entries(RAW).map(([c, n]) => `${c} = ${n}`).join("; ")}.
Kinds of entries:
- production: pieces made (date, code, qty).
- sales: pieces that LEFT the factory (delivered or collected), with the client if given.
- rm_purchases: raw material RECEIVED, qty in kg (1 ton = 1000 kg; a 50 kg cement bag = 50 kg), supplier if given.
Rules: only record what the message clearly states; dates like "yesterday"/"hier"/"yer" become the real date; never guess a product code: if a product, colour or quantity is unclear, record nothing for that line and ask a short question in "question" (in the sender's language). If the message is not a factory report (chat, thanks, other topics), return empty lists and empty question.
Reply with ONLY JSON: {"production": [{"date": "YYYY-MM-DD", "code": "", "qty": 0}], "sales": [{"date": "", "code": "", "qty": 0, "client": ""}], "rm_purchases": [{"date": "", "code": "", "qty_kg": 0, "supplier": ""}], "undo": false, "question": ""}
"undo": true only if the sender asks to cancel/undo their last report ("undo", "annule", "cancel", "sorry wrong").`;
}

async function askClaude(content) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: process.env.BOT_MODEL || "claude-sonnet-5-5", max_tokens: 1500, system: prompt(), messages: [{ role: "user", content }] }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Claude: ${data?.error?.message || res.status}`);
  return parseJson((data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("")) || {};
}

const fmtN = (n) => Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 });

async function reply(waId, text) {
  const id = await sendText(waId, text);
  await storeOut(waId, id, "text", text);
}

// Undo: remove every entry of the sender's last report.
async function undoLast(waId) {
  const batches = await getSetting("factory_batches", {});
  const batch = batches?.[waId];
  if (!batch) return "There's no report of yours to undo.";
  let removed = 0;
  for (const key of ["productionLog", "salesLog", "rmPurchases"]) {
    const list = await readKey(key, []);
    const kept = list.filter((e) => e.batch !== batch);
    if (kept.length !== list.length) { removed += list.length - kept.length; await writeKey(key, kept, `whatsapp:${waId}`); }
  }
  delete batches[waId];
  await setSetting("factory_batches", batches);
  return removed ? `↩️ Undone: your last report (${removed} line${removed > 1 ? "s" : ""}) was removed.` : "Nothing to undo.";
}

// Handles one message (or a few close together) from a factory reporter.
async function handleFactoryReport(waId) {
  const { data: rows } = await db().from("wa_messages").select("*").eq("wa_id", waId).order("sent_at", { ascending: false }).limit(12);
  const recent = (rows || []).reverse();
  // Only the messages since our last reply to this person.
  let start = 0;
  recent.forEach((m, i) => { if (m.direction === "out") start = i + 1; });
  let fresh = recent.slice(start).filter((m) => m.direction === "in");
  if (!fresh.length) fresh = recent.filter((m) => m.direction === "in").slice(-1); // clock rounding: at least the newest
  if (!fresh.length) return null;
  const { blocks } = await mediaBlocks(fresh);
  const content = [
    { type: "text", text: `Messages from staff (oldest first):\n${fresh.map((m) => `- ${m.body || "[photo]"}`).join("\n")}` },
    ...blocks,
    { type: "text", text: "Write the JSON." },
  ];
  const r = await askClaude(content);
  if (r.undo) { const t = await undoLast(waId); await reply(waId, t); return { undo: true }; }

  const batch = `wa-${waId}-${Date.now()}`;
  const by = `whatsapp:${waId}`;
  const stamp = (e, i) => ({ ...e, id: Date.now() + i, batch, by });
  const production = (Array.isArray(r.production) ? r.production : [])
    .filter((e) => PRODUCTS[e.code] && num(e.qty) > 0).map((e, i) => stamp({ date: validDate(e.date), code: e.code, qty: String(num(e.qty)) }, i));
  const sales = (Array.isArray(r.sales) ? r.sales : [])
    .filter((e) => PRODUCTS[e.code] && num(e.qty) > 0).map((e, i) => stamp({ date: validDate(e.date), code: e.code, qty: String(num(e.qty)), client: String(e.client || "").slice(0, 80) }, 100 + i));
  const rm = (Array.isArray(r.rm_purchases) ? r.rm_purchases : [])
    .filter((e) => RAW[e.code] && num(e.qty_kg) > 0).map((e, i) => stamp({ date: validDate(e.date), code: e.code, qty: num(e.qty_kg), unit: "kg", supplier: String(e.supplier || "").slice(0, 80) }, 200 + i));

  if (!production.length && !sales.length && !rm.length) {
    if (r.question) await reply(waId, String(r.question).slice(0, 500));
    return { recorded: 0 };
  }
  if (production.length) await writeKey("productionLog", [...await readKey("productionLog", []), ...production], by);
  if (sales.length) await writeKey("salesLog", [...await readKey("salesLog", []), ...sales], by);
  if (rm.length) await writeKey("rmPurchases", [...await readKey("rmPurchases", []), ...rm], by);
  const batches = await getSetting("factory_batches", {});
  await setSetting("factory_batches", { ...(batches && typeof batches === "object" ? batches : {}), [waId]: batch });

  const codes = [...new Set([...production, ...sales].map((e) => e.code))];
  const stock = await stockOf(codes);
  const lines = ["✅ Recorded in the factory app:"];
  for (const e of production) lines.push(`🏭 Made ${fmtN(e.qty)} ${PRODUCTS[e.code]} (${e.date})`);
  for (const e of sales) lines.push(`🚚 Out ${fmtN(e.qty)} ${PRODUCTS[e.code]}${e.client ? ` – ${e.client}` : ""} (${e.date})`);
  for (const e of rm) lines.push(`📦 Received ${fmtN(e.qty / 1000)} t ${RAW[e.code]}${e.supplier ? ` from ${e.supplier}` : ""} (${e.date})`);
  if (codes.length) lines.push("", "Stock now:", ...codes.map((c) => `• ${PRODUCTS[c]}: ${fmtN(stock[c])}`));
  if (r.question) lines.push("", String(r.question).slice(0, 300));
  lines.push("", 'Wrong? Reply "undo".');
  await reply(waId, lines.join("\n"));
  await logEvent("factory_report", { wa_id: waId, production: production.length, sales: sales.length, rm: rm.length });
  return { recorded: production.length + sales.length + rm.length };
}

module.exports = { handleFactoryReport, PRODUCTS, RAW };
