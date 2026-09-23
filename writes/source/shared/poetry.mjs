export const DEFAULT_LAYOUT = Object.freeze({lineHeight:1.9,stanzaGap:"original",align:"left",pageMode:"manual"});
export function stanzaParts(body) {
  // Blank-line separators are kept verbatim, including CRLF and whitespace.
  const parts = body.split(/(\r?\n[ \t]*\r?\n(?:[ \t]*\r?\n)*)/);
  return {blocks:parts.filter((_,i)=>i%2===0),gaps:parts.filter((_,i)=>i%2===1)};
}
export function joinStanzas({blocks,gaps}) {
  return blocks.map((text,i)=>text+(gaps[i]||"")).join("");
}
export function moveStanza(parts,index,delta) {
  const next=index+delta;
  if(next<0||next>=parts.blocks.length)return parts;
  const blocks=[...parts.blocks];
  [blocks[index],blocks[next]]=[blocks[next],blocks[index]];
  return {...parts,blocks};
}
export function bookPages(body,layout={}) {
  const pages=body.split(/(?:^|\r?\n)\[\[page\]\](?:\r?\n|$)/);
  if(layout.pageMode!=="stanza")return pages;
  const stanzas=pages.flatMap(p=>stanzaParts(p).blocks.filter(b=>b.trim()).map(b=>b.replace(/^(?:\r?\n)+|(?:\r?\n)+$/g,"")));
  return stanzas.length?stanzas:[""];
}
