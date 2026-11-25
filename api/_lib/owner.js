// The owner's own channel: only Iswarren (his login in the Suite, his number on WhatsApp) can use it.
//  - "contact 5762 9412 [in French] [send quotation for ...]": the bot opens the chat with the Sales Manager template.
//  - voice notes from his number are turned into text (OpenAI), shown back to him, and run after he says yes.
const { db, getSetting, setSetting, d360, sendText, downloadMedia, logEvent } = require("./common");
const { TEMPLATES, storeOut, prettyNumber } = require("./referrals");

const digits = (s) => String(s || "").replace(/\D/g, "");

// ---- Who is the owner ----
// Setting "owner_emails": once someone has made themselves owner in Setup, only those logins may use Setup.
// Until then Setup stays open to every login (so nobody is locked out by mistake).
async function ownerState() {
  const list = await getSetting("owner_emails", []);
  const emails = Array.isArray(list) ? list.map((e) => String(e).toLowerCase()) : [];
  return { emails, set: emails.length > 0 };
}
async function isOwnerEmail(email) {
  const o = await ownerState();
  return !o.set || o.emails.includes(String(email || "").toLowerCase());
}

function localNumber(raw) {
  let d = digits(raw);
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length === 8) d = `230${d}`;
  return d.length >= 10 && d.length <= 15 ? d : "";
}

// ---- Speech to text ----
const EXT = { "audio/ogg": "ogg", "audio/opus": "ogg", "audio/mp4": "m4a", "audio/m4a": "m4a", "audio/x-m4a": "m4a", "audio/aac": "m4a", "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/webm": "webm", "video/mp4": "m4a" };
async function transcribe(base64, mime) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set in Vercel yet");
  const buf = Buffer.from(String(base64 || ""), "base64");
  if (buf.length < 500) throw new Error("The recording is empty");
  const type = String(mime || "audio/ogg").split(";")[0].trim().toLowerCase();
  const form = new FormData();
  form.append("file", new Blob([buf], { type }), `voice.${EXT[type] || "ogg"}`);
  form.append("model", process.env.STT_MODEL || "gpt-4o-transcribe");
  form.append("prompt", "A business owner in Mauritius speaking English, French or Mauritian Creole, often mixed. Words: Paving Mauritius, pavers, slabs, quotation, devis, contact, Sales Manager, 600x300, 300x300, 450x450, Light Grey, Dark Grey, Rs, m2.");
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Speech service: ${data?.error?.message || res.status}`);
  return String(data.text || "").trim();
}

// ---- Understanding a command (typed or spoken, English / French / rough Creole) ----
const FAST = /^\s*(?:please\s+)?contact(?:e|ez)?\s+((?:\+?\d[\d\s().-]{6,}))\s*(.*)$/i;
async function parseCommand(text) {
  const t = String(text || "").trim();
  if (!t) return { action: "none" };
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set in Vercel");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: process.env.BOT_MODEL || "claude-sonnet-5-5", max_tokens: 400,
      system: `You read one instruction from the owner of Paving Mauritius Ltd to his WhatsApp bot. It may be typed or transcribed from speech (English, French, rough Mauritian Creole, so numbers and words may be slightly wrong).
