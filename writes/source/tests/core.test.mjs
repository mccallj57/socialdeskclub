import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { SQLiteStore, Conflict } from "../server/storage.mjs";
import { Writes } from "../server/core.mjs";
import { publicAddress, feedUrl, htmlText, parseFeed, parseFile, parseZip, safeFetch } from "../server/imports.mjs";
const setup = () => { const store=new SQLiteStore(":memory:");return {store,app:new Writes(store)}; };
const original={title:"A poem",body:"  First line\nsecond line\n\n    a stanza.\n\n[[page]]\n\nLast line",kind:"poetry",author:"Author"};
test("poetry survives saving, editing, history and portable JSON",async()=>{
  const {app}=setup();const {work}=await app.route("a","POST","/api/works",original);
  assert.equal(work.body,original.body);
  const updated=(await app.route("a","PUT","/api/works/"+work.id,{...work,body:work.body+"\nEnd."})).work;
  const history=(await app.route("a","GET","/api/works/"+work.id+"/history")).history;
  assert.equal(history[0].body,original.body);assert.equal(updated.version,2);
  const exported=(await app.route("a","GET","/api/works/"+work.id+"/export")).work;
  assert.equal(parseFile("backup.json",JSON.stringify({works:[exported]}))[0].body,updated.body);
});
test("private documents, histories, exports and import jobs cannot cross owners",async()=>{
  const {app}=setup();const {work}=await app.route("a","POST","/api/works",original);
  for(const suffix of ["","/history","/export"])await assert.rejects(app.route("b","GET","/api/works/"+work.id+suffix),e=>e.status===404);
  assert.equal((await app.route("b","GET","/api/works")).works.length,0);
  await assert.rejects(app.route(null,"GET","/api/works"),e=>e.status===401);
  const job=await app.route("a","POST","/api/import/preview",{name:"poem.txt",text:"private"});
  await assert.rejects(app.route("b","POST","/api/import/commit",{jobId:job.jobId,selected:[0],rights:true}),/expired/);
});
test("stale saves fail without overwriting content",async()=>{
  const {app}=setup();const {work}=await app.route("a","POST","/api/works",original);
  await app.route("a","PUT","/api/works/"+work.id,{...work,body:"saved new"});
  await assert.rejects(app.route("a","PUT","/api/works/"+work.id,{...work,body:"stale"}),e=>e.status===409);
  assert.equal((await app.route("a","GET","/api/works/"+work.id)).work.body,"saved new");
});
test("store compare-and-swap is atomic across operations",async()=>{
  const {store}=setup();await store.commit([{pk:"a",sk:"1",value:{version:1},expected:0}]);
  await assert.rejects(store.commit([{pk:"a",sk:"2",value:{version:1},expected:0},{pk:"a",sk:"1",value:{version:2},expected:0}]),Conflict);
  assert.equal(await store.get("a","2"),null);
});
test("snapshots expose only intended content and do not follow draft edits",async()=>{
  const {app}=setup();let {work}=await app.route("a","POST","/api/works",original);
  await assert.rejects(app.route("a","POST","/api/works/"+work.id+"/share",{}),/confirm/i);
  const out=await app.route("a","POST","/api/works/"+work.id+"/share",{confirm:true});work=out.work;
  assert.equal(out.token.length,32);
  await app.route("a","PUT","/api/works/"+work.id,{...work,body:"private revision"});
  const publicWork=(await app.route(null,"GET","/api/public/"+out.token)).work;
  assert.equal(publicWork.body,original.body);assert.equal(publicWork.source,undefined);assert.equal(publicWork.shareToken,undefined);
  assert.equal((await app.route("a","GET","/api/works/"+work.id+"/export")).work.shareToken,undefined);
  await app.route("a","DELETE","/api/works/"+work.id+"/share");
  await assert.rejects(app.route(null,"GET","/api/public/"+out.token),e=>e.status===404);
});
test("feed duplicates skip and changed posts require reviewed replacement",async()=>{
  const {store}=setup();let text="First<br/>second";
  const xml=()=>`<rss><channel><item><guid>1</guid><title>My post</title><link>https://example.com/p/1</link><description><![CDATA[<p>${text}</p>]]></description></item></channel></rss>`;
  const app=new Writes(store,async url=>({url,text:xml()}));
  let job=await app.route("a","POST","/api/import/preview",{url:"https://example.com/feed"});
  await assert.rejects(app.route("a","POST","/api/import/commit",{jobId:job.jobId,selected:[0]}),/own/);
  let result=await app.route("a","POST","/api/import/commit",{jobId:job.jobId,selected:[0],rights:true});
  assert.equal(result.results[0].status,"imported");
  job=await app.route("a","POST","/api/import/preview",{url:"https://example.com/feed"});assert.equal(job.candidates[0].status,"unchanged");
  let w=(await store.list("a","work#"))[0];await app.route("a","PUT","/api/works/"+w.id,{...w,body:"my local edits"});
  text="Changed article";
  job=await app.route("a","POST","/api/import/preview",{url:"https://example.com/feed"});assert.equal(job.candidates[0].status,"changed");assert.equal(job.candidates[0].existingBody,"my local edits");
  result=await app.route("a","POST","/api/import/commit",{jobId:job.jobId,selected:[0],rights:true});assert.equal(result.results[0].status,"needs-review");
  result=await app.route("a","POST","/api/import/commit",{jobId:job.jobId,selected:[0],rights:true,approvedChanges:[0]});assert.equal(result.results[0].status,"updated");
  const history=(await app.route("a","GET","/api/works/"+w.id+"/history")).history;
  assert.equal(history[0].body,"my local edits");assert.equal(history[1].source.original,"<p>First<br/>second</p>");
});
test("expired import previews and changed-in-meantime pieces are rejected",async()=>{
  const {store,app}=setup();const job=await app.route("a","POST","/api/import/preview",{name:"test.txt",text:"one"});
  await store.commit([{pk:"a",sk:"job#"+job.jobId,value:{expiresAt:1,version:1}}]);
  await assert.rejects(app.route("a","POST","/api/import/commit",{jobId:job.jobId,selected:[0],rights:true}),/expired/);
});
test("private, loopback, link-local and mapped IP addresses are blocked",async()=>{
  for(const ip of ["127.0.0.1","10.1.1.1","192.168.0.1","172.16.1.1","169.254.169.254","0.0.0.0","::1","fc00::1","fe80::1","::ffff:127.0.0.1"])assert.equal(publicAddress(ip),false,ip);
  assert.equal(publicAddress("1.1.1.1"),true);
  await assert.rejects(safeFetch("https://127.0.0.1/feed"),/public internet/);
  assert.throws(()=>feedUrl("http://example.com"),/HTTPS/);
  assert.throws(()=>feedUrl("https://user:secret@example.com"),/credentials/);
  assert.throws(()=>feedUrl("https://example.com:8443"),/port/);
  assert.equal(feedUrl("https://writer.substack.com"),"https://writer.substack.com/feed");
  assert.equal(feedUrl("https://medium.com/@writer"),"https://medium.com/feed/@writer");
});
test("HTML import is inert text and preserves explicit poetry spacing",()=>{
  assert.equal(htmlText("<pre>  one\n\n    two</pre>"),"  one\n\n    two");
  const result=htmlText('<script>alert(1)</script><style>bad</style><p>First<br>second</p><p>Third</p>');
  assert.equal(result,"First\nsecond\n\nThird");
  assert.throws(()=>parseFeed('<!DOCTYPE rss [<!ENTITY x "bad">]><rss/>',"https://example.com"),/entity/);
});
test("Medium-style feed images become linked markdown markers",()=>{
  const html='<p>Hello</p><figure><img alt="Cover" src="https://cdn-images-1.medium.com/max/1024/1*abc.png" /></figure><img width="1" height="1" src="https://medium.com/_/stat?event=post.clientViewed&postId=x" alt=""><p>Bye</p>';
  const body=htmlText(html);
  assert.match(body,/!\[Cover\]\(https:\/\/cdn-images-1\.medium\.com\/max\/1024\/1\*abc\.png\)/);
  assert.doesNotMatch(body,/medium\.com\/_\/stat/);
  assert.doesNotMatch(body,/\[Image\]/);
  assert.match(body,/Hello/);
  assert.match(body,/Bye/);
  const feed=parseFeed(`<rss><channel><item><guid>1</guid><title>Post</title><link>https://medium.com/p/1</link><content:encoded><![CDATA[${html}]]></content:encoded></item></channel></rss>`,"https://medium.com/feed/@writer");
  assert.equal(feed[0].source.platform,"Medium");
  assert.match(feed[0].body,/!\[Cover\]\(/);
});
test("ZIP reads exported archive once, rather than duplicating format variants",async()=>{
  const zip=new JSZip();zip.file("writes-library.json",JSON.stringify({works:[{...original,id:"x"}]}));zip.file("piece/writing.txt",original.body);zip.file("piece/read.html","<p>Duplicate</p>");zip.file("piece/revisions/1.json",JSON.stringify(original));
  const works=await parseZip(await zip.generateAsync({type:"base64"}));assert.equal(works.length,1);assert.equal(works[0].body,original.body);
});
test("ZIP limits stop oversized expanded entries",async()=>{
  const zip=new JSZip();zip.file("huge.txt","a".repeat(3100000));await assert.rejects(parseZip(await zip.generateAsync({type:"base64",compression:"DEFLATE"})),/large/);
});
test("importing a backup never imports another account's share tokens or ownership",async()=>{
  const {app}=setup();const job=await app.route("a","POST","/api/import/preview",{name:"b.json",text:JSON.stringify({works:[{...original,id:"foreign",shareToken:"not-yours",owner:"foreign"}]})});
  await app.route("a","POST","/api/import/commit",{jobId:job.jobId,selected:[0],rights:true});
  const id=(await app.route("a","GET","/api/works")).works[0].id;
  const w=(await app.route("a","GET","/api/works/"+id)).work;
  assert.equal(w.shareToken,undefined);assert.equal(w.owner,undefined);assert.notEqual(w.id,"foreign");
});
