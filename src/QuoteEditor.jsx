import { useState } from "react";
import { supabase } from "./supabaseClient";
import { buildDocPdf, fmt, docPrefix } from "./docPdf";
import { PRODUCT_OPTIONS, VAT_RATE } from "./products";

// Quotation card in a WhatsApp chat: check the bot's quotation (or make one), choose bank details,
// then approve. Approving takes the next PSM/Q number, saves it with the other documents and
// sends the PDF to the client on WhatsApp.

const BLUE = "#1B4F8A";
const LIGHT_BLUE = "#E8EFF8";
const GREEN = "#1A7A3C";
const MID_GREY = "#666666";

const btn=(bg,fg,extra={})=>({background:bg,color:fg,border:"none",borderRadius:8,padding:"10px 14px",cursor:"pointer",fontWeight:600,fontSize:14,...extra});
const field={width:"100%",boxSizing:"border-box",padding:8,fontSize:14,borderRadius:6,border:"1px solid #ccc",fontFamily:"inherit"};

function todayMU(){ return new Date().toLocaleDateString("en-CA",{timeZone:"Indian/Mauritius"}); }
function toBase64(buf){
  const bytes=new Uint8Array(buf);
  let s="";
  for(let i=0;i<bytes.length;i+=0x8000) s+=String.fromCharCode.apply(null,bytes.subarray(i,i+0x8000));
  return window.btoa(s);
}

