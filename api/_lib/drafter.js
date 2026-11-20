// Writes a suggested WhatsApp reply with Claude. Nothing is sent from here:
// the draft waits in the Suite until Iswarren or JL approves it.
const { db, getSetting, fmtTime, downloadMedia } = require("./common");
const { RULEBOOK } = require("./rulebook");
const { checkLine } = require("./products");
const { getAds, latestAd, adPrompt } = require("./ads");

const MODEL = process.env.BOT_MODEL || "claude-sonnet-5-5";
const HISTORY_LIMIT = 40;
const MESSAGE_BREAK = "\n---\n"; // separates the short messages of one suggestion
const MAX_MEDIA = 4; // newest photos / PDFs from the client that Claude looks at
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

function examplesText(examples) {
  const list = (Array.isArray(examples) ? examples : []).slice(-12);
  if (!list.length) return "";
  return `
Corrections by the team (most recent last). The team edited your suggestion before sending it; copy their style, length and choices in similar situations:
${list.map((e, i) => `${i + 1}. Client: ${String(e.client || "").slice(0, 300)}
   Your suggestion: ${String(e.bot || "").slice(0, 500)}
   What the team sent: ${String(e.team || "").slice(0, 500)}`).join("\n")}
`;
}

function referralText(ravin) {
  const local = ravin.startsWith("230") ? `${ravin.slice(3, 7)} ${ravin.slice(7)}` : `+${ravin}`;
  if (!ravin) return `
Layer referral: Ravin's number isn't set up yet. If the client wants a layer's number, set needs_team with the note "Send Ravin's number".
`;
  return `
Layer referral: our main layer is Ravin. When the client says yes to a layer's number, send exactly this, in the client's language (number written as ${local}):
- English: "Please call Ravin on ${local} and tell him Paving Mauritius Ltd referred you. He will do the needful for you."
- French: "Veuillez appeler Ravin au ${local} et dites-lui que c'est Paving Mauritius Ltd qui vous a référé. Il va faire le nécessaire pour vous."
- Creole: "Svp apel Ravin lor ${local} ek dir li ki Paving Mauritius Ltd ki finn refer ou. Li pou fer le nécessaire pou ou."
Then fill "referral" with what you know about the client: client_name, location (area, town or address), product and area (m²). Leave a field empty if unknown. The team approves, and Ravin automatically gets a message with these details.
`;
}