The only command is "contact": open a chat with a client. Examples: "contact 5762 9412", "contact 5762 9412 in French", "contact 57629412 and send a quotation for 20 m² of 600x300 Light Grey", "contacte le 5762 9412 en français, devis 30 m2 pavés".
Reply with JSON only: {"action":"contact"|"none","number":"the phone number digits as given, no spaces","lang":"fr" if he asks for French or the message itself is in French, else "en","note":"what the bot should prepare for the client after they reply, short, in English, e.g. quotation for 20 m2 of 600x300 Light Grey; empty string if nothing was asked"}.
If it is not a request to contact someone, or the number is missing, reply {"action":"none"}.`,
      messages: [{ role: "user", content: t }],
    }),
  });
  const data = await res.json().catch(() => ({}));
  const out = String((data.content || []).map((b) => b.text || "").join("")).replace(/```json|```/g, "").trim();
  try {
    const j = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
    if (j.action !== "contact") return { action: "none" };
    const number = localNumber(j.number);
    if (!number) return { action: "none", problem: "number" };
    return { action: "contact", number, lang: j.lang === "fr" ? "fr" : "en", note: String(j.note || "").slice(0, 300) };
  } catch {
    const m = FAST.exec(t);
    if (!m) return { action: "none" };
    const number = localNumber(m[1]);
    return number ? { action: "contact", number, lang: /fran[cç]ais|french|\bfr\b/i.test(m[2]) ? "fr" : "en", note: "" } : { action: "none" };
  }
}

// ---- Contacting a client with the Sales Manager message ----
async function contactClient({ number, lang, note, by }) {
  const waId = localNumber(number);
  if (!waId) throw new Error("That number doesn't look right");
  const [staff, ownerNum] = await Promise.all([getSetting("staff_numbers", []), getSetting("owner_number", "23057396517")]);
  if ((Array.isArray(staff) ? staff : []).map(digits).includes(waId) || digits(ownerNum) === waId) throw new Error("That's a team number, not a client");
  const t = lang === "fr" ? TEMPLATES.contactFr : TEMPLATES.contactEn;
  const { data: c } = await db().from("wa_contacts").select("wa_id,last_inbound_at").eq("wa_id", waId).maybeSingle();
  if (!c) await db().from("wa_contacts").insert({ wa_id: waId });
  const open = c?.last_inbound_at && Date.now() - new Date(c.last_inbound_at) < 23 * 3600 * 1000;
  let id = null;
  if (open) {
    id = await sendText(waId, t.body);
  } else {
    const data = await d360("/messages", {
      method: "POST",
      body: { messaging_product: "whatsapp", recipient_type: "individual", to: waId, type: "template", template: { name: t.name, language: { code: t.lang } } },
    });
    id = data?.messages?.[0]?.id || `local-${Date.now()}`;
  }
  await storeOut(waId, id, open ? "text" : "template", t.body);
  await db().from("wa_contacts").update({ last_message_at: new Date().toISOString() }).eq("wa_id", waId);
  if (note) {
    const orders = (await getSetting("contact_orders", {})) || {};
    orders[waId] = { note, at: new Date().toISOString(), by: by || "" };
    await setSetting("contact_orders", orders);
  }
  await logEvent("contact_client", { wa_id: waId, lang, note, by: by || "" });
  return { wa_id: waId, pretty: prettyNumber(waId), lang, note: note || "" };
}

// ---- The owner's WhatsApp messages (typed or voice) ----
const YES = /^\s*(yes|yep|yeah|ok|okay|go|oui|d'accord|dac|confirm|send it)\b/i;
const NO = /^\s*(no|non|cancel|stop|annule)\b/i;
const GATE = /(contact|contacte|devis|quotation)/i;

async function reply(waId, text) {
  const id = await sendText(waId, text);
  await storeOut(waId, id, "text", text);
}

function describe(cmd) {
  return `contact ${prettyNumber(cmd.number)} in ${cmd.lang === "fr" ? "French" : "English"}${cmd.note ? `, then prepare: ${cmd.note}` : ""}`;
}

async function handleOwnerMessage(waId, m) {
  try {
    const pending = await getSetting("owner_pending", null);
    const fresh = pending && pending.cmd && Date.now() - new Date(pending.at) < 10 * 60 * 1000;
    if (m.type === "text") {
      const text = String(m.text || "");
      if (fresh && YES.test(text)) {
        await setSetting("owner_pending", null);
        const r = await contactClient({ ...pending.cmd, by: "owner (WhatsApp)" });
        return reply(waId, `✅ Done: ${prettyNumber(r.wa_id)} has our first message${r.lang === "fr" ? " (French)" : ""}.${r.note ? ` I'll prepare "${r.note}" when they reply; quotations wait for your approval.` : ""}`);
      }
      if (fresh && NO.test(text)) { await setSetting("owner_pending", null); return reply(waId, "Cancelled."); }
      if (!GATE.test(text)) return null;
      const cmd = await parseCommand(text);
      if (cmd.action !== "contact") return cmd.problem === "number" ? reply(waId, "I couldn't read the number. Please check it and send the command again.") : null;
      const r = await contactClient({ ...cmd, by: "owner (WhatsApp)" });
      return reply(waId, `✅ Done: ${prettyNumber(r.wa_id)} has our first message${r.lang === "fr" ? " (French)" : ""}.${r.note ? ` I'll prepare "${r.note}" when they reply; quotations wait for your approval.` : ""}`);
    }
    if (m.type === "audio" && m.mediaId) {
      let heard = "";
      try {
        const media = await downloadMedia(m.mediaId);
        heard = await transcribe(media.base64, media.mime);
      } catch (err) {
        const msg = String(err?.message || err);
        await logEvent("voice_error", { message: msg.slice(0, 300) });
        return reply(waId, /OPENAI_API_KEY/.test(msg) ? "🎙️ Voice commands aren't switched on yet: the speech key still needs adding in Vercel." : "🎙️ I couldn't understand that voice note. Please try again or type it.");
      }
      if (fresh && YES.test(heard)) { // "yes" can be spoken too
        await setSetting("owner_pending", null);
        const r = await contactClient({ ...pending.cmd, by: "owner (voice)" });
        return reply(waId, `✅ Done: ${prettyNumber(r.wa_id)} has our first message.`);
      }
      const cmd = await parseCommand(heard);
      if (cmd.action !== "contact") return reply(waId, `🎙️ I heard: "${heard.slice(0, 400)}"\nI didn't find a command in it. Try: "contact 5762 9412".`);
      await setSetting("owner_pending", { cmd, at: new Date().toISOString(), heard });
      return reply(waId, `🎙️ I heard: "${heard.slice(0, 400)}"\nI will ${describe(cmd)}.\nReply YES to go ahead, or NO.`);
    }
  } catch (err) {
    await logEvent("owner_command_error", { message: String(err?.message || err).slice(0, 300) });
    try { await reply(waId, `⚠️ That didn't work: ${String(err?.message || err).slice(0, 200)}`); } catch { /* nothing more to do */ }
  }
  return null;
}

module.exports = { ownerState, isOwnerEmail, transcribe, parseCommand, contactClient, handleOwnerMessage, localNumber, describe };
