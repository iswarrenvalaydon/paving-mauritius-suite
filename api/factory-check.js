// Daily breakdown follow-up, run by Vercel's scheduler (vercel.json "crons"):
// 05:00 UTC = 9:00 in Mauritius: ask whoever reported an unrepaired breakdown if it's fixed.
// 07:00 UTC = 11:00 in Mauritius: no answer → tell Iswarren.
// Each step happens at most once per breakdown per day, so an extra call changes nothing.
const { logEvent } = require("./_lib/common");
const { breakdownCheck } = require("./_lib/factory");
const { mauritiusHour } = require("./_lib/autosend");

module.exports = async function handler(req, res) {
  const q = String(req.query?.step || "");
  const step = q === "ask" || q === "alert" ? q : mauritiusHour() < 10 ? "ask" : "alert";
  try {
    const done = await breakdownCheck(step);
    if (done.length) await logEvent("breakdown_" + step, { done });
    return res.status(200).json({ ok: true, step, done: done.length });
  } catch (err) {
    await logEvent("breakdown_check_error", { message: String(err?.message || err) });
    return res.status(500).json({ error: "check failed" });
  }
};