function systemPrompt(rulebook, contact, examples, ravin) {
  const now = fmtTime(new Date().toISOString());
  return `You are the WhatsApp assistant of Paving Mauritius Ltd, writing replies to clients on the business number 5725 4201.
Every reply you write is a DRAFT: a team member reads it and approves, edits or discards it before the client sees anything.

Follow this rulebook exactly:
<rulebook>
${rulebook}
</rulebook>

How to write:
- Write like a busy, friendly salesperson on WhatsApp: SHORT separate messages, not one block. Return 1 to 3 messages in "messages"; each one is normally a single sentence or two, under about 200 characters. One question per message, and the question goes last.
- Language: answer in the language of the client's MOST RECENT messages, even if the chat started in another language. Mauritian Creole (e.g. "mo", "ou kapav", "pou moi", "ena", "kombien") gets Mauritian Creole with the rulebook's spelling; French gets French; English gets English.
- Plain text only: no markdown, no bullet lists, no headings.
- Speak as "we". Never name JL, Julien or Iswarren. Never say you are waiting for approval.
- Don't list all colours, sizes or prices unless the client asks. Mention only the product the client (or the ad) is about. Never suggest mixing colours or designs unless the client asks.
- Never promise to come back "in a few minutes", "shortly" or at a set time. If something needs the team, set needs_team and explain in team_note; to the client, answer what you can or ask the next useful question. (Only exceptions: the rulebook's phrases "we'll confirm the final delivery price" and, for delay updates, "I'm checking with the team and will confirm today".)
- If the client's last messages need nothing more (for example "ok merci"), return no messages.
- Set needs_team whenever the rulebook says to hand over or check with the team, or when you are unsure. Explain why in team_note (English, one or two short lines, for the team only).
- Never invent prices, dates, stock or facts that are not in the rulebook or the conversation.
- Messages marked [team] were sent by our staff; treat them as our own and stay consistent with them.

The usual conversation:
1. Facebook ad: a message starting with [From Facebook ad: ...] or [From Facebook post: ...] means the client tapped our ad (the text in quotes is the ad; "Hello! Can I get more info on this?" is Facebook's automatic text). First reply, as two short messages: thank them for their interest in the advertised product (name only that product), then "Do you know your measurements? I can give you a quotation." No price list, no colour list, no other sizes. If the ad text is missing, ask briefly whether they want pavers or slabs, then the measurements question. Once the client has come from an ad, the advertised product IS the product they want: when they then send measurements (or a sketch), go straight to the estimate or quotation for that product. Never ask again which product, slab or paver they want, unless they say they want something else. If the ad shows a design (e.g. the two-colour design: 600x300 Light Grey + 300x300 Dark Grey), that whole design, with its sizes and colours, is what they want: never ask which colour or size, and never treat the design as two separate options. When they send measurements, the first message is the area and the pieces of each part of the design with the estimated total, VAT included (work the pieces out with the rulebook's design rule, no gap unless the client asks for one); the second message is "Would you like a formal quotation?". The quotation for a design is ONE quotation with one line per part (e.g. 600x300 Light Grey and 300x300 Dark Grey), each with its qty worked out by you and area_m2, area_sqft and gap_cm left at 0 (otherwise each line would be counted for the whole area). If the ad shows separate options (e.g. different sizes to choose from), use the one they name; only if they named none, quote the main one shown in the ad.
2. Measurements or a sketch: first message = the area you read (ask them to confirm if it came from a sketch) and the number of pieces. If the colour isn't known yet (and the client didn't come from an ad that shows it), the second message is just "Which colour would you like?" (don't list colours or prices; let them ask).
3. Once product, size, colour and area are known: first message = number of pieces and the estimated total, VAT included. Second message = "Would you like a formal quotation?"
Large orders (over about 150 m²) and contractors: as soon as you know the area is over about 150 m² (or they're a contractor), add a separate message saying our director will contact them personally (wording in the rulebook, section 10), and set needs_team with the area in team_note. Say it once per client.
4. Only when the client says yes, or asks for a quotation themselves, prepare "quotes" (see below). If they ask for a quotation directly, don't ask "would you like a quotation?" again: prepare it straight away if you have product, size, colour and area, otherwise ask only for what's missing.

Attachments from the client (photos and PDFs) come after the conversation, labelled to match it (for example [Photo 1]):
- Sketches and plans: read every measurement and calculate the area, including uneven sides and slopes (trapezoids, triangles), following the rulebook. Tell the client the area you found; don't ask them to confirm it. Ask only for a measurement that is missing or unreadable when the area can't be calculated without it. Put your working in team_note (e.g. "400×200 − 100×(120+100)/2 = 69,000 sq ft = 6,410 m²") so the team can check it.
- Site photos: use them to understand the job, but never estimate an area from a photo alone; ask for measurements.
- Payment proofs: fill "payment" with the amount in rupees (a number), date, bank and reference, mention them in team_note, and set needs_team. Never tell the client the payment is confirmed; just thank them and say the team will check it.
- If an attachment could not be loaded, say so in team_note.

Quotations ("quotes", a list):
- One quotation per option. If the client wants prices for several products, sizes, colours or laying patterns (e.g. "one quotation for each slab"), make a separate quotation for each one in "quotes"; never put alternatives together in one quotation (their totals would add up). Only lines that go together on the same job (e.g. slabs plus the pavers framing them) share one quotation.
- Each quotation's caption is the ONE short line sent with its PDF; with several, name the option, e.g. "Voilà ou quotation pou slab 300x300.", in the client's language, e.g. "Here is your quotation.", "Voici votre devis.", in Creole "Voilà ou quotation." (never "Ala"). Nothing more. If the client also asked something else (e.g. "do you also lay the slabs?"), answer it in "messages": those are sent as separate messages right after the PDF. Otherwise leave "messages" empty.
- For a simple line covering an area, give "area_m2" (or "area_sqft" if the client used feet) and, for slabs laid with a space between them, "gap_cm" (the gap in cm). The Suite works out the pieces from the price list; you may leave qty at 0. If the client wants a gap but hasn't said how wide, ask (suggest the usual 2.5 to 5 cm) before quoting. For two-colour or framed designs, work out qty yourself following the rulebook.
- unit_price_incl_vat is the list price per piece from the rulebook, VAT included. Never apply a discount.
- client_name: the client's name if known, otherwise their WhatsApp name. location: town or site address if known.
- summary: one line for the team, e.g. "20 m² driveway, pavers 60 mm, Light Grey".

First contact: the very first time a client talks to us, end that first conversation with "Thank you for contacting us." in their language (French "Merci de nous avoir contactés.", Creole "Mersi pou ou finn contacte nou."), as the last message once their questions are answered or the quotation is sent (also when they reply "ok merci"). Say it only once per client: if it was already said earlier in the chat, don't repeat it.

Price list: when the client asks for the price list, set "attach" to "price_list" and send one short line such as "Here is our price list." The PDF goes with it.
${referralText(ravin)}${examplesText(examples)}
Current time in Mauritius: ${now}.
Client: ${contact?.name || contact?.profile_name || "unknown"} (+${contact?.wa_id || ""}).

Reply with ONLY a JSON object, no other text:
{"messages": ["<short message>", "<short message>"], "needs_team": true|false, "team_note": "<short note or empty>", "attach": null | "price_list",
 "referral": null | {"client_name": "", "location": "", "product": "", "area": ""},
 "payment": null | {"amount": 25000, "date": "", "bank": "", "reference": ""},
 "quotes": [] | [{"client_name": "", "location": "", "summary": "", "caption": "Here is your quotation.", "items": [{"desc": "Slabs 600x300x60mm – Light Grey", "qty": 0, "area_m2": 20, "gap_cm": 5, "unit_price_incl_vat": 145}]}]}`;
}

