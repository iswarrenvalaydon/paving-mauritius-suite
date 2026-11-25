import { useState, useEffect, useCallback, useRef } from "react";
import QuoteEditor from "./QuoteEditor";
import PhotoManager from "./PhotoManager";
import { supabase } from "./supabaseClient";

// WhatsApp tab: chats on 5725 4201, the bot's suggested replies, and approve / edit / discard.
// All data goes through /api/wa-admin, which checks the team member's login (Supabase session).

const BLUE = "#1B4F8A";
const LIGHT_BLUE = "#E8EFF8";
const GREEN = "#1A7A3C";
const LIGHT_GREEN = "#E8F5ED";
const ORANGE = "#B45309";
const LIGHT_ORANGE = "#FEF3C7";
const MID_GREY = "#666666";

function when(iso){
  if(!iso) return "";
  const d=new Date(iso);
  const today=new Date();
  const same=d.toDateString()===today.toDateString();
  return same
    ? d.toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit",timeZone:"Indian/Mauritius"})
    : d.toLocaleDateString("en-GB",{day:"2-digit",month:"short",timeZone:"Indian/Mauritius"})+" "+d.toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit",timeZone:"Indian/Mauritius"});
}
const BREAK="\n---\n"; // the short messages of one suggestion are joined with this
function splitParts(t){ const p=String(t||"").split(/\n---\n/); return p.length?p:[""]; }
// A message can start with "↩ <client's words>\n": it is sent as a WhatsApp reply quoting that message.
function quoteOf(part){ const m=/^↩ ?([^\n]*)\n([\s\S]*)$/.exec(part||""); return m?{quote:m[1],text:m[2]}:{quote:"",text:part||""}; }
function withQuote(quote,text){ return quote?`↩ ${quote}\n${text}`:text; }
function quotesOf(d){
  const x=d&&d.quote;
  if(!x) return [];
  if(Array.isArray(x.quotes)) return x.quotes.filter(q=>q&&Array.isArray(q.items)&&q.items.length);
  return Array.isArray(x.items)&&x.items.length?[x]:[];
}
function hasQuote(d){ return quotesOf(d).length>0; }

function displayName(c){
  if(!c) return "";
  return c.name||c.profile_name||("+"+c.wa_id);
}
function sourceLabel(m){
  if(m.direction==="in") return "";
  if(m.source==="suite") return "sent from Suite";
  if(m.source==="phone") return "sent from phone";
  return "";
}

const btn=(bg,fg,extra={})=>({background:bg,color:fg,border:"none",borderRadius:8,padding:"10px 16px",cursor:"pointer",fontWeight:600,fontSize:14,...extra});


