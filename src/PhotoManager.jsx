import { useState, useEffect, useCallback } from "react";
import { PRODUCT_OPTIONS } from "./products";

// Product photos for the WhatsApp bot, grouped in albums (one per product and colour, or a design).
const BLUE="#1F4E79", GREEN="#2E7D32", MID_GREY="#666";
const DESIGNS=[
  "Two-colour design – 600x300 Light Grey + 300x300 Dark Grey",
  "Slabs 600x300 Dark Grey + 300x300 Light Grey",
  "Slabs 600x300 – Light Grey + Dark Grey",
  "Slabs 600x300 – Light Grey + Dark Grey, 5 cm gap with grass",
  "Slabs 600x300 – Light Grey + Terracotta, 2.5 cm gap",
  "Slabs 600x300 Light Grey with Pavers 60mm Dark Grey border",
  "Slabs 450x450x60mm – Light Grey, 2.5 cm gap with crushed coral",
  "Laying patterns","Finished driveways",
];
const ALBUM_CHOICES=[...PRODUCT_OPTIONS.map(p=>p.desc),...DESIGNS];
const OTHER="Other…";
const btn=(bg,fg,extra={})=>({background:bg,color:fg,border:"none",borderRadius:8,padding:"8px 12px",cursor:"pointer",fontWeight:600,fontSize:13,...extra});

// Shrinks a photo to at most 1600 px wide/high as a JPEG, so uploads are quick and WhatsApp-friendly.
function shrink(file){
  return new Promise((resolve,reject)=>{
    const img=new window.Image();
    const url=URL.createObjectURL(file);
    img.onload=()=>{
      const scale=Math.min(1,1600/Math.max(img.width,img.height));
      const c=document.createElement("canvas");
      c.width=Math.round(img.width*scale); c.height=Math.round(img.height*scale);
      c.getContext("2d").drawImage(img,0,0,c.width,c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL("image/jpeg",0.85));
    };
    img.onerror=()=>{ URL.revokeObjectURL(url); reject(new Error(`${file.name} isn't a photo the browser can open`)); };
    img.src=url;
  });
}

export default function PhotoManager({api}){
  const [photos,setPhotos]=useState(null);
  const [choice,setChoice]=useState(ALBUM_CHOICES[0]);
  const [other,setOther]=useState("");
  const [progress,setProgress]=useState("");
  const [error,setError]=useState("");

  const load=useCallback(async()=>{
    try{ const r=await api("photos"); setPhotos(r.photos||[]); }catch(e){ setError(e.message); }
  },[api]);
  useEffect(()=>{ load(); },[load]);

  const album=choice===OTHER?other.trim():choice;

  async function upload(files){
    setError("");
    const list=[...files];
    for(let i=0;i<list.length;i++){
      setProgress(`Uploading ${i+1} of ${list.length}…`);
      try{
        const data=await shrink(list[i]);
        await api("upload_photo",{album,data,mime:"image/jpeg"});
      }catch(e){ setError(e.message); break; }
    }
    setProgress(""); load();
  }

  async function remove(id){
    try{ await api("delete_photo",{value:id}); load(); }catch(e){ setError(e.message); }
  }

  const byAlbum=new Map();
  for(const p of photos||[]){ if(!byAlbum.has(p.album)) byAlbum.set(p.album,[]); byAlbum.get(p.album).push(p); }

  return(
    <div>
      <div style={{marginTop:18,fontWeight:700,color:BLUE,fontSize:14}}>Product photos</div>
      <div style={{fontSize:12,color:MID_GREY,marginBottom:6}}>
        Upload photos by product and colour. When a client asks to see a product, the bot suggests sending that album (up to 3 photos). You can also send an album yourself from any chat.
      </div>
      <select value={choice} onChange={e=>setChoice(e.target.value)}
        style={{width:"100%",padding:8,fontSize:13,borderRadius:6,border:"1px solid #ccc",marginBottom:6}}>
        {ALBUM_CHOICES.map(c=><option key={c} value={c}>{c}{byAlbum.has(c)?` (${byAlbum.get(c).length})`:""}</option>)}
        <option value={OTHER}>{OTHER}</option>
      </select>
      {choice===OTHER&&(
        <input value={other} onChange={e=>setOther(e.target.value)} placeholder="Album name, e.g. Pavers 200x100x60mm – Herringbone"
          style={{width:"100%",boxSizing:"border-box",padding:8,fontSize:13,borderRadius:6,border:"1px solid #ccc",marginBottom:6}}/>
      )}
      <label style={{...btn(album&&!progress?GREEN:"#9bbf9d","#fff"),display:"inline-block"}}>
        📷 Add photos to this album
        <input type="file" accept="image/*" multiple disabled={!album||Boolean(progress)} style={{display:"none"}}
          onChange={e=>{ if(e.target.files&&e.target.files.length) upload(e.target.files); e.target.value=""; }}/>
      </label>
      {progress&&<span style={{fontSize:12,color:MID_GREY,marginLeft:8}}>{progress}</span>}
      {error&&<div style={{fontSize:12,color:"#B00020",marginTop:4}}>{error}</div>}

      {photos===null&&<div style={{fontSize:13,color:MID_GREY,marginTop:6}}>Loading…</div>}
      {photos&&!photos.length&&<div style={{fontSize:13,color:MID_GREY,marginTop:6}}>No photos yet.</div>}
      {[...byAlbum.entries()].map(([name,list])=>(
        <div key={name} style={{marginTop:10}}>
          <div style={{fontSize:13,fontWeight:600}}>{name} <span style={{color:MID_GREY,fontWeight:400}}>· {list.length} photo{list.length>1?"s":""}{list.length>3?" (the first 3 are sent)":""}</span></div>
          <div style={{display:"flex",gap:6,flexWrap:"wrap",marginTop:4}}>
            {list.map(p=>(
              <div key={p.id} style={{position:"relative"}}>
                <img src={p.url} alt={name} style={{width:84,height:84,objectFit:"cover",borderRadius:6,border:"1px solid #ddd"}}/>
                <button onClick={()=>remove(p.id)} title="Delete this photo"
                  style={{position:"absolute",top:2,right:2,background:"rgba(255,255,255,0.9)",border:"none",borderRadius:4,color:"#B00020",cursor:"pointer",fontSize:12,padding:"1px 5px"}}>✖</button>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
