// Old missed calls that were never answered: find them, and send each caller the approved
// "missed_call" message once. Started by a person from Setup (preview first, then send).
const { db, getSetting, d360, logEvent } = require("./common");
const { TEMPLATES, storeOut } = require("./referrals");

const digits = (s) => String(s || "").replace(/\D/g, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function candidates() {
  const { data: calls } = await db().from("wa_messages").select("wa_id,sent_at,body").eq("type", "call")
    .order("sent_at", { ascending: true }).limit(5000);
  const last = new Map();
  for (const c of calls || []) last.set(c.wa_id, c); // latest call per number
  if (!last.size) return [];
  const [staff, ravin, owner, sm] = await Promise.all([getSetting("staff_numbers", []), getSetting("ravin_number", ""), getSetting("owner_number", ""), getSetting("sales_manager_number", "")]);
  const skip = new Set([...(Array.isArray(staff) ? staff : []), ravin, owner, sm, "23057254201"].map(digits).filter(Boolean));
  const out = [];
  for (const [waId, call] of last) {
    if (skip.has(waId)) continue;
    const [{ data: contact }, { data: later }] = await Promise.all([
      db().from("wa_contacts").select("name,profile_name,is_staff").eq("wa_id", waId).maybeSingle(),
      // anything written to or by this person after the call (an answer, a template, or their own message)
      db().from("wa_messages").select("id").eq("wa_id", waId).neq("type", "call").gt("sent_at", call.sent_at).limit(1),
    ]);
    if (contact?.is_staff || contact?.name) continue; // saved contacts (e.g. lorry drivers) are skipped, as for live calls
    if (later && later.length) continue; // already answered, or they wrote themselves
    out.push({ wa_id: waId, name: contact?.profile_name || "", called_at: call.sent_at, kind: /WhatsApp/i.test(call.body || "") ? "WhatsApp" : "phone" });
  }
  return out.sort((a, b) => new Date(a.called_at) - new Date(b.called_at));
}

async function sendBacklog(limit = 20) {
  const all = await candidates();
  const batch = all.slice(0, limit);
  const t = TEMPLATES.missed;
  const sent = [];
  const failed = [];
  for (const c of batch) {
    try {
      const data = await d360("/messages", {
        method: "POST",
        body: { messaging_product: "whatsapp", recipient_type: "individual", to: c.wa_id, type: "template", template: { name: t.name, language: { code: "en" } } },
      });
      const id = data?.messages?.[0]?.id || `local-${Date.now()}-${c.wa_id}`;
      await storeOut(c.wa_id, id, "template", t.body);
      const now = new Date().toISOString();
      await db().from("wa_contacts").update({ last_message_at: now }).eq("wa_id", c.wa_id);
      // the waiting suggestion for this caller is now done
      await db().from("wa_drafts").update({ status: "sent", body: t.body, decided_at: now }).eq("wa_id", c.wa_id).eq("status", "pending").eq("quote->>template", "missed_call");
      sent.push(c.wa_id);
    } catch (err) {
      failed.push({ wa_id: c.wa_id, error: String(err?.message || err).slice(0, 160) });
    }
    await sleep(1200);
  }
  await logEvent("missed_backlog_sent", { sent: sent.length, failed: failed.length });
  return { sent: sent.length, failed, remaining: Math.max(0, all.length - batch.length) + failed.length };
}

module.exports = { candidates, sendBacklog };
