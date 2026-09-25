import React, { useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { BookOpen, Feather, Library, Plus, ArrowUpRight, ArrowLeft, ArrowRight, Download, Upload, Search, X, Sun, Moon, Lock, Check, Archive, History, Link2, FileText, AlignLeft, ExternalLink, RefreshCw, Bookmark, PanelLeftClose, Scissors, CircleHelp } from "lucide-react";
import JSZip from "jszip";
import { DEFAULT_LAYOUT, bookPages, stanzaParts } from "../../shared/poetry.mjs";
import { htmlFromManuscript } from "../../shared/manuscript.mjs";
import { defaultCategories, categoryIdFromKind, resolveBiblioFields } from "../../shared/bibliography.mjs";
import { LayoutControls, VerseArranger, VerseText } from "./PoetryTools.jsx";
import "./style.css";
import "./poetry.css";

const cfg = window.WRITES_CONFIG || {};
const BASE = (cfg.apiBase || "").startsWith("__PORT_") ? "" : (cfg.apiBase || "").replace(/\/$/,"");
const SESSION_KEY = "sdc-writes-session";
const THEME_KEY = "sdc-writes-theme";
const LIBRARY_LIMIT = 500;
let TOKEN = "";
try { TOKEN = sessionStorage.getItem(SESSION_KEY) || ""; } catch { /* private browsing */ }
function setToken(token) {
  TOKEN = token || "";
  try {
    if (TOKEN) sessionStorage.setItem(SESSION_KEY, TOKEN);
    else sessionStorage.removeItem(SESSION_KEY);
  } catch { /* ignore quota / private mode */ }
}
async function api(path, method = "GET", data) {
  const r = await fetch(BASE + "/api" + path, { method, headers:{"Content-Type":"application/json",...(TOKEN?{Authorization:"Bearer "+TOKEN}:{})}, ...(data===undefined?{}:{body:JSON.stringify(data)}) });
  const out = await r.json().catch(()=>({error:"The server did not return a readable response."}));
  if(!r.ok) {
    if (r.status === 401 && cfg.mode === "production") setToken("");
    throw new Error(out.error || "The request could not be completed.");
  }
  return out;
}
const emptyWork = () => ({title:"",author:"",body:"",kind:"poetry",categoryId:"poetry",collection:"",theme:"forest",archived:false,layout:{...DEFAULT_LAYOUT},versionName:"",publishedAt:"",writtenAt:"",venue:"",venueUrl:"",draftOf:"",draftNote:""});
const kinds = {poetry:"Poetry",story:"Stories (narrative / fiction)",essay:"Essays (nonfiction)",other:"Other writing"};
const kindHints = {poetry:"Verse and poems",story:"Narrative or fiction — rename the bibliography label to Fiction if you like",essay:"Nonfiction reflections and commentary",other:"Anything that doesn’t fit the others"};
const countWords = text => text.trim().split(/\s+/).filter(Boolean).length;
const dateLabel = date => { const d=new Date(date); return Number.isNaN(d.getTime())?"":d.toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"}); };
const yearLabel = date => { const d=new Date(date); return Number.isNaN(d.getTime())?"":String(d.getFullYear()); };
const dateInputValue = date => { const d=String(date||"").trim(); if(/^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0,10); const t=new Date(d); return Number.isNaN(t.getTime())?"":t.toISOString().slice(0,10); };
const esc = s => String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,65)||"untitled";
const coverFor = w => {
  if (w?.coverUrl && /^https:\/\//i.test(w.coverUrl)) return w.coverUrl;
  const m = String(w?.body || "").match(/!\[[^\]]*\]\((https:\/\/[^)\s]+)\)/);
  return m ? m[1] : "";
};
function Logo(){return <svg aria-label="Writes pen mark" width="32" height="32" viewBox="0 0 32 32" fill="none"><path d="M8 25 10 13 23 5 27 9 19 22 8 25Z" stroke="currentColor" strokeWidth="1.5"/><path d="M8 25 17 16M12 11l9 9M5 28h21" stroke="currentColor" strokeWidth="1.5"/><circle cx="18" cy="15" r="2" stroke="currentColor" strokeWidth="1.5"/></svg>}
function Button({children,icon:Icon,variant="",...props}){return <button className={"button "+variant} {...props}>{Icon&&<Icon size={17}/>}<span>{children}</span></button>}
function Modal({title,children,onClose,wide=false}){
  const ref=useRef(null);
  useEffect(()=>{ref.current.showModal();return()=>ref.current?.close();},[]);
  return <dialog className={wide?"wide":""} ref={ref} onCancel={e=>{e.preventDefault();onClose();}} onClick={e=>{if(e.target===ref.current)onClose();}}>
    <div className="modal-head"><h2>{title}</h2><button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={21}/></button></div>{children}
  </dialog>;
}
function App(){
  const [user,setUser]=useState(null),[loading,setLoading]=useState(true),[error,setError]=useState(""),[toast,setToast]=useState("");
  const [works,setWorks]=useState([]),[sources,setSources]=useState([]),[filter,setFilter]=useState("all"),[query,setQuery]=useState("");
  const [view,setView]=useState("library"),[work,setWork]=useState(null),[saved,setSaved]=useState(""),[busy,setBusy]=useState(false);
  const [modal,setModal]=useState(""),[reader,setReader]=useState(null),[returnView,setReturnView]=useState("library");
  const [bibliography,setBibliography]=useState(null),[publicBib,setPublicBib]=useState(null),[bibLabels,setBibLabels]=useState(defaultCategories());
  const [history,setHistory]=useState([]),[shareUrl,setShareUrl]=useState(""),[theme,setTheme]=useState(()=>{
    try{const savedTheme=localStorage.getItem(THEME_KEY);if(savedTheme==="light"||savedTheme==="dark")return savedTheme;}catch{/* ignore */}
    return matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";
  });
  const [username,setUsername]=useState(""),[password,setPassword]=useState("");
  const [versionName,setVersionName]=useState("");
  const [apiReady,setApiReady]=useState(cfg.mode!=="production");
  const [linkedDrafts,setLinkedDrafts]=useState([]);
  const [draftNoteInput,setDraftNoteInput]=useState("");
  const [draftPrimaryId,setDraftPrimaryId]=useState("");
  const [draftWrittenAt,setDraftWrittenAt]=useState("");
  const bodyRef=useRef(null);
  const coversRefreshed=useRef(false);
  const biblioBackfilled=useRef(false);
  const dirty=!!work&&JSON.stringify(work)!==saved;
  function notice(s){setToast(s);setTimeout(()=>setToast(""),4500);}
  async function attempt(fn){setError("");setBusy(true);try{return await fn();}catch(e){setError(e.message);return null;}finally{setBusy(false);}}
  async function refresh({backfillCovers=false,backfillBiblio=false}={}){
    const [a,b]=await Promise.all([api("/works"),api("/sources")]);
    let list=a.works;
    if(backfillCovers&&!coversRefreshed.current&&list.some(w=>!w.coverUrl)){
      coversRefreshed.current=true;
      try{
        const out=await api("/works/refresh-covers","POST",{});
        if(out.updated>0){
          list=(await api("/works")).works;
          notice(out.updated===1?"Found a cover image for 1 piece on your shelf.":`Found cover images for ${out.updated} pieces on your shelf.`);
        }
      }catch{/* older Lambda without refresh-covers — list already backfills when possible */}
    }
    if(backfillBiblio&&!biblioBackfilled.current&&list.some(w=>!w.venue||!w.publishedAt)){
      biblioBackfilled.current=true;
      try{
        const out=await api("/works/backfill-biblio","POST",{});
        if(out.updated>0) list=(await api("/works")).works;
      }catch{/* older Lambda */}
    }
    setWorks(list);setSources(b.sources);
    try{
      const bib=await api("/bibliography");
      setBibliography(bib);
      setBibLabels(bib.categories||defaultCategories());
    }catch{/* older Lambda without bibliography */}
  }
  function signOut(){
    if(dirty&&!window.confirm("Sign out and discard unsaved changes? Your last saved version will remain."))return;
    coversRefreshed.current=false;biblioBackfilled.current=false;
    setToken("");setUser(null);setWorks([]);setSources([]);setBibliography(null);setWork(null);setSaved("");setView("library");setReader(null);setPublicBib(null);setModal("");setError("");notice("Signed out of Writes.");
  }
  async function boot(){
    try{
      const token=new URLSearchParams(location.hash.slice(1)).get("share");
      if(token){
        const out=await api("/public/"+encodeURIComponent(token));
        if(out.bibliography){setPublicBib(out.bibliography);setView("public-bib");setLoading(false);return;}
        setReader(out.work);setView("public");setLoading(false);return;
      }
      if(cfg.mode==="production"){
        try{
          const health=await fetch(BASE+"/api/health",{headers:{"Accept":"application/json"}}).then(r=>r.ok?r.json():null).catch(()=>null);
          setApiReady(!!(health&&health.ok&&health.mode==="production"));
        }catch{setApiReady(false);}
        if(TOKEN){
          try{
            const data=await api("/bootstrap");
            setUser(data.user);await refresh({backfillCovers:true,backfillBiblio:true});
          }catch{
            setToken("");setUser(null);
          }
        }
        setLoading(false);return;
      }
      const data=await api("/bootstrap");setToken(data.token);setUser(data.user);await refresh({backfillCovers:true,backfillBiblio:true});
    }catch(e){setError(e.message);}finally{setLoading(false);}
  }
  useEffect(()=>{boot();const onHash=()=>boot();window.addEventListener("hashchange",onHash);return()=>window.removeEventListener("hashchange",onHash);},[]);
  useEffect(()=>{document.documentElement.dataset.theme=theme;try{localStorage.setItem(THEME_KEY,theme);}catch{/* ignore */}},[theme]);
  useEffect(()=>{const fn=e=>{if(dirty){e.preventDefault();e.returnValue="";}};window.addEventListener("beforeunload",fn);return()=>window.removeEventListener("beforeunload",fn);},[dirty]);
  const abandon=()=>!dirty||window.confirm("Discard these unsaved changes? Your last saved version will remain.");
  function library(next="all"){if(!abandon())return;setWork(null);setView("library");setFilter(next);setQuery("");}
  async function openBibliography(){if(!abandon())return;await attempt(async()=>{const bib=await api("/bibliography");setBibliography(bib);setBibLabels(bib.categories||defaultCategories());setWork(null);setView("bibliography");});}
  function newWork(){if(!abandon())return;const w=emptyWork();setWork(w);setSaved(JSON.stringify(w));setLinkedDrafts([]);setView("editor");}
  async function loadDraftsFor(id){
    if(!id){setLinkedDrafts([]);return;}
    try{
      const out=await api("/works/"+id+"/drafts");
      setLinkedDrafts(out.drafts||[]);
    }catch{setLinkedDrafts([]);}
  }
  async function edit(id){if(!abandon())return;await attempt(async()=>{const {work:w}=await api("/works/"+id);if(!w.categoryId)w.categoryId=categoryIdFromKind(w.kind);const bib=resolveBiblioFields(w);w.publishedAt=w.publishedAt||bib.publishedAt;w.writtenAt=w.writtenAt||bib.writtenAt;w.venue=w.venue||bib.venue;w.venueUrl=w.venueUrl||bib.venueUrl;setWork(w);setSaved(JSON.stringify(w));setView("editor");await loadDraftsFor(w.draftOf?"":w.id);});}
  function change(field,value){
    setWork(w=>{
      const next={...w,[field]:value};
      if(field==="kind"&&(!w.categoryId||["poetry","story","essay","blog"].includes(w.categoryId))){
        next.categoryId=categoryIdFromKind(value);
      }
      return next;
    });
  }
  async function save(label=""){
    return attempt(async()=>{
      const {work:w}=await api(work.id?"/works/"+work.id:"/works",work.id?"PUT":"POST",{...work,versionName:typeof label==="string"?label:""});
      setWork(w);setSaved(JSON.stringify(w));await refresh();if(!w.draftOf)await loadDraftsFor(w.id);notice("Saved to your private library.");return w;
    });
  }
  async function archiveCurrentAsDraft(){
    if(!work?.id)return;
    if(dirty&&!window.confirm("Save changes first? Unsaved edits will not be copied into the archived draft."))return;
    await attempt(async()=>{
      if(dirty)await save();
      const out=await api("/works/"+work.id+"/archive-as-draft","POST",{note:draftNoteInput||"Earlier draft",writtenAt:draftWrittenAt||undefined});
      setDraftNoteInput("");setDraftWrittenAt("");setModal("");
      await loadDraftsFor(work.id);await refresh();
      notice("Current text archived as a draft under this piece. Keep editing the primary.");
      return out;
    });
  }
  async function linkAsDraft(){
    if(!work?.id||!draftPrimaryId)return;
    await attempt(async()=>{
      const out=await api("/works/"+work.id+"/link-draft","POST",{primaryId:draftPrimaryId,note:draftNoteInput,writtenAt:draftWrittenAt||undefined});
      setWork(out.work);setSaved(JSON.stringify(out.work));setDraftNoteInput("");setDraftPrimaryId("");setDraftWrittenAt("");setModal("");setLinkedDrafts([]);
      await refresh();notice("Linked as an archived draft. It no longer appears on the main shelf or bibliography.");
    });
  }
  async function unlinkDraft(restore=false){
    if(!work?.id||!work.draftOf)return;
    await attempt(async()=>{
      const out=await api("/works/"+work.id+"/unlink-draft","POST",{restore});
      setWork(out.work);setSaved(JSON.stringify(out.work));await refresh();
      notice(restore?"Draft unlinked and restored to your library.":"Draft unlinked; still archived.");
    });
  }
  async function preview(w,from){
    if(!w.id&&from==="editor"&&!w.title.trim()){setError("Give your writing a title before opening the book.");return;}
    setReader(w);setReturnView(from);setView("reader");
  }
  async function cardPreview(id){await attempt(async()=>{const {work:w}=await api("/works/"+id);preview(w,"library");});}
  async function showHistory(){if(!work.id)return;await attempt(async()=>{const out=await api("/works/"+work.id+"/history"),current=(await api("/works/"+work.id)).work;setHistory([current,...out.history,...(out.namedVersions||[])].sort((a,b)=>b.version-a.version));setModal("history");});}
  async function loadVersion(h){
    if(dirty&&!confirm("Replace these unsaved changes with this saved version?"))return;
    await attempt(async()=>{
      const r=h.body===undefined?(await api("/works/"+work.id+"/revisions/"+h.version)).revision:h;
      setWork(w=>({...w,title:r.title,author:r.author,body:r.body,kind:r.kind,collection:r.collection,theme:r.theme,layout:r.layout||{...DEFAULT_LAYOUT},versionName:""}));
      setModal("");notice("Version loaded as an unsaved draft. Review it, then save.");
    });
  }
  async function alternate(body,suffix){
    await attempt(async()=>{
      const fields={...work,body,title:((work.title||"Untitled")+" · "+suffix).slice(0,180),versionName:suffix,archived:false};
      const {work:w}=await api(work.id?"/works/"+work.id+"/fork":"/works","POST",fields);
      setWork(w);setSaved(JSON.stringify(w));setModal("");await refresh();notice("Separate alternate saved. The original writing is unchanged.");
    });
  }
  async function exportWorks(ids){
    await attempt(async()=>{
      const zip=new JSZip(), all=[];
      for(const id of ids){
        const data=await api("/works/"+id+"/export"),w=data.work;all.push(w);
        const folder=zip.folder(slug(w.title)+"-"+w.id.slice(-8));
        folder.file("writing.txt",w.body);folder.file("writing.md","# "+w.title+"\n\n"+w.body);
        folder.file("writing.json",JSON.stringify(w,null,2));
        const l={...DEFAULT_LAYOUT,...w.layout};
        folder.file("read.html",`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(w.title)}</title><style>body{max-width:44rem;margin:4rem auto;padding:1.5rem;font:18px/1.8 Georgia,serif;color:#243a30;background:#faf8f1}h1{line-height:1.2}pre{font:inherit;line-height:${l.lineHeight};text-align:${l.align};white-space:pre-wrap;overflow-wrap:anywhere;tab-size:4;margin:0}.manuscript-image{display:block;max-width:100%;height:auto;margin:1.25rem 0}.stanzas{display:grid;gap:${l.stanzaGap==="airy"?"2.5em":".8em"}}hr{margin:3rem 0}</style><h1>${esc(w.title)}</h1><p>${esc(w.author)}</p>${bookPages(w.body,l).map(p=>l.stanzaGap==="original"?htmlFromManuscript(p,esc):`<div class="stanzas">${stanzaParts(p).blocks.map(b=>htmlFromManuscript(b,esc)).join("")}</div>`).join("<hr>")}</html>`);
        if(w.source)folder.file("originals/source.txt",w.source.original);
        for(const item of data.revisions){const {revision}=await api("/works/"+id+"/revisions/"+item.version);folder.file("revisions/"+item.version+".json",JSON.stringify(revision,null,2));}
      }
      zip.file("writes-library.json",JSON.stringify({format:"socialdeskclub-writes",schemaVersion:1,exportedAt:new Date().toISOString(),works:all},null,2));
      zip.file("README.txt","Your writing belongs to you.\n\nwrites-library.json can be re-imported into Writes. Each folder contains plain text, Markdown, self-contained readable HTML, structured JSON, saved revisions, and original source text when available.\n\n[[page]] on its own line marks an intentional book page break. No text has been rewritten. Feed images are kept as HTTPS links in Markdown image markers; image binaries are not stored in this archive.\n\nKeep this archive somewhere you control.\n");
      const blob=await zip.generateAsync({type:"blob"}),url=URL.createObjectURL(blob),a=document.createElement("a");
      a.href=url;a.download=ids.length===1?slug(all[0].title)+".zip":"writes-library.zip";a.click();setTimeout(()=>URL.revokeObjectURL(url),15000);notice("Your portable archive is ready.");
    });
  }
  async function toggleArchive(){
    if(dirty&&!window.confirm("Save your current changes and "+(work.archived?"restore":"archive")+" this writing?"))return;
    await attempt(async()=>{const {work:w}=await api("/works/"+work.id,"PUT",{...work,archived:!work.archived});setWork(w);setSaved(JSON.stringify(w));await refresh();notice(w.archived?"Archived. It is still included in library exports.":"Restored to your library.");});
  }
  async function share(){
    if(dirty){setError("Save your changes before reviewing a shareable snapshot.");return;}
    setShareUrl(work.shareToken?location.href.split("#")[0]+"#share="+work.shareToken:"");setModal("share");
  }
  async function publish(){
    await attempt(async()=>{const out=await api("/works/"+work.id+"/share","POST",{confirm:true});setWork(out.work);setSaved(JSON.stringify(out.work));setShareUrl(location.href.split("#")[0]+"#share="+out.token);await refresh();notice("Snapshot created. Future draft edits stay private.");});
  }
  async function revoke(){
    await attempt(async()=>{const out=await api("/works/"+work.id+"/share","DELETE");setWork(out.work);setSaved(JSON.stringify(out.work));setShareUrl("");await refresh();notice("Snapshot link revoked.");});
  }
  async function login(e){
    e.preventDefault();await attempt(async()=>{
      // Call Writes API (CORS OK). Lambda proxies to Reads server-side — avoids browser "Failed to fetch" on authBase.
      const out=await api("/auth/login","POST",{username:username.trim(),password});
      if(!out?.token)throw new Error("Sign-in did not return a session token.");
      setToken(out.token);
      try{
        await refresh({backfillCovers:true,backfillBiblio:true});
      }catch(err){
        setToken("");
        throw new Error("Signed in, but Writes could not open your library ("+(err.message||"unauthorized")+").");
      }
      const u=out.user||{};
      setUser({username:u.username||username.trim(),display_name:u.display_name||u.displayName||u.username||username.trim()});
      setPassword("");notice("Welcome back to your writing desk.");
    });
  }
  const filtered=works.filter(w=>(filter==="archived"?w.archived:!w.archived)&&(filter==="all"||filter==="archived"||filter==="sources"||(filter==="shared"?w.shared:w.kind===filter))&&(w.title+" "+w.author+" "+w.collection).toLowerCase().includes(query.toLowerCase())).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
  const nav=[["all","My library",Library],["poetry","Poetry",Feather],["story","Stories",BookOpen],["essay","Essays",FileText],["other","Other writing",Bookmark],["sources","Imports",Upload],["shared","Shared snapshots",Link2],["archived","Archived",Archive]];
  const activeCount=works.filter(w=>!w.archived).length;
  const categoryOptions=bibLabels.length?bibLabels:defaultCategories();
  async function saveBibLabels(){
    await attempt(async()=>{
      const out=await api("/bibliography/categories","PUT",{categories:bibLabels});
      setBibLabels(out.categories);
      const bib=await api("/bibliography");
      setBibliography(bib);
      notice("Bibliography labels saved. Assigned works keep their category.");
    });
  }
  async function shareBibliography(){
    await attempt(async()=>{
      const out=await api("/bibliography/share","POST",{confirm:true,title:(user?.display_name||user?.username||"My")+" bibliography"});
      const url=location.href.split("#")[0]+"#share="+out.token;
      setShareUrl(url);
      setBibliography(b=>({...b,shareToken:out.token}));
      notice("Bibliography link ready — titles only, not full drafts.");
      try{await navigator.clipboard.writeText(url);}catch{/* ignore */}
    });
  }
  async function revokeBibliography(){
    await attempt(async()=>{
      await api("/bibliography/share","DELETE");
      setBibliography(b=>({...b,shareToken:""}));
      setShareUrl("");
      notice("Bibliography link revoked.");
    });
  }
  return <><a className="skip-link" href="#writes-main">Skip to content</a><header className="topbar">
    <a className="brand" href="https://socialdeskclub.com/" target="_blank" rel="noreferrer"><Logo/><span>Social Desk Club</span></a>
    <nav className="site-nav" aria-label="Social Desk Club"><a href="https://socialdeskclub.com/reads/" target="_blank" rel="noreferrer">Reads <ArrowUpRight size={13}/></a><button className="active" onClick={()=>library()}>Writes</button><a href="https://socialdeskclub.com/camp/" target="_blank" rel="noreferrer">Camp <ArrowUpRight size={13}/></a></nav>
    <div className="header-right"><span className="preview-tag">{cfg.mode==="production"?"MEMBER DESK":"WORKING PREVIEW"}</span>{user&&<button className="sign-out" onClick={signOut}>Sign out</button>}<button className="icon-button" aria-label={theme==="light"?"Switch to dark mode":"Switch to light mode"} onClick={()=>setTheme(theme==="light"?"dark":"light")}>{theme==="light"?<Moon size={19}/>:<Sun size={19}/>}</button></div>
  </header>
  {error&&<div className="error-banner" role="alert"><span>{error}</span><button className="icon-button" aria-label="Dismiss error" onClick={()=>setError("")}><X size={18}/></button></div>}
  {loading?<div className="loading" id="writes-main"><Logo/><p>Opening your writing desk…</p></div>:
  view==="public"&&reader?<Reader work={reader} publicView onClose={()=>{location.hash="";setReader(null);setView("library");}}/>:
  view==="public-bib"&&publicBib?<PublicBibliography bib={publicBib} onClose={()=>{location.hash="";setPublicBib(null);setView("library");}}/>:
  !user?<main className="signin" id="writes-main"><Logo/><p className="eyebrow">SOCIAL DESK CLUB · WRITES</p><h1>Your words have a home.</h1><p>Sign in with your existing Reads member account. Your writing library is separate and private.</p>{cfg.mode==="production"&&!apiReady&&<p className="callout" role="status">The Writes desk is still finishing setup. If this persists, ask an administrator to upload the API package.</p>}{cfg.mode==="production"?<form onSubmit={login}><label>Username<input required value={username} onChange={e=>setUsername(e.target.value)} autoComplete="username"/></label><label>Password<input required type="password" value={password} onChange={e=>setPassword(e.target.value)} autoComplete="current-password"/></label><Button variant="primary" disabled={busy||!apiReady}>Sign in to Writes</Button><a href="https://socialdeskclub.com/reads/" target="_blank" rel="noreferrer">Create a member account in Reads</a></form>:<Button icon={RefreshCw} onClick={()=>{setLoading(true);boot();}}>Try opening the desk again</Button>}<p className="fineprint">Writes never changes your Reads password. Snapshots you share are deliberate copies, not live drafts.</p></main>:
  view==="reader"?<Reader work={reader} onClose={()=>setView(returnView)}/>:
  <div className={"shell "+(view==="editor"?"editing":"")} id="writes-main">
    <aside className="sidebar"><div className="desk-label"><span className="avatar"><Feather size={18}/></span><div><strong>Your writing desk</strong><small>{cfg.mode==="production"?(user.display_name||user.username):"A private place to begin"}</small></div></div>
      <div className="nav-label">YOUR SHELVES</div><nav aria-label="Writing library">{nav.map(([id,label,Icon])=><button key={id} className={view==="library"&&filter===id?"selected":""} onClick={()=>library(id)}><Icon size={18}/><span>{label}</span>{["all","poetry","story","essay"].includes(id)&&<small>{works.filter(w=>!w.archived&&(id==="all"||w.kind===id)).length}</small>}</button>)}
        <button className={view==="bibliography"?"selected":""} onClick={openBibliography}><Library size={18}/><span>Bibliography</span><small>{works.filter(w=>!w.archived).length}</small></button>
      </nav>
      <div className="capacity" aria-live="polite"><span>Library capacity</span><strong>{activeCount} / {LIBRARY_LIMIT}</strong><div className="capacity-bar" role="presentation"><span style={{width:`${Math.min(100,(activeCount/LIBRARY_LIMIT)*100)}%`}}/></div></div>
      <div className="ownership"><Bookmark size={21}/><strong>Yours, wherever you go.</strong><p>Keep the original. Make something new. Take every word with you.</p><button onClick={()=>setModal("about")}>The Writes promise <ArrowUpRight size={15}/></button></div>
      <button className="sidebar-export" disabled={busy||!works.length} onClick={()=>exportWorks(works.map(w=>w.id))}><Download size={18}/>Export my library</button>
    </aside>
    {view==="bibliography"?<main className="library bibliography-view">
      <div className="page-heading"><div><p className="eyebrow">WRITES / BIBLIOGRAPHY</p><h1>A living bibliography.</h1><p className="lede">CV-style listings with date, venue, and category. Rename labels anytime — Stories can become Fiction without moving a single piece.</p></div><div className="heading-actions"><Button icon={Link2} onClick={shareBibliography} disabled={busy}>Share bibliography</Button><Button icon={RefreshCw} onClick={openBibliography} disabled={busy}>Refresh</Button></div></div>
      {bibliography?.shareToken&&<p className="callout">Public link (titles, dates, venues): <a href={location.href.split("#")[0]+"#share="+bibliography.shareToken} target="_blank" rel="noreferrer">{location.href.split("#")[0]+"#share="+bibliography.shareToken}</a> · <button type="button" className="text-button" onClick={revokeBibliography}>Revoke</button></p>}
      <section className="sources-panel bib-labels"><div className="section-label"><h2>Category labels</h2><span>Ids stay stable; only names change</span></div>
        <div className="bib-label-grid">{categoryOptions.map((c,i)=><label key={c.id}><span>{c.id}</span><input maxLength={60} value={bibLabels[i]?.label??c.label} onChange={e=>setBibLabels(list=>list.map((row,idx)=>idx===i?{...row,label:e.target.value}:row))}/><small>{bibLabels[i]?.hint||c.hint}</small></label>)}</div>
        <div className="modal-actions" style={{justifyContent:"flex-start"}}><Button variant="primary" disabled={busy} onClick={saveBibLabels}>Save labels</Button></div>
        <p className="fineprint">Each entry can carry published/written date and where it appeared (Farmapper, Maisa Space, Medium…). Archived drafts stay off this list. Edit dates and venues on each piece.</p>
      </section>
      {(bibliography?.sections||[]).map(section=>(
        <section className="bib-section" key={section.id}>
          <div className="section-label"><h2>{section.label}</h2><span>{section.entries.length}</span></div>
          {section.hint&&<p className="fineprint">{section.hint}</p>}
          {section.entries.length?<ul className="bib-list">{section.entries.map(e=><li key={e.id}><div><strong>{e.title}</strong><small>{e.author||"By you"}{e.venue?` · ${e.venue}`:""}{e.publishedAt?` · ${dateLabel(e.publishedAt)}`:e.writtenAt?` · written ${dateLabel(e.writtenAt)}`:""}{(e.venueUrl||e.sourceUrl)?<> · <a href={e.venueUrl||e.sourceUrl} target="_blank" rel="noreferrer">Link</a></>:null}</small></div><button className="edit-link" type="button" onClick={()=>edit(e.id)}>Open <ArrowUpRight size={15}/></button></li>)}</ul>:<p className="fineprint">Nothing in this category yet.</p>}
        </section>
      ))}
      <footer><span><Lock size={13}/>Bibliography shares list titles, dates, and venues — not full drafts</span><span>Assign categories, dates, and venues in the editor.</span></footer>
    </main>:view==="library"?<main className="library">
      <div className="page-heading"><div><p className="eyebrow">WRITES / {filter==="all"?"YOUR LIBRARY":nav.find(n=>n[0]===filter)?.[1].toUpperCase()}</p><h1>{filter==="all"?"A home for your words.":filter==="sources"?"Bring your writing home.":nav.find(n=>n[0]===filter)?.[1]}</h1><p className="lede">{filter==="sources"?"Import from a publication, an export file, or the page in front of you.":"Poems, stories, and things not quite named yet. All in one place."}</p></div><div className="heading-actions"><Button icon={Upload} onClick={()=>setModal("import")}>Import writing</Button><Button icon={Plus} variant="primary" onClick={newWork}>New writing</Button></div></div>
      {cfg.mode!=="production"&&<div className="preview-note"><span className="status-dot"/>Your own preview workspace. The sample books are examples, not imported member writing.</div>}
      {filter==="sources"?<section className="sources-panel"><div className="section-label"><h2>Your sources</h2><span>Refresh is always manual</span></div>{sources.length?sources.map(s=><div className="source-row" key={s.id}><div><strong>{new URL(s.url).hostname}</strong><p>{s.url}</p><small>Last import {dateLabel(s.updatedAt)}</small></div><Button icon={RefreshCw} onClick={()=>{setShareUrl(s.url);setModal("import");}}>Review new posts</Button></div>):<div className="empty-state"><Upload size={28}/><h2>No publications connected yet.</h2><p>Add your Medium or Substack feed. You will review the available posts before anything is copied.</p><Button variant="primary" onClick={()=>setModal("import")}>Import your first posts</Button></div>}<p className="fineprint">Feeds may contain only recent posts or excerpts. For a fuller archive, use your platform’s export. HTTPS images from the feed are kept as linked addresses; image files are not stored in Writes. Audio and video are still skipped.</p></section>:
      <><div className="library-tools"><div className="section-label"><h2>{filter==="all"?"On your shelf":nav.find(n=>n[0]===filter)?.[1]}</h2><span>{filtered.length} {filtered.length===1?"piece":"pieces"}</span></div><label className="search-field"><Search size={17}/><input aria-label="Find in your library" placeholder="Find a title, author, or collection" value={query} onChange={e=>setQuery(e.target.value)}/>{query&&<button className="icon-button" aria-label="Clear search" onClick={()=>setQuery("")}><X size={16}/></button>}</label></div>
      <div className="book-grid">{filtered.map((w,i)=><article className="book-card" key={w.id}>
        <button className={"book-cover "+w.theme+(coverFor(w)?" has-art":"")} style={coverFor(w)?{backgroundImage:`linear-gradient(180deg,rgba(20,28,22,.15),rgba(20,28,22,.78)),url(${coverFor(w)})`}:undefined} onClick={()=>cardPreview(w.id)} aria-label={"Read "+w.title}><span className="cover-top">{w.kind==="poetry"?"A COLLECTION OF POEMS":w.kind==="story"?"A SHORT STORY":w.kind==="essay"?"NOTES & REFLECTIONS":"COLLECTED WRITING"}</span><span className="cover-rule"/><span className="cover-title">{w.title}</span><span className="cover-author">{w.author||"By you"}</span><span className="cover-bottom"><span>WRITES</span><span>{String(i+1).padStart(2,"0")}</span></span><span className="read-overlay"><BookOpen size={16}/>Open book</span></button>
        <div className="book-meta"><div><span className="book-type">{kinds[w.kind]}</span><span>{w.isDraft?"Archived draft":w.example?"Example":w.venue||w.platform||"Original"}{w.shared?" · Shared":w.isDraft?"":" · Private"}</span></div><button className="edit-link" onClick={()=>edit(w.id)}>Open editor <ArrowUpRight size={15}/></button><div className="book-date">{w.words} words<span>{w.publishedAt?dateLabel(w.publishedAt):dateLabel(w.updatedAt)}</span></div></div>
      </article>)}{filter==="all"&&!query&&<button className="new-book" onClick={newWork}><span className="new-book-icon"><Plus size={28} strokeWidth={1}/></span><strong>The next page<br/>is yours.</strong><span>Start something new <ArrowUpRight size={16}/></span></button>}</div>
      {!filtered.length&&(query||filter!=="all")&&<div className="empty-state"><BookOpen size={28}/><h2>{query?"No writing matches that search.":"A little room for something new."}</h2><p>{query?"Try a different title, author, or collection.":"Your saved writing will appear on this shelf."}</p><Button onClick={newWork} icon={Plus}>New writing</Button></div>}
      <div className="library-bottom"><div><span className="eyebrow">FROM ANYWHERE. FOR KEEPS.</span><h2>Your writing shouldn’t live on borrowed time.</h2><p>Bring your posts in from Medium, Substack, or a file. Keep an independent text copy, then make it your own.</p></div><Button icon={ArrowRight} onClick={()=>setModal("import")}>Bring a piece over</Button></div></>}
      <footer><span><Lock size={13}/>Private until you choose to share</span><span>Made for the words, not the algorithm.</span></footer>
    </main>:<main className="editor">
      <div className="editor-top"><Button icon={ArrowLeft} variant="quiet" onClick={()=>library()}>My library</Button><div className="save-state">{dirty?<><span className="unsaved-dot"/>Unsaved changes</>:<><Check size={15}/> {work.id?"Saved":"New draft"}</>}</div><div className="editor-actions"><Button icon={BookOpen} onClick={()=>preview(work,"editor")}>Read as a book</Button><Button variant="primary" disabled={busy||(!dirty&&!!work.id)} onClick={save}>{busy?"Saving…":"Save writing"}</Button></div></div>
      <div className="editor-layout"><section className="manuscript"><label className="sr-only" htmlFor="work-title">Title</label><input id="work-title" className="title-input" placeholder="Give it a title" maxLength={180} value={work.title} onChange={e=>change("title",e.target.value)}/><label className="author-field"><span>By</span><input aria-label="Author" placeholder="Your name" maxLength={120} value={work.author} onChange={e=>change("author",e.target.value)}/></label>
        <div className="writing-toolbar"><span><Feather size={15}/>{kinds[work.kind]}</span><button onClick={()=>setModal("arrange")}><AlignLeft size={15}/>Arrange verse</button><button onClick={()=>{const el=bodyRef.current,a=el.selectionStart,b=el.selectionEnd;change("body",work.body.slice(0,a)+"\n\n[[page]]\n\n"+work.body.slice(b));setTimeout(()=>{el.focus();el.setSelectionRange(a+12,a+12);},0);}}><Scissors size={15}/>Page break</button></div>
        <label className="sr-only" htmlFor="work-body">Manuscript</label><textarea id="work-body" ref={bodyRef} className="body-input" spellCheck placeholder={"Begin here.\n\nA line, a stanza, a very small adventure."} value={work.body} onChange={e=>change("body",e.target.value)}/>
        <div className="writing-status"><span>{countWords(work.body)} words · {bookPages(work.body,work.layout).length} book {bookPages(work.body,work.layout).length===1?"page":"pages"}</span><span>Line breaks stay as you write them.</span></div>
      </section><aside className="editor-settings"><h2>Make it yours</h2><label>Writing type<select value={work.kind} onChange={e=>change("kind",e.target.value)}>{Object.entries(kinds).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label><p className="fineprint">{kindHints[work.kind]}</p>
        <label>Bibliography category<select value={work.categoryId||categoryIdFromKind(work.kind)} onChange={e=>change("categoryId",e.target.value)}>{categoryOptions.map(c=><option key={c.id} value={c.id}>{c.label}</option>)}</select></label>
        <p className="fineprint">{categoryOptions.find(c=>c.id===(work.categoryId||categoryIdFromKind(work.kind)))?.hint||"Appears under this heading in your living bibliography."}</p>
        <label>Published date<input type="date" value={dateInputValue(work.publishedAt)} onChange={e=>change("publishedAt",e.target.value)}/></label>
        <label>Written date<input type="date" value={dateInputValue(work.writtenAt)} onChange={e=>change("writtenAt",e.target.value)}/></label>
        <p className="fineprint">Published date comes from Substack/Medium when known. Written date is for drafts and pre-publication work.</p>
        <label>Where published<input placeholder="Farmapper, Maisa Space, Medium…" maxLength={120} value={work.venue||""} onChange={e=>change("venue",e.target.value)}/></label>
        <label>Venue / source URL<input type="url" placeholder="https://…" maxLength={2000} value={work.venueUrl||""} onChange={e=>change("venueUrl",e.target.value)}/></label>
        <label>Collection<input placeholder="An optional shelf name" value={work.collection} maxLength={80} onChange={e=>change("collection",e.target.value)}/></label>
        <fieldset><legend>Book cover</legend><div className="swatches">{["forest","clay","linen","night"].map(t=><button key={t} className={"swatch "+t+(t===work.theme?" chosen":"")} aria-label={t+" cover"} aria-pressed={t===work.theme} onClick={()=>change("theme",t)}>{t===work.theme?<Check size={18}/>:null}</button>)}</div></fieldset>
        <p className="setting-note">Use a page break where a poem or chapter should turn. Long pages scroll, so nothing is cut off.</p>
        <LayoutControls value={work.layout} onChange={v=>change("layout",v)}/>
        <Button icon={Bookmark} disabled={busy} onClick={()=>{setVersionName("");setModal("name-version");}}>Save named version</Button>
        {work.versionName&&<p className="setting-note">Current saved edition: <strong>{work.versionName}</strong></p>}
        <div className="settings-divider"/><span className="privacy-label"><Lock size={15}/>{work.draftOf?"Archived draft":"Private draft"}</span><p className="setting-note">{work.draftOf?"Linked under a primary piece — off the main shelf and bibliography.":"No automatic publishing. No AI detectors. No rewriting your words."}</p>
        {work.draftOf&&<div className="source-card"><small>DRAFT OF</small><p>{works.find(w=>w.id===work.draftOf)?.title||"Primary writing"}{work.draftNote?` — ${work.draftNote}`:""}</p><button type="button" onClick={()=>edit(work.draftOf)}>Open primary <ExternalLink size={14}/></button><button type="button" onClick={()=>unlinkDraft(true)}>Restore to library</button></div>}
        {work.id&&!work.draftOf&&<>
          <div className="settings-divider"/><span className="privacy-label"><Archive size={15}/>Archived drafts</span>
          <p className="fineprint">Keep Google Docs roughs and earlier cuts under this published piece — not on the main shelf.</p>
          {linkedDrafts.length?<ul className="draft-list">{linkedDrafts.map(d=><li key={d.id}><button type="button" className="text-button" onClick={()=>edit(d.id)}>{d.title}</button><small>{d.draftNote||"Draft"}{d.writtenAt?` · ${dateLabel(d.writtenAt)}`:""}</small></li>)}</ul>:<p className="fineprint">No archived drafts yet.</p>}
          <Button icon={Archive} disabled={busy} onClick={()=>{setDraftNoteInput("Earlier draft");setDraftWrittenAt(dateInputValue(work.writtenAt||work.publishedAt)||"");setModal("archive-draft");}}>Archive current text as draft</Button>
          <Button disabled={busy} onClick={()=>{setDraftPrimaryId("");setDraftNoteInput("");setDraftWrittenAt(dateInputValue(work.writtenAt)||"");setModal("link-draft");}}>Link this piece as a draft of…</Button>
        </>}
        {work.id&&<><Button icon={Link2} disabled={busy} onClick={share}>{work.shareToken?"Manage snapshot":"Share snapshot"}</Button><Button icon={Download} disabled={busy||dirty} onClick={()=>exportWorks([work.id])}>Export writing</Button><Button icon={History} onClick={showHistory}>Saved versions</Button><Button icon={Archive} onClick={toggleArchive}>{work.archived?"Restore to library":"Archive writing"}</Button></>}
        {work.source&&<div className="source-card"><small>IMPORTED FROM {work.source.platform.toUpperCase()}</small><p>Your imported original is kept separately from your edits.</p><button onClick={()=>setModal("original")}>View original source <ExternalLink size={14}/></button>{work.source.platform==="Google Docs text copy"&&<button onClick={()=>{if(!abandon())return;setShareUrl(work.source.url);setModal("import");}}>Review a newer Google draft <RefreshCw size={14}/></button>}</div>}
      </aside></div>
    </main>}
  </div>}
  {toast&&<div className="toast" role="status"><Check size={18}/>{toast}</div>}
  {modal==="import"&&<ImportModal initialName={work?.title||""} initialUrl={shareUrl.startsWith("https:")&&!shareUrl.includes("#share=")?shareUrl:""} onClose={()=>{setModal("");setShareUrl("");}} onDone={async message=>{setModal("");setShareUrl("");await refresh({backfillBiblio:true});setWork(null);setSaved("");setView("library");setFilter("all");notice(message);}}/>}
  {modal==="archive-draft"&&<Modal title="Archive current text as a draft" onClose={()=>{if(!busy)setModal("");}}><form className="modal-body" onSubmit={e=>{e.preventDefault();archiveCurrentAsDraft();}}>{error&&<p className="form-error" role="alert">{error}</p>}<p>Copies this piece’s current text into an archived draft under it. The primary stays on your shelf and bibliography; the draft does not.</p><label>Note<input maxLength={240} placeholder="Google Docs rough before trim" value={draftNoteInput} onChange={e=>setDraftNoteInput(e.target.value)}/></label><label>Draft date<input type="date" value={draftWrittenAt} onChange={e=>setDraftWrittenAt(e.target.value)}/></label><div className="modal-actions"><Button disabled={busy} variant="primary">Archive draft</Button></div></form></Modal>}
  {modal==="link-draft"&&<Modal title="Link as archived draft of…" onClose={()=>{if(!busy)setModal("");}}><form className="modal-body" onSubmit={e=>{e.preventDefault();linkAsDraft();}}>{error&&<p className="form-error" role="alert">{error}</p>}<p>Use this for a Google Docs paste or rough that later became a published post. This piece leaves the main shelf and bibliography.</p><label>Primary writing<select required value={draftPrimaryId} onChange={e=>setDraftPrimaryId(e.target.value)}><option value="">Choose…</option>{works.filter(w=>!w.archived&&!w.isDraft&&w.id!==work?.id).map(w=><option key={w.id} value={w.id}>{w.title}</option>)}</select></label><label>Note<input maxLength={240} placeholder="Rough draft from Docs" value={draftNoteInput} onChange={e=>setDraftNoteInput(e.target.value)}/></label><label>Draft date<input type="date" value={draftWrittenAt} onChange={e=>setDraftWrittenAt(e.target.value)}/></label><div className="modal-actions"><Button disabled={busy||!draftPrimaryId} variant="primary">Link as draft</Button></div></form></Modal>}
  {modal==="about"&&<Modal title="The Writes promise" onClose={()=>setModal("")}><div className="modal-body prose"><p>Your writing can begin anywhere. It should not have to stay there.</p><ul><li><strong>A copy you control.</strong> Imports become independent text copies. Their originals remain attached.</li><li><strong>Your voice, untouched.</strong> Plain-text editing preserves line breaks, indentation, and stanza spacing.</li><li><strong>An open door.</strong> Export TXT, Markdown, readable HTML, JSON, and saved revisions in a ZIP.</li><li><strong>You decide what leaves.</strong> Drafts stay private. Sharing creates a separate snapshot; later edits do not silently publish.</li></ul><p>Feed images are kept as HTTPS links so they can display in the reader. Binary image storage in Writes, illustration tools, and AI assistance are later additions.</p><p className="fineprint">{cfg.mode==="production"?"Your private library is stored in the Social Desk Club AWS account. Export anything important so you always keep a copy you control.":"The preview uses temporary development hosting, not your live AWS library. Export anything important before relying on it."}</p></div></Modal>}
  {modal==="arrange"&&<Modal title="Give your verses room" wide onClose={()=>{if(!busy)setModal("");}}>{error&&<p className="form-error" role="alert">{error}</p>}<VerseArranger body={work.body} busy={busy} onCancel={()=>setModal("")} onApply={body=>{change("body",body);setModal("");notice("Arrangement applied to your draft. Save when you are ready.");}} onAlternate={alternate}/></Modal>}
  {modal==="name-version"&&<Modal title="Keep a named version" onClose={()=>{if(!busy)setModal("");}}><form className="modal-body" onSubmit={async e=>{e.preventDefault();if(await save(versionName.trim()))setModal("");}}>{error&&<p className="form-error" role="alert">{error}</p>}<p>Save the current text and book layout as an edition you can find again. Later changes will not replace this saved version.</p><label>Version name<input autoFocus required maxLength={80} placeholder="Reading-night version" value={versionName} onChange={e=>setVersionName(e.target.value)}/></label><div className="modal-actions"><Button disabled={busy||!versionName.trim()} variant="primary">Save this version</Button></div></form></Modal>}
  {modal==="history"&&<Modal title="Saved versions" onClose={()=>setModal("")}><div className="modal-body">{history.map(h=><div className="history-row" key={h.version}><div><strong>{h.versionName||`Version ${h.version}`}</strong><small>Version {h.version}{h.version===work.version?" · Current":""} · {new Date(h.updatedAt).toLocaleString()} · {h.body===undefined?h.words:countWords(h.body)} words</small></div><Button disabled={busy} onClick={()=>loadVersion(h)}>Load as draft</Button></div>)}<p className="fineprint">The current version, 20 recent versions, and older named versions are shown. Every retained version is included in exports.</p></div></Modal>}
  {modal==="original"&&<Modal title="Your imported original" wide onClose={()=>setModal("")}><div className="modal-body"><p>Read-only source captured on {dateLabel(work.source.fetchedAt)}. It is never rendered as executable HTML.</p>{/^https?:/.test(work.source.url)&&<a href={work.source.url} target="_blank" rel="noreferrer">Visit the original post <ExternalLink size={14}/></a>}<pre className="original-text">{work.source.original}</pre></div></Modal>}
  {modal==="share"&&<Modal title="Share a snapshot, not your draft" wide onClose={()=>setModal("")}><div className="modal-body"><p>Audience: anyone with the link on the live site. Only the title, author, collection, cover, and complete text below are shared. Source files and version history stay private.</p>{cfg.mode!=="production"&&<p className="callout">This Computer preview is private. Links created here test snapshot behavior; they are not public production links.</p>}<h3>{work.title}</h3><p>{work.author}</p><div className="share-text"><VerseText text={work.body} layout={work.layout} wrap/></div>{shareUrl&&<label>Snapshot address<input readOnly value={shareUrl} onFocus={e=>e.target.select()}/><a href={shareUrl} target="_blank" rel="noreferrer">Open saved snapshot <ExternalLink size={14}/></a></label>}<div className="modal-actions">{shareUrl&&<Button onClick={revoke} disabled={busy}>Revoke link</Button>}<Button variant="primary" onClick={publish} disabled={busy}>{shareUrl?"Replace snapshot with this version":"Create this snapshot"}</Button></div><p className="fineprint">Recipients may keep copies. Revoking a link cannot recall copies they already made.</p></div></Modal>}
  </>;
}
function ImportModal({initialUrl,initialName,onClose,onDone}){
  const isGoogle=initialUrl.startsWith("https://docs.google.com/document/");
  const [tab,setTab]=useState(isGoogle?"google":"feed"),[url,setUrl]=useState(isGoogle?"":initialUrl),[name,setName]=useState(isGoogle?(initialName||"Google Docs draft"):"Pasted writing.txt"),[text,setText]=useState(""),[base64,setBase64]=useState("");
  const [googleDocUrl,setGoogleDocUrl]=useState(isGoogle?initialUrl:"");
  const [job,setJob]=useState(null),[selected,setSelected]=useState([]),[rights,setRights]=useState(false),[approve,setApprove]=useState(false),[includeAllAuthors,setIncludeAllAuthors]=useState(false),[soleAuthorExport,setSoleAuthorExport]=useState(false),[publicationUrl,setPublicationUrl]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState("");
  async function run(fn){setBusy(true);setError("");try{await fn();}catch(e){setError(e.message);}finally{setBusy(false);}}
  async function file(e){
    setError("");const f=e.target.files[0];if(!f)return;const zip=f.name.toLowerCase().endsWith(".zip");if(f.size>(zip?25000000:3000000)){setError(zip?"Choose a ZIP smaller than 25 MB.":"Choose a file smaller than 3 MB.");return;}
    setName(f.name);setText("");setBase64("");
    if(f.name.toLowerCase().endsWith(".zip")){
      const r=new FileReader();
      r.onload=async()=>{
        const b64=r.result.split(",")[1];
        setBase64(b64);
        try{
          const z=await JSZip.loadAsync(f);
          for(const path of Object.keys(z.files)){
            const m=path.match(/(?:^|\/)email_list\.([A-Za-z0-9_-]+)\.csv$/i);
            if(m){setPublicationUrl(u=>u.trim()?u:`https://${m[1]}.substack.com`);break;}
          }
        }catch{/* ignore zip peek */}
      };
      r.readAsDataURL(f);
    }else setText(await f.text());
  }
  async function preview(e){
    e.preventDefault();
    if(tab==="file"&&String(name).toLowerCase().endsWith(".zip")&&!publicationUrl.trim()){
      setError("Paste the publication homepage (e.g. https://blog.maisaspace.org) so Writes can look up authors. Substack ZIPs have no author column.");
      return;
    }
    await run(async()=>{const out=await api("/import/preview","POST",tab==="feed"?{url,includeAllAuthors}:tab==="google"?{googleDocUrl,name,text}:{name,text,base64,publicationUrl,includeAllAuthors,soleAuthorExport});setJob(out);setApprove(false);setRights(false);setSelected(out.candidates.filter(c=>c.status==="new"&&c.authorGate!=="unknown").map(c=>c.index));});
  }
  async function commit(){await run(async()=>{const out=await api("/import/commit","POST",{jobId:job.jobId,selected,rights,approvedChanges:approve?selected:[]});const n=out.results.filter(r=>["imported","updated"].includes(r.status)).length,pending=out.results.filter(r=>["conflict","needs-review"].includes(r.status)).length;if(pending){setError(`${n} saved. ${pending} changed while you were reviewing. Preview again before updating those pieces.`);setJob(null);}else await onDone(`${n} ${n===1?"piece":"pieces"} saved to your private library.`);});}
  const statusLabel=c=>{
    if(c.status==="excluded") return c.authorNote?`Locked — ${c.authorNote}`:"Locked — not your byline (enable “Import every author” to include)";
    if(c.authorGate==="unknown") return c.authorNote||"No byline — check to include only if you own this post";
    if(c.status==="new") return "New";
    if(c.status==="unchanged") return "Already in library";
    return "Changed — review";
  };
  const rowLocked=c=>c.status==="unchanged"||c.status==="excluded";
  return <Modal title={job?"Review before bringing it home":"Bring your writing home"} wide onClose={()=>{if(!busy)onClose();}}><div className="modal-body">
    {error&&<p className="form-error" role="alert">{error}</p>}
    {!job?<><p>Copy your own writing into an independent library. Nothing is posted back to its source.</p><div className="tabs" role="tablist" aria-label="Import method">{[["feed","Publication feed"],["google","Google Docs paste"],["file","Upload a file"],["paste","Paste text"]].map(([id,label])=><button role="tab" aria-selected={tab===id} key={id} onClick={()=>{setTab(id);setError("");setName(id==="google"?"Google Docs draft":"Pasted writing.txt");setText("");setBase64("");}}>{label}</button>)}</div><form onSubmit={preview}>
      {tab==="google"?<><p className="callout">No live Google connection. Paste your draft or upload its TXT export. The document address only matches later imports to the same writing — it never fetches the Doc.</p><label>Google Doc address<input type="url" required placeholder="https://docs.google.com/document/d/…" value={googleDocUrl} onChange={e=>setGoogleDocUrl(e.target.value)}/></label><label>Writing title<input required maxLength={180} value={name} onChange={e=>setName(e.target.value)}/></label><label>Plain-text export<input type="file" accept=".txt" aria-label="Google Docs text export" onChange={async e=>{const f=e.target.files[0];if(!f)return;if(!f.name.toLowerCase().endsWith(".txt")||f.size>120000){setError("Choose a TXT export smaller than 120 KB.");return;}setName(f.name.replace(/\.txt$/i,""));setText(await f.text());setError("");}}/></label><label>Draft text<textarea required className="paste-input" value={text} onChange={e=>setText(e.target.value)} placeholder="Paste the draft, keeping its line breaks."/></label><p className="fineprint">Review spacing before importing. Only this text is archived, not Google comments, formatting, images, or earlier Google revisions. Re-import with the same Doc address when you want to review a newer draft.</p></>:tab==="feed"?<><label>Medium, Substack, or RSS address<input required type="url" placeholder="https://your-publication.substack.com" value={url} onChange={e=>setUrl(e.target.value)}/></label><label className="check-label"><input type="checkbox" checked={includeAllAuthors} onChange={e=>setIncludeAllAuthors(e.target.checked)}/><span>Import every author on this publication (not just my posts)</span></label><p className="fineprint">By default only posts matching your Reads name/username (and Substack @profile name) are listed. Medium profile: https://medium.com/@yourname<br/>Substack: https://yourname.substack.com or https://substack.com/@yourname<br/>Custom-domain blogs: https://www.blog.example.com — Writes appends /feed automatically.</p></>:tab==="file"?<><label className="file-drop"><Upload size={28}/><strong>Choose an export or a writing file</strong><span>TXT, MD, HTML, JSON, Substack ZIP · up to 25 MB for Substack exports</span><input aria-label="Writing file" type="file" accept=".txt,.md,.html,.htm,.json,.zip" onChange={file}/></label>{(text||base64)&&<p className="file-selected"><Check size={16}/>{name}</p>}{String(name).toLowerCase().endsWith(".zip")&&<><label>Publication homepage <strong>(required for author lookup)</strong><input type="url" required placeholder="https://blog.maisaspace.org" value={publicationUrl} onChange={e=>setPublicationUrl(e.target.value)}/><small className="fineprint">Substack ZIPs have no author column. Writes looks up bylines from this site’s RSS and /api/v1/posts/{"{slug}"} (including posts older than the RSS window). Early posts that still lack a byline stay selectable — check them only if you own them.</small></label><label className="check-label"><input type="checkbox" checked={soleAuthorExport} onChange={e=>{setSoleAuthorExport(e.target.checked);if(e.target.checked)setIncludeAllAuthors(false);}}/><span>This export is only my writing (blank bylines count as mine — e.g. Farmapper)</span></label></>}<label className="check-label"><input type="checkbox" checked={includeAllAuthors} onChange={e=>{setIncludeAllAuthors(e.target.checked);if(e.target.checked)setSoleAuthorExport(false);}}/><span>Import every author in this file (not just my posts)</span></label><p className="fineprint">Substack ZIPs omit authors. Homepage is required (auto-filled from email_list.subdomain.csv when present). Writes looks up RSS + API bylines — not an LLM. Author-only keeps your posts; other authors stay locked. No-byline rows can be checked after you confirm ownership.</p></>:<><label>File or piece name<input value={name} required onChange={e=>setName(e.target.value)}/></label><label>Your text<textarea className="paste-input" required value={text} onChange={e=>setText(e.target.value)}/></label></>}
      <div className="callout"><Lock size={17}/><span>Feeds can be incomplete or excerpt-only. Imported HTML is converted to plain text, so review poetry spacing before saving.</span></div><div className="modal-actions"><Button disabled={busy||(tab==="file"&&!text&&!base64)} variant="primary">{busy?"Reading the source…":"Preview import"}</Button></div></form></>:
    <><p className="callout">{job.warning}</p>{job.candidates.some(c=>c.authorGate==="unknown")&&<p className="fineprint">Rows marked “no byline” are unchecked by default. Check any you own, then confirm rights below — they are not locked forever. Co-author rows stay locked unless you enable “Import every author.”</p>}<div className="import-list">{job.candidates.map(c=><div className={"import-item "+(rowLocked(c)?"unchanged":c.authorGate==="unknown"?"unknown-author":"")} key={c.index}><label className="candidate-label"><input type="checkbox" disabled={rowLocked(c)} checked={selected.includes(c.index)} onChange={e=>setSelected(s=>e.target.checked?[...s,c.index]:s.filter(i=>i!==c.index))}/><span><strong>{c.title||"(Untitled)"}</strong><small>{c.platform}{c.author?` · ${c.author}`:""} · {statusLabel(c)}{c.coverUrl?" · has image":""}</small></span></label>{c.status!=="excluded"&&<details><summary>Read imported text{c.status==="changed"?" and compare":""}</summary>{c.status==="changed"&&<><h4>Your current writing</h4><div className="import-preview-body"><VerseText text={c.existingBody||""} wrap/></div><h4>Incoming text</h4></>}<div className="import-preview-body"><VerseText text={c.body||"(No text in this feed entry)"} wrap/></div></details>}</div>)}</div>
      <label className="check-label"><input type="checkbox" checked={rights} onChange={e=>setRights(e.target.checked)}/><span>I own the selected writing or have permission to copy it.</span></label>
      {job.candidates.some(c=>c.status==="changed"&&selected.includes(c.index))&&<label className="check-label"><input type="checkbox" checked={approve} onChange={e=>setApprove(e.target.checked)}/><span>I reviewed the changes. Replace the selected current text and keep its previous version in history.</span></label>}
      <div className="modal-actions"><Button disabled={busy} onClick={()=>setJob(null)}>Back</Button><Button variant="primary" disabled={busy||!rights||!selected.length||(job.candidates.some(c=>c.status==="changed"&&selected.includes(c.index))&&!approve)} onClick={commit}>{busy?"Saving copies…":`Import ${selected.length} ${selected.length===1?"piece":"pieces"}`}</Button></div>
    </>}
  </div></Modal>;
}
function PublicBibliography({bib,onClose}){
  return <main className="library bibliography-view public-bib" id="writes-main">
    <div className="page-heading"><div><p className="eyebrow">SOCIAL DESK CLUB · WRITES</p><h1>{bib.title||"Bibliography"}</h1><p className="lede">{bib.author?`A public reading list from ${bib.author}.`:"A public reading list from Writes."} Titles only — not the full drafts.</p></div><Button icon={X} onClick={onClose}>Close</Button></div>
    {(bib.sections||[]).map(section=>(
      <section className="bib-section" key={section.id}>
        <div className="section-label"><h2>{section.label}</h2><span>{(section.entries||[]).length}</span></div>
        {(section.entries||[]).length?<ul className="bib-list">{section.entries.map((e,i)=><li key={i}><div><strong>{e.title}</strong><small>{e.author||""}{e.venue?` · ${e.venue}`:""}{e.publishedAt?` · ${dateLabel(e.publishedAt)}`:e.writtenAt?` · written ${dateLabel(e.writtenAt)}`:""}{(e.venueUrl||e.sourceUrl)?<> · <a href={e.venueUrl||e.sourceUrl} target="_blank" rel="noreferrer">Link</a></>:null}</small></div></li>)}</ul>:<p className="fineprint">No entries.</p>}
      </section>
    ))}
  </main>;
}
function Reader({work,onClose,publicView=false}){
  const pages=bookPages(work.body,work.layout),[index,setIndex]=useState(0),[mode,setMode]=useState("book"),[wrap,setWrap]=useState(work.kind!=="poetry"),[flipping,setFlipping]=useState(false);
  const mobile=useRef(matchMedia("(max-width: 760px)").matches),[small,setSmall]=useState(mobile.current);
  const pageCount=pages.length+1,step=small?1:2,max=Math.floor((pageCount-1)/step)*step;
  useEffect(()=>{const m=matchMedia("(max-width: 760px)"),fn=()=>{setSmall(m.matches);setIndex(0);};m.addEventListener("change",fn);return()=>m.removeEventListener("change",fn);},[]);
  function turn(delta){setIndex(i=>Math.max(0,Math.min(max,i+delta*step)));setFlipping(true);setTimeout(()=>setFlipping(false),330);}
  useEffect(()=>{const fn=e=>{if(e.key==="ArrowRight")turn(1);if(e.key==="ArrowLeft")turn(-1);if(e.key==="Escape")onClose();};window.addEventListener("keydown",fn);return()=>window.removeEventListener("keydown",fn);},[max,step]);
  function page(n){return n===0?<div className={"reader-cover "+work.theme}><span className="cover-top">{kinds[work.kind]}</span><div><h1>{work.title}</h1><p>{work.author||"By you"}</p></div><span className="cover-bottom">SOCIAL DESK CLUB · WRITES</span></div>:n<=pages.length?<div className="reader-page"><div className="running-head">{work.title}</div><VerseText text={pages[n-1]} layout={work.layout} wrap={wrap}/><span className="folio">{n}</span></div>:<div className="reader-page end-page"><Feather size={24}/><p>A little space<br/>for what comes next.</p></div>;}
  return <main className="reader"><div className="reader-toolbar"><Button icon={ArrowLeft} variant="quiet" onClick={onClose}>{publicView?"Writing desk":"Back to desk"}</Button><span>{publicView?"SHARED SNAPSHOT":"YOUR BOOK, UNBOUND"}</span><div className="reader-switch"><Button icon={mode==="book"?AlignLeft:BookOpen} onClick={()=>setMode(mode==="book"?"scroll":"book")}>{mode==="book"?"Scroll view":"Book view"}</Button></div></div>
    <div className="reader-sub"><span>{work.collection||"An independent edition"}</span><label className="check-label"><input type="checkbox" checked={wrap} onChange={e=>setWrap(e.target.checked)}/>Wrap long lines</label></div>
    {mode==="book"?<><div className={"book-spread "+(flipping?"turning":"")}>{page(index)}{!small&&page(index+1)}</div><div className="reader-controls"><button className="icon-button" aria-label="Previous page" disabled={index===0} onClick={()=>turn(-1)}><ArrowLeft/></button><span>{index===0?"Cover":`Page ${index}`} {small?"":index+1<=pages.length?`/ ${index+1}`:""}<small>{pages.length} text {pages.length===1?"page":"pages"} · use arrow keys</small></span><button className="icon-button" aria-label="Next page" disabled={index>=max} onClick={()=>turn(1)}><ArrowRight/></button></div><p className="reader-hint">Long pages scroll inside the book. {wrap?"Lines wrap to fit.":"Original line lengths are preserved; scroll sideways if needed."}</p></>:<article className="scroll-reader"><h1>{work.title}</h1><p>{work.author}</p>{pages.map((p,i)=><React.Fragment key={i}>{i>0&&<hr/>}<VerseText text={p} layout={work.layout} wrap={wrap}/></React.Fragment>)}</article>}
  </main>;
}
createRoot(document.getElementById("root")).render(<App/>);
