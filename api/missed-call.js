// Missed calls on the business phone. A small app on the phone (MacroDroid) opens this link
// when a call is missed; the Suite then prepares the "sorry we missed your call" WhatsApp
// message for the team to approve. Protected by a secret token in the link.
const { db, missedCallToken, safeEqual, getSetting, logEvent } = require("./_lib/common");

const digits = (s) => String(s || "").replace(/\D/g, "");

// Mauritian numbers come as 8 digits (5xxx xxxx) or with 230 / +230 in front.
function waIdOf(raw) {
  let d = digits(raw);
  // The number put in twice by mistake (e.g. "[call_number][call_number]"): keep one.
  if (d.length % 2 === 0 && d.length >= 16 && d.slice(0, d.length / 2) === d.slice(d.length / 2)) d = d.slice(0, d.length / 2);
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length === 8) d = `230${d}`;
  return d.length >= 10 && d.length <= 15 ? d : "";
}

const MISSED_TEXT = "Hello, this is Paving Mauritius Ltd. Sorry we missed your call! How can we help you? You can reply here on WhatsApp.";

async function handleMissedCall({ number, kind, name }) {
  const waId = waIdOf(number);
  if (!waId) return { skipped: "no number (private or saved contact)" };
  const [staff, ravin] = await Promise.all([getSetting("staff_numbers", []), getSetting("ravin_number", "")]);
  const own = "23057254201";
  if (waId === own || (Array.isArray(staff) && staff.map(digits).includes(waId)) || digits(ravin) === waId) return { skipped: "staff" };

  const { data: contact } = await db().from("wa_contacts").select("*").eq("wa_id", waId).maybeSingle();
  if (contact?.is_staff) return { skipped: "staff" };
  if (contact?.name) return { skipped: "saved contact" }; // saved on the business phone (e.g. lorry drivers)

  const now = new Date();
  const label = kind === "whatsapp" ? "📞 Missed WhatsApp call" : "📞 Missed phone call";
  // The phone sometimes reports the same missed call twice: ignore repeats within 3 minutes.
  const { data: recentCall } = await db().from("wa_messages").select("id").eq("wa_id", waId).eq("type", "call")
    .gte("sent_at", new Date(now.getTime() - 3 * 60 * 1000).toISOString()).limit(1);
  if (recentCall && recentCall.length) return { skipped: "same call reported twice" };
  if (!contact) await db().from("wa_contacts").insert({ wa_id: waId, profile_name: String(name || "").trim() || null });
  await db().from("wa_messages").upsert({
    id: `call-${waId}-${now.getTime()}`, wa_id: waId, direction: "in", source: "client", type: "call",
    body: `[${label}]`, sent_at: now.toISOString(),
  }, { onConflict: "id", ignoreDuplicates: true });
  await db().from("wa_contacts").update({ last_message_at: now.toISOString(), unread: (contact?.unread || 0) + 1 }).eq("wa_id", waId);

  // One suggestion per caller: if one is already waiting, leave it.
  const { data: pending } = await db().from("wa_drafts").select("id").eq("wa_id", waId).eq("status", "pending").limit(1);
  if (pending && pending.length) return { ok: true, wa_id: waId, draft: "already waiting" };

  const recent = contact?.last_inbound_at && now - new Date(contact.last_inbound_at) < 23 * 3600 * 1000;
  const { data: draft } = await db().from("wa_drafts").insert({
    wa_id: waId, body: MISSED_TEXT, needs_team: false,
    team_note: `${label}. Approve to send the missed-call message${recent ? "" : " (sent as WhatsApp's approved message, so your edits aren't used)"}.`,
    quote: { template: "missed_call" },
  }).select().single();

  // With automatic sending on, the message goes out by itself (not at night: it waits for the morning team).
  const { autoSettings, mauritiusHour } = require("./_lib/autosend");
  const cfg = await autoSettings();
  const h = mauritiusHour(now);
  if (cfg.enabled && draft && h >= 7 && h < 23) {
    try {
      await require("./wa-admin").internals.send(waId, MISSED_TEXT, draft.id);
      await logEvent("auto_sent", { wa_id: waId, draft_id: draft.id, missed_call: true });
      return { ok: true, wa_id: waId, sent: true };
    } catch (err) {
      const msg = String(err?.message || err).slice(0, 300);
      await db().from("wa_drafts").update({ needs_team: true, team_note: `${label}. ⚠️ Automatic sending failed, please send it: ${msg}` }).eq("id", draft.id);
      await logEvent("auto_send_error", { wa_id: waId, draft_id: draft.id, message: msg });
    }
  }
  return { ok: true, wa_id: waId };
}

module.exports = async function handler(req, res) {
  const q = { ...(req.query || {}), ...(req.body && typeof req.body === "object" ? req.body : {}) };
  if (!safeEqual(q.token, missedCallToken())) return res.status(401).json({ error: "Wrong token" });
  try {
    const kind = String(q.kind || "phone").toLowerCase().startsWith("w") ? "whatsapp" : "phone";
    const out = await handleMissedCall({ number: q.number, kind, name: q.name });
    await logEvent("missed_call", { number: String(q.number || ""), kind, ...out });
    return res.json(out);
  } catch (err) {
    await logEvent("missed_call_error", { message: String(err?.message || err) });
    return res.status(500).json({ error: String(err?.message || err) });
  }
};
module.exports.MISSED_TEXT = MISSED_TEXT;
module.exports.waIdOf = waIdOf;
