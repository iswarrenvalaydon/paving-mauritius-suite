// Builds public/price-list.pdf for the WhatsApp bot (no 600x600; prices VAT included).
const fs=require('fs');
const { jsPDF } = require('/tmp/jspdf/dist/jspdf.umd.js');
const logo='data:image/png;base64,'+fs.readFileSync('/home/claude/paving-mauritius-suite/paving-logo.png').toString('base64');
const BLUE=[27,79,138], GREY=[102,102,102];
const rows=[
  ['Pavers 200x100x60mm',50,13.50,16.50],
  ['Pavers 200x100x80mm',50,16.50,null],
  ['Pavers 200x100x100mm',50,17.60,18.98],
  ['Cobbles 140x140x60mm',52,13.50,16.50],
  ['Slabs 300x300x60mm',11.25,80.01,100.05],
  ['Slabs 600x300x60mm',5.75,145.00,180.00],
  ['Slabs 450x450x60mm',5,180.00,218.50],
  ['Evergreen 400x400x120mm',6.25,120.00,null],
];
const f=n=>n.toLocaleString('en-MU',{minimumFractionDigits:2,maximumFractionDigits:2});
const doc=new jsPDF({unit:'mm',format:'a4'});
const W=210, L=15;
doc.addImage(logo,'PNG',L,12,26,26);
doc.setFont('helvetica','bold'); doc.setFontSize(18); doc.setTextColor(...BLUE);
doc.text('Paving Mauritius Ltd',46,22);
doc.setFont('helvetica','normal'); doc.setFontSize(10); doc.setTextColor(...GREY);
doc.text('Paving bricks, cobbles and slabs at factory prices',46,28);
doc.text('WhatsApp 5725 4201  ·  info@paving.mu  ·  paving.mu',46,33);
doc.setFont('helvetica','bold'); doc.setFontSize(14); doc.setTextColor(...BLUE);
doc.text('Price list',L,50);
doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(...GREY);
doc.text('All prices in Rs, VAT 15% included.',L,55);
// table
let y=63; const cols=[L,74,105,135,162]; const heads=['Product','Pieces per sq m','Light Grey','Colours*','Light Grey per sq m'];
doc.setFillColor(...BLUE); doc.rect(L,y-5,W-2*L,8,'F');
doc.setTextColor(255,255,255); doc.setFont('helvetica','bold'); doc.setFontSize(9.5);
heads.forEach((h,i)=>doc.text(h,cols[i]+(i?0:2),y));
doc.setFont('helvetica','normal'); doc.setTextColor(40,40,40);
y+=9;
rows.forEach((r,i)=>{
  if(i%2===0){ doc.setFillColor(232,239,248); doc.rect(L,y-5,W-2*L,8,'F'); }
  doc.text(r[0],cols[0]+2,y);
  doc.text(String(r[1]),cols[1],y);
  doc.text(f(r[2]),cols[2],y);
  doc.text(r[3]===null?'–':f(r[3]),cols[3],y);
  doc.text(f(r[2]*r[1]),cols[4],y);
  y+=8;
});
if(true){ doc.text('Kerb 450x200x125mm',cols[0]+2,y); doc.text('–',cols[1],y); doc.text(f(150),cols[2],y); doc.text('–',cols[3],y); doc.text('per piece',cols[4],y); y+=8; }
y+=3;
doc.setFontSize(9); doc.setTextColor(...GREY);
const notes=[
  '* Colours: Dark Grey, Red, Terracotta. 80 mm pavers, Evergreen and kerbs: Light Grey only.',
  'Prices per piece unless stated. Evergreen contractor price on request.',
  'Payment: 50% on confirmation, 50% prior to delivery.',
  'Transport is not included and is paid directly to the lorry driver. Ask us for a delivery estimate.',
  'Collection at the factory: full payment before collection; we load with a forklift.',
];
notes.forEach(n=>{ doc.text(n,L,y); y+=5.5; });
y+=4;
doc.setFont('helvetica','bold'); doc.setTextColor(...BLUE); doc.setFontSize(10.5);
doc.text('Factory',L,y); y+=5.5;
doc.setFont('helvetica','normal'); doc.setTextColor(40,40,40); doc.setFontSize(9.5);
['138 New Industrial Zone, La Tour Koenig, Pointe aux Sables','Open Monday–Friday 8:30–16:00, Saturday 8:30–12:00',
 'Send us your measurements or a sketch on WhatsApp for a free quotation.'].forEach(t=>{ doc.text(t,L,y); y+=5.5; });
doc.setFontSize(8); doc.setTextColor(...GREY);
doc.text('Paving Suppliers (Mauritius) Ltd  ·  BRN C18155933  ·  VAT 27611178',W/2,285,{align:'center'});
fs.writeFileSync('/home/claude/paving-mauritius-suite/public/price-list.pdf',Buffer.from(doc.output('arraybuffer')));
console.log('ok');
