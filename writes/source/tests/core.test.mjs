import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { SQLiteStore, Conflict } from "../server/storage.mjs";
import { Writes } from "../server/core.mjs";
import { publicAddress, feedUrl, htmlText, parseFeed, parseFile, parseZip, safeFetch, resolveFeedUrls, publicationFeedUrl, substackProfileHandle, collectAuthorAliases, authorMatches, filterCandidatesByAuthor, gateCandidatesByAuthor } from "../server/imports.mjs";
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
  assert.equal(feedUrl("https://www.blog.farmapper.com/"),"https://www.blog.farmapper.com/feed");
  assert.equal(feedUrl("https://www.blog.farmapper.com/feed"),"https://www.blog.farmapper.com/feed");
  assert.equal(substackProfileHandle("https://substack.com/@mccallios/posts"),"mccallios");
  assert.equal(publicationFeedUrl({custom_domain:"www.blog.farmapper.com",subdomain:"farmapper"}),"https://www.blog.farmapper.com/feed");
  assert.equal(publicationFeedUrl({subdomain:"lexdao"}),"https://lexdao.substack.com/feed");
});
test("Substack profile paste expands to public admin publication feeds",async()=>{
  const profile={
    name:"James McCall",
    publicationUsers:[
      {public:true,role:"admin",is_primary:false,publication:{name:"Farmapper",subdomain:"farmapper",custom_domain:"www.blog.farmapper.com"}},
      {public:true,role:"admin",is_primary:true,publication:{name:"Maisa Space",subdomain:"maisaspace",custom_domain:"blog.maisaspace.org"}},
      {public:false,role:"admin",publication:{subdomain:"secret"}},
      {public:true,role:"contributor",publication:{subdomain:"other"}},
    ]
  };
  const resolved=await resolveFeedUrls("https://substack.com/@mccallios/posts",async()=>profile);
  assert.deepEqual(resolved.urls,[
    "https://blog.maisaspace.org/feed",
    "https://www.blog.farmapper.com/feed",
  ]);
  assert.equal(resolved.handle,"mccallios");
  assert.equal(resolved.profileName,"James McCall");
});
test("author filter keeps only matching bylines",()=>{
  const aliases=collectAuthorAliases({display_name:"James McCall",username:"james"},{handle:"mccallios",profileName:"James McCall"},"member#james");
  assert.ok(aliases.includes("james mccall"));
  assert.ok(aliases.includes("james"));
  assert.ok(aliases.includes("mccallios"));
  assert.equal(authorMatches("James McCall",aliases),true);
  assert.equal(authorMatches("Samia",aliases),false);
  assert.equal(authorMatches("Anthony Glukhov",aliases),false);
  assert.equal(authorMatches("",aliases),false);
  const {kept,skipped,filtered}=filterCandidatesByAuthor(
    [{author:"James McCall",title:"A"},{author:"Samia",title:"B"},{author:"James McCall",title:"C"}],
    aliases,
    {authorsOnly:true}
  );
  assert.equal(filtered,true);
  assert.equal(kept.length,2);
  assert.equal(skipped,1);
  const gated=gateCandidatesByAuthor(
    [{author:"",title:"Blank"},{author:"Samia",title:"S"},{author:"James McCall",title:"J"}],
    aliases,
    {authorsOnly:true,soleAuthor:false}
  );
  assert.equal(gated.kept,1);
  assert.equal(gated.skippedMissing,1);
  assert.equal(gated.skippedOther,1);
  assert.equal(gated.candidates.filter(c=>c.authorGate==="block").length,2);
});
test("import preview defaults to author-only posts from multi-author feeds",async()=>{
  const multi=`<rss><channel><generator>Substack</generator>
    <item><guid>1</guid><title>Mine</title><link>https://www.blog.farmapper.com/p/1</link><dc:creator><![CDATA[James McCall]]></dc:creator><content:encoded><![CDATA[<p>Hi</p>]]></content:encoded></item>
    <item><guid>2</guid><title>Theirs</title><link>https://blog.maisaspace.org/p/2</link><dc:creator><![CDATA[Samia]]></dc:creator><content:encoded><![CDATA[<p>Yo</p>]]></content:encoded></item>
  </channel></rss>`;
  const {store}=setup();
  const app=new Writes(store,async()=>({url:"https://www.blog.farmapper.com/feed",text:multi}));
  const job=await app.route("member#james","POST","/api/import/preview",{url:"https://www.blog.farmapper.com/"},{display_name:"James McCall",username:"james"});
  assert.equal(job.candidates.length,1);
  assert.equal(job.candidates[0].title,"Mine");
  assert.equal(job.candidates[0].author,"James McCall");
  assert.match(job.warning,/Author filter on/i);
  const all=await app.route("member#james","POST","/api/import/preview",{url:"https://www.blog.farmapper.com/",includeAllAuthors:true},{display_name:"James McCall",username:"james"});
  assert.equal(all.candidates.length,2);
});
test("Substack ZIP with blank authors skips under author-only unless sole-author opt-in",async()=>{
  const html='<p>Hello</p><img alt="Hero" src="https://substack-post-media.s3.amazonaws.com/public/images/hero.png"><p>More</p>';
  const csv='post_id,post_date,is_published,type,title,subtitle,audience\n190318527.we-named-a-mapping-tool-after-a-potato,2023-01-01T00:00:00.000Z,true,newsletter,We Named a Mapping Tool After a Potato.,,everyone\n190318528.samias-piece,2023-02-01T00:00:00.000Z,true,newsletter,Samias Piece,,everyone\n';
  const zip=new JSZip();
  zip.file("posts.csv",csv);
  zip.file("posts/190318527.we-named-a-mapping-tool-after-a-potato.html",html);
  zip.file("posts/190318528.samias-piece.html","<p>By Samia</p>");
  const base64=await zip.generateAsync({type:"base64"});
  const {app}=setup();
  const actor={display_name:"James McCall",username:"james"};
  const blocked=await app.route("member#james","POST","/api/import/preview",{name:"export.zip",base64},actor);
  assert.equal(blocked.candidates.length,2);
  assert.equal(blocked.candidates.filter(c=>c.status==="excluded").length,2);
  assert.equal(blocked.candidates.filter(c=>c.status==="new").length,0);
  assert.match(blocked.warning,/no byline/i);
  assert.match(blocked.warning,/0 matched/i);
  const sole=await app.route("member#james","POST","/api/import/preview",{name:"export.zip",base64,soleAuthorExport:true},actor);
  assert.equal(sole.candidates.filter(c=>c.status==="new").length,2);
  assert.equal(sole.candidates.every(c=>c.authorGate!=="block"),true);
});
test("ZIP author enrichment from Substack RSS/API enables author-only filter",async()=>{
  const {enrichSubstackAuthors}=await import("../server/imports.mjs");
  const candidates=[
    {title:"Mine",author:"",source:{url:"https://blog.maisaspace.org/p/giving-tree",postId:"1.giving-tree"}},
    {title:"Theirs",author:"",source:{url:"https://blog.maisaspace.org/p/empty-locker-decorated-halls",postId:"2.empty-locker-decorated-halls"}},
    {title:"Older",author:"",source:{url:"https://blog.maisaspace.org/p/maisa-space",postId:"3.maisa-space"}},
  ];
  const feedXml=`<rss><channel><generator>Substack</generator>
    <item><guid>g1</guid><title>Giving Tree</title><link>https://blog.maisaspace.org/p/giving-tree</link><dc:creator><![CDATA[James McCall]]></dc:creator><content:encoded><![CDATA[<p>x</p>]]></content:encoded></item>
    <item><guid>g2</guid><title>Empty</title><link>https://blog.maisaspace.org/p/empty-locker-decorated-halls</link><dc:creator><![CDATA[Samia]]></dc:creator><content:encoded><![CDATA[<p>y</p>]]></content:encoded></item>
  </channel></rss>`;
  const enriched=await enrichSubstackAuthors(candidates,{
    publicationUrl:"https://blog.maisaspace.org/",
    feedFetch:async()=>({url:"https://blog.maisaspace.org/feed",text:feedXml}),
    get:async(url)=>{
      if(String(url).includes("/api/v1/posts/maisa-space")) return {text:JSON.stringify({publishedBylines:[{name:"James McCall",handle:"mccallios"}]}),url};
      if(String(url).includes("/p/maisa-space")) return {text:"<title>Maisa Space - by James McCall - Maisa Space</title>",url};
      throw new Error("unexpected "+url);
    },
  });
  assert.equal(enriched.fromFeed,2);
  assert.equal(enriched.fromApi,1);
  assert.equal(enriched.candidates[0].author,"James McCall");
  assert.equal(enriched.candidates[1].author,"Samia");
  assert.equal(enriched.candidates[2].author,"James McCall");
  assert.match(enriched.note,/Looked up 3 authors/i);

  const html='<p>Hi</p>';
  const csv='post_id,post_date,is_published,type,title,subtitle,audience\n1.giving-tree,2023-01-01T00:00:00.000Z,true,newsletter,Giving Tree,,everyone\n2.empty-locker-decorated-halls,2023-02-01T00:00:00.000Z,true,newsletter,Empty Locker,,everyone\n';
  const zip=new JSZip();zip.file("posts.csv",csv);zip.file("posts/1.giving-tree.html",html);zip.file("posts/2.empty-locker-decorated-halls.html",html);
  const base64=await zip.generateAsync({type:"base64"});
  const store=new (await import("../server/storage.mjs")).SQLiteStore(":memory:");
  const app=new Writes(store,async()=>({url:"https://blog.maisaspace.org/feed",text:feedXml}));
  // Monkeypatch enrich path uses this.fetcher for feed; API via real safeGet would hit network — inject by wrapping route through enrich unit above already covered.
  // Integration: fetcher provides feed authors for both ZIP posts.
  const job=await app.route("member#james","POST","/api/import/preview",{name:"export.zip",base64,publicationUrl:"https://blog.maisaspace.org/"},{display_name:"James McCall",username:"james"});
  assert.match(job.warning,/Looked up|Author filter on/i);
  const allowed=job.candidates.filter(c=>c.status!=="excluded");
  const blocked=job.candidates.filter(c=>c.status==="excluded");
  assert.equal(allowed.length,1);
  assert.equal(allowed[0].title,"Giving Tree");
  assert.equal(allowed[0].author,"James McCall");
  assert.equal(blocked.length,1);
  assert.match(blocked[0].authorNote||"",/Samia/);
});
test("Substack export ZIP parses posts and dedupes against prior RSS by URL",async()=>{
  const html='<p>Hello</p><img alt="Hero" src="https://substack-post-media.s3.amazonaws.com/public/images/hero.png"><p>More</p>';
  const csv='post_id,post_date,is_published,type,title,subtitle,audience\n190318527.we-named-a-mapping-tool-after-a-potato,2023-01-01T00:00:00.000Z,true,newsletter,We Named a Mapping Tool After a Potato.,,everyone\n';
  const zip=new JSZip();
  zip.file("posts.csv",csv);
  zip.file("posts/190318527.we-named-a-mapping-tool-after-a-potato.html",html);
  const base64=await zip.generateAsync({type:"base64"});
  const fromZip=await parseZip(base64,{substack:true,publicationUrl:"https://www.blog.farmapper.com/"});
  assert.equal(fromZip.length,1);
  assert.equal(fromZip[0].title,"We Named a Mapping Tool After a Potato.");
  assert.equal(fromZip[0].source.url,"https://www.blog.farmapper.com/p/we-named-a-mapping-tool-after-a-potato");
  assert.match(fromZip[0].coverUrl,/hero\.png/);
  assert.equal(fromZip[0].source.key,"url|https://www.blog.farmapper.com/p/we-named-a-mapping-tool-after-a-potato");
  assert.equal(fromZip[0].author,"");

  const feedXml=`<rss><channel><generator>Substack</generator><item><guid>https://www.blog.farmapper.com/p/we-named-a-mapping-tool-after-a-potato</guid><title>We Named a Mapping Tool After a Potato.</title><link>https://www.blog.farmapper.com/p/we-named-a-mapping-tool-after-a-potato</link><dc:creator><![CDATA[James McCall]]></dc:creator><content:encoded><![CDATA[${html}]]></content:encoded></item></channel></rss>`;
  const {store}=setup();
  const app=new Writes(store,async()=>({url:"https://www.blog.farmapper.com/feed",text:feedXml}));
  const rssJob=await app.route("member#james","POST","/api/import/preview",{url:"https://www.blog.farmapper.com/"},{display_name:"James McCall",username:"james"});
  await app.route("member#james","POST","/api/import/commit",{jobId:rssJob.jobId,selected:[0],rights:true},{display_name:"James McCall",username:"james"});
  const zipJob=await app.route("member#james","POST","/api/import/preview",{name:"export.zip",base64,publicationUrl:"https://www.blog.farmapper.com/",soleAuthorExport:true},{display_name:"James McCall",username:"james"});
  assert.equal(zipJob.candidates.length,1);
  assert.equal(zipJob.candidates[0].status,"unchanged");
  assert.match(zipJob.warning,/Duplicates match/i);
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
test("Substack feed images prefer data-attrs originals and label as Substack",()=>{
  const html='<p>Hi</p><img alt="Map" src="https://substackcdn.com/image/fetch/w_1456/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fabc.png" data-attrs="{&quot;src&quot;:&quot;https://substack-post-media.s3.amazonaws.com/public/images/abc.png&quot;,&quot;alt&quot;:null}">';
  const body=htmlText(html);
  assert.match(body,/!\[Map\]\(https:\/\/substack-post-media\.s3\.amazonaws\.com\/public\/images\/abc\.png\)/);
  const feed=parseFeed(`<rss><channel><generator>Substack</generator><item><guid>9</guid><title>Farm</title><link>https://www.blog.farmapper.com/p/x</link><content:encoded><![CDATA[${html}]]></content:encoded></item></channel></rss>`,"https://www.blog.farmapper.com/feed");
  assert.equal(feed[0].source.platform,"Substack");
});
test("refresh-covers recovers image from source.original when body only has [Image]",async()=>{
  const {coverFromWork,firstImageUrlFromHtml}=await import("../shared/manuscript.mjs");
  const html='<p>Lead</p><img alt="Hero" src="https://substack-post-media.s3.amazonaws.com/public/images/farm.png"><p>More</p>';
  assert.match(firstImageUrlFromHtml(html),/farm\.png/);
  const ghost={title:"Farm",body:"Lead\n\n[Image]\n\nMore",kind:"essay",author:"James",coverUrl:"",source:{original:html,platform:"Substack",url:"https://www.blog.farmapper.com/p/x",key:"url|https://www.blog.farmapper.com/p/x",hash:"abc"}};
  assert.match(coverFromWork(ghost),/farm\.png/);
  const {store,app}=setup();
  await store.commit([{pk:"member#james",sk:"work#import-old",value:{...ghost,id:"import-old",version:1,createdAt:"2020-01-01T00:00:00.000Z",updatedAt:"2020-01-01T00:00:00.000Z",archived:false,theme:"linen",collection:""},expected:0}]);
  const listed=(await app.route("member#james","GET","/api/works")).works;
  assert.match(listed[0].coverUrl,/farm\.png/);
  const refreshed=await app.route("member#james","POST","/api/works/refresh-covers",{});
  assert.equal(refreshed.updated,1);
  assert.equal(refreshed.missing,0);
  const saved=(await app.route("member#james","GET","/api/works/import-old")).work;
  assert.match(saved.coverUrl,/farm\.png/);
  const again=await app.route("member#james","POST","/api/works/refresh-covers",{});
  assert.equal(again.updated,0);
  assert.equal(again.already,1);
});
test("RSS enclosure supplies cover when body has no markdown image",()=>{
  const feed=parseFeed(`<rss><channel><generator>Substack</generator><item><guid>1</guid><title>Post</title><link>https://www.blog.farmapper.com/p/1</link><enclosure url="https://substackcdn.com/image/fetch/hero.jpg" length="0" type="image/jpeg"/><content:encoded><![CDATA[<p>No figures here</p>]]></content:encoded></item></channel></rss>`,"https://www.blog.farmapper.com/feed");
  assert.match(feed[0].coverUrl,/hero\.jpg/);
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
test("bibliography groups works by editable category labels",async()=>{
  const {app}=setup();
  const poem=await app.route("a","POST","/api/works",{title:"Verse",body:"line",kind:"poetry",author:"James"});
  const tale=await app.route("a","POST","/api/works",{title:"Tale",body:"once",kind:"story",author:"James"});
  assert.equal(poem.work.categoryId,"poetry");
  assert.equal(tale.work.categoryId,"story");
  let bib=await app.route("a","GET","/api/bibliography");
  assert.ok(bib.sections.some(s=>s.id==="poetry"&&s.entries.some(e=>e.title==="Verse")));
  assert.ok(bib.sections.some(s=>s.id==="story"&&s.entries.some(e=>e.title==="Tale")));
  const renamed=await app.route("a","PUT","/api/bibliography/categories",{categories:bib.categories.map(c=>c.id==="story"?{...c,label:"Fiction"}:c)});
  assert.equal(renamed.categories.find(c=>c.id==="story").label,"Fiction");
  bib=await app.route("a","GET","/api/bibliography");
  assert.equal(bib.sections.find(s=>s.id==="story").label,"Fiction");
  assert.equal(bib.sections.find(s=>s.id==="story").entries[0].title,"Tale");
  const shared=await app.route("a","POST","/api/bibliography/share",{confirm:true},{display_name:"James McCall"});
  assert.equal(shared.token.length,32);
  const pub=await app.route(null,"GET","/api/public/"+shared.token);
  assert.equal(pub.bibliography.sections.find(s=>s.id==="story").label,"Fiction");
  assert.equal(pub.work,undefined);
});
