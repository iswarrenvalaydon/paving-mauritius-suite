// Price list used to check the bot's quotations (prices per piece, VAT included).
// Pieces are worked out here from the area, so quantities never depend on the bot's arithmetic.
const PRODUCTS = [
  { key: "200x100x60", perM2: 50, lightGrey: 13.50, colours: 16.50 },
  { key: "200x100x80", perM2: 50, lightGrey: 16.50, colours: null },
  { key: "200x100x100", perM2: 50, lightGrey: 17.60, colours: 18.98 },
  { key: "140x140x60", perM2: 52, lightGrey: 13.50, colours: 16.50 },
  { key: "300x300", perM2: 11.25, lightGrey: 80.01, colours: 100.05, slab: [0.3, 0.3] },
  { key: "600x300", perM2: 5.75, lightGrey: 145.00, colours: 180.00, slab: [0.6, 0.3] },
  { key: "450x450", perM2: 5, lightGrey: 180.00, colours: 218.50, slab: [0.45, 0.45] },
  { key: "400x400", perM2: 6.25, lightGrey: 120.00, colours: null, slab: [0.4, 0.4] }, // Evergreen
  { key: "450x200x125", perM2: null, lightGrey: 150.00, colours: null }, // kerb, priced per piece
];
const SQFT_TO_M2 = 0.09290304;

function findProduct(desc) {
  const d = String(desc || "").toLowerCase().replace(/\s+/g, "").replace(/[×*]/g, "x");
  // Longest key first, so "450x200x125" wins over "450x450" checks etc.
  return [...PRODUCTS].sort((a, b) => b.key.length - a.key.length).find((p) => d.includes(p.key)) || null;
}

function colourOf(desc) {
  const d = String(desc || "").toLowerCase();
  if (/light\s*grey|gris\s*(clair|pale|pâle)|classic/.test(d)) return "light";
  if (/dark\s*grey|gris\s*fonc|red|rouge|terracotta|terracota/.test(d)) return "colour";
  return null;
}

// Returns a corrected line: list price for the product and colour, and pieces from the area when given.
function checkLine(line) {
  const p = findProduct(line.desc);
  if (!p) return line;
  const out = { ...line };
  const colour = colourOf(line.desc);
  const contractor = /contract/i.test(line.desc);
  if (!contractor) {
    if (colour === "light") out.unit_price_incl_vat = p.lightGrey;
    else if (colour === "colour" && p.colours) out.unit_price_incl_vat = p.colours;
  }
  const area = Number(line.area_m2) > 0 ? Number(line.area_m2) : Number(line.area_sqft) > 0 ? Number(line.area_sqft) * SQFT_TO_M2 : 0;
  const gap = Number(line.gap_cm) > 0 ? Number(line.gap_cm) / 100 : 0; // metres
  if (area > 0 && p.perM2) {
    let perM2 = p.perM2;
    // Slabs laid with a gap: each slab covers its size plus the gap on two sides.
    if (gap > 0 && p.slab) perM2 = 1 / ((p.slab[0] + gap) * (p.slab[1] + gap));
    out.qty = Math.ceil(Math.round(area * perM2 * 1000) / 1000);
    out.area_m2 = Math.round(area * 100) / 100;
  }
  return out;
}

module.exports = { PRODUCTS, checkLine, SQFT_TO_M2 };
