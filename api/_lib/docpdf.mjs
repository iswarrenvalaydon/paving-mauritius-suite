// Shared PDF template for quotations, invoices, delivery notes and statements.
// Used by the Documents tab and by WhatsApp quotations, so both look the same.
// api/_lib/docpdf.mjs is an exact copy for automatic quotations: copy this file there after any change.

export const LOGO_URL = "https://raw.githubusercontent.com/iswarrenvalaydon/paving-mauritius-suite/main/paving-logo.png";

export const COMMERCIAL_NAME = "Paving Mauritius Ltd"; // used in client-facing emails/WhatsApp
export const SUPPLIER = {
  name: "Paving Suppliers (Mauritius) Ltd", // official legal name, used on documents
  address: "138 New Industrial Zone",
  city: "La Tour Koenig",
  area: "Pointe aux Sables",
  brn: "BRN C18155933",
  vat: "VAT 27611178",
  bank: "SBM Acc Num: 50300000511199",
  contact: "Dr Iswarren Valaydon – Tel: +230 5725 4201",
  email: "info@paving.mu",
};

export function fmt(n){ return Number(n||0).toLocaleString("en-MU",{minimumFractionDigits:2,maximumFractionDigits:2}); }
export function fmtDate(d){ if(!d)return""; const[y,m,day]=d.split("-"); return`${day}.${m}.${String(y).slice(2)}`; }
export function docPrefix(t){ return{Quotation:"PSM/Q",Invoice:"PSM/INV","Delivery Note":"PSM/DN","Statement of Account":"PSM/SOA"}[t]; }