function transcript(messages, labels) {
  return messages
    .map((m) => {
      const who = m.direction === "in" ? "Client" : "Paving Mauritius [team]";
      const tag = labels.get(m.id) ? `${labels.get(m.id)} ` : "";
      return `[${fmtTime(m.sent_at)}] ${who}: ${tag}${m.body || `[${m.type || "message"}]`}`;
    })
    .join("\n");
}

// Fetch the newest client photos and PDFs so Claude can look at them.
async function mediaBlocks(messages) {
  const labels = new Map();
  const blocks = [];
  const wanted = messages
    .filter((m) => m.direction === "in" && m.media_id && (m.type === "image" || m.type === "document"))
    .slice(-MAX_MEDIA);
  let n = 0;
  for (const m of wanted) {
    n += 1;
    const label = m.type === "image" ? `[Photo ${n}]` : `[Document ${n}]`;
    labels.set(m.id, label);
    try {
      const file = await downloadMedia(m.media_id);
      if (IMAGE_TYPES.includes(file.mime) && file.size <= 4.5 * 1024 * 1024) {
        blocks.push({ type: "text", text: `${label} sent ${fmtTime(m.sent_at)}:` });
        blocks.push({ type: "image", source: { type: "base64", media_type: file.mime, data: file.base64 } });
      } else if (file.mime === "application/pdf" && file.size <= 20 * 1024 * 1024) {
        blocks.push({ type: "text", text: `${label} (PDF) sent ${fmtTime(m.sent_at)}:` });
        blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: file.base64 } });
      } else {
        blocks.push({ type: "text", text: `${label}: could not be read (${file.mime || "unknown type"}, ${Math.round(file.size / 1024)} KB).` });
      }
    } catch (err) {
      blocks.push({ type: "text", text: `${label}: could not be loaded (${String(err.message || err).slice(0, 120)}).` });
    }
  }
  return { labels, blocks };
}

