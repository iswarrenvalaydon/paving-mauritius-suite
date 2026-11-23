// Product photos the team uploads in Setup, grouped in albums such as
// "Slabs 600x300x60mm – Light Grey". The bot attaches an album when a client asks to see a product.
// Files live in a public Supabase Storage bucket; the list of photos is kept in wa_settings.
const crypto = require("crypto");
const { db, getSetting, setSetting } = require("./common");

const BUCKET = "product-photos";
const MAX_PER_ALBUM = 3; // photos sent per album

const clean = (t) => String(t || "").replace(/\s+/g, " ").trim();
const slug = (t) => clean(t).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "album";

// Photos that ship with the Suite (in /public/photos), shown like uploaded ones; deleting one hides it.
const SEED = require("./photo-seed.json");
function siteUrl() {
  return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || "paving-mauritius-suite.vercel.app"}`;
}

async function uploadedPhotos() {
  const list = await getSetting("photos", []);
  return Array.isArray(list) ? list : [];
}

async function getPhotos() {
  const hidden = new Set(await getSetting("photos_hidden", []));
  const seed = SEED.filter((p) => !hidden.has(p.id)).map((p) => ({ id: p.id, album: p.album, url: `${siteUrl()}/photos/${p.file}`, builtin: true }));
  return [...seed, ...await uploadedPhotos()];
}

// Albums with their photo counts, in a stable order.
async function albums() {
  const counts = new Map();
  for (const p of await getPhotos()) counts.set(p.album, (counts.get(p.album) || 0) + 1);
  return [...counts.entries()].map(([album, count]) => ({ album, count })).sort((a, b) => a.album.localeCompare(b.album));
}

let bucketReady = false;
async function ensureBucket() {
  if (bucketReady) return;
  const { data } = await db().storage.getBucket(BUCKET);
  if (!data) {
    const { error } = await db().storage.createBucket(BUCKET, { public: true, fileSizeLimit: 5 * 1024 * 1024 });
    if (error && !/exists/i.test(error.message || "")) throw new Error(`Couldn't create the photo storage: ${error.message}`);
  }
  bucketReady = true;
}

async function addPhoto(album, base64, mime = "image/jpeg") {
  const name = clean(album).slice(0, 120);
  if (!name) throw new Error("Choose which product the photo is for");
  const raw = String(base64 || "").replace(/^data:[^,]*,/, "");
  const bytes = Buffer.from(raw, "base64");
  if (!bytes.length) throw new Error("The photo is empty");
  if (bytes.length > 5 * 1024 * 1024) throw new Error("The photo is too big (5 MB max)");
  await ensureBucket();
  const ext = /png/i.test(mime) ? "png" : "jpg";
  const path = `${slug(name)}/${Date.now()}-${crypto.randomBytes(3).toString("hex")}.${ext}`;
  const { error } = await db().storage.from(BUCKET).upload(path, bytes, { contentType: /png/i.test(mime) ? "image/png" : "image/jpeg", upsert: false });
  if (error) throw new Error(`Upload failed: ${error.message}`);
  const { data } = db().storage.from(BUCKET).getPublicUrl(path);
  const photo = { id: crypto.randomUUID(), album: name, path, url: data.publicUrl, added: new Date().toISOString() };
  const list = await uploadedPhotos();
  list.push(photo);
  await setSetting("photos", list);
  return photo;
}

async function deletePhoto(id) {
  if (String(id).startsWith("seed-")) {
    const hidden = await getSetting("photos_hidden", []);
    if (!hidden.includes(id)) await setSetting("photos_hidden", [...hidden, id]);
    return;
  }
  const list = await uploadedPhotos();
  const photo = list.find((p) => p.id === id);
  if (!photo) return;
  await db().storage.from(BUCKET).remove([photo.path]);
  await setSetting("photos", list.filter((p) => p.id !== id));
}

// The photos to send for an album (first ones uploaded first).
async function albumPhotos(album, max = MAX_PER_ALBUM) {
  return (await getPhotos()).filter((p) => p.album === album).slice(0, max);
}

// Keeps only album names that exist (the bot may misspell one slightly).
async function knownAlbums(names) {
  const all = (await albums()).map((a) => a.album);
  const norm = (t) => slug(t);
  const out = [];
  for (const n of Array.isArray(names) ? names : []) {
    const hit = all.find((a) => norm(a) === norm(n)) || all.find((a) => norm(a).includes(norm(n)) || norm(n).includes(norm(a)));
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out.slice(0, 2);
}

module.exports = { BUCKET, MAX_PER_ALBUM, getPhotos, albums, addPhoto, deletePhoto, albumPhotos, knownAlbums };
