// Writes a suggested WhatsApp reply with Claude. Nothing is sent from here:
// the draft waits in the Suite until Iswarren or JL approves it.
const { db, getSetting, fmtTime, downloadMedia } = require("./common");
const { RULEBOOK } = require("./rulebook");

const MODEL = process.env.BOT_MODEL || "claude-sonnet-5-5";
const HISTORY_LIMIT = 40;
const MAX_MEDIA = 4; // newest photos / PDFs from the client that Claude looks at
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

function systemPrompt(rulebook, contact) {
  const now = fmtTime(new Date().toISOString());
  return `You are the WhatsApp assistant of Paving Mauritius Ltd, writing replies to clients on the business number 5725 4201.
Every reply you write is a DRAFT: a team member reads it and approves, edits or discards it before the client sees anything.

Follow this rulebook exactly:
<rulebook>
${rulebook}
</rulebook>

How to answer:
- Write the next message to send to the client, in the client's language (English, French or Mauritian Creole). Keep it SHORT, like a real WhatsApp message from a busy salesperson: usually one to three sentences, one question at a time. Only a price breakdown may be longer. No markdown, no headings; plain text only.
- Never promise to come back to the client "in a few minutes", "shortly" or at a set time. If something needs the team, set needs_team and explain in team_note; in the reply, answer what you can or ask the next useful question. (Only exceptions: the rulebook's own phrases "we'll confirm the final delivery price" and, for delay updates, "I'm checking with the team and will confirm today".)
- A message starting with [From Facebook ad: ...] or [From Facebook post: ...] means the client tapped one of our ads; the text in quotes is the ad. Answer about that product straight away (price per piece and per m², colours) and ask for the area. Don't ask which product they mean if the ad makes it clear. If the ad text is missing, ask briefly whether they want pavers or slabs and the area.
- Speak as "we". Never name JL, Julien or Iswarren. Never say you are waiting for approval.
- When a client gives measurements, show the area and quantities clearly so the team can check them. For a price, give quantities, unit price before VAT, VAT 15% and total, then say a formal quotation will follow.
- If the client's last messages need nothing more (for example "ok merci"), return an empty reply.
- Set needs_team to true whenever the rulebook says to hand over or check with the team, or when you are unsure. Explain why in team_note (in English, one or two short lines, for the team only).
- Never invent prices, dates, stock or facts that are not in the rulebook or the conversation.
- Photos and PDFs the client sent are attached after the conversation, labelled to match it (for example [Photo 1]). Use them:
  - Sketches and plans: read every measurement, split the shape into rectangles, give the area, and ask the client to confirm your reading. If a side is missing or unreadable, ask for it.
  - Site photos: use them to understand the job, but never estimate an area from a photo alone; ask for measurements.
  - Payment proofs: put the amount, date, bank and reference in team_note and set needs_team. Never tell the client the payment is confirmed; just thank them and say the team will check it.
  - If an attachment could not be loaded, say so in team_note.
- Messages in the conversation marked [team] were sent by our staff; treat them as our own replies and stay consistent with them.

Current time in Mauritius: ${now}.
Client: ${contact?.name || contact?.profile_name || "unknown"} (+${contact?.wa_id || ""}).

Quotations:
- When you know the product, size, colour and the quantity (from measurements the client has confirmed), prepare a formal quotation in "quote". The team checks it and sends it as a PDF, with your "reply" as the message that goes with the PDF (for example "Here is your quotation for your driveway. Let me know if you have any questions.").
- Quantity in pieces = area in m² × pieces per m², rounded up to a whole piece. For two-colour or framed designs, follow the rulebook.
- unit_price_incl_vat is the list price per piece from the rulebook, VAT included. Never apply a discount.
- client_name: the client's name if known, otherwise their WhatsApp name. location: town or site address if known.
- summary: one line for the team, e.g. "20 m² driveway, pavers 60 mm, Light Grey".
- If you don't have enough information yet, set "quote" to null and ask for what is missing.

Reply with ONLY a JSON object, no other text:
{"reply": "<message to send, or empty>", "needs_team": true|false, "team_note": "<short note or empty>",
 "quote": null | {"client_name": "", "location": "", "summary": "", "items": [{"desc": "Pavers 200x100x60mm – Light Grey", "qty": 1000, "unit_price_incl_vat": 13.5}]}}`;
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

  const rulebook = await getSetting("rulebook", RULEBOOK);
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
      system: systemPrompt(typeof rulebook === "string" ? rulebook : RULEBOOK, contact),
      messages: [{ role: "user", content }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Claude: ${data?.error?.message || res.status}`);
  const text = (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
  const parsed = parseJson(text);
  if (!parsed) return { reply: text.trim(), needs_team: true, team_note: "The bot's answer was not in the expected format; please check it." };
  return {
    reply: String(parsed.reply || "").trim(),
    needs_team: Boolean(parsed.needs_team),
    team_note: String(parsed.team_note || "").trim(),
    quote: cleanQuote(parsed.quote),
  };
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
    items,
  };
}

module.exports = { draftReply, cleanQuote };
