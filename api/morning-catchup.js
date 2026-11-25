// 7:00 in Mauritius (03:00 UTC, see vercel.json "crons"): answer what arrived overnight.
// Nothing is sent between 23:00 and 07:00, so at 7:00 the bot goes through the night:
//  1. suggestions held for the night (and missed-call messages) are sent, if nothing else needs a person;
//  2. clients whose last message is still unanswered and have no suggestion get one written and sent.
// Quotations, estimates, payment proof, etc. still wait for the team (same hold rules as any reply).
// Only runs when automatic sending is switched on. Safe to call twice: sent items are no longer pending.
const { db, getSetting, insertDraft, logEvent } = require("./_lib/common");
const { autoSettings, autoSend, mauritiusHour } = require("./_lib/autosend");
const { draftReply, draftRow, hasContent } = require("./_lib/drafter");

const LOOKBACK_MS = 14 * 3600 * 1000; // 17:00 the evening before is plenty: chat hours end at 23:00

async function catchUp() {
  const cfg = await autoSettings();
  if (!cfg.enabled) return { skipped: "automatic sending is off" };
  const h = mauritiusHour();
  if (h < 7 || h >= 23) return { skipped: "still night" };
  if ((await getSetting("bot_enabled", true)) === false) return { skipped: "bot is switched off" };

  const since = new Date(Date.now() - LOOKBACK_MS).toISOString();
  const { send } = require("./wa-admin").internals;
  const staffNums = new Set((await getSetting("staff_numbers", [])).map((n) => String(n).replace(/\D/g, "")));
  const out = { sent: 0, held: 0, written: 0, errors: 0 };

  const eligible = async (waId) => {
    if (staffNums.has(waId)) return false;
    const { data: c } = await db().from("wa_contacts").select("bot_paused,is_staff").eq("wa_id", waId).maybeSingle();
    return !(c?.bot_paused || c?.is_staff);
  };

  // 1. Suggestions waiting from the night.
  const { data: pending } = await db().from("wa_drafts").select("*").eq("status", "pending").gte("created_at", since).order("created_at", { ascending: true }).limit(100);
  const seen = new Set();
  for (const d of pending || []) {
    seen.add(d.wa_id);
    if (!(await eligible(d.wa_id))) continue;
    try {
      if (d.quote?.template === "missed_call") {
        const { MISSED_TEXT } = require("./missed-call");
        await send(d.wa_id, MISSED_TEXT, d.id);
        out.sent += 1;
        continue;
      }
      const r = await autoSend(d.wa_id, d);
      if (r?.sent) out.sent += 1; else if (r?.held) out.held += 1; else if (r?.error) out.errors += 1;
    } catch (err) {
      out.errors += 1;
      await logEvent("morning_catchup_error", { wa_id: d.wa_id, message: String(err?.message || err).slice(0, 300) });
    }
  }

  // 2. Clients still waiting for an answer, with no suggestion at all.
  const { data: recent } = await db().from("wa_messages").select("id,wa_id,direction,type,sent_at").gte("sent_at", since).order("sent_at", { ascending: false }).limit(1000);
  const lastBy = new Map();
  for (const m of recent || []) if (!lastBy.has(m.wa_id)) lastBy.set(m.wa_id, m); // newest per client
  for (const [waId, m] of lastBy) {
    if (seen.has(waId) || m.direction !== "in" || m.type === "call" || m.type === "reaction") continue;
    if (!(await eligible(waId))) continue;
    const { data: waiting } = await db().from("wa_drafts").select("id").eq("wa_id", waId).eq("status", "pending").limit(1);
    if (waiting && waiting.length) continue;
    try {
      const draft = await draftReply(waId);
      if (!draft || !hasContent(draft)) continue;
      const row = await insertDraft(draftRow(waId, m.id, draft));
      out.written += 1;
      const r = await autoSend(waId, row);
      if (r?.sent) out.sent += 1; else if (r?.held) out.held += 1; else if (r?.error) out.errors += 1;
    } catch (err) {
      out.errors += 1;
      await logEvent("morning_catchup_error", { wa_id: waId, message: String(err?.message || err).slice(0, 300) });
    }
  }
  return out;
}

module.exports = async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers?.authorization !== `Bearer ${secret}`) return res.status(401).json({ error: "no" });
  try {
    const out = await catchUp();
    await logEvent("morning_catchup", out);
    return res.status(200).json({ ok: true, ...out });
  } catch (err) {
    await logEvent("morning_catchup_error", { message: String(err?.message || err).slice(0, 300) });
    return res.status(500).json({ error: "catch-up failed" });
  }
};
module.exports.catchUp = catchUp;
