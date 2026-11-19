// Writes a suggested WhatsApp reply with Claude. Nothing is sent from here:
// the draft waits in the Suite until Iswarren or JL approves it.
const { db, getSetting, fmtTime, downloadMedia } = require("./common");
const { RULEBOOK } = require("./rulebook");

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

function systemPrompt(rulebook, contact, examples) {
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
1. Facebook ad: a message starting with [From Facebook ad: ...] or [From Facebook post: ...] means the client tapped our ad (the text in quotes is the ad; "Hello! Can I get more info on this?" is Facebook's automatic text). First reply, as two short messages: thank them for their interest in the advertised product (name only that product), then "Do you know your measurements? I can give you a quotation." No price list, no colour list, no other sizes. If the ad text is missing, ask briefly whether they want pavers or slabs, then the measurements question.
2. Measurements or a sketch: first message = the area you read (ask them to confirm if it came from a sketch) and the number of pieces. If the colour isn't known yet, the second message is just "Which colour would you like?" (don't list colours or prices; let them ask).
3. Once product, size, colour and area are known: first message = number of pieces and the estimated total, VAT included. Second message = "Would you like a formal quotation?"
4. Only when the client says yes, or asks for a quotation themselves, prepare "quote" (see below).

Attachments from the client (photos and PDFs) come after the conversation, labelled to match it (for example [Photo 1]):
- Sketches and plans: read every measurement, split the shape into rectangles, add them up, and ask the client to confirm your reading. If a side is missing or unreadable, ask for it.
- Site photos: use them to understand the job, but never estimate an area from a photo alone; ask for measurements.
- Payment proofs: put the amount, date, bank and reference in team_note and set needs_team. Never tell the client the payment is confirmed; just thank them and say the team will check it.
- If an attachment could not be loaded, say so in team_note.

Quotations ("quote"):
- quote.caption is the ONE short line sent with the PDF, in the client's language, e.g. "Here is your quotation.", "Voici votre devis.", "Ala ou quotation." Nothing more. When you include a quote, leave "messages" empty.
- Quantity in pieces = area in m² × pieces per m², rounded up to a whole piece. For two-colour or framed designs, follow the rulebook.
- unit_price_incl_vat is the list price per piece from the rulebook, VAT included. Never apply a discount.
- client_name: the client's name if known, otherwise their WhatsApp name. location: town or site address if known.
- summary: one line for the team, e.g. "20 m² driveway, pavers 60 mm, Light Grey".

Price list: when the client asks for the price list, set "attach" to "price_list" and send one short line such as "Here is our price list." The PDF goes with it.
${examplesText(examples)}
Current time in Mauritius: ${now}.
Client: ${contact?.name || contact?.profile_name || "unknown"} (+${contact?.wa_id || ""}).

Reply with ONLY a JSON object, no other text:
{"messages": ["<short message>", "<short message>"], "needs_team": true|false, "team_note": "<short note or empty>", "attach": null | "price_list",
 "quote": null | {"client_name": "", "location": "", "summary": "", "caption": "Here is your quotation.", "items": [{"desc": "Pavers 200x100x60mm – Light Grey", "qty": 1000, "unit_price_incl_vat": 13.5}]}}`;
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

  const [rulebook, examples] = await Promise.all([getSetting("rulebook", RULEBOOK), getSetting("examples", [])]);
  const { labels, blocks } = await mediaBlocks(messages);
  const content = [
    { type: "text", text: `Conversation so far (oldest first):\n${transcript(messages, labels)}` },
    ...(blocks.length ? [{ type: "text", text: "Attachments from the client:" }, ...blocks] : []),
    { type: "text", text: "Write the JSON for our next message." },
  ];
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      system: systemPrompt(typeof rulebook === "string" ? rulebook : RULEBOOK, contact, examples),
      messages: [{ role: "user", content }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Claude: ${data?.error?.message || res.status}`);
  const text = (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
  const parsed = parseJson(text);
  if (!parsed) return { reply: text.trim(), needs_team: true, team_note: "The bot's answer was not in the expected format; please check it.", quote: null, attach: null };
  const quote = cleanQuote(parsed.quote);
  const parts = (Array.isArray(parsed.messages) ? parsed.messages : [parsed.reply])
    .map((m) => String(m || "").replace(/\n-{3,}\n/g, "\n").trim())
    .filter(Boolean)
    .slice(0, 3);
  return {
    reply: quote ? "" : parts.join(MESSAGE_BREAK),
    needs_team: Boolean(parsed.needs_team),
    team_note: String(parsed.team_note || "").trim(),
    quote,
    attach: parsed.attach === "price_list" ? "price_list" : null,
  };
}

// Builds the row saved in wa_drafts. Extras (quotation, attachment) live in the "quote" column.
function draftRow(waId, replyTo, draft) {
  const extras = draft.quote ? { ...draft.quote } : {};
  if (draft.attach) extras.attach = draft.attach;
  return {
    wa_id: waId, reply_to: replyTo || null, body: draft.reply || "", needs_team: draft.needs_team,
    team_note: draft.team_note || null, ...(Object.keys(extras).length ? { quote: extras } : {}),
  };
}

function hasContent(draft) {
  return Boolean(draft && (draft.reply || draft.needs_team || draft.quote || draft.attach));
}

// Keep only sensible quotation lines; the team can still edit everything before sending.
function cleanQuote(q) {
  if (!q || typeof q !== "object" || !Array.isArray(q.items)) return null;
  const items = q.items
    .map((i) => ({
      desc: String(i?.desc || "").slice(0, 120).trim(),
      qty: Math.max(0, Math.ceil(Number(i?.qty) || 0)),
      unit_price_incl_vat: Math.max(0, Number(i?.unit_price_incl_vat) || 0),
    }))
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
