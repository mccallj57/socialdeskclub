import React,{useState} from "react";
import {ArrowUp,ArrowDown,Undo2} from "lucide-react";
import {DEFAULT_LAYOUT,stanzaParts,joinStanzas,moveStanza} from "../../shared/poetry.mjs";
import {splitManuscript} from "../../shared/manuscript.mjs";

function ManuscriptChunk({text}) {
  return splitManuscript(text).map((part,i)=>part.type==="image"
    ? <img key={i} className="manuscript-image" src={part.src} alt={part.alt||""} loading="lazy" referrerPolicy="no-referrer"/>
    : <span key={i} className="manuscript-text">{part.value}</span>);
}

export function VerseText({text,layout={},wrap=false}) {
  const l={...DEFAULT_LAYOUT,...layout};
  return <div className={"poem "+(wrap?"wrap":"")} style={{lineHeight:l.lineHeight,textAlign:l.align}}>
    {l.stanzaGap==="original"?<ManuscriptChunk text={text}/>:<div className={"verse-spacing "+l.stanzaGap}>{stanzaParts(text).blocks.map((b,i)=><div key={i}><ManuscriptChunk text={b}/></div>)}</div>}
  </div>;
}
export function LayoutControls({value,onChange}) {
  const l={...DEFAULT_LAYOUT,...value};
  return <fieldset className="layout-settings"><legend>Book layout</legend>
    <p className="setting-note">Presentation only. These controls never rewrite your manuscript.</p>
    <label>Page arrangement<select aria-label="Page arrangement" value={l.pageMode} onChange={e=>onChange({...l,pageMode:e.target.value})}><option value="manual">Use my page breaks</option><option value="stanza">One stanza per page</option></select></label>
    <label>Alignment<select aria-label="Alignment" value={l.align} onChange={e=>onChange({...l,align:e.target.value})}><option value="left">Left</option><option value="center">Centered</option><option value="right">Right</option></select></label>
    <label>Line spacing<select aria-label="Line spacing" value={l.lineHeight} onChange={e=>onChange({...l,lineHeight:Number(e.target.value)})}><option value={1.4}>Close</option><option value={1.9}>Natural</option><option value={2.3}>Open</option></select></label>
    <label>Stanza spacing<select aria-label="Stanza spacing" value={l.stanzaGap} onChange={e=>onChange({...l,stanzaGap:e.target.value})}><option value="original">As written</option><option value="compact">Compact</option><option value="airy">Airy</option></select></label>
  </fieldset>;
}
export function VerseArranger({body,onApply,onAlternate,onCancel,busy}) {
  const [parts,setParts]=useState(()=>stanzaParts(body)),[undo,setUndo]=useState([]);
  const [name,setName]=useState("Alternate arrangement");
  function update(next){setUndo(u=>[...u.slice(-29),parts]);setParts(next);}
  function edit(i,text){update({...parts,blocks:parts.blocks.map((b,j)=>j===i?text:b)});}
  const result=joinStanzas(parts);
  return <div className="modal-body verse-workspace">
    <p>Move or edit whole stanzas without retyping them. Blank-line spacing stays in place; indentation travels with each stanza.</p>
    <p className="callout">This changes the words and their order, not just the book layout. Apply to your unsaved draft, or save a separate alternate to leave the original alone.</p>
    <div className="verse-tools"><strong>{parts.blocks.length} {parts.blocks.length===1?"block":"blocks"}</strong><button className="button" disabled={!undo.length} onClick={()=>{setParts(undo.at(-1));setUndo(u=>u.slice(0,-1));}}><Undo2 size={16}/>Undo</button><button className="button" onClick={()=>update(stanzaParts(body))}>Reset arrangement</button></div>
    <div className="stanza-list">{parts.blocks.map((block,i)=><section className="stanza-card" key={i}>
      <div className="stanza-head"><strong>{block.trim()==="[[page]]"?"Page break":`Stanza ${i+1}`}</strong><div>
        <button className="icon-button" aria-label={`Move stanza ${i+1} up`} disabled={i===0} onClick={()=>update(moveStanza(parts,i,-1))}><ArrowUp size={18}/></button>
        <button className="icon-button" aria-label={`Move stanza ${i+1} down`} disabled={i===parts.blocks.length-1} onClick={()=>update(moveStanza(parts,i,1))}><ArrowDown size={18}/></button>
      </div></div>
      <textarea aria-label={`Stanza ${i+1}`} rows={Math.min(10,Math.max(3,block.split("\n").length))} value={block} onChange={e=>edit(i,e.target.value)} spellCheck/>
      {block.trim()!=="[[page]]"&&<div className="stanza-actions"><button onClick={()=>edit(i,block.replace(/^/gm,"  "))}>Indent</button><button onClick={()=>edit(i,block.replace(/^(?: {1,2}|\t)/gm,""))}>Outdent</button><button onClick={()=>edit(i,block.replace(/\r?\n/g," "))}>Join lines</button></div>}
    </section>)}</div>
    <details className="arrangement-preview"><summary>Read the arranged manuscript</summary><pre>{result}</pre></details>
    <label>Alternate title suffix<input value={name} maxLength={60} onChange={e=>setName(e.target.value)}/></label>
    <div className="modal-actions"><button className="button" disabled={busy} onClick={onCancel}>Cancel</button><button className="button" disabled={busy||!name.trim()} onClick={()=>onAlternate(result,name.trim())}>Save as alternate</button><button className="button primary" disabled={busy} onClick={()=>onApply(result)}>Apply to draft</button></div>
  </div>;
}
