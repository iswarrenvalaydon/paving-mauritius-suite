// Facebook ads the team has described to the bot.
// Each ad clients arrive from is remembered under a key; the team tells the bot once
// what the ad shows (e.g. "600x300 Light Grey + 300x300 Dark Grey design") and the bot
// uses that for every client from that ad.
const { getSetting, setSetting } = require("./common");

const clean = (t) => String(t || "").replace(/\s+/g, " ").trim();

// The text of an ad, as stored at the start of the client's message by the webhook.
function adText(r) {
  return [r.headline, r.body].filter(Boolean).map(clean).join(" – ").replace(/"/g, "'").slice(0, 300);
}

function adKey(r) {
  if (!r) return "";
  if (r.source_id) return `id:${clean(r.source_id)}`;
  if (r.source_url) return `url:${clean(r.source_url)}`;
  const t = adText(r);
  return t ? `text:${t.toLowerCase()}` : "";
}

// "[From Facebook ad: "text" https://… (ad 123)] " at the start of a stored message.
const MARK = /^\[From Facebook (ad|post)(?:: "([^"]*)")?(?: (https?:\/\/\S+?))?(?: \(ad ([^)]+)\))?\] /;

function adFromBody(body) {
  const m = MARK.exec(String(body || ""));
  if (!m) return null;
  const r = { source_type: m[1], headline: m[2] || "", source_url: m[3] || "", source_id: m[4] || "" };
  const key = adKey(r);
  return key ? { key, label: r.headline || r.source_url || "Facebook ad", url: r.source_url } : null;
}

// The ad the client most recently came from (messages oldest first).
function latestAd(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.direction !== "in") continue;
    const ad = adFromBody(m.body);
    if (ad) return ad;
  }
  return null;
}

async function getAds() {
  const ads = await getSetting("ads", {});
  return ads && typeof ads === "object" && !Array.isArray(ads) ? ads : {};
}

// Remember an ad clients arrive from (design stays empty until the team describes it).
async function noteAd(r) {
  const key = adKey(r);
  if (!key) return;
  const ads = await getAds();
  if (ads[key]) return;
  ads[key] = { label: adText(r) || clean(r.source_url) || "Facebook ad", url: clean(r.source_url), design: "", first_seen: new Date().toISOString() };
  await setSetting("ads", ads);
}

async function describeAd(key, design, extra = {}) {
  if (!key) throw new Error("Which ad?");
  const ads = await getAds();
  const prev = ads[key] || { label: clean(extra.label) || "Facebook ad", url: clean(extra.url), first_seen: new Date().toISOString() };
  ads[key] = { ...prev, design: clean(design).slice(0, 500), updated_at: new Date().toISOString() };
  await setSetting("ads", ads);
  return ads[key];
}

async function deleteAd(key) {
  const ads = await getAds();
  delete ads[key];
  await setSetting("ads", ads);
}

// What the bot is told about the client's ad.
function adPrompt(ad, info) {
  if (!ad) return "";
  if (info && info.design) {
    return `This client came from our Facebook ad "${ad.label}". The team says this ad shows: ${info.design}. That is what the client wants (product, sizes, colours, design) unless they say they want something else or send a photo of another of our products (then that product is what they want): when they send measurements, give the estimate for it straight away and never ask which slab, size or colour.`;
  }
  return `This client came from our Facebook ad "${ad.label}", but the team hasn't told you yet what this ad's picture shows. For a first reply, thank them and ask for their measurements as usual (name the product only as the ad text does). If they have already sent measurements, don't ask the client which slab, size or colour: give the area and set needs_team so the team can tell you what the ad shows.`;
}

module.exports = { adKey, adText, adFromBody, latestAd, getAds, noteAd, describeAd, deleteAd, adPrompt };
