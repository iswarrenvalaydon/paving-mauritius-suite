import { useState, useRef } from "react";

const LOGO_URL = "https://raw.githubusercontent.com/iswarrenvalaydon/paving-mauritius-suite/main/paving-logo.png";
const BLUE = "#1B4F8A";
const LIGHT_BLUE = "#E8EFF8";
const GREEN = "#1A7A3C";
const LIGHT_GREEN = "#E8F5ED";
const DARK_GREY = "#333333";
const MID_GREY = "#666666";

const SUPPLIER = {
  name: "Paving Suppliers Mauritius Ltd",
  address: "138 New Industrial Zone",
  city: "La Tour Koenig",
  area: "Pointe aux Sable",
  brn: "BRN C18155933",
  vat: "VAT 27611178",
  bank: "SBM Acc Num: 50300000511199",
  contact: "Dr Iswarren Valaydon – Tel: +230 57396517",
  email: "info@paving.mu",
};

const DOC_TYPES = ["Quotation","Invoice","Delivery Note","Statement of Account"];

function fmt(n){ return Number(n||0).toLocaleString("en-MU",{minimumFractionDigits:2,maximumFractionDigits:2}); }
function fmtDate(d){ if(!d)return""; const[y,m,day]=d.split("-"); return`${day}.${m}.${String(y).slice(2)}`; }
function docPrefix(t){ return{Quotation:"PSM/Q",Invoice:"PSM/INV","Delivery Note":"PSM/DN","Statement of Account":"PSM/SOA"}[t]; }

const EMPTY_ITEM = {desc:"",qty:"",unitPrice:"",code:""};
const EMPTY_CLIENT = {name:"",address:"",city:"",area:"",brn:"",vat:"",contact:"",email:""};

