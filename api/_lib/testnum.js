// Test numbers (setting "test_numbers", default: 5738 7118). Each time one of them sends
// "this is a test msg" or leaves a missed call, the bot forgets everything about it and starts fresh,
// so the same phone can be used to try the first-contact flow again and again.
const { db, getSetting, setSetting, logEvent } = require("./common");

const digits = (s) => String(s || "").replace(/\D/g, "");
const DEFAULT = ["23057387118"];
const PHRASE = /this is a test msg/i;

async function testNumbers() {
  const list = await getSetting("test_numbers", DEFAULT);
  const arr = Array.isArray(list) && list.length ? list : DEFAULT;
  return arr.map(digits).map((d) => (d.length === 8 ? `230${d}` : d)).filter(Boolean);
}
async function isTestNumber(waId) { return (await testNumbers()).includes(digits(waId)); }

async function dropKey(setting, waId) {
  const m = await getSetting(setting, {});
  if (m && typeof m === "object" && !Array.isArray(m) && waId in m) { delete m[waId]; await setSetting(setting, m); }
}

async function resetTestChat(waId) {
  await db().from("wa_messages").delete().eq("wa_id", waId);
  await db().from("wa_drafts").delete().eq("wa_id", waId);
  await db().from("wa_contacts").update({ name: null, unread: 0, bot_paused: false, last_inbound_at: null, last_message_at: null }).eq("wa_id", waId);
  for (const s of ["client_ads", "quote_totals", "payments", "sales_handovers", "contact_orders"]) await dropKey(s, waId);
  const refs = await getSetting("referrals", []);
  if (Array.isArray(refs) && refs.some((r) => digits(r?.wa_id) === waId)) await setSetting("referrals", refs.filter((r) => digits(r?.wa_id) !== waId));
  await logEvent("test_reset", { wa_id: waId });
}

module.exports = { testNumbers, isTestNumber, resetTestChat, PHRASE };
