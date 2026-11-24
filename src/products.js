// Client price list from the bot rulebook. Prices per piece, VAT included.
// null = not available in that colour.
const RANGE = [
  { name: "Pavers 200x100x60mm",     perM2: 50,    lightGrey: 13.50,  colours: 16.50 },
  { name: "Pavers 200x100x80mm",     perM2: 50,    lightGrey: 16.50,  colours: null },
  { name: "Pavers 200x100x100mm",    perM2: 50,    lightGrey: 17.60,  colours: 18.98 },
  { name: "Cobbles 140x140x60mm",    perM2: 52,    lightGrey: 13.50,  colours: 16.50 },
  { name: "Slabs 300x300x60mm",      perM2: 11.25, lightGrey: 80.01,  colours: 100.00 },
  { name: "Slabs 600x300x60mm",      perM2: 5.75,  lightGrey: 145.00, colours: 180.00 },
  { name: "Slabs 450x450x60mm",      perM2: 5,     lightGrey: 180.00, colours: 218.50 },
  { name: "Evergreen 400x400x120mm", perM2: 6.25,  lightGrey: 120.00, colours: null },
];
const COLOURS = ["Dark Grey", "Red", "Terracotta"];

export const PRODUCT_OPTIONS = [
  ...RANGE.flatMap((p) => [
    { desc: `${p.name} – Light Grey`, price: p.lightGrey, perM2: p.perM2 },
    ...(p.colours === null ? [] : COLOURS.map((c) => ({ desc: `${p.name} – ${c}`, price: p.colours, perM2: p.perM2 }))),
  ]),
  { desc: "Kerb 450x200x125mm – Light Grey", price: 150.00, perM2: null },
];

export const VAT_RATE = 0.15;