export default function App(){
  const [tab,setTab]=useState("generator");
  const [docType,setDocType]=useState("Quotation");
  const [refNum,setRefNum]=useState("001");
  const [date,setDate]=useState(new Date().toISOString().split("T")[0]);
  const [client,setClient]=useState(EMPTY_CLIENT);
  const [toName,setToName]=useState("");
  const [items,setItems]=useState([{...EMPTY_ITEM},{...EMPTY_ITEM},{...EMPTY_ITEM}]);
  const [priceList,setPriceList]=useState([]);
  const [priceListName,setPriceListName]=useState("");
  const [scanning,setScanning]=useState(false);
  const [scanMsg,setScanMsg]=useState("");
  const [soaData,setSoaData]=useState({totalQty:"",deliveredQty:"",remainingQty:"",paid:true});
  const [savedClients,setSavedClients]=useState([]);
  const [showClientList,setShowClientList]=useState(false);
  const [notification,setNotification]=useState(null);
  const [emailDraft,setEmailDraft]=useState(null);
  const [whatsappDraft,setWhatsappDraft]=useState(null);
  const [generatingMsg,setGeneratingMsg]=useState(false);
  const [clientAnalysis,setClientAnalysis]=useState(null);
  const [analysing,setAnalysing]=useState(false);
  const [priceSearch,setPriceSearch]=useState("");

  const scanRef=useRef();
  const priceRef=useRef();
  const analysisRef=useRef();

  // ── Notify helper ──────────────────────────────
  function notify(msg,type="success"){
    setNotification({msg,type});
    setTimeout(()=>setNotification(null),4000);
  }

  // ── Price list loader ──────────────────────────
  async function loadPriceList(e){
    const file=e.target.files[0]; if(!file)return;
    setPriceListName(file.name);
    const ext=file.name.split(".").pop().toLowerCase();
    if(ext==="xlsx"||ext==="xls"){
      const XLSX=await import("xlsx");
      const ab=await file.arrayBuffer();
      const wb=XLSX.read(ab);
      const ws=wb.Sheets[wb.SheetNames[0]];
      const rows=XLSX.utils.sheet_to_json(ws,{header:1});
      const parsed=rows.slice(1).map(r=>({code:String(r[0]||"").trim(),desc:String(r[1]||"").trim(),price:parseFloat(r[2])||0})).filter(r=>r.desc);
      setPriceList(parsed);
      notify(`✅ Loaded ${parsed.length} products from ${file.name}`);
    } else if(ext==="pdf"){
      const reader=new FileReader();
      reader.onload=async()=>{
        const b64=reader.result.split(",")[1];
        try{
          const res=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:1000,messages:[{role:"user",content:[{type:"document",source:{type:"base64",media_type:"application/pdf",data:b64}},{type:"text",text:'Extract price list. Return ONLY JSON array: [{"code":"","desc":"","price":0}]. No markdown.'}]}]})});
          const data=await res.json();
          const text=data.content.map(i=>i.text||"").join("");
          const parsed=JSON.parse(text.replace(/```json|```/g,"").trim());
          setPriceList(parsed);
          notify(`✅ Loaded ${parsed.length} products from PDF`);
        }catch{ notify("❌ Could not read PDF price list","error"); }
      };
      reader.readAsDataURL(file);
    }
  }

  function lookupPrice(idx,val){
    if(!priceList.length||!val||val.length<2)return;
    const q=val.toLowerCase();
    const found=priceList.find(p=>p.code.toLowerCase().includes(q)||p.desc.toLowerCase().includes(q));
    if(found){
      const updated=[...items];
      updated[idx]={...updated[idx],desc:found.desc,unitPrice:String(found.price),code:found.code};
      setItems(updated);
    }
  }

  // ── Client photo scan ──────────────────────────
  async function scanClientPhoto(e){
    const file=e.target.files[0]; if(!file)return;
    setScanning(true); setScanMsg("🔍 AI scanning image...");
    const reader=new FileReader();
    reader.onload=async()=>{
      const b64=reader.result.split(",")[1];
      try{
        const res=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:500,messages:[{role:"user",content:[{type:"image",source:{type:"base64",media_type:file.type,data:b64}},{type:"text",text:'Extract client details from this image. Return ONLY JSON: {"name":"","address":"","city":"","area":"","brn":"","vat":"","contact":"","email":""}'}]}]})});
        const data=await res.json();
        const text=data.content.map(i=>i.text||"").join("");
        const parsed=JSON.parse(text.replace(/```json|```/g,"").trim());
        setClient(parsed);
        setScanMsg("✅ Client details extracted!");
        notify("✅ Client details filled from photo!");
      }catch{ setScanMsg("❌ Could not read. Fill manually."); }
      setScanning(false);
    };
    reader.readAsDataURL(file);
  }

  // ── Save/load client ───────────────────────────
  function saveClient(){
    if(!client.name){ notify("Enter client name first","error"); return; }
    const existing=savedClients.findIndex(c=>c.name===client.name);
    if(existing>=0){ const updated=[...savedClients]; updated[existing]=client; setSavedClients(updated); }
    else setSavedClients([...savedClients,client]);
    notify(`✅ ${client.name} saved!`);
  }
  function loadClient(c){ setClient(c); setToName(c.contact||c.name); setShowClientList(false); notify(`✅ Loaded: ${c.name}`); }

  // ── Calculations ───────────────────────────────
  const calcItems=items.map(it=>({...it,total:(parseFloat(it.qty)||0)*(parseFloat(it.unitPrice)||0)}));
  const subtotal=calcItems.reduce((s,i)=>s+i.total,0);
  const vat=subtotal*0.15;
  const total=subtotal+vat;
  const soaUnit=parseFloat(items[0]?.unitPrice)||0;
  const soaTotal=(parseFloat(soaData.totalQty)||0)*soaUnit;
  const soaVat=soaTotal*0.15;
  const soaTTC=soaTotal+soaVat;
  const soaDelivered=(parseFloat(soaData.deliveredQty)||0)*soaUnit;
  const soaRemaining=(parseFloat(soaData.remainingQty)||0)*soaUnit;
  const isSOA=docType==="Statement of Account";
  const ref=`${docPrefix(docType)}/${refNum}`;
  const grandTotal=isSOA?soaTTC:total;

  // ── Generate Email ─────────────────────────────
  async function generateEmail(){
    setGeneratingMsg(true); setEmailDraft(null); setWhatsappDraft(null);
    const summary=isSOA
      ?`Statement of Account for ${client.name}. Total: Rs ${fmt(soaTTC)}. Status: ${soaData.paid?"Fully Paid":"Balance Due"}.`
      :`${docType} Ref: ${ref}. Items: ${calcItems.filter(i=>i.desc).map(i=>`${i.desc} x${i.qty}`).join(", ")}. Subtotal: Rs ${fmt(subtotal)}, VAT 15%: Rs ${fmt(vat)}, Total: Rs ${fmt(total)}.`;
    const prompt=`Write a professional but friendly business email from Paving Suppliers Mauritius Ltd to ${toName||client.name} at ${client.email||"[client email]"} regarding the attached ${docType} (Ref: ${ref}, Date: ${fmtDate(date)}). Summary: ${summary}. Contact: ${SUPPLIER.contact}. Bank: ${SUPPLIER.bank}. Keep it concise and professional. Return ONLY the email body (no subject line in body).`;
    try{
      const res=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:500,messages:[{role:"user",content:prompt}]})});
      const data=await res.json();
      const body=data.content.map(i=>i.text||"").join("");
      setEmailDraft({subject:`${docType} – ${ref} – Paving Suppliers Mauritius Ltd`,body});
    }catch{ notify("❌ Could not generate email","error"); }
    setGeneratingMsg(false);
  }

  // ── Generate WhatsApp ──────────────────────────
  async function generateWhatsApp(){
    setGeneratingMsg(true); setWhatsappDraft(null); setEmailDraft(null);
    const summary=isSOA
      ?`SOA for ${client.name}. Total: Rs ${fmt(soaTTC)}. ${soaData.paid?"✅ Fully Paid":"⏳ Balance due."}`
      :`${docType} ${ref}. Total: Rs ${fmt(total)} (incl. 15% VAT).`;
    const prompt=`Write a short, friendly WhatsApp message from Paving Mauritius to ${toName||client.name} about their ${docType} (${ref}, ${fmtDate(date)}). ${summary}. Contact: +230 57396517. Max 5 lines. Informal but professional. Use emojis sparingly.`;
    try{
      const res=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:200,messages:[{role:"user",content:prompt}]})});
      const data=await res.json();
      const msg=data.content.map(i=>i.text||"").join("");
      setWhatsappDraft(msg);
    }catch{ notify("❌ Could not generate WhatsApp message","error"); }
    setGeneratingMsg(false);
  }

  // ── Keyword detection ──────────────────────────
  function detectKeyword(text){
    const lower=text.toLowerCase();
    if(lower.includes("invoice"))return"Invoice";
    if(lower.includes("quotation")||lower.includes("quote"))return"Quotation";
    if(lower.includes("statement")||lower.includes("soa"))return"Statement of Account";
    if(lower.includes("delivery"))return"Delivery Note";
    return null;
  }

  // ── Client analysis ────────────────────────────
  async function analyseFiles(e){
    const files=Array.from(e.target.files); if(!files.length)return;
    setAnalysing(true); setClientAnalysis(null);
    const texts=[];
    for(const file of files){
      const ext=file.name.split(".").pop().toLowerCase();
      if(ext==="xlsx"||ext==="xls"){
        const XLSX=await import("xlsx");
        const ab=await file.arrayBuffer();
        const wb=XLSX.read(ab);
        const ws=wb.Sheets[wb.SheetNames[0]];
        texts.push(`FILE: ${file.name}\n${XLSX.utils.sheet_to_csv(ws).slice(0,3000)}`);
      } else { texts.push(`FILE: ${file.name} (PDF)`); }
    }
    try{
      const res=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:1000,messages:[{role:"user",content:`Analyse these business files and return ONLY JSON: {"clients":[{"name":"","address":"","brn":"","vat":"","email":"","totalSales":0,"invoiceCount":0,"quotationCount":0,"conversionRate":""}],"summary":{"totalRevenue":0,"totalInvoices":0,"totalQuotations":0,"overallConversionRate":"","topClient":""}}\nFiles:\n${texts.join("\n\n")}`}]})});
      const data=await res.json();
      const text=data.content.map(i=>i.text||"").join("");
      setClientAnalysis(JSON.parse(text.replace(/```json|```/g,"").trim()));
      notify("✅ Analysis complete!");
    }catch{ setClientAnalysis({error:"Could not analyse files."}); }
    setAnalysing(false);
  }

  // ── PDF Download (SVG) ─────────────────────────
  function downloadDoc(){
    const W=595,H=842,BL=BLUE,LB=LIGHT_BLUE,GR=GREEN,LG=LIGHT_GREEN;
    let s="";
    s+=`<rect x="0" y="0" width="${W}" height="115" fill="${BL}"/>`;
    s+=`<image href="data:image/jpeg;base64,${LOGO_B64}" x="${(W-110)/2}" y="8" width="110" height="80" preserveAspectRatio="xMidYMid meet"/>`;
    s+=`<text x="${W-18}" y="55" font-family="Arial" font-size="17" font-weight="bold" fill="white" text-anchor="end">${docType.toUpperCase()}</text>`;
    s+=`<text x="${W-18}" y="74" font-family="Arial" font-size="9" fill="#AACCEE" text-anchor="end">Ref: ${ref}     Date: ${fmtDate(date)}</text>`;

    const ay=135;
    s+=`<text x="18" y="${ay}" font-family="Arial" font-size="8" font-weight="bold" fill="${BL}">CUSTOMER</text>`;
    s+=`<rect x="18" y="${ay+2}" width="80" height="1" fill="#AACCEE"/>`;
    s+=`<text x="18" y="${ay+16}" font-family="Arial" font-size="10" font-weight="bold" fill="${DARK_GREY}">${client.name}</text>`;
    [client.address,client.city,client.area,client.brn,client.vat].filter(Boolean).forEach((l,i)=>{
      s+=`<text x="18" y="${ay+28+i*13}" font-family="Arial" font-size="8.5" fill="${MID_GREY}">${l}</text>`;
    });

    s+=`<text x="${W-18}" y="${ay}" font-family="Arial" font-size="8" font-weight="bold" fill="${BL}" text-anchor="end">SUPPLIER</text>`;
    s+=`<rect x="${W-100}" y="${ay+2}" width="82" height="1" fill="#AACCEE"/>`;
    [SUPPLIER.name,SUPPLIER.address,SUPPLIER.city,SUPPLIER.area,SUPPLIER.brn,SUPPLIER.vat].forEach((l,i)=>{
      s+=`<text x="${W-18}" y="${ay+16+i*13}" font-family="Arial" font-size="${i===0?10:8.5}" font-weight="${i===0?"bold":"normal"}" fill="${i===0?DARK_GREY:MID_GREY}" text-anchor="end">${l}</text>`;
    });

    const toY=ay+95;
    s+=`<text x="18" y="${toY}" font-family="Arial" font-size="11" font-weight="bold" fill="${DARK_GREY}">To: ${toName||client.name}</text>`;

    const tY=toY+18;
    const cols=isSOA?[185,55,70,80,80]:[210,55,70,130,0];
    const hdrs=isSOA?["Description","Qty","Unit Price (Rs)","Amount (Rs)","Balance (Rs)"]:["Description","Qty","Unit Price (Rs)","Total (Rs)",""];
    const rh=22; let cx=15;
    cols.forEach((cw,ci)=>{
      if(!cw)return;
      s+=`<rect x="${cx}" y="${tY}" width="${cw}" height="${rh}" fill="${BL}"/>`;
      s+=`<text x="${ci===0?cx+4:cx+cw/2}" y="${tY+14}" font-family="Arial" font-size="8.5" font-weight="bold" fill="white" text-anchor="${ci===0?"start":"middle"}">${hdrs[ci]}</text>`;
      cx+=cw;
    });

    const displayRows=isSOA?[
      {desc:items[0]?.desc||"Product",qty:soaData.totalQty,unit:soaUnit,amt:soaTotal,bal:soaTotal,bold:true},
      {desc:"  Delivered",qty:soaData.deliveredQty,unit:soaUnit,amt:soaDelivered,bal:soaRemaining,bold:false},
      {desc:"  Remaining",qty:soaData.remainingQty,unit:soaUnit,amt:soaRemaining,bal:0,bold:false},
    ]:calcItems;

    displayRows.forEach((row,ri)=>{
      const ry=tY+rh*(ri+1);
      const bg=ri%2===0?LB:"#FFFFFF";
      cx=15;
      cols.forEach((cw,ci)=>{
        if(!cw)return;
        s+=`<rect x="${cx}" y="${ry}" width="${cw}" height="${rh}" fill="${bg}"/>`;
        s+=`<line x1="${cx}" y1="${ry+rh}" x2="${cx+cw}" y2="${ry+rh}" stroke="#CCDDEE" stroke-width="0.4"/>`;
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
        const ta=ci===0?"start":"middle";
        const tx=ci===0?cx+4:cx+cw/2;
        s+=`<text x="${tx}" y="${ry+14}" font-family="Arial" font-size="${ci===0&&(ri===0||isSOA&&row.bold)?"9":"8"}" font-weight="${ci===0&&ri===0?"bold":"normal"}" fill="${ci===0?DARK_GREY:MID_GREY}" text-anchor="${ta}">${val}</text>`;
        cx+=cw;
      });
    });

    const usedW=cols.reduce((a,b)=>a+b,0);
    const sumY=tY+rh*(displayRows.length+1);
    const sumX=15+(isSOA?cols[0]+cols[1]+cols[2]:cols[0]+cols[1]+cols[2]);
    const sumW=isSOA?cols[3]+cols[4]:cols[3];
    const summaryRows=isSOA
      ?[["Subtotal",`Rs ${fmt(soaTotal)}`],["VAT (15%)",`Rs ${fmt(soaVat)}`],["Total",`Rs ${fmt(soaTTC)}`],["Payment Received",`(Rs ${fmt(soaTTC)})`],["Balance Due","Rs 0.00"]]
      :[["Subtotal",`Rs ${fmt(subtotal)}`],["VAT (15%)",`Rs ${fmt(vat)}`],["Total",`Rs ${fmt(total)}`]];

    summaryRows.forEach(([label,value],si)=>{
      const sy=sumY+si*rh;
      const isBold=label==="Total"||label==="Balance Due";
      s+=`<rect x="${sumX}" y="${sy}" width="${sumW}" height="${rh}" fill="${isBold?LB:"#F5F5F5"}"/>`;
      s+=`<line x1="${sumX}" y1="${sy+rh}" x2="${sumX+sumW}" y2="${sy+rh}" stroke="#CCDDEE" stroke-width="0.4"/>`;
      s+=`<text x="${sumX+4}" y="${sy+14}" font-family="Arial" font-size="9" font-weight="${isBold?"bold":"normal"}" fill="${isBold?BL:DARK_GREY}">${label}</text>`;
      s+=`<text x="${sumX+sumW-4}" y="${sy+14}" font-family="Arial" font-size="9" font-weight="${isBold?"bold":"normal"}" fill="${isBold?BL:MID_GREY}" text-anchor="end">${value}</text>`;
    });

    const stampY=sumY+summaryRows.length*rh+18;
    if(isSOA&&soaData.paid){
      s+=`<rect x="18" y="${stampY}" width="130" height="32" rx="5" fill="${LG}" stroke="${GR}" stroke-width="2"/>`;
      s+=`<text x="83" y="${stampY+20}" font-family="Arial" font-size="14" font-weight="bold" fill="${GR}" text-anchor="middle">✓ FULLY PAID</text>`;
    }

    // Terms for quotation
    if(docType==="Quotation"){
      const termsY=stampY+(isSOA?0:10);
      s+=`<text x="18" y="${termsY}" font-family="Arial" font-size="8.5" font-weight="bold" fill="${DARK_GREY}">Terms &amp; Conditions:</text>`;
      [`1. Contact: ${SUPPLIER.contact}`,"2. Valid for 2 months depending on stock availability","3. All wooden pallets must be returned in good condition",`4. Bank: ${SUPPLIER.name} – ${SUPPLIER.bank}`].forEach((t,i)=>{
        s+=`<text x="18" y="${termsY+12+i*12}" font-family="Arial" font-size="8" fill="${MID_GREY}">${t}</text>`;
      });
    }

    s+=`<rect x="0" y="${H-30}" width="${W}" height="30" fill="${BL}"/>`;
    s+=`<text x="${W/2}" y="${H-11}" font-family="Arial" font-size="7.5" fill="white" text-anchor="middle">${SUPPLIER.name} | ${SUPPLIER.address}, ${SUPPLIER.city}, ${SUPPLIER.area} | ${SUPPLIER.brn} | ${SUPPLIER.email}</text>`;

    const svg=`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${s}</svg>`;
    const blob=new Blob([svg],{type:"image/svg+xml"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");
    a.href=url; a.download=`${ref.replace(/\//g,"_")}.svg`; a.click();
    notify(`✅ ${docType} downloaded!`);
  }

  const filteredPriceList=priceList.filter(p=>
    !priceSearch||p.desc.toLowerCase().includes(priceSearch.toLowerCase())||p.code.toLowerCase().includes(priceSearch.toLowerCase())
  );

  const inp=(val,onChange,placeholder,type="text",style={})=>(
    <input type={type} value={val} onChange={e=>onChange(e.target.value)} placeholder={placeholder}
      style={{width:"100%",border:"1px solid #ddd",borderRadius:6,padding:"7px 10px",fontSize:13,boxSizing:"border-box",...style}}/>
  );

  const card=(children,style={})=>(
    <div style={{background:"#fff",borderRadius:12,padding:20,boxShadow:"0 2px 8px #0001",...style}}>{children}</div>
  );

  const sectionTitle=(icon,title,extra=null)=>(
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
      <div style={{fontWeight:700,color:BLUE,fontSize:15}}>{icon} {title}</div>
      {extra}
    </div>
  );

  return(
    <div style={{fontFamily:"Segoe UI,Arial,sans-serif",background:"#F0F4FA",minHeight:"100vh"}}>
      {/* Notification */}
      {notification&&(
        <div style={{position:"fixed",top:16,right:16,zIndex:999,background:notification.type==="error"?"#C0392B":GREEN,color:"#fff",padding:"12px 20px",borderRadius:10,fontWeight:600,fontSize:14,boxShadow:"0 4px 16px #0003"}}>
          {notification.msg}
        </div>
      )}

      {/* Header */}
      <div style={{background:BLUE,color:"#fff",padding:"0 24px",display:"flex",alignItems:"center",gap:16,height:58,boxShadow:"0 2px 8px #0002"}}>
        <img src={`data:image/jpeg;base64,${LOGO_B64}`} alt="logo" style={{height:42,objectFit:"contain"}}/>
        <div>
          <div style={{fontWeight:700,fontSize:17,letterSpacing:0.5}}>Paving Mauritius – Business Suite</div>
          <div style={{fontSize:11,opacity:0.75}}>Invoice · Quotation · Delivery Note · Statement of Account</div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{background:"#fff",borderBottom:`3px solid ${BLUE}`,display:"flex",gap:0,overflowX:"auto"}}>
        {[["generator","📄 Documents"],["pricelist","💰 Price List"],["comms","📨 Communications"],["analysis","📊 Analysis"]].map(([t,label])=>(
          <button key={t} onClick={()=>setTab(t)} style={{padding:"12px 22px",border:"none",cursor:"pointer",fontWeight:600,fontSize:13,background:tab===t?BLUE:"transparent",color:tab===t?"#fff":BLUE,whiteSpace:"nowrap"}}>
            {label}
          </button>
        ))}
      </div>

      <div style={{maxWidth:900,margin:"24px auto",padding:"0 16px",paddingBottom:40}}>

        {/* ══ GENERATOR TAB ══ */}
        {tab==="generator"&&(
          <div style={{display:"flex",flexDirection:"column",gap:18}}>

            {/* Doc type */}
            {card(<>
              {sectionTitle("📋","Document Type")}
              <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
                {DOC_TYPES.map(dt=>(
                  <button key={dt} onClick={()=>setDocType(dt)} style={{padding:"8px 18px",borderRadius:8,border:`2px solid ${docType===dt?BLUE:"#ddd"}`,background:docType===dt?BLUE:"#fff",color:docType===dt?"#fff":DARK_GREY,fontWeight:600,cursor:"pointer",fontSize:13}}>
                    {dt}
                  </button>
                ))}
              </div>
            </>)}

            {/* Ref & Date */}
            {card(<>
              <div style={{display:"flex",gap:16,flexWrap:"wrap"}}>
                <div style={{flex:1,minWidth:200}}>
                  <label style={{fontSize:12,color:MID_GREY,fontWeight:600,display:"block",marginBottom:4}}>Reference Number</label>
                  <div style={{display:"flex",alignItems:"center",gap:6}}>
                    <span style={{color:BLUE,fontWeight:700,fontSize:13,whiteSpace:"nowrap"}}>{docPrefix(docType)}/</span>
                    {inp(refNum,setRefNum,"001","text",{width:120})}
                  </div>
                </div>
                <div style={{flex:1,minWidth:200}}>
                  <label style={{fontSize:12,color:MID_GREY,fontWeight:600,display:"block",marginBottom:4}}>Date</label>
                  <input type="date" value={date} onChange={e=>setDate(e.target.value)}
                    style={{border:"1px solid #ddd",borderRadius:6,padding:"7px 10px",fontSize:13,width:"100%",boxSizing:"border-box"}}/>
                </div>
              </div>
            </>)}

            {/* Client */}
            {card(<>
              {sectionTitle("👤","Client Details",
                <div style={{display:"flex",gap:8}}>
                  <button onClick={()=>setShowClientList(!showClientList)} style={{background:LIGHT_BLUE,color:BLUE,border:`1px solid ${BLUE}`,borderRadius:8,padding:"7px 13px",cursor:"pointer",fontWeight:600,fontSize:12}}>
                    📂 Saved Clients ({savedClients.length})
                  </button>
                  <button onClick={()=>scanRef.current.click()} style={{background:BLUE,color:"#fff",border:"none",borderRadius:8,padding:"7px 13px",cursor:"pointer",fontWeight:600,fontSize:12}}>
                    📷 Scan Photo
                  </button>
                  <button onClick={saveClient} style={{background:GREEN,color:"#fff",border:"none",borderRadius:8,padding:"7px 13px",cursor:"pointer",fontWeight:600,fontSize:12}}>
                    💾 Save
                  </button>
                </div>
              )}
              <input ref={scanRef} type="file" accept="image/*" style={{display:"none"}} onChange={scanClientPhoto}/>
              {scanning&&<div style={{color:BLUE,fontSize:13,marginBottom:10}}>⏳ {scanMsg}</div>}
              {!scanning&&scanMsg&&<div style={{color:GREEN,fontSize:13,marginBottom:10}}>{scanMsg}</div>}

              {showClientList&&savedClients.length>0&&(
                <div style={{background:LIGHT_BLUE,borderRadius:8,padding:12,marginBottom:14}}>
                  <div style={{fontWeight:600,color:BLUE,marginBottom:8,fontSize:13}}>Saved Clients:</div>
                  {savedClients.map((c,i)=>(
                    <div key={i} onClick={()=>loadClient(c)} style={{padding:"6px 10px",cursor:"pointer",borderRadius:6,marginBottom:4,background:"#fff",fontSize:13,fontWeight:500,color:DARK_GREY,display:"flex",justifyContent:"space-between"}}>
                      <span>{c.name}</span><span style={{color:MID_GREY,fontSize:11}}>{c.brn}</span>
                    </div>
                  ))}
                </div>
              )}

              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                {[["Company Name","name"],["Contact Person","contact"],["Address","address"],["City","city"],["Area","area"],["BRN","brn"],["VAT Number","vat"],["Email","email"]].map(([label,key])=>(
                  <div key={key}>
                    <label style={{fontSize:12,color:MID_GREY,fontWeight:600,display:"block",marginBottom:4}}>{label}</label>
                    {inp(client[key],v=>setClient({...client,[key]:v}),label)}
                  </div>
                ))}
                <div>
                  <label style={{fontSize:12,color:MID_GREY,fontWeight:600,display:"block",marginBottom:4}}>To: (Name on document)</label>
                  {inp(toName,setToName,"Mr. / Mrs.")}
                </div>
              </div>
            </>)}

            {/* SOA fields */}
            {isSOA&&card(<>
              {sectionTitle("📦","Delivery & Payment Status")}
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12,marginBottom:12}}>
                {[["Total Qty Ordered","totalQty"],["Delivered Qty","deliveredQty"],["Remaining Qty","remainingQty"]].map(([label,key])=>(
                  <div key={key}>
                    <label style={{fontSize:12,color:MID_GREY,fontWeight:600,display:"block",marginBottom:4}}>{label}</label>
                    <input type="number" value={soaData[key]} onChange={e=>setSoaData({...soaData,[key]:e.target.value})}
                      style={{width:"100%",border:"1px solid #ddd",borderRadius:6,padding:"7px 10px",fontSize:13,boxSizing:"border-box"}}/>
                  </div>
                ))}
              </div>
              <label style={{display:"flex",alignItems:"center",gap:8,cursor:"pointer"}}>
                <input type="checkbox" checked={soaData.paid} onChange={e=>setSoaData({...soaData,paid:e.target.checked})}/>
                <span style={{fontWeight:600,color:GREEN,fontSize:13}}>✓ Mark as Fully Paid</span>
              </label>
            </>)}

            {/* Items */}
            {card(<>
              {sectionTitle("🧱","Items",
                priceList.length>0&&<span style={{fontSize:11,color:GREEN,fontWeight:500}}>💡 {priceList.length} products loaded — type name or code to auto-fill price</span>
              )}
              <div style={{overflowX:"auto"}}>
                <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
                  <thead>
                    <tr style={{background:BLUE,color:"#fff"}}>
                      {["#","Code","Description","Qty","Unit Price (Rs)","Total (Rs)",""].map(h=>(
                        <th key={h} style={{padding:"8px 10px",textAlign:"left",fontWeight:600,fontSize:12}}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item,i)=>(
                      <tr key={i} style={{background:i%2===0?LIGHT_BLUE:"#fff"}}>
                        <td style={{padding:"5px 10px",color:MID_GREY,fontWeight:600}}>{i+1}</td>
                        <td style={{padding:"4px 5px"}}>
                          <input value={item.code} onChange={e=>{const u=[...items];u[i]={...u[i],code:e.target.value};setItems(u);lookupPrice(i,e.target.value);}}
                            placeholder="Code" style={{width:65,border:"1px solid #ddd",borderRadius:5,padding:"5px 6px",fontSize:12}}/>
                        </td>
                        <td style={{padding:"4px 5px"}}>
                          <input value={item.desc} onChange={e=>{const u=[...items];u[i]={...u[i],desc:e.target.value};setItems(u);lookupPrice(i,e.target.value);}}
                            placeholder="Product description" style={{minWidth:180,width:"100%",border:"1px solid #ddd",borderRadius:5,padding:"5px 6px",fontSize:12}}/>
                        </td>
                        <td style={{padding:"4px 5px"}}>
                          <input type="number" value={item.qty} onChange={e=>{const u=[...items];u[i]={...u[i],qty:e.target.value};setItems(u);}}
                            style={{width:70,border:"1px solid #ddd",borderRadius:5,padding:"5px 6px",fontSize:12}}/>
                        </td>
                        <td style={{padding:"4px 5px"}}>
                          <input type="number" value={item.unitPrice} onChange={e=>{const u=[...items];u[i]={...u[i],unitPrice:e.target.value};setItems(u);}}
                            style={{width:90,border:"1px solid #ddd",borderRadius:5,padding:"5px 6px",fontSize:12}}/>
                        </td>
                        <td style={{padding:"5px 10px",fontWeight:600,color:BLUE,whiteSpace:"nowrap"}}>
                          {calcItems[i]?.total?`Rs ${fmt(calcItems[i].total)}`:"—"}
                        </td>
                        <td style={{padding:"4px 5px"}}>
                          <button onClick={()=>setItems(items.filter((_,idx)=>idx!==i))}
                            style={{background:"#FFE8E8",color:"#C0392B",border:"none",borderRadius:5,padding:"4px 8px",cursor:"pointer",fontSize:12}}>✕</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button onClick={()=>setItems([...items,{...EMPTY_ITEM}])}
                style={{marginTop:10,background:LIGHT_BLUE,color:BLUE,border:`1px dashed ${BLUE}`,borderRadius:8,padding:"7px 16px",cursor:"pointer",fontWeight:600,fontSize:13}}>
                + Add Item
              </button>
              <div style={{marginTop:16,display:"flex",justifyContent:"flex-end"}}>
                <div style={{minWidth:270}}>
                  {[["Subtotal",fmt(isSOA?soaTotal:subtotal)],["VAT (15%)",fmt(isSOA?soaVat:vat)],["TOTAL",fmt(isSOA?soaTTC:total)]].map(([label,val],i)=>(
                    <div key={label} style={{display:"flex",justifyContent:"space-between",padding:"8px 14px",background:i===2?LIGHT_BLUE:"#F5F5F5",borderBottom:"1px solid #CCDDEE",fontWeight:i===2?700:400,color:i===2?BLUE:DARK_GREY,fontSize:i===2?15:13}}>
                      <span>{label}</span><span>Rs {val}</span>
                    </div>
                  ))}
                </div>
              </div>
            </>)}

            {/* Actions */}
            <div style={{display:"flex",gap:12,justifyContent:"flex-end",flexWrap:"wrap"}}>
              <button onClick={downloadDoc} style={{background:BLUE,color:"#fff",border:"none",borderRadius:10,padding:"13px 28px",fontSize:14,fontWeight:700,cursor:"pointer",boxShadow:`0 4px 14px ${BLUE}55`}}>
                ⬇ Download {docType}
              </button>
            </div>

            {/* Bank info */}
            <div style={{background:LIGHT_BLUE,borderRadius:10,padding:"12px 16px",fontSize:12,color:MID_GREY,border:`1px solid ${BLUE}20`}}>
              <strong style={{color:BLUE}}>🏦 Bank Details:</strong> {SUPPLIER.name} — {SUPPLIER.bank}
            </div>
          </div>
        )}

        {/* ══ PRICE LIST TAB ══ */}
        {tab==="pricelist"&&card(<>
          {sectionTitle("💰","Price List Manager")}
          <div style={{display:"flex",gap:12,marginBottom:16,flexWrap:"wrap",alignItems:"center"}}>
            <button onClick={()=>priceRef.current.click()} style={{background:BLUE,color:"#fff",border:"none",borderRadius:8,padding:"10px 20px",cursor:"pointer",fontWeight:600,fontSize:13}}>
              📂 Load Excel or PDF
            </button>
            <input ref={priceRef} type="file" accept=".xlsx,.xls,.pdf" style={{display:"none"}} onChange={loadPriceList}/>
            {priceListName&&<span style={{color:GREEN,fontSize:13,fontWeight:600}}>✅ {priceListName} — {priceList.length} items</span>}
          </div>
          {priceList.length>0&&<>
            <input value={priceSearch} onChange={e=>setPriceSearch(e.target.value)} placeholder="🔍 Search by name or code..."
              style={{width:"100%",border:"1px solid #ddd",borderRadius:8,padding:"9px 14px",fontSize:13,marginBottom:14,boxSizing:"border-box"}}/>
            <div style={{overflowX:"auto",maxHeight:450,overflowY:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
                <thead style={{position:"sticky",top:0}}>
                  <tr style={{background:BLUE,color:"#fff"}}>
                    {["Code","Description","Unit Price (Rs)"].map(h=><th key={h} style={{padding:"9px 12px",textAlign:"left",fontWeight:600}}>{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {filteredPriceList.map((p,i)=>(
                    <tr key={i} style={{background:i%2===0?LIGHT_BLUE:"#fff",cursor:"pointer"}}
                      onClick={()=>{const u=[...items];u[0]={...u[0],code:p.code,desc:p.desc,unitPrice:String(p.price)};setItems(u);setTab("generator");notify(`✅ ${p.desc} added to item 1`); }}>
                      <td style={{padding:"7px 12px",color:MID_GREY}}>{p.code}</td>
                      <td style={{padding:"7px 12px"}}>{p.desc}</td>
                      <td style={{padding:"7px 12px",fontWeight:600,color:BLUE}}>Rs {fmt(p.price)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{marginTop:10,fontSize:12,color:MID_GREY}}>💡 Click any product to add it to Item 1 in the document generator.</div>
          </>}
          {!priceList.length&&<div style={{color:MID_GREY,fontSize:13,padding:"20px 0"}}>No price list loaded. Upload an Excel file with columns: Code | Description | Price, or a PDF price list.</div>}
        </>)}

        {/* ══ COMMUNICATIONS TAB ══ */}
        {tab==="comms"&&(
          <div style={{display:"flex",flexDirection:"column",gap:18}}>
            {card(<>
              {sectionTitle("📨","Email & WhatsApp Generator")}
              <p style={{color:MID_GREY,fontSize:13,marginBottom:16}}>
                Fill in client details and items in the Document tab first, then generate your message here. The AI will write it based on your document.
              </p>
              <div style={{background:LIGHT_BLUE,borderRadius:8,padding:12,marginBottom:16,fontSize:13}}>
                <strong style={{color:BLUE}}>Current document:</strong> {docType} – {ref} – {client.name||"(no client)"} – Rs {fmt(grandTotal)}
              </div>
              <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
                <button onClick={generateEmail} disabled={generatingMsg} style={{background:BLUE,color:"#fff",border:"none",borderRadius:8,padding:"10px 20px",cursor:"pointer",fontWeight:600,fontSize:13,opacity:generatingMsg?0.6:1}}>
                  {generatingMsg?"⏳ Generating...":"✉️ Generate Email Draft"}
                </button>
                <button onClick={generateWhatsApp} disabled={generatingMsg} style={{background:"#25D366",color:"#fff",border:"none",borderRadius:8,padding:"10px 20px",cursor:"pointer",fontWeight:600,fontSize:13,opacity:generatingMsg?0.6:1}}>
                  {generatingMsg?"⏳ Generating...":"💬 Generate WhatsApp Message"}
                </button>
              </div>
            </>)}

            {emailDraft&&card(<>
              {sectionTitle("✉️","Email Draft")}
              <div style={{marginBottom:10}}>
                <div style={{fontSize:12,color:MID_GREY,fontWeight:600,marginBottom:4}}>Subject:</div>
                <div style={{background:LIGHT_BLUE,borderRadius:6,padding:"8px 12px",fontSize:13,fontWeight:600,color:BLUE}}>{emailDraft.subject}</div>
              </div>
              <div style={{fontSize:12,color:MID_GREY,fontWeight:600,marginBottom:4}}>Body:</div>
              <textarea value={emailDraft.body} onChange={e=>setEmailDraft({...emailDraft,body:e.target.value})}
                style={{width:"100%",minHeight:220,border:"1px solid #ddd",borderRadius:8,padding:"12px",fontSize:13,lineHeight:1.6,boxSizing:"border-box",fontFamily:"inherit"}}/>
              <div style={{display:"flex",gap:10,marginTop:10}}>
                <button onClick={()=>{navigator.clipboard.writeText(`Subject: ${emailDraft.subject}\n\n${emailDraft.body}`);notify("✅ Email copied to clipboard!");}}
                  style={{background:BLUE,color:"#fff",border:"none",borderRadius:8,padding:"9px 18px",cursor:"pointer",fontWeight:600,fontSize:13}}>
                  📋 Copy Email
                </button>
                <button onClick={()=>{const ml=`mailto:${client.email||""}?subject=${encodeURIComponent(emailDraft.subject)}&body=${encodeURIComponent(emailDraft.body)}`;window.open(ml);}}
                  style={{background:LIGHT_BLUE,color:BLUE,border:`1px solid ${BLUE}`,borderRadius:8,padding:"9px 18px",cursor:"pointer",fontWeight:600,fontSize:13}}>
                  📧 Open in Mail App
                </button>
              </div>
            </>)}

            {whatsappDraft&&card(<>
              {sectionTitle("💬","WhatsApp Message")}
              <textarea value={whatsappDraft} onChange={e=>setWhatsappDraft(e.target.value)}
                style={{width:"100%",minHeight:140,border:"1px solid #ddd",borderRadius:8,padding:"12px",fontSize:13,lineHeight:1.6,boxSizing:"border-box",fontFamily:"inherit"}}/>
              <div style={{display:"flex",gap:10,marginTop:10}}>
                <button onClick={()=>{navigator.clipboard.writeText(whatsappDraft);notify("✅ Message copied!");}}
                  style={{background:"#25D366",color:"#fff",border:"none",borderRadius:8,padding:"9px 18px",cursor:"pointer",fontWeight:600,fontSize:13}}>
                  📋 Copy Message
                </button>
                {client.contact&&<button onClick={()=>{const num=client.contact.replace(/\D/g,"");window.open(`https://wa.me/${num}?text=${encodeURIComponent(whatsappDraft)}`);}}
                  style={{background:LIGHT_BLUE,color:BLUE,border:`1px solid ${BLUE}`,borderRadius:8,padding:"9px 18px",cursor:"pointer",fontWeight:600,fontSize:13}}>
                  📱 Open WhatsApp
                </button>}
              </div>
            </>)}

            {/* Keyword detector */}
            {card(<>
              {sectionTitle("🔔","Keyword Notification Checker")}
              <p style={{color:MID_GREY,fontSize:13,marginBottom:10}}>Paste an email or message to detect what document is needed:</p>
              <textarea id="kwtext" placeholder="Paste email or message here..." style={{width:"100%",minHeight:100,border:"1px solid #ddd",borderRadius:8,padding:"10px",fontSize:13,boxSizing:"border-box",fontFamily:"inherit"}}/>
              <button onClick={()=>{
                const text=document.getElementById("kwtext").value;
                const detected=detectKeyword(text);
                if(detected){ setDocType(detected); notify(`🔔 Detected: "${detected}" — switching document type!`); setTab("generator"); }
                else notify("No document keyword found (try: invoice, quotation, statement, delivery)","error");
              }} style={{marginTop:10,background:BLUE,color:"#fff",border:"none",borderRadius:8,padding:"9px 18px",cursor:"pointer",fontWeight:600,fontSize:13}}>
                🔍 Detect Document Type
              </button>
            </>)}
          </div>
        )}

        {/* ══ ANALYSIS TAB ══ */}
        {tab==="analysis"&&(
          <div style={{display:"flex",flexDirection:"column",gap:18}}>
            {card(<>
              {sectionTitle("📊","Client & Sales Analysis")}
              <p style={{color:MID_GREY,fontSize:13,marginBottom:14}}>Upload past invoices, quotations, or Excel files. AI will produce a full business summary.</p>
              <button onClick={()=>analysisRef.current.click()} style={{background:BLUE,color:"#fff",border:"none",borderRadius:8,padding:"10px 20px",cursor:"pointer",fontWeight:600,fontSize:13}}>
                📂 Upload Files (PDF / Excel)
              </button>
              <input ref={analysisRef} type="file" multiple accept=".xlsx,.xls,.pdf" style={{display:"none"}} onChange={analyseFiles}/>
              {analysing&&<div style={{marginTop:14,color:BLUE,fontWeight:600,fontSize:14}}>⏳ AI is analysing your files... please wait</div>}
            </>)}

            {clientAnalysis&&!clientAnalysis.error&&<>
              <div style={{background:BLUE,borderRadius:12,padding:20,color:"#fff"}}>
                <div style={{fontWeight:700,fontSize:15,marginBottom:14}}>📈 Overall Business Summary</div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:12}}>
                  {[["💰 Total Revenue",`Rs ${fmt(clientAnalysis.summary?.totalRevenue||0)}`],["🧾 Total Invoices",clientAnalysis.summary?.totalInvoices||0],["📋 Total Quotations",clientAnalysis.summary?.totalQuotations||0],["📊 Conversion Rate",clientAnalysis.summary?.overallConversionRate||"N/A"],["⭐ Top Client",clientAnalysis.summary?.topClient||"N/A"]].map(([label,val])=>(
                    <div key={label} style={{background:"#ffffff22",borderRadius:8,padding:"12px 16px"}}>
                      <div style={{fontSize:11,opacity:0.8}}>{label}</div>
                      <div style={{fontSize:16,fontWeight:700,marginTop:4}}>{val}</div>
                    </div>
                  ))}
                </div>
              </div>

              {card(<>
                {sectionTitle("👥","Client List")}
                <div style={{overflowX:"auto"}}>
                  <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                    <thead>
                      <tr style={{background:BLUE,color:"#fff"}}>
                        {["Client","BRN","VAT","Email","Sales (Rs)","Invoices","Quotations","Conversion"].map(h=>(
                          <th key={h} style={{padding:"8px 10px",textAlign:"left",fontWeight:600,fontSize:11}}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {(clientAnalysis.clients||[]).map((c,i)=>(
                        <tr key={i} style={{background:i%2===0?LIGHT_BLUE:"#fff"}}>
                          <td style={{padding:"7px 10px",fontWeight:600}}>{c.name}</td>
                          <td style={{padding:"7px 10px",color:MID_GREY}}>{c.brn}</td>
                          <td style={{padding:"7px 10px",color:MID_GREY}}>{c.vat}</td>
                          <td style={{padding:"7px 10px",color:MID_GREY}}>{c.email}</td>
                          <td style={{padding:"7px 10px",color:BLUE,fontWeight:600}}>Rs {fmt(c.totalSales||0)}</td>
                          <td style={{padding:"7px 10px",textAlign:"center"}}>{c.invoiceCount}</td>
                          <td style={{padding:"7px 10px",textAlign:"center"}}>{c.quotationCount}</td>
                          <td style={{padding:"7px 10px",color:GREEN,fontWeight:600}}>{c.conversionRate}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <button onClick={()=>{
                  const csv=["Client,BRN,VAT,Email,Sales,Invoices,Quotations,Conversion",...(clientAnalysis.clients||[]).map(c=>`${c.name},${c.brn},${c.vat},${c.email},${c.totalSales},${c.invoiceCount},${c.quotationCount},${c.conversionRate}`)].join("\n");
                  const blob=new Blob([csv],{type:"text/csv"});
                  const url=URL.createObjectURL(blob);
                  const a=document.createElement("a");a.href=url;a.download="client_analysis.csv";a.click();
                  notify("✅ Analysis exported as CSV!");
                }} style={{marginTop:14,background:LIGHT_BLUE,color:BLUE,border:`1px solid ${BLUE}`,borderRadius:8,padding:"9px 18px",cursor:"pointer",fontWeight:600,fontSize:13}}>
                  ⬇ Export as CSV
                </button>
              </>)}
            </>}
            {clientAnalysis?.error&&<div style={{color:"red",padding:14,background:"#FFE8E8",borderRadius:8}}>{clientAnalysis.error}</div>}
          </div>
        )}

      </div>
    </div>
  );
}