export default function QuoteEditor({quote,contact,caption,followup,draftId,waId,api,onSent,onCancel}){
  const [name,setName]=useState((quote&&quote.client_name)||(contact&&(contact.name||contact.profile_name))||"");
  const [location,setLocation]=useState((quote&&quote.location)||"");
  const [lines,setLines]=useState(()=>(quote&&quote.items&&quote.items.length)
    ?quote.items.map(i=>({desc:i.desc,qty:String(i.qty),price:String(i.unit_price_incl_vat||"")}))
    :[{desc:"",qty:"",price:""}]);
  const [bank,setBank]=useState("");
  const [message,setMessage]=useState(caption||"Here is your quotation from Paving Mauritius. Let us know if you have any questions.");
  const [working,setWorking]=useState(false);
  const [err,setErr]=useState("");
  const [previewUrl,setPreviewUrl]=useState("");
  const [savedRef,setSavedRef]=useState("");
  const [after,setAfter]=useState(()=>String(followup||"").split(/\n---\n/).map(t=>t.trim()).filter(Boolean));

  const calc=lines.map(l=>{
    const qty=parseFloat(l.qty)||0;
    const unitPrice=(parseFloat(l.price)||0)/(1+VAT_RATE); // price before VAT, not rounded
    return {desc:l.desc.trim(),qty,unitPrice,total:qty*unitPrice,code:""};
  }).filter(l=>l.desc&&l.qty>0);
  const subtotal=calc.reduce((s,l)=>s+l.total,0);
  const vat=subtotal*VAT_RATE;
  const total=subtotal+vat;
  const client={name:name.trim(),address:location.trim(),city:"",area:"",brn:"",vat:"",contact:`+${waId}`,email:""};
  const ready=Boolean(calc.length&&name.trim()&&bank);

  // Any edit after saving means a new quotation, so it will get a new number.
  function changed(){ setPreviewUrl(""); setSavedRef(""); }
  function setLine(i,patch){ setLines(ls=>ls.map((l,j)=>j===i?{...l,...patch}:l)); changed(); }
  function pick(i,idx){
    const o=PRODUCT_OPTIONS[Number(idx)];
    if(o) setLine(i,{desc:o.desc,price:String(o.price)});
  }

  async function makePdf(ref){
    return buildDocPdf({
      docType:"Quotation",docRef:ref,date:todayMU(),client,toName:client.name,
      calcItems:calc,subtotal,vat,total,includeBank:bank==="sbm",
    });
  }

  async function preview(){
    setErr(""); setWorking(true);
    try{
      const doc=await makePdf("PSM/Q/(preview)");
      setPreviewUrl(URL.createObjectURL(doc.output("blob")));
    }catch(e){ setErr(`Could not make the preview: ${e.message}`); }
    setWorking(false);
  }

  // Takes the next number from the same counter as the Documents tab.
  async function nextRef(){
    const {data:num,error}=await supabase.rpc("get_next_ref",{p_doc_type:"Quotation"});
    if(error||num===null||num===undefined) throw new Error("Could not get the next quotation number");
    return `${docPrefix("Quotation")}/${String(num).padStart(3,"0")}`;
  }

  async function record(ref){
    try{
      await supabase.from("documents").insert({
        doc_type:"Quotation",ref,doc_date:todayMU(),client_name:client.name||null,client_snapshot:client,
        items:calc,include_bank:bank==="sbm",total,
      });
    }catch{ /* the PDF exists; only the record failed */ }
  }

  async function approve(){
    if(!ready) return;
    setErr(""); setWorking(true);
    try{
      const ref=savedRef||await nextRef();
      const doc=await makePdf(ref);
      await api("send_pdf",{
        wa_id:waId,filename:`${ref.replace(/\//g,"_")}.pdf`,data:toBase64(doc.output("arraybuffer")),
        body:message,draft_id:draftId||null,ref,total,followup:after.map(t=>t.trim()).filter(Boolean).join("\n---\n"),
      });
      if(!savedRef) await record(ref);
      onSent(ref);
    }catch(e){ setErr(e.message); }
    setWorking(false);
  }

  // For sending from the phone: real number, saved with the documents, PDF downloaded.
  async function saveOnly(){
    if(!ready) return;
    setErr(""); setWorking(true);
    try{
      const ref=savedRef||await nextRef();
      const doc=await makePdf(ref);
      if(!savedRef) await record(ref);
      try{ await api("record_quote",{wa_id:waId,ref,total}); }catch{ /* only used for payment tracking */ }
      setSavedRef(ref);
      doc.save(`${ref.replace(/\//g,"_")}.pdf`);
    }catch(e){ setErr(e.message); }
    setWorking(false);
  }

  return(
    <div style={{background:"#fff",border:`1px solid ${BLUE}`,borderRadius:10,padding:12,marginTop:8}}>
      <div style={{fontWeight:700,color:BLUE,marginBottom:4}}>📄 Quotation</div>
      {quote&&quote.summary&&<div style={{fontSize:13,color:MID_GREY,marginBottom:8}}>{quote.summary}</div>}

      <div style={{display:"grid",gap:6,marginBottom:10}}>
        <input value={name} onChange={e=>{ setName(e.target.value); changed(); }} placeholder="Client name (on the quotation)" style={field}/>
        <input value={location} onChange={e=>{ setLocation(e.target.value); changed(); }} placeholder="Address / town (optional)" style={field}/>
      </div>

      {lines.map((l,i)=>{
        const qty=parseFloat(l.qty)||0;
        const lineTotal=qty*(parseFloat(l.price)||0);
        return(
          <div key={i} style={{background:LIGHT_BLUE,borderRadius:8,padding:8,marginBottom:6}}>
            <select value="" onChange={e=>pick(i,e.target.value)} style={{...field,marginBottom:6}}>
              <option value="">Choose a product…</option>
              {PRODUCT_OPTIONS.map((o,idx)=><option key={o.desc} value={idx}>{o.desc} – Rs {fmt(o.price)}</option>)}
            </select>
            <input value={l.desc} onChange={e=>setLine(i,{desc:e.target.value})} placeholder="Description" style={{...field,marginBottom:6}}/>
            <div style={{display:"flex",gap:6,alignItems:"center"}}>
              <input value={l.qty} onChange={e=>setLine(i,{qty:e.target.value})} placeholder="Pieces" inputMode="numeric" style={{...field,flex:1}}/>
              <input value={l.price} onChange={e=>setLine(i,{price:e.target.value})} placeholder="Rs/piece incl. VAT" inputMode="decimal" style={{...field,flex:1}}/>
              <button onClick={()=>{ setLines(ls=>ls.length>1?ls.filter((_,j)=>j!==i):[{desc:"",qty:"",price:""}]); changed(); }} style={btn("#fff","#B00020",{padding:"6px 10px",border:"1px solid #B00020"})}>✖</button>
            </div>
            <div style={{fontSize:12,color:MID_GREY,marginTop:4,textAlign:"right"}}>Line total incl. VAT: Rs {fmt(lineTotal)}</div>
          </div>
        );
      })}
      <button onClick={()=>setLines(ls=>[...ls,{desc:"",qty:"",price:""}])} style={btn(LIGHT_BLUE,BLUE,{padding:"6px 12px",fontSize:13})}>+ Add a line</button>

      <div style={{marginTop:10,fontSize:14}}>
        <div style={{display:"flex",justifyContent:"space-between"}}><span>Subtotal (before VAT)</span><span>Rs {fmt(subtotal)}</span></div>
        <div style={{display:"flex",justifyContent:"space-between"}}><span>VAT 15%</span><span>Rs {fmt(vat)}</span></div>
        <div style={{display:"flex",justifyContent:"space-between",fontWeight:700,color:BLUE}}><span>Total</span><span>Rs {fmt(total)}</span></div>
        <div style={{fontSize:12,color:MID_GREY,marginTop:2}}>Terms on the PDF: 50% on confirmation, 50% prior to delivery. Transport not included.</div>
      </div>

      <div style={{marginTop:10,fontSize:13,fontWeight:600}}>Bank details on the quotation?</div>
      <div style={{display:"flex",gap:8,marginTop:6}}>
        <button onClick={()=>{ setBank("sbm"); changed(); }} style={btn(bank==="sbm"?BLUE:"#f2f2f2",bank==="sbm"?"#fff":"#333",{padding:"8px 12px",fontSize:13})}>SBM</button>
        <button onClick={()=>{ setBank("none"); changed(); }} style={btn(bank==="none"?BLUE:"#f2f2f2",bank==="none"?"#fff":"#333",{padding:"8px 12px",fontSize:13})}>None</button>
      </div>

      <div style={{marginTop:10,fontSize:13,fontWeight:600}}>Message sent with the PDF</div>
      <textarea value={message} onChange={e=>setMessage(e.target.value)} rows={3} style={{...field,marginTop:4}}/>

      <div style={{marginTop:10,fontSize:13,fontWeight:600}}>Messages sent after the PDF{after.length?"":" (none)"}</div>
      {after.map((t,i)=>(
        <div key={i} style={{display:"flex",gap:6,alignItems:"flex-start",marginTop:4}}>
          <textarea value={t} onChange={e=>setAfter(a=>a.map((x,j)=>j===i?e.target.value:x))} rows={Math.min(6,Math.max(2,Math.ceil(t.length/38)))} style={{...field,flex:1}}/>
          <button onClick={()=>setAfter(a=>a.filter((_,j)=>j!==i))} style={btn("#fff","#B00020",{padding:"6px 9px",border:"1px solid #B00020"})}>✖</button>
        </div>
      ))}
      <button onClick={()=>setAfter(a=>[...a,""])} style={btn(LIGHT_BLUE,BLUE,{padding:"6px 12px",fontSize:13,marginTop:6})}>+ Message after the PDF</button>

      {err&&<div style={{background:"#FFE8E8",color:"#B00020",padding:8,borderRadius:6,fontSize:13,marginTop:8}}>{err}</div>}

      <div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:10}}>
        <button onClick={approve} disabled={working||!ready} style={btn(ready?GREEN:"#9bbfa7","#fff")}>{working?"Working…":"✅ Approve & send quotation"}</button>
        <button onClick={saveOnly} disabled={working||!ready} style={btn("#fff",GREEN,{border:`1px solid ${GREEN}`})}>💾 Save PDF only</button>
        <button onClick={preview} disabled={working||!calc.length} style={btn("#fff",BLUE,{border:`1px solid ${BLUE}`})}>👁 Preview PDF</button>
        {previewUrl&&<a href={previewUrl} target="_blank" rel="noreferrer" style={{alignSelf:"center",color:BLUE,fontWeight:600}}>Open preview</a>}
        {onCancel&&<button onClick={onCancel} disabled={working} style={btn("#f2f2f2","#333")}>Close</button>}
      </div>
      {savedRef&&<div style={{background:"#E8F5ED",color:GREEN,padding:8,borderRadius:6,fontSize:13,marginTop:8}}>✅ {savedRef} saved and downloaded. Send it from the phone, or tap Approve & send to send this same quotation from here. If you change anything, it becomes a new quotation with a new number.</div>}
      {!ready&&<div style={{fontSize:12,color:MID_GREY,marginTop:6}}>To send or save: client name, at least one line, and choose SBM or None.</div>}
      <div style={{fontSize:12,color:MID_GREY,marginTop:6}}>Preview PDF shows "(preview)" instead of a number and is not saved. Don't send it to clients.</div>
    </div>
  );
}