// The bot answers through a tool with a fixed shape, so its reply always comes back complete and readable.
const STR = { type: "string" };
const DRAFT_TOOL = {
  name: "draft_reply",
  description: "Return the suggested WhatsApp reply for the team to approve.",
  input_schema: {
    type: "object",
    properties: {
      messages: { type: "array", items: STR, description: "1 to 3 short messages to send, in order. Empty if no reply is needed." },
      needs_team: { type: "boolean" },
      team_note: { type: "string", description: "Short note for the team in English, or empty." },
      attach: { type: "string", enum: ["none", "price_list"] },
      referral: { type: "object", properties: { client_name: STR, location: STR, product: STR, area: STR } },
      payment: { type: "object", properties: { amount: { type: "number" }, date: STR, bank: STR, reference: STR } },
      quote: {
        type: "object",
        properties: {
          client_name: STR, location: STR, summary: STR, caption: STR,
          items: { type: "array", items: { type: "object", properties: { desc: STR, qty: { type: "number" }, unit_price_incl_vat: { type: "number" } }, required: ["desc", "qty", "unit_price_incl_vat"] } },
        },
      },
    },
    required: ["messages", "needs_team", "team_note"],
  },
};

// Last resort if the answer came back as text: pull the messages out so the team never sees raw code.
function salvage(text) {
  const m = text.match(/"messages"\s*:\s*\[([\s\S]*?)\]/);
  if (!m) return null;
  const parts = [...m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => { try { return JSON.parse(`"${x[1]}"`); } catch { return x[1]; } });
  return parts.length ? { messages: parts } : null;
}

function parseJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

