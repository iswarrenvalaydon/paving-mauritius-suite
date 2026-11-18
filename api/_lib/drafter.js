// Writes a suggested WhatsApp reply with Claude. Nothing is sent from here:
// the draft waits in the Suite until Iswarren or JL approves it.
const { db, getSetting, fmtTime } = require("./common");
const { RULEBOOK } = require("./rulebook");

const MODEL = process.env.BOT_MODEL || "claude-sonnet-5-5";
const HISTORY_LIMIT = 40;

function systemPrompt(rulebook, contact) {
  const now = fmtTime(new Date().toISOString());
  return `You are the WhatsApp assistant of Paving Mauritius Ltd, writing replies to clients on the business number 5725 4201.
Every reply you write is a DRAFT: a team member reads it and approves, edits or discards it before the client sees anything.

Follow this rulebook exactly:
<rulebook>
${rulebook}
</rulebook>

How to answer:
- Write the next message to send to the client, in the client's language (English, French or Mauritian Creole), short like a real WhatsApp message. No markdown, no headings; plain text only. Simple line breaks are fine.
- Speak as "we". Never name JL, Julien or Iswarren. Never say you are waiting for approval.
- When a client gives measurements, show the area and quantities clearly so the team can check them. For a price, give quantities, unit price before VAT, VAT 15% and total, then say a formal quotation will follow.
- If the client's last messages need nothing more (for example "ok merci"), return an empty reply.
- Set needs_team to true whenever the rulebook says to hand over or check with the team, or when you are unsure. Explain why in team_note (in English, one or two short lines, for the team only).
- Never invent prices, dates, stock or facts that are not in the rulebook or the conversation.
- Messages in the conversation marked [team] were sent by our staff; treat them as our own replies and stay consistent with them.

Current time in Mauritius: ${now}.
Client: ${contact?.name || contact?.profile_name || "unknown"} (+${contact?.wa_id || ""}).

Reply with ONLY a JSON object, no other text:
{"reply": "<message to send, or empty>", "needs_team": true|false, "team_note": "<short note or empty>"}`;
}

function transcript(messages) {
  return messages
    .map((m) => {
      const who = m.direction === "in" ? "Client" : "Paving Mauritius [team]";
      return `[${fmtTime(m.sent_at)}] ${who}: ${m.body || `[${m.type || "message"}]`}`;
    })
    .join("\n");
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
    db().from("wa_messages").select("direction,type,body,sent_at").eq("wa_id", waId).order("sent_at", { ascending: false }).limit(HISTORY_LIMIT),
  ]);
  const messages = (recent || []).reverse();
  if (!messages.length) return null;

  const rulebook = await getSetting("rulebook", RULEBOOK);
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1200,
      system: systemPrompt(typeof rulebook === "string" ? rulebook : RULEBOOK, contact),
      messages: [{ role: "user", content: `Conversation so far (oldest first):\n${transcript(messages)}\n\nWrite the JSON for our next message.` }],
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
  };
}

module.exports = { draftReply };
