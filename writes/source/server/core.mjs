import crypto from "node:crypto";
import { z } from "zod";
import { fail, hash, resolveFeedUrls, safeFetch, parseFeed, parseFile, parseZip, googleDraft, collectAuthorAliases, gateCandidatesByAuthor, workImportId, normalizeCanonicalUrl, enrichSubstackAuthors, publicationHomeFromUrls } from "./imports.mjs";
import { DEFAULT_LAYOUT } from "../shared/poetry.mjs";
import { coverFromWork, firstImageUrl } from "../shared/manuscript.mjs";
import { defaultCategories, normalizeCategories, inferCategoryId, categoryIdFromKind, labelForCategory } from "../shared/bibliography.mjs";

const CATEGORY_IDS = defaultCategories().map(c => c.id);
const input = z.object({
  title: z.string().trim().min(1, "Give this writing a title.").max(180),
  author: z.string().max(120).default(""),
  body: z.string().refine(s => Buffer.byteLength(s) <= 120000, "Keep each writing below 120 KB of text."),
  kind: z.enum(["poetry","story","essay","other"]).default("poetry"),
  categoryId: z.string().max(40).optional().refine(v => v == null || v === "" || CATEGORY_IDS.includes(v), "Choose a bibliography category."),
  collection: z.string().max(80).default(""),
  theme: z.enum(["forest","clay","linen","night"]).default("forest"),
  coverUrl: z.string().max(2000).default(""),
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
const resolveCategoryId = (w, fields = {}) => {
  const raw = fields.categoryId ?? w?.categoryId;
  if (raw && CATEGORY_IDS.includes(raw)) return raw;
  return categoryIdFromKind(fields.kind || w?.kind || "essay");
};
const metadata = w => ({
  id:w.id, title:w.title, author:w.author, kind:w.kind, categoryId: resolveCategoryId(w),
  collection:w.collection, theme:w.theme,
  coverUrl: coverFromWork(w),
  archived:w.archived, version:w.version, updatedAt:w.updatedAt, example:w.example, shared:!!w.shareToken,
  platform:w.source?.platform, words:w.body.trim().split(/\s+/).filter(Boolean).length,
  sourceUrl: w.source?.url || "",
  publishedAt: w.source?.publishedAt || "",
});
const publicCopy = w => ({ id:w.id,title:w.title,author:w.author,kind:w.kind,categoryId:resolveCategoryId(w),body:w.body,theme:w.theme,collection:w.collection,layout:w.layout,coverUrl:coverFromWork(w),version:w.version,publishedAt:now() });
const exportCopy = w => { const {shareToken,...copy} = w; return copy; };
export const EXAMPLES = [
  { title:"The space between",kind:"poetry",categoryId:"poetry",theme:"forest",collection:"Small observations",author:"A Writes example",body:"Not every silence\nis an empty room.\n\nSome are a window\nleft open\n    for the rain.\n\n[[page]]\n\nI am learning\nto leave a little space\nbetween the things I know.\n\nEnough for a seed.\nEnough for a question.\nEnough for you.",example:true },
  { title:"A small atlas\nof home",kind:"story",categoryId:"story",theme:"clay",collection:"Small observations",author:"A Writes example",body:"The map her grandfather left behind had no roads.\n\nInstead, there were the places where things had happened: a first snow, a lost dog found, a very good sandwich.\n\nIn the corner, beneath a tiny drawing of the kitchen, he had written: Start here.\n\n[[page]]\n\nShe spread it on the table and took out a pencil.\n\nThe house had changed. The apple tree was gone. But the afternoon light still found the same patch of floor.\n\nShe drew a small square and wrote: Where I began again.",example:true },
  { title:"Notes from\nthe margins",kind:"essay",categoryId:"essay",theme:"linen",collection:"Field notes",author:"A Writes example",body:"There is a kind of thinking that only happens at the edge of a page.\n\nNot the polished thought, with its shoes on and somewhere to be. The other kind. The half-formed question. The sentence you underline for reasons you cannot quite explain.\n\nThis is a place to keep those things.\n\n[[page]]\n\nA notebook does not ask where a thought will be published. It simply makes room.\n\nThat seems like a useful quality for a digital space, too.",example:true },
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
  async bibliographySettings(owner) {
    const row = await this.store.get(owner, "settings#bibliography");
    return {
      categories: normalizeCategories(row?.categories),
      shareToken: row?.shareToken || "",
      version: row?.version || 0,
    };
  }
  async save(owner, fields, old = null, extra = {}) {
    const validated = input.parse(fields), stamp = now();
    const coverUrl = coverFromWork({ ...old, ...validated, ...extra, source: extra.source || validated.source || old?.source })
      || normalizeCanonicalUrl(validated.coverUrl)
      || normalizeCanonicalUrl(extra.coverUrl)
      || firstImageUrl(validated.body)
      || old?.coverUrl
      || "";
    const categoryId = resolveCategoryId(old, { ...validated, ...extra });
    const w = { ...old, ...validated, ...extra, coverUrl, categoryId, id:old?.id || extra.id || crypto.randomUUID(),createdAt:old?.createdAt || stamp,updatedAt:stamp,version:(old?.version||0)+1 };
    if (Buffer.byteLength(JSON.stringify(w)) > 300000) fail("This piece and its source are too large to save together. Import a smaller plain-text section.");
    const ops = [{pk:owner,sk:"work#"+w.id,value:w,expected:old?.version||0}];
    if (old) ops.push({pk:owner,sk:`revision#${old.id}#${String(old.version).padStart(8,"0")}`,value:exportCopy(old),expected:0});
    await this.store.commit(ops);
    return w;
  }
  async findExistingImport(owner, candidate) {
    const primaryId = workImportId(candidate.source.key);
    const primary = await this.store.get(owner, "work#" + primaryId);
    if (primary) return { work: primary, id: primary.id };

    const works = await this.store.list(owner, "work#");
    const wantUrl = normalizeCanonicalUrl(candidate.source.url);
    const wantPostId = String(candidate.source.postId || "").split(".")[0];
    const wantTitleDate = candidate.title && candidate.source.publishedAt
      ? String(candidate.title).trim().toLowerCase().replace(/\s+/g, " ") + "|" + String(candidate.source.publishedAt).slice(0, 10)
      : "";

    for (const work of works) {
      const haveUrl = normalizeCanonicalUrl(work.source?.url);
      if (wantUrl && haveUrl && wantUrl === haveUrl) return { work, id: work.id };
      const havePostId = String(work.source?.postId || "").split(".")[0];
      if (wantPostId && havePostId && wantPostId === havePostId) return { work, id: work.id };
      // Older RSS imports used hash(feed|guid) keys; recover via URL equality above.
      // Also match prior url| keys stored on source.key
      if (wantUrl && work.source?.key === "url|" + wantUrl) return { work, id: work.id };
      if (wantTitleDate && work.source?.publishedAt) {
        const have = String(work.title || "").trim().toLowerCase().replace(/\s+/g, " ") + "|" + String(work.source.publishedAt).slice(0, 10);
        if (have === wantTitleDate) return { work, id: work.id };
      }
    }
    return { work: null, id: primaryId };
  }
  async route(owner, method, path, data = {}, actor = null) {
    if (path.startsWith("/api/public/") && method === "GET") {
      const token = path.split("/").pop();
      if (!/^[a-zA-Z0-9_-]{32}$/.test(token)) fail("This shared writing is unavailable.",404);
      const bib = await this.store.get("public#"+token,"bibliography");
      if (bib) return { bibliography: bib };
      const w = await this.store.get("public#"+token,"snapshot");
      if (!w) fail("This shared writing is unavailable or its link was revoked.",404);
      return {work:w};
    }
    if (!owner) fail("Please sign in to your member account.",401);
    if (method === "GET" && path === "/api/works") return {works:(await this.store.list(owner,"work#")).map(metadata)};
    if (method === "GET" && path === "/api/bibliography") {
      const settings = await this.bibliographySettings(owner);
      const works = (await this.store.list(owner,"work#")).filter(w => !w.archived);
      const entries = works.map(w => {
        const meta = metadata(w);
        return {
          id: meta.id,
          title: meta.title,
          author: meta.author,
          categoryId: meta.categoryId,
          categoryLabel: labelForCategory(settings.categories, meta.categoryId),
          updatedAt: meta.updatedAt,
          publishedAt: meta.publishedAt,
          sourceUrl: meta.sourceUrl,
          kind: meta.kind,
          words: meta.words,
        };
      }).sort((a,b) => a.title.localeCompare(b.title));
      const sections = settings.categories.map(cat => ({
        ...cat,
        entries: entries.filter(e => e.categoryId === cat.id),
      }));
      return { categories: settings.categories, sections, entries, shareToken: settings.shareToken || "" };
    }
    if (method === "PUT" && path === "/api/bibliography/categories") {
      const categories = normalizeCategories(data.categories);
      const prev = await this.store.get(owner, "settings#bibliography");
      const next = { categories, shareToken: prev?.shareToken || "", version: (prev?.version || 0) + 1, updatedAt: now() };
      await this.store.commit([{ pk: owner, sk: "settings#bibliography", value: next, expected: prev?.version || 0 }]);
      return { categories: next.categories };
    }
    if (method === "POST" && path === "/api/bibliography/share") {
      if (data.confirm !== true) fail("Confirm before creating a public bibliography link.");
      const settings = await this.bibliographySettings(owner);
      const token = settings.shareToken || crypto.randomBytes(24).toString("base64url");
      const listing = await this.route(owner, "GET", "/api/bibliography", {}, actor);
      const snapshot = {
        title: data.title || "Bibliography",
        author: actor?.display_name || actor?.displayName || actor?.username || "",
        categories: listing.categories,
        sections: listing.sections.map(s => ({
          id: s.id, label: s.label, hint: s.hint,
          entries: s.entries.map(e => ({ title: e.title, author: e.author, sourceUrl: e.sourceUrl, publishedAt: e.publishedAt })),
        })),
        publishedAt: now(),
      };
      const prev = await this.store.get(owner, "settings#bibliography");
      const next = { categories: settings.categories, shareToken: token, version: (prev?.version || 0) + 1, updatedAt: now() };
      await this.store.commit([
        { pk: owner, sk: "settings#bibliography", value: next, expected: prev?.version || 0 },
        { pk: "public#" + token, sk: "bibliography", value: snapshot },
      ]);
      return { token, bibliography: snapshot };
    }
    if (method === "DELETE" && path === "/api/bibliography/share") {
      const prev = await this.store.get(owner, "settings#bibliography");
      if (!prev?.shareToken) return { revoked: false };
      const next = { categories: normalizeCategories(prev.categories), shareToken: "", version: (prev.version || 0) + 1, updatedAt: now() };
      await this.store.commit([
        { pk: owner, sk: "settings#bibliography", value: next, expected: prev.version || 0 },
        { pk: "public#" + prev.shareToken, sk: "bibliography", remove: true },
      ]);
      return { revoked: true };
    }
    if (method === "POST" && path === "/api/works/refresh-covers") {
      const works = await this.store.list(owner, "work#");
      let updated = 0, already = 0, missing = 0;
      for (const work of works) {
        const next = coverFromWork(work);
        if (!next) { missing += 1; continue; }
        if (String(work.coverUrl || "") === next) { already += 1; continue; }
        const stamp = now();
        const saved = { ...work, coverUrl: next, updatedAt: stamp, version: (work.version || 0) + 1 };
        await this.store.commit([{ pk: owner, sk: "work#" + work.id, value: saved, expected: work.version || 0 }]);
        updated += 1;
      }
      return { updated, already, missing, total: works.length };
    }
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
      let candidates, source, feedNote = "";
      if (data.googleDocUrl) {
        candidates=googleDraft(data.googleDocUrl,data.name,data.text);
      } else if (data.url) {
        let resolved;
        try { resolved = await resolveFeedUrls(data.url); }
        catch(e) { e.status = e.status || 400; throw e; }
        const merged = [];
        const seen = new Set();
        for (const feed of resolved.urls) {
          let fetched;
          try { fetched = await this.fetcher(feed); }
          catch(e) { e.status = e.status || 400; throw e; }
          let items;
          try { items = parseFeed(fetched.text, feed); }
          catch(e) {
            if (resolved.urls.length === 1) { e.status = e.status || 400; throw e; }
            continue; // skip empty/broken pubs when expanding a profile
          }
          for (const item of items) {
            if (seen.has(item.source.key)) continue;
            seen.add(item.source.key);
            merged.push(item);
            if (merged.length >= 40) break;
          }
          if (merged.length >= 40) break;
        }
        if (!merged.length) fail("No articles were found across those publication feeds. Try a single publication /feed URL.");
        const authorsOnly = data.includeAllAuthors !== true;
        const soleAuthor = data.soleAuthorExport === true;
        const aliases = collectAuthorAliases(actor || {}, resolved, owner, typeof data.authorFilter === "string" ? data.authorFilter : "");
        const defaultAuthor = actor?.display_name || actor?.displayName || actor?.username || "";
        const gated = gateCandidatesByAuthor(merged, aliases, { authorsOnly, soleAuthor, defaultAuthor });
        if (gated.filtered && !gated.kept) {
          fail(`No posts matched your author identity (${aliases.join(", ") || "unknown"}). Skipped ${gated.skippedOther} by other authors and ${gated.skippedMissing} with no byline. Enable “Import every author on this publication” only to copy co-authors’ writing.`);
        }
        candidates = gated.filtered ? gated.candidates.filter(c => c.authorGate === "allow") : gated.candidates;
        // Keep blocked posts out of the feed commit list (feeds can be large); counts go in the warning.
        source = {id:hash(resolved.label).slice(0,24),url:resolved.label,updatedAt:now(),version:1};
        if (resolved.handle) feedNote = `Loaded public publications from @${resolved.handle}. `;
        if (gated.filtered) {
          feedNote += `Author filter on: showing ${gated.kept} post${gated.kept===1?"":"s"} matching ${aliases.join(" / ")}. Skipped ${gated.skippedOther} by other authors` + (gated.skippedMissing ? `, ${gated.skippedMissing} with no byline` : "") + `. `;
        } else if (authorsOnly && !aliases.length) {
          feedNote += "Author filter idle (no member display name/username to match). Showing all posts from the feed. ";
        } else if (!authorsOnly) {
          feedNote += "Importing every author on this publication (opt-in). ";
        }
      } else if (data.name?.toLowerCase().endsWith(".zip")) {
        const defaultAuthor = actor?.display_name || actor?.displayName || actor?.username || "";
        const requestedPub = String(data.publicationUrl || "").trim();
        candidates = await parseZip(data.base64 || "", {
          substack: true,
          publicationUrl: requestedPub,
        });
        // Always enrich: form homepage, else URLs from email_list.{sub}.csv auto-detect inside parseZip.
        const pubUrl = requestedPub || publicationHomeFromUrls(candidates);
        const enriched = await enrichSubstackAuthors(candidates, {
          publicationUrl: pubUrl,
          feedFetch: this.fetcher,
        });
        candidates = enriched.candidates;
        const authorsOnly = data.includeAllAuthors !== true;
        const soleAuthor = data.soleAuthorExport === true;
        const aliases = collectAuthorAliases(actor || {}, {}, owner, typeof data.authorFilter === "string" ? data.authorFilter : "");
        const gated = gateCandidatesByAuthor(candidates, aliases, { authorsOnly, soleAuthor, defaultAuthor });
        candidates = gated.candidates;
        feedNote = enriched.note || "";
        if (gated.filtered) {
          const lookedUp = (enriched.fromFeed || 0) + (enriched.fromApi || 0) + (enriched.fromHtml || 0);
          const tip = gated.skippedMissing && !lookedUp
            ? " Paste the publication homepage (e.g. https://blog.maisaspace.org) and Preview again so authors can be looked up."
            : gated.skippedOther
              ? " Co-author posts stay skipped unless you enable “Import every author.”"
              : "";
          feedNote += `Substack export. Author filter on: ${gated.kept} matched ${aliases.join(" / ") || "your identity"}. Skipped ${gated.skippedOther} by other authors, ${gated.skippedMissing} with no byline.${tip} `;
        } else if (!authorsOnly) {
          feedNote += "Substack export. Importing every author (opt-in). ";
        } else {
          feedNote += "Substack export. Author filter idle (no member identity to match). ";
        }
        source = { id: hash("substack-export|" + (pubUrl || data.name || "zip")).slice(0, 24), url: pubUrl || "", updatedAt: now(), version: 1 };
      } else candidates = parseFile(data.name || "Pasted writing.txt",data.text || "");
      const jobId = crypto.randomUUID(), expiresAt = Math.floor(Date.now()/1000)+1800;
      const previews = [];
      for (const [index,c] of candidates.entries()) {
        const blocked = c.authorGate === "block";
        const found = blocked ? { work: null, id: workImportId(c.source.key) } : await this.findExistingImport(owner, c);
        const existing = found.work;
        const id = found.id;
        const status = blocked ? "excluded" : !existing ? "new" : existing.source?.hash === c.source.hash ? "unchanged" : "changed";
        const entry = {
          ...(blocked ? { ...c, body: "", source: { ...c.source, original: "" } } : c),
          id,
          index,
          status,
          existingVersion: existing?.version || 0,
          expiresAt,
          version: 1,
          coverUrl: blocked ? "" : (c.coverUrl || firstImageUrl(c.body) || coverFromWork(c) || existing?.coverUrl || ""),
        };
        if (Buffer.byteLength(JSON.stringify(entry)) > 300000) fail("An imported piece is too large. Import a smaller plain-text section.");
        await this.store.commit([{pk:owner,sk:`job#${jobId}#${index}`,value:entry,expected:0}]);
        previews.push({
          index,
          title:c.title,
          author:c.author,
          body: blocked ? "" : c.body,
          status,
          platform:c.source.platform,
          existingBody:existing?.body,
          coverUrl: blocked ? "" : entry.coverUrl,
          authorGate: c.authorGate || "allow",
          authorNote: c.authorNote || "",
        });
      }
      await this.store.commit([{pk:owner,sk:"job#"+jobId,value:{expiresAt,count:candidates.length,source,version:1},expected:0}]);
      return {jobId,candidates:previews,warning:data.googleDocUrl?"This is an independent text copy, not a live Google connection. Re-import using the same document address to review a later draft. Google’s revision history, comments, formatting, and media are not imported.":feedNote+"Duplicates match by canonical URL, Substack post id, or title+date against your library (including prior RSS/Medium imports). HTTPS images stay linked; ZIP exports do not include binary media files. Review the result against your original."};
    }
    if (path === "/api/import/commit" && method === "POST") {
      if (data.rights !== true) fail("Confirm that you own this writing or have permission to copy it.");
      const job = await this.store.get(owner,"job#"+data.jobId);
      if (!job || job.expiresAt < Date.now()/1000) fail("This import preview expired. Preview the source again.");
      const selected = [...new Set(data.selected || [])];
      if (selected.length > 200 || !selected.every(x=>Number.isInteger(x)&&x>=0&&x<job.count)) fail("Invalid import selection.");
      if ((await this.store.list(owner,"work#")).length + selected.length > 500) fail("This workspace is limited to 500 writings.");
      const results = [];
      for (const index of selected) {
        const c = await this.store.get(owner,`job#${data.jobId}#${index}`);
        if (c.authorGate === "block" || c.status === "excluded") { results.push({title:c.title,status:"excluded"}); continue; }
        const old = await this.store.get(owner,"work#"+c.id);
        if (old?.source?.hash === c.source.hash) { results.push({title:c.title,status:"skipped"}); continue; }
        if ((old?.version||0) !== c.existingVersion) { results.push({title:c.title,status:"conflict"}); continue; }
        if (old && !(data.approvedChanges||[]).includes(index)) { results.push({title:c.title,status:"needs-review"}); continue; }
        try {
          await this.save(owner,{
            ...c,
            ...(old?{kind:old.kind,collection:old.collection,theme:old.theme,layout:old.layout,archived:old.archived,categoryId:old.categoryId}:{archived:false}),
            versionName:"",
            coverUrl:c.coverUrl||old?.coverUrl||"",
            categoryId: old?.categoryId || inferCategoryId({ kind: c.kind, title: c.title, platform: c.source?.platform, collection: c.collection }),
          },old,{id:c.id,source:c.source,example:false,coverUrl:c.coverUrl||old?.coverUrl||""});
          results.push({title:c.title,status:old?"updated":"imported"});
        } catch(e) { if(e.status===409) results.push({title:c.title,status:"conflict"}); else throw e; }
      }
      if (job.source && results.some(r=>["imported","updated","skipped"].includes(r.status))) await this.store.commit([{pk:owner,sk:"source#"+job.source.id,value:job.source}]);
      return {results};
    }
    fail("This action is not available.",404);
  }
}
