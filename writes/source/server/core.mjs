import crypto from "node:crypto";
import { z } from "zod";
import { fail, hash, feedUrl, safeFetch, parseFeed, parseFile, parseZip, googleDraft } from "./imports.mjs";
import { DEFAULT_LAYOUT } from "../shared/poetry.mjs";

const input = z.object({
  title: z.string().trim().min(1, "Give this writing a title.").max(180),
  author: z.string().max(120).default(""),
  body: z.string().refine(s => Buffer.byteLength(s) <= 120000, "Keep each writing below 120 KB of text."),
  kind: z.enum(["poetry","story","essay","other"]).default("poetry"),
  collection: z.string().max(80).default(""),
  theme: z.enum(["forest","clay","linen","night"]).default("forest"),
  archived: z.boolean().default(false),
  versionName: z.string().trim().max(80).default(""),
  layout: z.object({
    lineHeight:z.number().min(1.2).max(2.4).default(1.9),
    stanzaGap:z.enum(["original","compact","airy"]).default("original"),
    align:z.enum(["left","center","right"]).default("left"),
    pageMode:z.enum(["manual","stanza"]).default("manual"),
  }).default(DEFAULT_LAYOUT),
});
const now = () => new Date().toISOString();
const metadata = w => ({ id:w.id, title:w.title, author:w.author, kind:w.kind, collection:w.collection, theme:w.theme, archived:w.archived, version:w.version, updatedAt:w.updatedAt, example:w.example, shared:!!w.shareToken, platform:w.source?.platform, words:w.body.trim().split(/\s+/).filter(Boolean).length });
const publicCopy = w => ({ id:w.id,title:w.title,author:w.author,kind:w.kind,body:w.body,theme:w.theme,collection:w.collection,layout:w.layout,version:w.version,publishedAt:now() });
const exportCopy = w => { const {shareToken,...copy} = w; return copy; };
export const EXAMPLES = [
  { title:"The space between",kind:"poetry",theme:"forest",collection:"Small observations",author:"A Writes example",body:"Not every silence\nis an empty room.\n\nSome are a window\nleft open\n    for the rain.\n\n[[page]]\n\nI am learning\nto leave a little space\nbetween the things I know.\n\nEnough for a seed.\nEnough for a question.\nEnough for you.",example:true },
  { title:"A small atlas\nof home",kind:"story",theme:"clay",collection:"Small observations",author:"A Writes example",body:"The map her grandfather left behind had no roads.\n\nInstead, there were the places where things had happened: a first snow, a lost dog found, a very good sandwich.\n\nIn the corner, beneath a tiny drawing of the kitchen, he had written: Start here.\n\n[[page]]\n\nShe spread it on the table and took out a pencil.\n\nThe house had changed. The apple tree was gone. But the afternoon light still found the same patch of floor.\n\nShe drew a small square and wrote: Where I began again.",example:true },
  { title:"Notes from\nthe margins",kind:"essay",theme:"linen",collection:"Field notes",author:"A Writes example",body:"There is a kind of thinking that only happens at the edge of a page.\n\nNot the polished thought, with its shoes on and somewhere to be. The other kind. The half-formed question. The sentence you underline for reasons you cannot quite explain.\n\nThis is a place to keep those things.\n\n[[page]]\n\nA notebook does not ask where a thought will be published. It simply makes room.\n\nThat seems like a useful quality for a digital space, too.",example:true },
];
export class Writes {
  constructor(store, fetcher = safeFetch) { this.store = store; this.fetcher = fetcher; }
  async seed(owner) {
    if (await this.store.get(owner, "setup")) return;
    const stamp = now();
    const works = EXAMPLES.map((s,i) => ({...s,id:`example-${i+1}`,version:1,createdAt:stamp,updatedAt:stamp,archived:false}));
    try { await this.store.commit([{pk:owner,sk:"setup",value:{version:1},expected:0}, ...works.map(w=>({pk:owner,sk:"work#"+w.id,value:w,expected:0}))]); } catch(e) { if(e.status !==409) throw e; }
  }
  async required(owner, id) {
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(id)) fail("Writing not found.",404);
    const work = await this.store.get(owner, "work#"+id);
    if (!work) fail("Writing not found.",404);
    return work;
  }
  async save(owner, fields, old = null, extra = {}) {
    const validated = input.parse(fields), stamp = now();
    const w = { ...old, ...validated, ...extra, id:old?.id || extra.id || crypto.randomUUID(),createdAt:old?.createdAt || stamp,updatedAt:stamp,version:(old?.version||0)+1 };
    if (Buffer.byteLength(JSON.stringify(w)) > 300000) fail("This piece and its source are too large to save together. Import a smaller plain-text section.");
    const ops = [{pk:owner,sk:"work#"+w.id,value:w,expected:old?.version||0}];
    if (old) ops.push({pk:owner,sk:`revision#${old.id}#${String(old.version).padStart(8,"0")}`,value:exportCopy(old),expected:0});
    await this.store.commit(ops);
    return w;
  }
  async route(owner, method, path, data = {}) {
    if (path.startsWith("/api/public/") && method === "GET") {
      const token = path.split("/").pop();
      if (!/^[a-zA-Z0-9_-]{32}$/.test(token)) fail("This shared writing is unavailable.",404);
      const w = await this.store.get("public#"+token,"snapshot");
      if (!w) fail("This shared writing is unavailable or its link was revoked.",404);
      return {work:w};
    }
    if (!owner) fail("Please sign in to your member account.",401);
    if (method === "GET" && path === "/api/works") return {works:(await this.store.list(owner,"work#")).map(metadata)};
    if (method === "POST" && path === "/api/works") {
      if ((await this.store.list(owner,"work#")).length >= 500) fail("This workspace is limited to 500 writings in this first release.");
      return {work:await this.save(owner,data)};
    }
    const revisionMatch = path.match(/^\/api\/works\/([a-zA-Z0-9-]+)\/revisions\/([0-9]+)$/);
    if (revisionMatch && method === "GET") {
      await this.required(owner,revisionMatch[1]);
      const revision = await this.store.get(owner,`revision#${revisionMatch[1]}#${revisionMatch[2].padStart(8,"0")}`);
      if (!revision) fail("Saved version not found.",404);
      return {revision:exportCopy(revision)};
    }
    const match = path.match(/^\/api\/works\/([a-zA-Z0-9-]+)(?:\/(history|export|share|fork))?$/);
    if (match) {
      const [,id,action] = match, old = await this.required(owner,id);
      if (action === "history" && method === "GET") {
        const all=(await this.store.list(owner,"revision#"+id+"#")).sort((a,b)=>b.version-a.version);
        return {history:all.slice(0,20),namedVersions:all.slice(20).filter(w=>w.versionName).map(w=>({...metadata(w),versionName:w.versionName}))};
      }
      if (action === "fork" && method === "POST") {
        if(data.version!==old.version)fail("The original changed in another window. Reload it before creating an alternate.",409);
        if ((await this.store.list(owner,"work#")).length >= 500) fail("This workspace is limited to 500 writings.");
        return {work:await this.save(owner,{...old,...data,archived:false},null,{derivedFrom:{id:old.id,version:old.version,title:old.title}})};
      }
      if (action === "export" && method === "GET") return {work:exportCopy(old),revisions:(await this.store.list(owner,"revision#"+id+"#")).map(r=>({version:r.version}))};
      if (action === "share" && method === "POST") {
        if (data.confirm !== true) fail("Review and confirm the complete writing before creating an anyone-with-the-link snapshot.");
        const token = old.shareToken || crypto.randomBytes(24).toString("base64url");
        const next = {...old,shareToken:token,version:old.version+1,updatedAt:now()};
        await this.store.commit([
          {pk:owner,sk:"work#"+id,value:next,expected:old.version},
          {pk:owner,sk:`revision#${id}#${String(old.version).padStart(8,"0")}`,value:exportCopy(old),expected:0},
          {pk:"public#"+token,sk:"snapshot",value:publicCopy(old)},
        ]);
        return {work:next,token};
      }
      if (action === "share" && method === "DELETE") {
        const next = {...old,version:old.version+1,updatedAt:now()}; delete next.shareToken;
        const ops = [{pk:owner,sk:"work#"+id,value:next,expected:old.version},{pk:owner,sk:`revision#${id}#${String(old.version).padStart(8,"0")}`,value:exportCopy(old),expected:0}];
        if(old.shareToken) ops.push({pk:"public#"+old.shareToken,sk:"snapshot",remove:true});
        await this.store.commit(ops); return {work:next};
      }
      if (!action && method === "GET") return {work:old};
      if (!action && method === "PUT") {
        if (data.version !== old.version) fail("This writing changed in another window. Reload it before saving.",409);
        return {work:await this.save(owner,data,old)};
      }
    }
    if (path === "/api/sources" && method === "GET") return {sources:await this.store.list(owner,"source#")};
    if (path === "/api/import/preview" && method === "POST") {
      let candidates, source;
      if (data.googleDocUrl) {
        candidates=googleDraft(data.googleDocUrl,data.name,data.text);
      } else if (data.url) {
        const url = feedUrl(data.url);
        let fetched;
        try { fetched = await this.fetcher(url); candidates = parseFeed(fetched.text,url); }
        catch(e) { e.status = e.status || 400; throw e; }
        source = {id:hash(url).slice(0,24),url,updatedAt:now(),version:1};
      } else if (data.name?.toLowerCase().endsWith(".zip")) candidates = await parseZip(data.base64 || "");
      else candidates = parseFile(data.name || "Pasted writing.txt",data.text || "");
      const jobId = crypto.randomUUID(), expiresAt = Math.floor(Date.now()/1000)+1800;
      const previews = [];
      for (const [index,c] of candidates.entries()) {
        const id = "import-"+hash(c.source.key).slice(0,32);
        const existing = await this.store.get(owner,"work#"+id);
        const status = !existing ? "new" : existing.source?.hash === c.source.hash ? "unchanged" : "changed";
        const entry = {...c,id,index,status,existingVersion:existing?.version||0,expiresAt,version:1};
        if (Buffer.byteLength(JSON.stringify(entry)) > 300000) fail("An imported piece is too large. Import a smaller plain-text section.");
        await this.store.commit([{pk:owner,sk:`job#${jobId}#${index}`,value:entry,expected:0}]);
        previews.push({index,title:c.title,author:c.author,body:c.body,status,platform:c.source.platform,existingBody:existing?.body});
      }
      await this.store.commit([{pk:owner,sk:"job#"+jobId,value:{expiresAt,count:candidates.length,source,version:1},expected:0}]);
      return {jobId,candidates:previews,warning:data.googleDocUrl?"This is an independent text copy, not a live Google connection. Re-import using the same document address to review a later draft. Google’s revision history, comments, formatting, and media are not imported.":"RSS may include only recent posts or excerpts. HTTPS images from the feed are kept as linked addresses (for example Medium’s CDN). Image files are not downloaded into Writes storage. Audio and video are still skipped. Review the result against your original."};
    }
    if (path === "/api/import/commit" && method === "POST") {
      if (data.rights !== true) fail("Confirm that you own this writing or have permission to copy it.");
      const job = await this.store.get(owner,"job#"+data.jobId);
      if (!job || job.expiresAt < Date.now()/1000) fail("This import preview expired. Preview the source again.");
      const selected = [...new Set(data.selected || [])];
      if (selected.length > 40 || !selected.every(x=>Number.isInteger(x)&&x>=0&&x<job.count)) fail("Invalid import selection.");
      if ((await this.store.list(owner,"work#")).length + selected.length > 500) fail("This workspace is limited to 500 writings.");
      const results = [];
      for (const index of selected) {
        const c = await this.store.get(owner,`job#${data.jobId}#${index}`);
        const old = await this.store.get(owner,"work#"+c.id);
        if (old?.source?.hash === c.source.hash) { results.push({title:c.title,status:"skipped"}); continue; }
        if ((old?.version||0) !== c.existingVersion) { results.push({title:c.title,status:"conflict"}); continue; }
        if (old && !(data.approvedChanges||[]).includes(index)) { results.push({title:c.title,status:"needs-review"}); continue; }
        try {
          await this.save(owner,{...c,...(old?{kind:old.kind,collection:old.collection,theme:old.theme,layout:old.layout,archived:old.archived}:{archived:false}),versionName:""},old,{id:c.id,source:c.source,example:false});
          results.push({title:c.title,status:old?"updated":"imported"});
        } catch(e) { if(e.status===409) results.push({title:c.title,status:"conflict"}); else throw e; }
      }
      if (job.source && results.some(r=>["imported","updated","skipped"].includes(r.status))) await this.store.commit([{pk:owner,sk:"source#"+job.source.id,value:job.source}]);
      return {results};
    }
    fail("This action is not available.",404);
  }
}