// Draws the document and returns the jsPDF object (call .save() or .output("blob")).
export async function buildDocPdf({
  docType, docRef, date, client, toName, items=[], calcItems=[], subtotal=0, vat=0, total=0,
  soaData={}, soaUnit=0, soaTotal=0, soaVat=0, soaTTC=0, soaDelivered=0, soaRemaining=0, includeBank=true,
}){
  const isSOA=docType==="Statement of Account";
  const mod = await import("jspdf");
  const jsPDF = mod.jsPDF || (mod.default && mod.default.jsPDF) || mod.default;
  const doc = new jsPDF({orientation:"portrait",unit:"mm",format:"a4"});
  const W=210, H=297;
  const bl=[27,79,138], lb=[232,239,248], gr=[26,122,60], lg=[232,245,237];
  const dg=[51,51,51], mg=[102,102,102];

  // Header blue banner
  doc.setFillColor(...bl);
  doc.rect(0,0,W,38,"F");

  // Logo
  try{
    // Works in the browser and on the server (automatic quotations).
    const bytes=new Uint8Array(await (await fetch(LOGO_URL)).arrayBuffer());
    let bin="";
    for(let i=0;i<bytes.length;i+=0x8000) bin+=String.fromCharCode.apply(null,bytes.subarray(i,i+0x8000));
    const imgB64=`data:image/png;base64,${btoa(bin)}`;
    doc.addImage(imgB64,"PNG",(W-35)/2,3,35,28);
  }catch{
    doc.setTextColor(255,255,255);
    doc.setFontSize(14);doc.setFont("helvetica","bold");
    doc.text("PAVING",W/2,18,{align:"center"});
  }

  // Doc type & ref
  doc.setTextColor(255,255,255);
  doc.setFontSize(14);doc.setFont("helvetica","bold");
  doc.text(docType.toUpperCase(),W-8,18,{align:"right"});
  doc.setFontSize(8);doc.setFont("helvetica","normal");
  doc.setTextColor(170,204,238);
  doc.text(`Ref: ${docRef}     Date: ${fmtDate(date)}`,W-8,26,{align:"right"});

  // Addresses
  let ay=46;
  doc.setTextColor(...bl);doc.setFontSize(7);doc.setFont("helvetica","bold");
  doc.text("CUSTOMER",8,ay);
  doc.setFillColor(...bl);doc.rect(8,ay+1,28,0.4,"F");
  doc.setTextColor(...dg);doc.setFontSize(9);doc.setFont("helvetica","bold");
  doc.text(client.name||"",8,ay+7);
  doc.setFont("helvetica","normal");doc.setFontSize(8);doc.setTextColor(...mg);
  [client.address,client.city,client.area,client.brn,client.vat].filter(Boolean).forEach((l,i)=>{
    doc.text(l,8,ay+13+i*5);
  });

  doc.setTextColor(...bl);doc.setFontSize(7);doc.setFont("helvetica","bold");
  doc.text("SUPPLIER",W-8,ay,{align:"right"});
  doc.setFillColor(...bl);doc.rect(W-38,ay+1,30,0.4,"F");
  [SUPPLIER.name,SUPPLIER.address,SUPPLIER.city,SUPPLIER.area,SUPPLIER.brn,SUPPLIER.vat].forEach((l,i)=>{
    doc.setFontSize(i===0?9:8);doc.setFont("helvetica",i===0?"bold":"normal");
    doc.setTextColor(...(i===0?dg:mg));
    doc.text(l,W-8,ay+7+i*5,{align:"right"});
  });

  // To line
  const toY=ay+38;
  doc.setTextColor(...dg);doc.setFontSize(10);doc.setFont("helvetica","bold");
  doc.text(`To: ${toName||client.name}`,8,toY);

  // Table
  const tY=toY+8;
  const cols=isSOA?[62,18,26,28,28]:[72,18,26,46,0];
  const hdrs=isSOA?["Description","Qty","Unit Price (Rs)","Amount (Rs)","Balance (Rs)"]:["Description","Qty","Unit Price (Rs)","Total (Rs)",""];
  const rh=7;

  // Header row
  let cx=8;
  doc.setFillColor(...bl);
  cols.forEach(cw=>{if(cw)doc.rect(cx,tY,cw,rh,"F");cx+=cw;});
  cx=8;
  doc.setTextColor(255,255,255);doc.setFontSize(7.5);doc.setFont("helvetica","bold");
  cols.forEach((cw,ci)=>{
    if(!cw)return;
    const tx=ci===0?cx+2:cx+cw/2;
    doc.text(hdrs[ci],tx,tY+4.5,{align:ci===0?"left":"center",maxWidth:cw-2});
    cx+=cw;
  });

  // Data rows
  const displayRows=isSOA?[
    {desc:items[0]?.desc||"Product",qty:soaData.totalQty,unit:soaUnit,amt:soaTotal,bal:soaTotal,bold:true},
    {desc:"  Delivered",qty:soaData.deliveredQty,unit:soaUnit,amt:soaDelivered,bal:soaRemaining,bold:false},
    {desc:"  Remaining",qty:soaData.remainingQty,unit:soaUnit,amt:soaRemaining,bal:0,bold:false},
  ]:calcItems;

  displayRows.forEach((row,ri)=>{
    const ry=tY+rh*(ri+1);
    cx=8;
    const bg=ri%2===0?lb:[255,255,255];
    cols.forEach((cw,ci)=>{
      if(!cw)return;
      doc.setFillColor(...bg);doc.rect(cx,ry,cw,rh,"F");
      doc.setDrawColor(204,221,238);doc.setLineWidth(0.2);
      doc.line(cx,ry+rh,cx+cw,ry+rh);
      let val="";
      if(isSOA){
        if(ci===0)val=row.desc||"";
        else if(ci===1)val=String(row.qty||"");
        else if(ci===2)val=fmt(row.unit);
        else if(ci===3)val=`Rs ${fmt(row.amt)}`;
        else val=`Rs ${fmt(row.bal)}`;
      } else {
        if(ci===0)val=row.desc||"";
        else if(ci===1)val=String(row.qty||"");
        else if(ci===2)val=row.unitPrice?fmt(row.unitPrice):"";
        else if(ci===3)val=row.total?`Rs ${fmt(row.total)}`:"";
      }
      doc.setTextColor(...(ci===0?dg:mg));
      doc.setFontSize(ci===0&&ri===0?8:7.5);
      doc.setFont("helvetica",ci===0&&ri===0?"bold":"normal");
      const tx=ci===0?cx+2:cx+cw/2;
      doc.text(val,tx,ry+4.5,{align:ci===0?"left":"center",maxWidth:cw-2});
      cx+=cw;
    });
  });

  // Summary
  const sumY=tY+rh*(displayRows.length+1);
  const sumX=8+(isSOA?cols[0]+cols[1]+cols[2]:cols[0]+cols[1]+cols[2]);
  const sumW=isSOA?cols[3]+cols[4]:cols[3];
  const summaryRows=isSOA
    ?[["Subtotal",`Rs ${fmt(soaTotal)}`],["VAT (15%)",`Rs ${fmt(soaVat)}`],["Total",`Rs ${fmt(soaTTC)}`],["Payment Received",`(Rs ${fmt(soaTTC)})`],["Balance Due","Rs 0.00"]]
    :[["Subtotal",`Rs ${fmt(subtotal)}`],["VAT (15%)",`Rs ${fmt(vat)}`],["Total",`Rs ${fmt(total)}`]];

  summaryRows.forEach(([label,value],si)=>{
    const sy=sumY+si*rh;
    const isBold=label==="Total"||label==="Balance Due";
    doc.setFillColor(...(isBold?lb:[245,245,245]));
    doc.rect(sumX,sy,sumW,rh,"F");
    doc.setDrawColor(204,221,238);doc.setLineWidth(0.2);
    doc.line(sumX,sy+rh,sumX+sumW,sy+rh);
    doc.setFontSize(8);doc.setFont("helvetica",isBold?"bold":"normal");
    doc.setTextColor(...(isBold?bl:dg));
    doc.text(label,sumX+2,sy+4.5);
    doc.text(value,sumX+sumW-2,sy+4.5,{align:"right"});
  });

  // FULLY PAID stamp
  const stampY=sumY+summaryRows.length*rh+6;
  if(isSOA&&soaData.paid){
    doc.setFillColor(...lg);doc.setDrawColor(...gr);doc.setLineWidth(0.8);
    doc.roundedRect(8,stampY,44,11,2,2,"FD");
    doc.setTextColor(...gr);doc.setFontSize(11);doc.setFont("helvetica","bold");
    doc.text("✓ FULLY PAID",30,stampY+7,{align:"center"});
  }

  // Terms for quotation
  if(docType==="Quotation"){
    const termsY=stampY+6;
    doc.setTextColor(...dg);doc.setFontSize(8);doc.setFont("helvetica","bold");
    doc.text("Terms & Conditions:",8,termsY);
    doc.setFont("helvetica","normal");doc.setTextColor(...mg);doc.setFontSize(7.5);
    [`1. Contact: ${SUPPLIER.contact}`,"2. Valid for 2 months depending on stock availability","3. Payment: 50% on confirmation, 50% prior to delivery",
      ...(includeBank?[`4. Bank: ${SUPPLIER.name} – ${SUPPLIER.bank}`]:[])
    ].forEach((t,i)=>{
      doc.text(t,8,termsY+5+i*5);
    });
  }

  // Footer
  doc.setFillColor(...bl);doc.rect(0,H-12,W,12,"F");
  doc.setTextColor(255,255,255);doc.setFontSize(7);doc.setFont("helvetica","normal");
  doc.text(`${SUPPLIER.name} | ${SUPPLIER.address}, ${SUPPLIER.city}, ${SUPPLIER.area} | ${SUPPLIER.brn} | ${SUPPLIER.email}`,W/2,H-5,{align:"center"});

  return doc;
}