async function draftReply(waId) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set in Vercel");

  const [{ data: contact }, { data: recent }] = await Promise.all([
    db().from("wa_contacts").select("*").eq("wa_id", waId).maybeSingle(),
    db().from("wa_messages").select("id,direction,type,body,media_id,sent_at").eq("wa_id", waId).order("sent_at", { ascending: false }).limit(HISTORY_LIMIT),
  ]);
  const messages = (recent || []).reverse();
  if (!messages.length) return null;

  const [rulebook, examples, ravin, ads] = await Promise.all([getSetting("rulebook", RULEBOOK), getSetting("examples", []), getSetting("ravin_number", ""), getAds()]);
  const ad = latestAd(messages);
  const adInfo = ad ? ads[ad.key] : null;
  const adUnknown = Boolean(ad && !(adInfo && adInfo.design));
  const { labels, blocks } = await mediaBlocks(messages);
  const content = [
    { type: "text", text: `Conversation so far (oldest first):\n${transcript(messages, labels)}` },
    ...(ad ? [{ type: "text", text: adPrompt(ad, adInfo) }] : []),
    ...(blocks.length ? [{ type: "text", text: "Attachments from the client:" }, ...blocks] : []),
    { type: "text", text: "Write the JSON for our next message." },
  ];
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      system: systemPrompt(typeof rulebook === "string" ? rulebook : RULEBOOK, contact, examples, String(ravin || "").replace(/\D/g, "")),
      messages: [{ role: "user", content }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Claude: ${data?.error?.message || res.status}`);
  const toolUse = (data.content || []).find((c) => c.type === "tool_use" && c.name === "draft_reply");
  const text = (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
  let parsed = toolUse?.input || parseJson(text);
  if (!parsed) {
    const saved = salvage(text);
    if (!saved) return { reply: "", needs_team: true, team_note: "The bot couldn't write a proper suggestion this time. Tap ↻ New suggestion or answer yourself.", quote: null, attach: null };
    parsed = { ...saved, needs_team: true, team_note: "The bot's answer was cut short; check it before sending." };
  }
  if (data.stop_reason === "max_tokens" && toolUse) parsed = { ...parsed, needs_team: true, team_note: [parsed.team_note, "(The bot's answer was cut short; check it.)"].filter(Boolean).join(" ") };
  const rawQuotes = Array.isArray(parsed.quotes) ? parsed.quotes : parsed.quote ? [parsed.quote] : [];
  const quotes = rawQuotes.map(cleanQuote).filter(Boolean).slice(0, 4);
  const quote = quotes.length ? quotes[0] : null;
  const parts = (Array.isArray(parsed.messages) ? parsed.messages : [parsed.reply])
    .map((m) => String(m || "").replace(/\n-{3,}\n/g, "\n").trim())
    .filter(Boolean)
    .slice(0, 3);
  return {
    reply: parts.join(MESSAGE_BREAK), // with a quote, these go out after the PDF
    needs_team: Boolean(parsed.needs_team) || adUnknown,
    team_note: [adUnknown ? "📢 New ad: tell the bot what's in it (box above), then it can quote." : "", String(parsed.team_note || "").trim()].filter(Boolean).join(" "),
    quote,
    quotes,
    attach: parsed.attach === "price_list" ? "price_list" : null,
    referral: cleanReferral(parsed.referral),
    payment: cleanPayment(parsed.payment),
  };
}

function cleanPayment(p) {
  if (!p || typeof p !== "object") return null;
  const amount = Number(String(p.amount ?? "").replace(/[^\d.]/g, ""));
  if (!amount || amount <= 0) return null;
  const f = (v) => String(v || "").replace(/\s+/g, " ").trim().slice(0, 80);
  return { amount: Math.round(amount * 100) / 100, date: f(p.date), bank: f(p.bank), reference: f(p.reference) };
}

function cleanReferral(r) {
  if (!r || typeof r !== "object") return null;
  const f = (v) => String(v || "").replace(/\s+/g, " ").trim().slice(0, 120);
  const out = { client_name: f(r.client_name), location: f(r.location), product: f(r.product), area: f(r.area) };
  return Object.values(out).some(Boolean) ? out : null; // an empty object means "no referral"
}

// Builds the row saved in wa_drafts. Extras (quotation, attachment) live in the "quote" column.
function draftRow(waId, replyTo, draft) {
  const extras = draft.quotes && draft.quotes.length ? { quotes: draft.quotes } : {};
  if (draft.attach) extras.attach = draft.attach;
  if (draft.referral) extras.referral = draft.referral;
  if (draft.payment) extras.payment = draft.payment;
  return {
    wa_id: waId, reply_to: replyTo || null, body: draft.reply || "", needs_team: draft.needs_team,
    team_note: draft.team_note || null, ...(Object.keys(extras).length ? { quote: extras } : {}),
  };
}

function hasContent(draft) {
  return Boolean(draft && (draft.reply || draft.needs_team || draft.quote || draft.attach || draft.referral || draft.payment));
}

// Keep only sensible quotation lines; the team can still edit everything before sending.
function cleanQuote(q) {
  if (!q || typeof q !== "object" || !Array.isArray(q.items)) return null;
  const items = q.items
    .map((i) => checkLine({
      desc: String(i?.desc || "").slice(0, 120).trim(),
      qty: Math.max(0, Math.ceil(Number(i?.qty) || 0)),
      unit_price_incl_vat: Math.max(0, Number(i?.unit_price_incl_vat) || 0),
      area_m2: Number(i?.area_m2) || 0,
      area_sqft: Number(i?.area_sqft) || 0,
      gap_cm: Number(i?.gap_cm) || 0,
    }))
    .map(({ desc, qty, unit_price_incl_vat }) => ({ desc, qty, unit_price_incl_vat }))
    .filter((i) => i.desc && i.qty > 0)
    .slice(0, 12);
  if (!items.length) return null;
  return {
    client_name: String(q.client_name || "").slice(0, 120).trim(),
    location: String(q.location || "").slice(0, 200).trim(),
    summary: String(q.summary || "").slice(0, 300).trim(),
    caption: String(q.caption || "").slice(0, 900).trim(),
    items,
  };
}

module.exports = { draftReply, cleanQuote, draftRow, hasContent, MESSAGE_BREAK };