export default function WhatsAppInbox(){
  const authed=true; // the whole Suite is behind the login
  const [view,setView]=useState("list");
  const [chats,setChats]=useState([]);
  const [botEnabled,setBotEnabled]=useState(true);
  const [isOwner,setIsOwner]=useState(true); // Setup is for the owner only, once one is set
  const [voiceOut,setVoiceOut]=useState(null); // result of the voice test
  const [rec,setRec]=useState(false); // microphone is recording
  const [cmdOut,setCmdOut]=useState(null); // what the microphone command understood, waiting for Confirm
  const recRef=useRef({});
  const [contactForm,setContactForm]=useState({number:"",lang:"en",note:""});
  const [selected,setSelected]=useState(null);
  const [chat,setChat]=useState(null);
  const [draftText,setDraftText]=useState("");
  const [photoSel,setPhotoSel]=useState([]); // photo albums the bot suggested, still ticked
  const [albumList,setAlbumList]=useState(null); // for "Send photos" in a chat
  const [oldCalls,setOldCalls]=useState(null); // unanswered missed calls waiting to be messaged
  const [pastRefs,setPastRefs]=useState(null); // clients given Ravin's number without Ravin being told
  const [manualText,setManualText]=useState("");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [info,setInfo]=useState("");
  const [setup,setSetup]=useState(null);
  const [filter,setFilter]=useState("all");
  const [media,setMedia]=useState({});
  const [quoteOpen,setQuoteOpen]=useState(false);
  const [ravinInput,setRavinInput]=useState("");
  const [payAmount,setPayAmount]=useState("");
  const [adInput,setAdInput]=useState("");
  const [adEdit,setAdEdit]=useState(false);
  const [adEdits,setAdEdits]=useState({});
  const draftIdRef=useRef(null);
  const bottomRef=useRef(null);

  const api=useCallback(async(action,payload={})=>{
    const {data:auth}=await supabase.auth.getSession();
    const res=await fetch("/api/wa-admin",{
      method:"POST",
      headers:{"Content-Type":"application/json",Authorization:`Bearer ${auth?.session?.access_token||""}`},
      body:JSON.stringify({action,...payload}),
    });
    let data={};
    try{ data=await res.json(); }catch{ data={error:`Server error (${res.status})`}; }
    if(res.status===401) throw new Error(data.error||"Please log out and log in again.");
    if(!res.ok) throw new Error(data.error||`Error ${res.status}`);
    return data;
  },[]);

  const loadChats=useCallback(async()=>{
    try{
      const data=await api("chats");
      setChats(data.chats||[]);
      setBotEnabled(data.bot_enabled!==false);
      setIsOwner(data.is_owner!==false);
      setError("");
    }catch(e){ setError(e.message); }
  },[api]);

  const loadChat=useCallback(async(waId)=>{
    if(!waId) return;
    try{
      const data=await api("chat",{wa_id:waId});
      setChat(data);
      const newDraftId=data.draft?data.draft.id:null;
      if(newDraftId!==draftIdRef.current){
        draftIdRef.current=newDraftId;
        setDraftText(data.draft?data.draft.body||"":"");
        setPhotoSel(data.draft&&data.draft.quote&&Array.isArray(data.draft.quote.photos)?data.draft.quote.photos:[]);
      }
      setError("");
    }catch(e){ setError(e.message); }
  },[api]);

  // Refresh the chat list, and the open chat, every 15 seconds.
  useEffect(()=>{
    if(!authed) return undefined;
    loadChats();
    const t=setInterval(()=>{
      loadChats();
      if(view==="chat"&&selected) loadChat(selected);
    },15000);
    return ()=>clearInterval(t);
  },[authed,view,selected,loadChats,loadChat]);

  useEffect(()=>{
    if(view==="chat"&&bottomRef.current) bottomRef.current.scrollIntoView({block:"end"});
  },[chat,view]);

  async function showMedia(messageId){
    setMedia(m=>({...m,[messageId]:{loading:true}}));
    try{
      const r=await api("media",{message_id:messageId});
      const bytes=Uint8Array.from(window.atob(r.data),c=>c.charCodeAt(0));
      const url=URL.createObjectURL(new Blob([bytes],{type:r.mime}));
      setMedia(m=>({...m,[messageId]:{url,mime:r.mime}}));
    }catch(e){ setMedia(m=>({...m,[messageId]:{error:e.message}})); }
  }

  function openChat(waId){
    setSelected(waId); setChat(null); setView("chat"); setMedia({}); setQuoteOpen(false); setPayAmount(""); setAdInput(""); setAdEdit(false); setAlbumList(null);
    draftIdRef.current=null; setDraftText(""); setManualText(""); setInfo("");
    loadChat(waId);
  }

  async function sendMessage(text,draftId){
    const attach=Boolean(draftId&&chat&&chat.draft&&chat.draft.quote&&chat.draft.quote.attach)||Boolean(draftId&&photoSel.length);
    if(!text.replace(/-{3}/g,"").trim()&&!attach) return;
    setBusy(true); setError(""); setInfo("");
    try{
      const r=await api("send",{wa_id:selected,body:text,draft_id:draftId||null,...(draftId?{photos:photoSel}:{})});
      setInfo(r&&r.referral_sent?"✅ Sent, and Ravin has been told":"✅ Sent");
      if(r&&r.warning) setError(r.warning);
      if(draftId){ draftIdRef.current=null; setDraftText(""); } else setManualText("");
      await loadChat(selected); loadChats();
    }catch(e){ setError(e.message); }
    setBusy(false);
  }

  async function act(action,payload,doneMsg){
    setBusy(true); setError(""); setInfo("");
    try{
      const r=await api(action,payload);
      if(doneMsg) setInfo(doneMsg);
      return r;
    }catch(e){ setError(e.message); return null; }
    finally{ setBusy(false); }
  }

  async function quoteSent(ref,r){
    if(r&&r.remaining>0){
      setInfo(`✅ Quotation ${ref} sent. ${r.remaining} more to send.`);
      await loadChat(selected); return;
    }
    if(r&&r.warning) setError(r.warning);
    setInfo(`✅ Quotation ${ref} sent and saved`);
    setQuoteOpen(false); draftIdRef.current=null; setDraftText("");
    await loadChat(selected); loadChats();
  }

  async function discardDraft(){
    if(!chat||!chat.draft) return;
    const r=await act("discard",{draft_id:chat.draft.id},"Suggestion discarded");
    if(r){ draftIdRef.current=null; setDraftText(""); await loadChat(selected); loadChats(); }
  }

  async function saveAd(){
    if(!chat||!chat.ad||!adInput.trim()) return;
    const r=await act("describe_ad",{wa_id:selected,key:chat.ad.key,label:chat.ad.label,url:chat.ad.url,value:adInput},"Ad saved, new suggestion written");
    if(r){ setAdInput(""); setAdEdit(false); draftIdRef.current=null; await loadChat(selected); loadChats(); }
  }

  async function pickAd(key){
    const r=await act("pick_ad",{wa_id:selected,value:key},"Noted, new suggestion written");
    if(r){ draftIdRef.current=null; setDraftText(""); await loadChat(selected); loadChats(); }
  }

  async function redraft(){
    const r=await act("redraft",{wa_id:selected},"New suggestion written");
    if(r) await loadChat(selected);
  }

  async function togglePause(){
    if(!chat||!chat.contact) return;
    const r=await act("pause_contact",{wa_id:selected,value:!chat.contact.bot_paused},chat.contact.bot_paused?"Bot back on for this client":"Bot paused for this client");
    if(r) loadChat(selected);
  }

  async function toggleBot(){
    const r=await act("bot_enabled",{value:!botEnabled},botEnabled?"Bot paused for everyone":"Bot back on");
    if(r) loadChats();
  }

  async function openSetup(){
    setView("setup"); setSetup(null);
    const r=await act("status");
    if(r) setSetup(r);
  }

  async function connectWebhook(){
    const r=await act("connect_webhook",{},"✅ WhatsApp connected to the Suite");
    if(r) openSetup();
  }

  const header=(
    <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap",marginBottom:12}}>
      {view!=="list"&&<button onClick={()=>{ setView("list"); setSelected(null); setInfo(""); loadChats(); }} style={btn(LIGHT_BLUE,BLUE,{padding:"8px 12px"})}>← Chats</button>}
      <div style={{fontWeight:700,fontSize:17,color:BLUE,flex:1}}>
        {view==="chat"&&chat?displayName(chat.contact):view==="setup"?"Bot setup":"💬 WhatsApp · 5725 4201"}
      </div>
      {view==="list"&&(
        <>
          <button onClick={toggleBot} disabled={busy} style={btn(botEnabled?LIGHT_GREEN:LIGHT_ORANGE,botEnabled?GREEN:ORANGE,{padding:"8px 12px",fontSize:13})}>
            {botEnabled?"🤖 Bot on":"⏸ Bot paused"}
          </button>
          {isOwner&&<button onClick={openSetup} style={btn(LIGHT_BLUE,BLUE,{padding:"8px 12px",fontSize:13})}>⚙️ Setup</button>}
        </>
      )}
    </div>
  );

  const banner=(
    <>
      {error&&<div style={{background:"#FFE8E8",color:"#B00020",padding:10,borderRadius:8,fontSize:13,marginBottom:10}}>{error}</div>}
      {info&&<div style={{background:LIGHT_GREEN,color:GREEN,padding:10,borderRadius:8,fontSize:13,marginBottom:10}}>{info}</div>}
    </>
  );

  // ── Setup page ─────────────────────────────────
  if(view==="setup"){
    const row=(ok,label,detail)=>(
      <div style={{display:"flex",gap:10,padding:"10px 0",borderBottom:"1px solid #eee",fontSize:14}}>
        <span>{ok?"✅":"❌"}</span>
        <div><div style={{fontWeight:600}}>{label}</div>{detail&&<div style={{color:MID_GREY,fontSize:12,wordBreak:"break-all"}}>{detail}</div>}</div>
      </div>
    );
    return(
      <div style={{background:"#fff",borderRadius:12,padding:18,boxShadow:"0 2px 10px #0001"}}>
        {header}{banner}
        {!setup&&<div style={{color:MID_GREY}}>Checking…</div>}
        {setup&&(
          <>
            {!setup.owner_set&&(
              <div style={{background:LIGHT_ORANGE,border:`1px solid ${ORANGE}`,borderRadius:8,padding:10,marginBottom:10,fontSize:13}}>
                Setup is open to every login. Tap the button to make <b>this login</b> the only owner: nobody else (for example Julien) will see or use Setup afterwards.
                <div><button onClick={async()=>{ if(window.confirm("Make this login the only owner of Setup? Only do this from your own login.")){ const r=await act("claim_owner",{},"You are now the owner"); if(r) openSetup(); } }} disabled={busy}
                  style={btn(ORANGE,"#fff",{marginTop:8,padding:"6px 12px",fontSize:13})}>Make me the owner</button></div>
              </div>
            )}
            {row(setup.keys?.whatsapp,"WhatsApp key (360dialog)")}
            {row(setup.keys?.claude,"Claude key")}
            {row(setup.keys?.speech,"Speech key (voice commands)",setup.keys?.speech?null:"Add OPENAI_API_KEY in Vercel to switch voice commands on")}
            {row(setup.keys?.database,"Database key")}
            {row(setup.tables,"Bot tables in Supabase",setup.tables?null:"Run the SQL from supabase/whatsapp_bot.sql in Supabase's SQL Editor")}
            {row(setup.webhook_ok,"WhatsApp messages arriving in the Suite",setup.webhook_url||setup.webhook_error||"Not connected yet")}
            {!setup.webhook_ok&&(
              <button onClick={connectWebhook} disabled={busy||!setup.tables} style={btn(GREEN,"#fff",{marginTop:14,width:"100%"})}>
                {busy?"Connecting…":"Connect WhatsApp to the Suite"}
              </button>
            )}
            <div style={{marginTop:18,fontWeight:700,color:BLUE,fontSize:14}}>Contact a client</div>
            <div style={{fontSize:12,color:MID_GREY,marginBottom:6}}>Sends the Sales Manager's first message. When the client replies, the bot carries on and prepares what you write below (quotations wait for your approval). You can also WhatsApp the bot: "contact 5762 9412 in French, send quotation for 20 m² of 600x300", by text or voice note.</div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:6}}>
              <input value={contactForm.number} onChange={e=>setContactForm({...contactForm,number:e.target.value})} placeholder="Number, e.g. 5762 9412" inputMode="tel" style={{flex:1,minWidth:150,padding:8,fontSize:14,borderRadius:6,border:"1px solid #ccc"}}/>
              <select value={contactForm.lang} onChange={e=>setContactForm({...contactForm,lang:e.target.value})} style={{padding:8,fontSize:14,borderRadius:6,border:"1px solid #ccc"}}><option value="en">English</option><option value="fr">Français</option></select>
            </div>
            <input value={contactForm.note} onChange={e=>setContactForm({...contactForm,note:e.target.value})} placeholder="Optional: e.g. quotation for 20 m² of 600x300 Light Grey" style={{width:"100%",boxSizing:"border-box",padding:8,fontSize:14,borderRadius:6,border:"1px solid #ccc",marginBottom:6}}/>
            <button onClick={async()=>{ const r=await act("contact_client",contactForm,""); if(r){ setInfo(`✅ First message sent to ${r.contacted.pretty}`); setContactForm({number:"",lang:contactForm.lang,note:""}); } }} disabled={busy||contactForm.number.replace(/\D/g,"").length<8}
              style={btn(GREEN,"#fff",{padding:"6px 12px",fontSize:13,marginBottom:6})}>Contact this client</button>
            <div style={{marginTop:18,fontWeight:700,color:BLUE,fontSize:14}}>Voice command</div>
            <div style={{fontSize:12,color:MID_GREY,marginBottom:6}}>Tap, speak, tap again. For example: "Contact 5762 9412 in French, send quotation for 20 m² of 600x300". It shows what it heard and waits for your Confirm. Only visible to you; nothing goes through the WhatsApp chat.</div>
            <button disabled={busy&&!rec} onClick={async()=>{
              if(rec){ try{ recRef.current.mr.stop(); }catch{ setRec(false); } return; }
              if(!navigator.mediaDevices||!window.MediaRecorder){ setError("This browser can't record. Use Chrome or Safari, or the Voice test with a file."); return; }
              try{
                const stream=await navigator.mediaDevices.getUserMedia({audio:true});
                const mr=new window.MediaRecorder(stream); const chunks=[];
                mr.ondataavailable=(ev)=>{ if(ev.data&&ev.data.size) chunks.push(ev.data); };
                mr.onstop=async()=>{
                  window.clearTimeout(recRef.current.t); stream.getTracks().forEach(t=>t.stop()); setRec(false);
                  const blob=new Blob(chunks,{type:mr.mimeType||"audio/webm"});
                  if(blob.size<1500){ setError("I didn't hear anything. Try again."); return; }
                  const data=await new Promise((ok)=>{ const rd=new FileReader(); rd.onload=()=>ok(String(rd.result).split(",")[1]||""); rd.readAsDataURL(blob); });
                  setCmdOut(null); const r=await act("voice_test",{data,mime:blob.type},""); if(r) setCmdOut(r);
                };
                recRef.current={mr,t:window.setTimeout(()=>{ try{ mr.stop(); }catch{ /* already stopped */ } },60000)};
                setCmdOut(null); mr.start(); setRec(true);
              }catch{ setError("The microphone is blocked. Allow it for this site in your browser settings."); }
            }} style={btn(rec?"#B91C1C":GREEN,"#fff",{padding:"8px 14px",fontSize:14,marginBottom:6})}>{rec?"⏹ Stop and send":"🎙️ Record a command"}</button>
            {cmdOut&&(
              <div style={{border:"1px solid #eee",borderRadius:8,padding:8,fontSize:13,marginBottom:6}}>
                <div><b>I heard:</b> {cmdOut.heard||"(nothing)"}</div>
                {cmdOut.command&&cmdOut.command.action==="contact"?(
                  <>
                    <div style={{marginTop:4}}>I will contact <b>+{cmdOut.command.number}</b> in {cmdOut.command.lang==="fr"?"French":"English"}{cmdOut.command.note?`, then prepare: ${cmdOut.command.note}`:""}.{cmdOut.command.send_quote&&(cmdOut.command.bank==="sbm"||cmdOut.command.bank==="none")?<b> The quotation ({cmdOut.command.bank==="sbm"?"SBM bank details":"no bank details"}) goes out as soon as they reply, with no approval.</b>:null}</div>
                    <div style={{marginTop:6,display:"flex",gap:8}}>
                      <button disabled={busy} onClick={async()=>{ const c=cmdOut.command; const r=await act("contact_client",{number:c.number,lang:c.lang,note:c.note||"",send_quote:Boolean(c.send_quote),bank:c.bank||""},""); if(r){ setInfo(`✅ First message sent to ${r.contacted.pretty}${r.contacted.direct?". The quotation goes out when they reply.":""}`); setCmdOut(null); } }} style={btn(GREEN,"#fff",{padding:"6px 12px",fontSize:13})}>✅ Confirm</button>
                      <button disabled={busy} onClick={()=>setCmdOut(null)} style={btn("#fff",MID_GREY,{border:"1px solid #ccc",padding:"6px 12px",fontSize:13})}>Cancel</button>
                    </div>
                  </>
                ):(
                  <div style={{marginTop:4,color:MID_GREY}}>I didn't find a command in it. Try: "Contact 5762 9412".</div>
                )}
              </div>
            )}
            <div style={{marginTop:18,fontWeight:700,color:BLUE,fontSize:14}}>Voice test</div>
            <div style={{fontSize:12,color:MID_GREY,marginBottom:6}}>Choose a recording (English, French or Creole). It shows what the speech service heard and what the bot would do. Nothing is sent to anyone.</div>
            <input type="file" accept="audio/*,video/mp4" disabled={busy} onChange={async(e)=>{ const f=e.target.files&&e.target.files[0]; e.target.value=""; if(!f) return; if(f.size>3000000){ setError("Recording too big (max about 3 MB, about 2 minutes)"); return; }
              const data=await new Promise((ok)=>{ const rd=new FileReader(); rd.onload=()=>ok(String(rd.result).split(",")[1]||""); rd.readAsDataURL(f); });
              setVoiceOut(null); const r=await act("voice_test",{data,mime:f.type||"audio/mp4"},""); if(r) setVoiceOut(r); }} style={{fontSize:13,marginBottom:6}}/>
            {voiceOut&&(
              <div style={{border:"1px solid #eee",borderRadius:8,padding:8,fontSize:13,marginBottom:6}}>
                <div><b>Heard:</b> {voiceOut.heard||"(nothing)"}</div>
                <div style={{marginTop:4,color:MID_GREY}}>{voiceOut.command&&voiceOut.command.action==="contact"?`Would contact +${voiceOut.command.number} in ${voiceOut.command.lang==="fr"?"French":"English"}${voiceOut.command.note?`, then prepare: ${voiceOut.command.note}`:""}`:"No command found in it."}</div>
              </div>
            )}
            <div style={{marginTop:18,fontWeight:700,color:BLUE,fontSize:14}}>Overnight messages</div>
            <div style={{fontSize:12,color:MID_GREY,marginBottom:6}}>Every day at 7:00 the bot answers what arrived overnight. Tap here to do it now (needs automatic sending on). Quotations, payment proofs and anything flagged still wait for you.</div>
            <button onClick={async()=>{ const r=await act("catch_up",{},""); if(r) window.alert(r.skipped?`Nothing done: ${r.skipped}`:`Sent: ${r.sent}\nWritten: ${r.written}\nStill waiting for you: ${r.held}${r.errors?`\nErrors: ${r.errors}`:""}`); }} disabled={busy}
              style={btn(GREEN,"#fff",{padding:"6px 12px",fontSize:13,marginBottom:6})}>☀️ Answer overnight messages now</button>
            <div style={{marginTop:18,fontWeight:700,color:BLUE,fontSize:14}}>Old missed calls</div>
            <div style={{fontSize:12,color:MID_GREY,marginBottom:6}}>Sends the "Sorry we missed your call" message once to everyone who called and was never answered. Saved contacts, staff, and anyone already answered or who wrote since are skipped.</div>
            <button onClick={async()=>{ const r=await act("missed_backlog",{value:"preview"},""); if(r) setOldCalls(r.calls||[]); }} disabled={busy}
              style={btn("#fff",BLUE,{border:`1px solid ${BLUE}`,padding:"6px 10px",fontSize:12,marginBottom:6})}>🔎 Check old missed calls</button>
            {oldCalls&&!oldCalls.length&&<div style={{fontSize:12,color:MID_GREY,marginBottom:6}}>No unanswered missed calls.</div>}
            {oldCalls&&oldCalls.length>0&&(
              <div style={{marginBottom:8}}>
                <div style={{fontSize:12,marginBottom:6}}><b>{oldCalls.length}</b> caller{oldCalls.length>1?"s":""} will get the message: {oldCalls.slice(0,8).map(c=>`+${c.wa_id}`).join(", ")}{oldCalls.length>8?"…":""}</div>
                <button onClick={async()=>{ if(!window.confirm(`Send the missed-call message to ${oldCalls.length} caller(s) now?`)) return; const r=await act("missed_backlog",{value:"send"},""); if(r){ window.alert(`Sent: ${r.sent}${r.failed.length?`\nFailed: ${r.failed.length} (${r.failed[0].error})`:""}${r.remaining?`\n${r.remaining} still waiting, tap Send again`:""}`); const p=await act("missed_backlog",{value:"preview"},""); if(p) setOldCalls(p.calls||[]); } }} disabled={busy}
                  style={btn(GREEN,"#fff",{padding:"6px 12px",fontSize:13})}>Send to all ({Math.min(oldCalls.length,20)} at a time)</button>
              </div>
            )}
            <div style={{marginTop:18,fontWeight:700,color:BLUE,fontSize:14}}>Layer referrals (Ravin)</div>
            <div style={{fontSize:12,color:MID_GREY,marginBottom:6}}>When a client wants a layer, the bot gives Ravin's number and, once you approve, sends Ravin the client's name, number, location, product and area. If you or Julien give Ravin's number yourselves (from the Suite or the phone), Ravin is told too, once per client. When the client pays, tap the payment button in their chat to update Ravin.</div>
            <button onClick={async()=>{ const r=await act("past_referrals",{},""); if(r) setPastRefs(r.clients||[]); }} disabled={busy}
              style={btn("#fff",BLUE,{border:`1px solid ${BLUE}`,padding:"6px 10px",fontSize:12,marginBottom:6})}>🔎 Check past chats for Ravin's number</button>
            {pastRefs&&!pastRefs.length&&<div style={{fontSize:12,color:MID_GREY,marginBottom:6}}>No client was given Ravin's number without Ravin being told.</div>}
            {pastRefs&&pastRefs.map(c=>(
              <div key={c.wa_id} style={{border:"1px solid #eee",borderRadius:8,padding:8,marginBottom:6,fontSize:12}}>
                <div><b>{c.name||`+${c.wa_id}`}</b> · +{c.wa_id} · {new Date(c.sent_at).toLocaleDateString("en-GB")}</div>
                <div style={{color:MID_GREY,margin:"2px 0 6px"}}>"{c.text}"</div>
                <button onClick={async()=>{ const r=await act("refer_ravin",{wa_id:c.wa_id},"✅ Ravin told"); if(r) setPastRefs(pastRefs.filter(x=>x.wa_id!==c.wa_id)); }} disabled={busy}
                  style={btn(GREEN,"#fff",{padding:"4px 10px",fontSize:12})}>Tell Ravin</button>
              </div>
            ))}
            <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
              <input value={ravinInput} onChange={e=>setRavinInput(e.target.value)} placeholder={setup.ravin_number?`+${setup.ravin_number}`:"Ravin's number, e.g. 5xxx xxxx"} inputMode="tel"
                style={{flex:1,minWidth:160,padding:8,fontSize:14,borderRadius:6,border:"1px solid #ccc"}}/>
              <button onClick={async()=>{ const r=await act("ravin_number",{value:ravinInput},"Ravin's number saved"); if(r){ setRavinInput(""); openSetup(); } }} disabled={busy||!ravinInput.trim()}
                style={btn(BLUE,"#fff",{padding:"8px 12px",fontSize:13})}>Save</button>
            </div>
            {row(Boolean(setup.ravin_number),"Ravin's number",setup.ravin_number?`+${setup.ravin_number}`:"Not saved yet")}
            {(()=>{
              const t=setup.templates||{};
              const label=(st)=>st==="missing"?"Not created yet":st?`Status: ${st}`:"Unknown";
              return(
                <>
                  {row(t.referral==="approved","Template: referral message to Ravin",t.error||label(t.referral))}
                  {row(t.payment==="approved","Template: payment update to Ravin",t.error||label(t.payment))}
                  {row(t.missed==="approved","Template: missed-call message to clients",t.error||label(t.missed))}
                  {row(t.contactEn==="approved","Template: Sales Manager first message (English)",t.error||label(t.contactEn))}
                  {row(t.contactFr==="approved","Template: Sales Manager first message (French)",t.error||label(t.contactFr))}
                  {row(t.sales==="approved","Template: big-order alert to the Sales Manager",t.error||label(t.sales))}
                  {row(t.breakdownCheck==="approved","Template: \"is it repaired?\" breakdown check",t.error||label(t.breakdownCheck))}
                  {row(t.breakdownAlert==="approved","Template: breakdown alert to Iswarren",t.error||label(t.breakdownAlert))}
                  {[t.referral,t.payment,t.missed,t.sales,t.breakdownCheck,t.breakdownAlert,t.contactEn,t.contactFr].includes("missing")&&(
                    <button onClick={async()=>{ const r=await act("create_referral_template",{},""); if(r){ if(r.failed&&r.failed.length) setError(`WhatsApp refused: ${r.failed.join(" · ")}`); else setInfo("Templates sent to WhatsApp for approval"); openSetup(); } }} disabled={busy}
                      style={btn(GREEN,"#fff",{marginTop:8,padding:"8px 12px",fontSize:13})}>Create the templates</button>
                  )}
                  {[t.referral,t.payment,t.missed,t.sales,t.breakdownCheck,t.breakdownAlert,t.contactEn,t.contactFr].some(x=>String(x||"").startsWith("pending"))&&<div style={{fontSize:12,color:MID_GREY,marginTop:4}}>WhatsApp is reviewing them, usually within minutes, sometimes up to a day.</div>}
                </>
              );
            })()}

            <div style={{marginTop:18,fontWeight:700,color:BLUE,fontSize:14}}>Automatic sending</div>
            {(()=>{
              const a=setup.auto_send||{enabled:false,bank:"none"};
              const save=async(patch,msg)=>{ const r=await act("auto_send",patch,msg); if(r) openSetup(); };
              return(
                <div style={{border:`2px solid ${a.enabled?GREEN:"#ccc"}`,borderRadius:8,padding:10,fontSize:12}}>
                  <div style={{fontSize:14,fontWeight:700,color:a.enabled?GREEN:MID_GREY,marginBottom:4}}>{a.enabled?"🟢 ON: simple replies go out by themselves":"⚪ OFF: every suggestion waits for your approval"}</div>
                  <div style={{color:MID_GREY,marginBottom:6}}>
                    When on, the bot sends greetings, factory hours and location, the price list and photos by itself. Every quotation still waits for your approval, so you choose the bank details each time.
                    It still waits for you on: sketches, photos, files and voice notes from the client; unclear measurements, several areas, unclear product or colour;
                    large orders and contractors; discounts; payments; "which ad?"; anything it isn't sure about; clients the team answered from the phone in the last 2 hours; and at night (11 p.m. to 7 a.m.).
                    Everything it sends shows in the chat, and in the review file as "SENT AUTOMATICALLY".
                  </div>
                  <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                    <button onClick={()=>{ if(a.enabled||window.confirm("Switch on automatic sending? Simple replies (greetings, hours, location, price list, photos) will go to clients without your approval. Quotations still wait for you.")) save({enabled:!a.enabled},a.enabled?"Automatic sending switched off":"Automatic sending switched on"); }} disabled={busy}
                      style={btn(a.enabled?"#fff":GREEN,a.enabled?"#B00020":"#fff",a.enabled?{border:"1px solid #B00020",padding:"6px 12px",fontSize:13}:{padding:"6px 12px",fontSize:13})}>{a.enabled?"Switch off":"Switch on"}</button>
                  </div>
                </div>
              );
            })()}

            <div style={{marginTop:18,fontWeight:700,color:BLUE,fontSize:14}}>Team alerts</div>
            <div style={{fontSize:12,color:MID_GREY,marginBottom:6}}>
              When a client is told "our Sales Manager will contact you", the Sales Manager gets the client's details on WhatsApp.
              Breakdowns reported by WhatsApp are followed up at 9 a.m. each day until repaired; with no answer by 11, you get a message.
            </div>
            {[["sales_manager","Sales Manager (big orders)",setup.sales_manager_number],["owner","Iswarren (breakdown alerts)",setup.owner_number]].map(([k,lbl,val])=>(
              <div key={k} style={{display:"flex",gap:8,alignItems:"center",marginBottom:6,fontSize:12}}>
                <span style={{width:170}}>{lbl}</span>
                <input defaultValue={val?`+${val}`:""} id={`num-${k}`} style={{flex:1,minWidth:0,padding:6,fontSize:13,borderRadius:6,border:"1px solid #ccc"}}/>
                <button onClick={async()=>{ const v=document.getElementById(`num-${k}`).value; const r=await act("team_numbers",{[k]:v},"Number saved"); if(r) openSetup(); }} disabled={busy}
                  style={btn(GREEN,"#fff",{padding:"4px 10px",fontSize:12})}>Save</button>
              </div>
            ))}

            <div style={{marginTop:18,fontWeight:700,color:BLUE,fontSize:14}}>Missed calls</div>
            <div style={{fontSize:12,color:MID_GREY,marginBottom:6}}>
              When a call to the business phone is missed, the chat appears here with "Sorry we missed your call" ready to approve. Saved contacts (like lorry drivers) and staff are skipped.
              On the business phone, in the MacroDroid app, make a macro: trigger <b>Call Missed</b> (Non-contacts), action <b>HTTP Request</b> (GET) to this link with <b>[call_number]</b> added at the end:
            </div>
            {setup.missed_call_url&&(
              <div style={{display:"flex",gap:8,alignItems:"center"}}>
                <input readOnly value={setup.missed_call_url+"[call_number]"} onFocus={e=>e.target.select()}
                  style={{flex:1,minWidth:0,padding:8,fontSize:12,borderRadius:6,border:"1px solid #ccc",fontFamily:"monospace"}}/>
                <button onClick={async()=>{ try{ await navigator.clipboard.writeText(setup.missed_call_url+"[call_number]"); setInfo("Link copied"); }catch{ setError("Couldn't copy: select the link and copy it"); } }}
                  style={btn(BLUE,"#fff",{padding:"8px 12px",fontSize:13})}>Copy</button>
              </div>
            )}
            <div style={{fontSize:12,color:MID_GREY,marginTop:4}}>Keep this link private. Missed WhatsApp calls: a second macro with trigger <b>Notification Received</b> (WhatsApp Business, text contains "Missed") and the same link with <b>[notification_title]</b> at the end and <b>&amp;kind=whatsapp</b>.</div>

            <PhotoManager api={api}/>

            <div style={{marginTop:18,fontWeight:700,color:BLUE,fontSize:14}}>Facebook ads</div>
            <div style={{fontSize:12,color:MID_GREY,marginBottom:6}}>Ads clients have come from. Tell the bot what each one shows, and it quotes that for every client from the ad.</div>
            {(!setup.ads||!setup.ads.length)&&<div style={{fontSize:13,color:MID_GREY}}>No clients from ads yet.</div>}
            {(setup.ads||[]).map(a=>{
              const v=adEdits[a.key]!==undefined?adEdits[a.key]:(a.design||"");
              return(
                <div key={a.key} style={{border:`1px solid ${a.design?"#eee":ORANGE}`,borderRadius:8,padding:8,marginBottom:6,fontSize:12}}>
                  <div><b>{a.label}</b>{a.url&&<> · <a href={a.url} target="_blank" rel="noreferrer">open</a></>}</div>
                  {!a.design&&<div style={{color:ORANGE}}>The bot doesn't know what this ad shows yet.</div>}
                  <textarea value={v} onChange={e=>setAdEdits({...adEdits,[a.key]:e.target.value})} rows={2} placeholder="e.g. 600x300 Light Grey + 300x300 Dark Grey design"
                    style={{width:"100%",boxSizing:"border-box",padding:6,fontSize:13,borderRadius:6,border:"1px solid #ccc",marginTop:4}}/>
                  <div style={{display:"flex",gap:6,marginTop:4}}>
                    <button onClick={async()=>{ const r=await act("describe_ad",{key:a.key,label:a.label,url:a.url,value:v},"Ad saved"); if(r){ setAdEdits({...adEdits,[a.key]:undefined}); openSetup(); } }} disabled={busy||!v.trim()||v===a.design}
                      style={btn(GREEN,"#fff",{padding:"4px 10px",fontSize:12})}>Save</button>
                    <button onClick={async()=>{ const r=await act("delete_ad",{value:a.key},"Ad removed"); if(r) openSetup(); }} disabled={busy}
                      style={btn("#fff","#B00020",{border:"1px solid #B00020",padding:"4px 10px",fontSize:12})}>Remove</button>
                  </div>
                </div>
              );
            })}

            <div style={{marginTop:18,fontWeight:700,color:BLUE,fontSize:14}}>What the bot learned from your corrections</div>
            <div style={{fontSize:12,color:MID_GREY,marginBottom:6}}>When you change a suggestion before sending, the bot keeps the example and follows it for all clients. Delete any that shouldn't become a habit.</div>
            {(!setup.examples||!setup.examples.length)&&<div style={{fontSize:13,color:MID_GREY}}>None yet.</div>}
            {(setup.examples||[]).slice().reverse().map(ex=>(
              <div key={ex.at} style={{border:"1px solid #eee",borderRadius:8,padding:8,marginBottom:6,fontSize:12}}>
                <div><b>Client:</b> {ex.client}</div>
                <div style={{color:"#B00020"}}><b>Bot:</b> {ex.bot}</div>
                <div style={{color:GREEN}}><b>You sent:</b> {ex.team}</div>
                <button onClick={async()=>{ const r=await act("delete_example",{value:ex.at},"Example deleted"); if(r) openSetup(); }} disabled={busy}
                  style={btn("#fff","#B00020",{border:"1px solid #B00020",padding:"4px 10px",fontSize:12,marginTop:4})}>Delete</button>
              </div>
            ))}
            <div style={{marginTop:16,fontSize:12,color:MID_GREY}}>
              Staff numbers (no bot replies): {(setup.staff_numbers||[]).map(n=>"+"+n).join(", ")||"none"}
            </div>
            <div style={{marginTop:18,fontWeight:700,color:BLUE,fontSize:14}}>Review the bot</div>
            <div style={{fontSize:12,color:MID_GREY,marginBottom:6}}>Downloads the last 7 days of client chats with every bot suggestion: what it wrote, whether you sent it as written, changed it or discarded it, and its notes. Send the file to Claude for a review.</div>
            <button onClick={async()=>{ const r=await act("review_export",{value:7},"Review file downloaded"); if(r){ const url=URL.createObjectURL(new Blob([r.text],{type:"text/plain"})); const a=document.createElement("a"); a.href=url; a.download=`bot-review-${new Date().toISOString().slice(0,10)}.txt`; a.click(); URL.revokeObjectURL(url); } }} disabled={busy}
              style={btn("#fff",BLUE,{border:`1px solid ${BLUE}`,padding:"6px 10px",fontSize:12})}>📋 Download chats for review</button>

            <FactoryReporters api={api} act={act} busy={busy}/>
            <TeamLogins api={api} act={act} busy={busy}/>
          </>
        )}
      </div>
    );
  }

  // ── One chat ───────────────────────────────────
  if(view==="chat"){
    const draft=chat&&chat.draft;
    return(
      <div style={{background:"#fff",borderRadius:12,padding:14,boxShadow:"0 2px 10px #0001"}}>
        {header}
        {chat&&chat.contact&&(
          <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",fontSize:12,color:MID_GREY,marginBottom:10}}>
            <span>+{chat.contact.wa_id}</span>
            {chat.contact.profile_name&&chat.contact.name&&<span>· “{chat.contact.profile_name}”</span>}
            <button onClick={togglePause} disabled={busy} style={btn(chat.contact.bot_paused?LIGHT_ORANGE:"#f2f2f2",chat.contact.bot_paused?ORANGE:"#333",{padding:"5px 10px",fontSize:12,marginLeft:"auto"})}>
              {chat.contact.bot_paused?"▶ Bot paused for this client":"⏸ Pause bot for this client"}
            </button>
          </div>
        )}
        <div style={{background:"#EFEAE2",borderRadius:10,padding:10,maxHeight:"55vh",overflowY:"auto"}}>
          {!chat&&<div style={{color:MID_GREY,padding:10}}>Loading…</div>}
          {chat&&chat.messages.length===0&&<div style={{color:MID_GREY,padding:10}}>No messages yet.</div>}
          {chat&&chat.messages.map(m=>(
            <div key={m.id} style={{display:"flex",justifyContent:m.direction==="in"?"flex-start":"flex-end",margin:"4px 0"}}>
              <div style={{maxWidth:"80%",background:m.direction==="in"?"#fff":"#D9FDD3",borderRadius:8,padding:"7px 10px",fontSize:14,whiteSpace:"pre-wrap",wordBreak:"break-word",boxShadow:"0 1px 1px #0001"}}>
                {m.body}
                {m.media_id&&(m.type==="image"||m.type==="document")&&(()=>{
                  const f=media[m.id];
                  if(f&&f.url&&f.mime.startsWith("image/")) return <img src={f.url} alt="Sent in this chat" style={{display:"block",maxWidth:"100%",borderRadius:6,marginTop:6}}/>;
                  if(f&&f.url) return <div style={{marginTop:6}}><a href={f.url} target="_blank" rel="noreferrer" style={{color:BLUE,fontWeight:600}}>📄 Open file</a></div>;
                  return(
                    <div style={{marginTop:6}}>
                      <button onClick={()=>showMedia(m.id)} disabled={Boolean(f&&f.loading)} style={btn(LIGHT_BLUE,BLUE,{padding:"5px 10px",fontSize:12})}>
                        {f&&f.loading?"Loading…":m.type==="image"?"📷 Show photo":"📄 Show file"}
                      </button>
                      {f&&f.error&&<div style={{color:"#B00020",fontSize:11,marginTop:4}}>{f.error}</div>}
                    </div>
                  );
                })()}
                <div style={{fontSize:10,color:MID_GREY,textAlign:"right",marginTop:3}}>
                  {[sourceLabel(m),when(m.sent_at),m.status==="failed"?"⚠️ not delivered":"",m.status==="no_whatsapp"?"⚠️ not on WhatsApp":"",m.status==="resent"?"↻ resent":""].filter(Boolean).join(" · ")}
                </div>
                {m.direction==="out"&&(m.status==="no_whatsapp"||(m.status==="failed"&&m.type==="template"))&&m.body&&(
                  <a href={`sms:+${selected}?body=${encodeURIComponent(m.body)}`}
                    style={{...btn("#fff",BLUE,{border:`1px solid ${BLUE}`,padding:"4px 10px",fontSize:12,marginTop:4,marginLeft:6}),display:"inline-block",textDecoration:"none"}}>📱 Send as SMS</a>
                )}
                {m.direction==="out"&&m.status==="failed"&&m.type==="text"&&(
                  <button disabled={busy} onClick={async()=>{ const r=await act("resend",{message_id:m.id},"↻ Sent again"); if(r) loadChat(selected); }}
                    style={btn("#fff","#B00020",{border:"1px solid #B00020",padding:"4px 10px",fontSize:12,marginTop:4})}>↻ Resend</button>
                )}
              </div>
            </div>
          ))}
          <div ref={bottomRef}/>
        </div>

        <div style={{marginTop:12}}>{banner}</div>

        {chat&&chat.ad&&((!chat.ad.design||adEdit)?(
          <div style={{border:`2px solid ${ORANGE}`,background:LIGHT_ORANGE,borderRadius:10,padding:12,marginBottom:10}}>
            <div style={{fontWeight:700,color:ORANGE,fontSize:14}}>📢 {chat.ad.design?"Change what this ad shows":"New ad: what's in it?"}</div>
            <div style={{fontSize:13,color:"#333",margin:"4px 0 8px"}}>
              This client came from the ad "{chat.ad.label}".{chat.ad.url&&<> <a href={chat.ad.url} target="_blank" rel="noreferrer">Open the ad</a></>} Tell the bot once what the ad shows; it will use it for every client from this ad.
            </div>
            <textarea value={adInput} onChange={e=>setAdInput(e.target.value)} rows={2} placeholder="e.g. 600x300 Light Grey + 300x300 Dark Grey design"
              style={{width:"100%",boxSizing:"border-box",padding:8,fontSize:14,borderRadius:6,border:"1px solid #ccc"}}/>
            <div style={{display:"flex",gap:8,marginTop:6}}>
              <button onClick={saveAd} disabled={busy||!adInput.trim()} style={btn(GREEN,"#fff",{padding:"8px 12px",fontSize:13})}>Save & new suggestion</button>
              {chat.ad.design&&<button onClick={()=>{ setAdEdit(false); setAdInput(""); }} disabled={busy} style={btn("#fff",MID_GREY,{border:"1px solid #ccc",padding:"8px 12px",fontSize:13})}>Cancel</button>}
            </div>
          </div>
        ):(
          <div style={{fontSize:12,color:MID_GREY,marginBottom:8}}>
            📢 From the ad "{chat.ad.label}": {chat.ad.design} · <button onClick={()=>{ setAdInput(chat.ad.design); setAdEdit(true); }} style={{background:"none",border:"none",color:BLUE,padding:0,fontSize:12,textDecoration:"underline",cursor:"pointer"}}>change</button>
          </div>
        ))}

        {chat&&(()=>{
          const money=chat.money||{};
          const proof=chat.draft&&chat.draft.quote&&chat.draft.quote.payment;
          const show=proof||chat.referral||(money.payments&&money.payments.length)||money.quote;
          if(!show) return null;
          const amount=payAmount!==""?payAmount:(proof?String(proof.amount):"");
          const after=money.quote&&Number(amount)>0?Math.round(((money.paid||0)+Number(amount))/money.quote.total*100):null;
          return(
            <div style={{border:`1px solid ${BLUE}`,background:LIGHT_BLUE,borderRadius:10,padding:10,marginBottom:10,fontSize:13}}>
              <div style={{fontWeight:700,color:BLUE}}>💰 Payments</div>
              {money.quote
                ?<div>Quotation {money.quote.ref}: Rs {Number(money.quote.total).toLocaleString("en-MU",{minimumFractionDigits:2})} · paid so far: Rs {Number(money.paid||0).toLocaleString("en-MU")} ({money.pct||0}%)</div>
                :<div style={{color:MID_GREY}}>No quotation total on record for this chat, so payments show in rupees, not %.</div>}
              {proof&&<div style={{marginTop:4}}>The bot read a payment proof: <b>Rs {Number(proof.amount).toLocaleString("en-MU")}</b>{proof.bank?` · ${proof.bank}`:""}{proof.reference?` · ref ${proof.reference}`:""}{proof.date?` · ${proof.date}`:""}</div>}
              {chat.referral&&<div style={{marginTop:4}}>🤝 Referred to Ravin on {when(chat.referral.referred_at)}{(chat.referral.payments||[]).length?` · told: ${chat.referral.payments.map(p=>p.status).join(", ")}`:""}</div>}
              <div style={{marginTop:6}}>Check the bank, then confirm the amount received:</div>
              <div style={{display:"flex",gap:6,alignItems:"center",flexWrap:"wrap",marginTop:4}}>
                <span>Rs</span>
                <input value={amount} onChange={e=>setPayAmount(e.target.value)} inputMode="decimal" placeholder="Amount"
                  style={{width:120,padding:7,fontSize:14,borderRadius:6,border:"1px solid #ccc"}}/>
                <button disabled={busy||!(Number(amount)>0)} onClick={async()=>{
                  const r=await act("confirm_payment",{wa_id:selected,value:Number(amount),draft_id:chat.draft?chat.draft.id:null});
                  if(r){
                    const pct=r.pct!==null&&r.pct!==undefined?` (${r.pct}% paid)`:"";
                    setInfo(`✅ Payment recorded${pct}${r.ravin==="told"?" and Ravin told":""}`);
                    if(r.warning) setError(r.warning);
                    setPayAmount(""); loadChat(selected);
                  }
                }} style={btn(GREEN,"#fff",{padding:"7px 12px",fontSize:13})}>
                  ✅ Payment confirmed{after!==null?` · ${after}%`:""}
                </button>
              </div>
              {chat.referral&&<div style={{fontSize:12,color:MID_GREY,marginTop:4}}>Ravin is told the new % automatically (not if it goes over 100%).</div>}
            </div>
          );
        })()}

        {draft&&(
          <div style={{border:`2px solid ${draft.needs_team?ORANGE:GREEN}`,background:draft.needs_team?LIGHT_ORANGE:LIGHT_GREEN,borderRadius:10,padding:12,marginTop:4}}>
            <div style={{fontWeight:700,fontSize:13,color:draft.needs_team?ORANGE:GREEN,marginBottom:6}}>
              {draft.needs_team?"⚠️ Bot suggestion – needs your decision":"🤖 Bot suggestion – check and send"}
            </div>
            {draft.team_note&&<div style={{fontSize:13,color:"#333",marginBottom:8}}><b>Note for the team:</b> {draft.team_note}</div>}
            {draft.quote&&draft.quote.ask_ad&&(
              <div style={{display:"grid",gap:6,marginBottom:8}}>
                {(chat.ad_choices||[]).map(a=>(
                  <button key={a.key} onClick={()=>pickAd(a.key)} disabled={busy} style={btn("#fff",BLUE,{border:`1px solid ${BLUE}`,textAlign:"left",fontSize:13})}>
                    📢 {a.design}<div style={{fontWeight:400,fontSize:12,color:MID_GREY,marginTop:2}}>{String(a.label||"").slice(0,90)}</div>
                  </button>
                ))}
                <button onClick={()=>pickAd("none")} disabled={busy} style={btn("#fff",MID_GREY,{border:"1px solid #ccc",fontSize:13})}>Not from an ad</button>
              </div>
            )}
            {hasQuote(draft)?(
              <>
                {(()=>{
                  const qs=quotesOf(draft);
                  const sent=(draft.quote&&draft.quote.sent)||{};
                  const unsent=qs.map((_,i)=>i).filter(i=>!sent[i]);
                  return(
                    <>
                      {qs.length>1&&<div style={{fontSize:13,color:BLUE,marginBottom:4}}>{qs.length} quotations, one per option. Send each one; the extra messages go after the last.</div>}
                      {qs.map((q,i)=>(
                        <QuoteEditor key={`${draft.id}-${i}`} quote={q} contact={chat.contact} caption={q.caption||""}
                          followup={draft.body||""} showFollowup={unsent.length===1&&unsent[0]===i}
                          label={qs.length>1?`Quotation ${i+1} of ${qs.length}`:"Quotation"} quoteIndex={i} sentRef={sent[i]||""}
                          draftId={draft.id} waId={selected} api={api} onSent={quoteSent}/>
                      ))}
                    </>
                  );
                })()}
              </>
            ):(
              <>
                {splitParts(draftText).map((part,i,all)=>{ const q=quoteOf(part); return(
                  <div key={i} style={{display:"flex",gap:6,alignItems:"flex-start",marginBottom:6}}>
                    <div style={{flex:1,minWidth:0}}>
                      {q.quote&&(
                        <div style={{display:"flex",alignItems:"center",gap:6,background:"#f0f0f0",borderLeft:`3px solid ${GREEN}`,borderRadius:6,padding:"4px 8px",marginBottom:3,fontSize:12,color:"#555"}}>
                          <span style={{flex:1,minWidth:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>↩ Replying to: "{q.quote}"</span>
                          <button onClick={()=>{ const p=[...all]; p[i]=q.text; setDraftText(p.join(BREAK)); }} title="Send without quoting"
                            style={{background:"none",border:"none",color:"#B00020",cursor:"pointer",fontSize:12,padding:0}}>✖</button>
                        </div>
                      )}
                      <textarea value={q.text} rows={Math.min(8,Math.max(2,Math.ceil(q.text.length/38)))}
                        onChange={e=>{ const p=[...all]; p[i]=withQuote(q.quote,e.target.value); setDraftText(p.join(BREAK)); }}
                        placeholder={all.length===1?"(The bot suggests no reply. Write one here if needed.)":"Message"}
                        style={{width:"100%",boxSizing:"border-box",padding:10,fontSize:14,borderRadius:8,border:"1px solid #ccc",fontFamily:"inherit",background:"#fff"}}/>
                    </div>
                    {all.length>1&&<button onClick={()=>setDraftText(all.filter((_,j)=>j!==i).join(BREAK))} title="Remove this message"
                      style={btn("#fff","#B00020",{padding:"6px 9px",border:"1px solid #B00020"})}>✖</button>}
                  </div>
                );})}
                {draft.quote&&draft.quote.attach==="price_list"&&<div style={{fontSize:13,color:BLUE,marginBottom:6}}>📎 The price list PDF is sent after the message.</div>}
                {draft.quote&&Array.isArray(draft.quote.photos)&&draft.quote.photos.map(a=>(
                  <label key={a} style={{display:"flex",alignItems:"center",gap:6,fontSize:13,color:BLUE,marginBottom:6}}>
                    <input type="checkbox" checked={photoSel.includes(a)} onChange={e=>setPhotoSel(e.target.checked?[...photoSel,a]:photoSel.filter(x=>x!==a))}/>
                    📷 {draft.quote.photo_mode==="designs"?"Send 1 photo of":"Send photos:"} {a}
                  </label>
                ))}
                {draft.quote&&draft.quote.photos_after&&photoSel.length>0&&(
                  <div style={{fontSize:13,color:BLUE,marginBottom:6}}>💬 Then: "{draft.quote.photos_after}"</div>
                )}
                {draft.quote&&draft.quote.referral&&(
                  <div style={{fontSize:13,color:BLUE,marginBottom:6}}>
                    📨 Ravin will also get a message: {[draft.quote.referral.client_name||displayName(chat.contact),draft.quote.referral.location,draft.quote.referral.product,draft.quote.referral.area].filter(Boolean).join(" · ")}
                  </div>
                )}
                <div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:4}}>
                  <button onClick={()=>sendMessage(draftText,draft.id)} disabled={busy} style={btn(GREEN,"#fff")}>
                    {busy?"…":splitParts(draftText).filter(t=>quoteOf(t).text.trim()).length>1?`✅ Send ${splitParts(draftText).filter(t=>quoteOf(t).text.trim()).length} messages`:"✅ Send"}
                  </button>
                  <button onClick={()=>setDraftText(draftText+BREAK)} disabled={busy} style={btn("#fff",GREEN,{border:`1px solid ${GREEN}`,padding:"8px 12px",fontSize:13})}>+ Message</button>
                </div>
              </>
            )}
            <div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:8}}>
              <button onClick={discardDraft} disabled={busy} style={btn("#fff","#B00020",{border:"1px solid #B00020"})}>✖ Discard</button>
              <button onClick={redraft} disabled={busy} style={btn("#fff",BLUE,{border:`1px solid ${BLUE}`})}>↻ New suggestion</button>
            </div>
          </div>
        )}

        <div style={{marginTop:12}}>
          <textarea value={manualText} onChange={e=>setManualText(e.target.value)} rows={2} placeholder="Write your own message…"
            style={{width:"100%",boxSizing:"border-box",padding:10,fontSize:14,borderRadius:8,border:"1px solid #ccc",fontFamily:"inherit"}}/>
          <div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:6}}>
            <button onClick={()=>sendMessage(manualText,null)} disabled={busy||!manualText.trim()} style={btn(BLUE,"#fff")}>Send my message</button>
            {!draft&&<button onClick={redraft} disabled={busy} style={btn("#fff",BLUE,{border:`1px solid ${BLUE}`})}>🤖 Ask the bot for a reply</button>}
            {!hasQuote(draft)&&!quoteOpen&&<button onClick={()=>setQuoteOpen(true)} disabled={busy} style={btn("#fff",BLUE,{border:`1px solid ${BLUE}`})}>📄 Make a quotation</button>}
            <button onClick={async()=>{ if(albumList){ setAlbumList(null); return; } try{ const r=await api("photos"); setAlbumList(r.albums||[]); }catch(e){ setError(e.message); } }} disabled={busy}
              style={btn("#fff",BLUE,{border:`1px solid ${BLUE}`})}>📷 Send photos</button>
          </div>
          {albumList&&(
            <div style={{border:"1px solid #ddd",borderRadius:8,padding:8,marginTop:6,background:"#fafafa"}}>
              {!albumList.length&&<div style={{fontSize:13,color:MID_GREY}}>No photos yet. Add them in Setup → Product photos.</div>}
              {albumList.map(a=>(
                <button key={a.album} disabled={busy} onClick={async()=>{ const r=await act("send_photos",{wa_id:selected,value:a.album},"✅ Photos sent"); if(r){ setAlbumList(null); await loadChat(selected); loadChats(); } }}
                  style={{...btn("#fff",BLUE,{border:`1px solid ${BLUE}`,padding:"6px 10px",fontSize:13}),display:"block",width:"100%",textAlign:"left",marginBottom:4}}>
                  {a.album} · {Math.min(a.count,3)} photo{Math.min(a.count,3)>1?"s":""}
                </button>
              ))}
            </div>
          )}
          {quoteOpen&&!hasQuote(draft)&&chat&&(
            <QuoteEditor key="manual" quote={null} contact={chat.contact} caption="" draftId={null}
              waId={selected} api={api} onSent={quoteSent} onCancel={()=>setQuoteOpen(false)}/>
          )}
        </div>
      </div>
    );
  }

  // ── Chat list ──────────────────────────────────
  const waiting=chats.filter(c=>c.pending).length;
  const shown=filter==="waiting"?chats.filter(c=>c.pending):chats;
  return(
    <div style={{background:"#fff",borderRadius:12,padding:14,boxShadow:"0 2px 10px #0001"}}>
      {header}{banner}
      <div style={{display:"flex",gap:8,marginBottom:10}}>
        <button onClick={()=>setFilter("all")} style={btn(filter==="all"?BLUE:"#f2f2f2",filter==="all"?"#fff":"#333",{padding:"6px 12px",fontSize:13})}>All chats</button>
        <button onClick={()=>setFilter("waiting")} style={btn(filter==="waiting"?BLUE:"#f2f2f2",filter==="waiting"?"#fff":"#333",{padding:"6px 12px",fontSize:13})}>Waiting for approval ({waiting})</button>
      </div>
      {shown.length===0&&<div style={{color:MID_GREY,padding:16,textAlign:"center"}}>{filter==="waiting"?"Nothing waiting. 👍":"No chats yet. New WhatsApp messages will appear here."}</div>}
      {shown.map(c=>(
        <button key={c.wa_id} onClick={()=>openChat(c.wa_id)}
          style={{display:"flex",width:"100%",textAlign:"left",gap:10,alignItems:"center",background:c.pending?(c.needs_team?LIGHT_ORANGE:LIGHT_GREEN):"#fff",border:"none",borderBottom:"1px solid #eee",padding:"12px 8px",cursor:"pointer"}}>
          <div style={{flex:1,minWidth:0}}>
            <div style={{display:"flex",justifyContent:"space-between",gap:8}}>
              <span style={{fontWeight:600,fontSize:15,color:"#222",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                {displayName(c)}{c.is_staff?" (team)":""}{c.bot_paused?" ⏸":""}
              </span>
              <span style={{fontSize:11,color:MID_GREY,whiteSpace:"nowrap"}}>{when(c.last_message_at)}</span>
            </div>
            <div style={{fontSize:13,color:MID_GREY,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
              {c.last?(c.last.direction==="out"?"You: ":"")+(c.last.body||""):""}
            </div>
          </div>
          {c.pending&&<span style={{fontSize:11,fontWeight:700,color:c.needs_team?ORANGE:GREEN,whiteSpace:"nowrap"}}>{c.needs_team?"⚠️ check":"🤖 reply ready"}</span>}
          {c.unread>0&&<span style={{background:GREEN,color:"#fff",borderRadius:12,fontSize:11,fontWeight:700,padding:"2px 7px"}}>{c.unread}</span>}
        </button>
      ))}
    </div>
  );
}

// Who can log in to the Suite (and the factory app): add a login, or remove one.
function TeamLogins({api,act,busy}){
  const [team,setTeam]=useState(null);
  const [email,setEmail]=useState("");
  const [pw,setPw]=useState("");
  const load=useCallback(async()=>{ try{ const r=await api("team"); setTeam(r.team||[]); }catch{ setTeam([]); } },[api]);
  useEffect(()=>{ load(); },[load]);
  return(
    <div>
      <div style={{marginTop:18,fontWeight:700,color:BLUE,fontSize:14}}>Team logins</div>
      <div style={{fontSize:12,color:MID_GREY,marginBottom:6}}>Only these emails can open the Suite and the factory app. To add someone (e.g. Julien), enter their email and a password, then give them the password.</div>
      {(team||[]).map(e=>(
        <div key={e} style={{display:"flex",alignItems:"center",gap:8,fontSize:13,padding:"4px 0"}}>
          <span style={{flex:1}}>👤 {e}</span>
          <button onClick={async()=>{ if(window.confirm(`Remove ${e}'s login?`)){ const r=await act("remove_login",{email:e},"Login removed"); if(r) load(); } }} disabled={busy}
            style={btn("#fff","#B00020",{border:"1px solid #B00020",padding:"3px 8px",fontSize:12})}>Remove</button>
        </div>
      ))}
      <div style={{display:"flex",gap:6,flexWrap:"wrap",marginTop:6}}>
        <input type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="Email" autoComplete="off"
          style={{flex:1,minWidth:150,padding:8,fontSize:13,borderRadius:6,border:"1px solid #ccc"}}/>
        <input type="password" value={pw} onChange={e=>setPw(e.target.value)} placeholder="Password (8+ characters)" autoComplete="new-password"
          style={{flex:1,minWidth:150,padding:8,fontSize:13,borderRadius:6,border:"1px solid #ccc"}}/>
        <button onClick={async()=>{ const r=await act("create_login",{email,password:pw},"Login saved"); if(r){ setEmail(""); setPw(""); load(); } }} disabled={busy||!email.trim()||pw.length<8}
          style={btn(GREEN,"#fff",{padding:"8px 12px",fontSize:13})}>Add / change password</button>
      </div>
    </div>
  );
}

// Who can send factory reports (production, deliveries out, raw material in) to the business WhatsApp.
function FactoryReporters({api,act,busy}){
  const [numbers,setNumbers]=useState(null);
  const [input,setInput]=useState("");
  const load=useCallback(async()=>{ try{ const r=await api("factory_reporters"); setNumbers(r.numbers||[]); }catch{ setNumbers([]); } },[api]);
  useEffect(()=>{ load(); },[load]);
  async function saveList(list){ const r=await act("factory_reporters",{numbers:list},"Saved"); if(r) setNumbers(r.numbers||[]); }
  return(
    <div>
      <div style={{marginTop:18,fontWeight:700,color:BLUE,fontSize:14}}>Factory reports by WhatsApp</div>
      <div style={{fontSize:12,color:MID_GREY,marginBottom:6}}>
        These people (e.g. Julien, Kailash) send the business WhatsApp what was made, what left the factory and raw material received, like "2000 PB60 LG" or "40 ton rock sand Akshay", or a photo of the delivery note. It goes straight into the factory app and they get a confirmation with the new stock. "undo" cancels their last report.
      </div>
      {(numbers||[]).map(n=>(
        <div key={n} style={{display:"flex",alignItems:"center",gap:8,fontSize:13,padding:"4px 0"}}>
          <span style={{flex:1}}>📲 +{n}</span>
          <button onClick={()=>saveList(numbers.filter(x=>x!==n))} disabled={busy}
            style={btn("#fff","#B00020",{border:"1px solid #B00020",padding:"3px 8px",fontSize:12})}>Remove</button>
        </div>
      ))}
      <div style={{display:"flex",gap:6,marginTop:6}}>
        <input value={input} onChange={e=>setInput(e.target.value)} placeholder="Number, e.g. 5xxx xxxx" inputMode="tel"
          style={{flex:1,minWidth:150,padding:8,fontSize:13,borderRadius:6,border:"1px solid #ccc"}}/>
        <button onClick={async()=>{ await saveList([...(numbers||[]),input]); setInput(""); }} disabled={busy||input.replace(/\D/g,"").length<8}
          style={btn(GREEN,"#fff",{padding:"8px 12px",fontSize:13})}>Add</button>
      </div>
    </div>
  );
}
