import { useState, useEffect, useCallback, useRef } from "react";
import QuoteEditor from "./QuoteEditor";
import PhotoManager from "./PhotoManager";

// WhatsApp tab: chats on 5725 4201, the bot's suggested replies, and approve / edit / discard.
// All data goes through /api/wa-admin, which checks the Suite password set in Vercel.

const BLUE = "#1B4F8A";
const LIGHT_BLUE = "#E8EFF8";
const GREEN = "#1A7A3C";
const LIGHT_GREEN = "#E8F5ED";
const ORANGE = "#B45309";
const LIGHT_ORANGE = "#FEF3C7";
const MID_GREY = "#666666";
const PW_KEY = "pm_suite_wa_password";

function readSaved(){ try{ return window.localStorage.getItem(PW_KEY)||""; }catch{ return ""; } }
function save(pw){ try{ window.localStorage.setItem(PW_KEY,pw); }catch{ /* storage unavailable */ } }
function forget(){ try{ window.localStorage.removeItem(PW_KEY); }catch{ /* storage unavailable */ } }

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
  const [password,setPassword]=useState(readSaved);
  const [pwInput,setPwInput]=useState("");
  const [authed,setAuthed]=useState(false);
  const [view,setView]=useState("list");
  const [chats,setChats]=useState([]);
  const [botEnabled,setBotEnabled]=useState(true);
  const [selected,setSelected]=useState(null);
  const [chat,setChat]=useState(null);
  const [draftText,setDraftText]=useState("");
  const [photoSel,setPhotoSel]=useState([]); // photo albums the bot suggested, still ticked
  const [albumList,setAlbumList]=useState(null); // for "Send photos" in a chat
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

  const api=useCallback(async(action,payload={},pw=password)=>{
    const res=await fetch("/api/wa-admin",{
      method:"POST",
      headers:{"Content-Type":"application/json","x-suite-password":pw},
      body:JSON.stringify({action,...payload}),
    });
    let data={};
    try{ data=await res.json(); }catch{ data={error:`Server error (${res.status})`}; }
    if(res.status===401){ forget(); setAuthed(false); throw new Error("Wrong password"); }
    if(!res.ok) throw new Error(data.error||`Error ${res.status}`);
    return data;
  },[password]);

  const loadChats=useCallback(async()=>{
    try{
      const data=await api("chats");
      setChats(data.chats||[]);
      setBotEnabled(data.bot_enabled!==false);
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

  // Log in with the saved password, if there is one.
  useEffect(()=>{
    if(!password||authed) return;
    (async()=>{
      try{ await api("chats"); setAuthed(true); }catch{ setPassword(""); }
    })();
  },[password,authed,api]);

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

  async function login(){
    const pw=pwInput.trim();
    if(!pw) return;
    setBusy(true); setError("");
    try{
      await api("chats",{},pw);
      save(pw); setPassword(pw); setAuthed(true); setPwInput("");
    }catch(e){ setError(e.message==="Wrong password"?"Wrong password, try again.":e.message); }
    setBusy(false);
  }

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

  // ── Not logged in ──────────────────────────────
  if(!authed){
    return(
      <div style={{background:"#fff",borderRadius:12,padding:24,boxShadow:"0 2px 10px #0001",maxWidth:420,margin:"0 auto"}}>
        <div style={{fontWeight:700,fontSize:18,color:BLUE,marginBottom:6}}>💬 WhatsApp</div>
        <div style={{fontSize:13,color:MID_GREY,marginBottom:16}}>Enter the Suite password to see the chats on 5725 4201.</div>
        <input type="password" value={pwInput} onChange={e=>setPwInput(e.target.value)} onKeyDown={e=>{ if(e.key==="Enter") login(); }}
          placeholder="Password" autoComplete="current-password"
          style={{width:"100%",boxSizing:"border-box",padding:12,fontSize:15,border:"1px solid #ccc",borderRadius:8,marginBottom:12}}/>
        <button onClick={login} disabled={busy} style={btn(BLUE,"#fff",{width:"100%"})}>{busy?"Checking…":"Open WhatsApp"}</button>
        {error&&<div style={{color:"#B00020",marginTop:12,fontSize:13}}>{error}</div>}
      </div>
    );
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
          <button onClick={openSetup} style={btn(LIGHT_BLUE,BLUE,{padding:"8px 12px",fontSize:13})}>⚙️ Setup</button>
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
            {row(setup.keys?.whatsapp,"WhatsApp key (360dialog)")}
            {row(setup.keys?.claude,"Claude key")}
            {row(setup.keys?.database,"Database key")}
            {row(setup.tables,"Bot tables in Supabase",setup.tables?null:"Run the SQL from supabase/whatsapp_bot.sql in Supabase's SQL Editor")}
            {row(setup.webhook_ok,"WhatsApp messages arriving in the Suite",setup.webhook_url||setup.webhook_error||"Not connected yet")}
            {!setup.webhook_ok&&(
              <button onClick={connectWebhook} disabled={busy||!setup.tables} style={btn(GREEN,"#fff",{marginTop:14,width:"100%"})}>
                {busy?"Connecting…":"Connect WhatsApp to the Suite"}
              </button>
            )}
            <div style={{marginTop:18,fontWeight:700,color:BLUE,fontSize:14}}>Layer referrals (Ravin)</div>
            <div style={{fontSize:12,color:MID_GREY,marginBottom:6}}>When a client wants a layer, the bot gives Ravin's number and, once you approve, sends Ravin the client's name, number, location, product and area. When the client pays, tap the payment button in their chat to update Ravin.</div>
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
                  {(t.referral==="missing"||t.payment==="missing"||t.missed==="missing")&&(
                    <button onClick={async()=>{ const r=await act("create_referral_template",{},"Templates sent to WhatsApp for approval"); if(r) openSetup(); }} disabled={busy}
                      style={btn(GREEN,"#fff",{marginTop:8,padding:"8px 12px",fontSize:13})}>Create the templates</button>
                  )}
                  {[t.referral,t.payment,t.missed].some(x=>String(x||"").startsWith("pending"))&&<div style={{fontSize:12,color:MID_GREY,marginTop:4}}>WhatsApp is reviewing them, usually within minutes, sometimes up to a day.</div>}
                </>
              );
            })()}

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
            <button onClick={()=>{ forget(); setPassword(""); setAuthed(false); }} style={btn("#eee","#333",{marginTop:16,fontSize:13,padding:"8px 12px"})}>Log out on this device</button>
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
                    📷 Send photos: {a}
                  </label>
                ))}
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
