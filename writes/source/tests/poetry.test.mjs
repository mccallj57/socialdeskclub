import {test} from "node:test";
import assert from "node:assert/strict";
import {stanzaParts,joinStanzas,moveStanza,bookPages,DEFAULT_LAYOUT} from "../shared/poetry.mjs";
import {SQLiteStore} from "../server/storage.mjs";
import {Writes} from "../server/core.mjs";
import {googleDraft,parseFile} from "../server/imports.mjs";
const setup=()=>new Writes(new SQLiteStore(":memory:"));
const poem={title:"Lines at dusk",kind:"poetry",body:"  First\nsecond\n\n\tThird\nfourth",layout:{...DEFAULT_LAYOUT}};
test("stanza parsing is lossless for CRLF, blank margins, tabs and page breaks",()=>{
  for(const body of ["","\n\nlead\n\n","  a\r\nb\r\n \r\n\tc\r\n\r\n","a\n\n[[page]]\n\nb","a\n \n\n\n  b","\nonly\n"]){
    assert.equal(joinStanzas(stanzaParts(body)),body);
  }
  const p=stanzaParts("one\r\n  two\r\n\r\n\tthree");
  assert.equal(joinStanzas(moveStanza(p,1,-1)),"\tthree\r\n\r\none\r\n  two");
  assert.equal(joinStanzas(moveStanza(moveStanza(p,1,-1),0,1)),joinStanzas(p));
});
test("book presentation separates stanzas without rewriting the manuscript",()=>{
  const body="  one\nline\n\n  two\n\n[[page]]\n\nthree";
  assert.deepEqual(bookPages(body,{pageMode:"stanza"}),["  one\nline","  two","three"]);
  assert.equal(bookPages(body,{pageMode:"manual"}).length,2);
  assert.deepEqual(bookPages("",{pageMode:"stanza"}),[""]);
  assert.equal(body,"  one\nline\n\n  two\n\n[[page]]\n\nthree");
});
test("named revisions remain findable after 20 ordinary saves",async()=>{
  const app=setup();let {work}=await app.route("a","POST","/api/works",{...poem,versionName:"Reading night"});
  const id=work.id;
  for(let i=0;i<24;i++)work=(await app.route("a","PUT","/api/works/"+id,{...work,body:poem.body+"\n"+i,versionName:""})).work;
  const out=await app.route("a","GET","/api/works/"+id+"/history");
  assert.equal(out.history.length,20);
  assert.equal(out.namedVersions[0].versionName,"Reading night");
  const first=(await app.route("a","GET","/api/works/"+id+"/revisions/1")).revision;
  assert.equal(first.body,poem.body);assert.equal(first.versionName,"Reading night");
  assert.equal(work.versionName,"");
});
test("alternate is independent, private, owner-checked and does not change original",async()=>{
  const app=setup();const {work}=await app.route("a","POST","/api/works",poem);
  const shared=await app.route("a","POST","/api/works/"+work.id+"/share",{confirm:true});
  const path="/api/works/"+work.id+"/fork";
  await assert.rejects(app.route("b","POST",path,{...shared.work}),e=>e.status===404);
  await assert.rejects(app.route("a","POST",path,{...work}),e=>e.status===409);
  const {work:copy}=await app.route("a","POST",path,{...shared.work,title:"Alternate",body:"new order",versionName:"Alternate"});
  assert.notEqual(copy.id,work.id);assert.equal(copy.version,1);assert.equal(copy.shareToken,undefined);assert.equal(copy.source,undefined);
  assert.deepEqual(copy.derivedFrom,{id:work.id,version:shared.work.version,title:work.title});
  assert.equal((await app.route("a","GET","/api/works/"+work.id)).work.body,poem.body);
});
test("layout survives revisions, snapshots and backup roundtrip; text stays exact",async()=>{
  const app=setup();const {work}=await app.route("a","POST","/api/works",{...poem,versionName:"Original"});
  const layout={lineHeight:2.3,align:"center",stanzaGap:"airy",pageMode:"stanza"};
  const {work:next}=await app.route("a","PUT","/api/works/"+work.id,{...work,layout,versionName:""});
  assert.equal(next.body,poem.body);
  const out=await app.route("a","POST","/api/works/"+work.id+"/share",{confirm:true});
  const pub=(await app.route(null,"GET","/api/public/"+out.token)).work;
  assert.deepEqual(pub.layout,layout);assert.equal(pub.versionName,undefined);
  assert.equal((await app.route("a","GET","/api/works/"+work.id+"/revisions/1")).revision.versionName,"Original");
  const exported=(await app.route("a","GET","/api/works/"+work.id+"/export")).work;
  assert.deepEqual(parseFile("backup.json",JSON.stringify(exported))[0].layout,layout);
  await assert.rejects(app.route("a","POST","/api/works",{...poem,layout:{...layout,align:"url(javascript:x)"}}));
});
test("Google draft refresh requires reviewed replacement and keeps original plus local edits",async()=>{
  const app=setup(),googleDocUrl="https://docs.google.com/document/d/abcdefghijklmno/edit?usp=sharing";
  const preview=text=>app.route("a","POST","/api/import/preview",{googleDocUrl,name:"My Google poem",text});
  const commit=(job,approved=false)=>app.route("a","POST","/api/import/commit",{jobId:job.jobId,selected:[0],rights:true,approvedChanges:approved?[0]:[]});
  let job=await preview(poem.body);await commit(job);
  const id=(await app.route("a","GET","/api/works")).works[0].id;
  let work=(await app.route("a","GET","/api/works/"+id)).work;
  assert.equal(work.source.original,poem.body);assert.equal(work.source.url,"https://docs.google.com/document/d/abcdefghijklmno/edit");
  await app.route("a","PUT","/api/works/"+id,{...work,body:"local changes",kind:"poetry",layout:{...DEFAULT_LAYOUT,align:"center"},archived:true,versionName:"Before refresh"});
  job=await preview(poem.body);assert.equal(job.candidates[0].status,"unchanged");
  job=await preview("a newer draft");
  assert.equal(job.candidates[0].existingBody,"local changes");
  assert.equal((await commit(job)).results[0].status,"needs-review");
  assert.equal((await app.route("a","GET","/api/works/"+id)).work.body,"local changes");
  await commit(job,true);
  work=(await app.route("a","GET","/api/works/"+id)).work;
  assert.equal(work.body,"a newer draft");assert.equal(work.kind,"poetry");assert.equal(work.archived,true);assert.equal(work.layout.align,"center");
  const history=(await app.route("a","GET","/api/works/"+id+"/history")).history;
  assert.equal(history[0].body,"local changes");assert.equal(history[0].versionName,"Before refresh");assert.equal(history[1].source.original,poem.body);
});
test("Google links are identifiers only; invalid addresses and empty drafts are rejected",()=>{
  for(const url of ["http://docs.google.com/document/d/abcdefghijk/edit","https://docs.google.com.evil.test/document/d/abcdefghijk/edit","https://user:secret@docs.google.com/document/d/abcdefghijk/edit","https://docs.google.com/spreadsheets/d/abcdefghijk/edit"]){
    assert.throws(()=>googleDraft(url,"title","text"));
  }
  assert.throws(()=>googleDraft("https://docs.google.com/document/d/abcdefghijk/edit","title",""),/address alone/);
});
