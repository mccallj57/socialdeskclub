import https from "node:https";
import dns from "node:dns/promises";
import crypto from "node:crypto";
import ipaddr from "ipaddr.js";
import { XMLParser } from "fast-xml-parser";
import { parseHTML } from "linkedom";
import yauzl from "yauzl";
import { firstImageUrl, normalizeCanonicalUrl } from "../shared/manuscript.mjs";
export { firstImageUrl, normalizeCanonicalUrl };

export function fail(message, status = 400) { const e = new Error(message); e.status = status; throw e; }
export const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const bytes = value => Buffer.byteLength(value, "utf8");
export function publicAddress(address) {
  try { return ipaddr.process(address).range() === "unicast"; } catch { return false; }
}
export function stableImportKey({ url, postId, title, publishedAt, fallback }) {
  const canonical = normalizeCanonicalUrl(url);
  if (canonical) return "url|" + canonical;
  const id = String(postId || "").trim();
  if (id) return "substack|" + (id.split(".")[0] || id);
  const stamped = String(publishedAt || "").slice(0, 10);
  if (title && stamped) return "title-date|" + String(title).trim().toLowerCase().replace(/\s+/g, " ") + "|" + stamped;
  return fallback || ("body|" + hash(String(title || "") + "|" + stamped));
}
export function workImportId(sourceKey) {
  return "import-" + hash(sourceKey).slice(0, 32);
}
function barePath(pathname) {
  const path = (pathname || "/").replace(/\/+$/, "") || "/";
  return path;
}
/** Sync rewrite: Medium, *.substack.com roots, and homepage-like blogs (WordPress / Substack custom domains) → /feed. */
export function feedUrl(input) {
  let url;
  try { url = new URL(input.trim()); } catch { fail("Enter a complete https:// publication or RSS address."); }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) fail("Use a public HTTPS address without credentials or a custom port.");
  if (url.hostname === "medium.com" && !url.pathname.startsWith("/feed/")) url.pathname = "/feed/" + url.pathname.replace(/^\//, "");
  else if (url.hostname.endsWith(".substack.com")) {
    const path = barePath(url.pathname);
    if (path === "/" || path === "/archive" || path === "/posts") url.pathname = "/feed";
  } else if (url.hostname !== "substack.com") {
    // Custom domains (Substack, WordPress, many blogs): homepage → /feed
    const path = barePath(url.pathname);
    if (path === "/" || path === "/posts" || path === "/blog") url.pathname = "/feed";
  }
  url.hash = "";
  return url.toString();
}
export function substackProfileHandle(input) {
  let url;
  try { url = new URL(String(input).trim()); } catch { return null; }
  if (url.hostname !== "substack.com") return null;
  const match = barePath(url.pathname).match(/^\/@([A-Za-z0-9_-]+)(?:\/(?:posts|notes|about))?$/);
  return match ? match[1] : null;
}
export function publicationFeedUrl(pub = {}) {
  const custom = typeof pub.custom_domain === "string" ? pub.custom_domain.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "") : "";
  if (custom) return `https://${custom}/feed`;
  const sub = typeof pub.subdomain === "string" ? pub.subdomain.trim() : "";
  if (sub) return `https://${sub}.substack.com/feed`;
  fail("That Substack publication does not expose a public feed address.");
}
/** Resolve one paste into one or more RSS URLs. Substack @profile expands to public admin publications. */
export async function resolveFeedUrls(input, fetchJson = defaultJsonFetch) {
  const handle = substackProfileHandle(input);
  if (handle) {
    let profile;
    try {
      profile = await fetchJson(`https://substack.com/api/v1/user/${encodeURIComponent(handle)}/public_profile`);
    } catch {
      fail("Could not look up that Substack profile. Paste a publication address (for example https://name.substack.com) or its /feed URL.");
    }
    const rows = Array.isArray(profile?.publicationUsers) ? profile.publicationUsers : [];
    const feeds = [];
    const seen = new Set();
    const ordered = [...rows].sort((a, b) => Number(!!b?.is_primary) - Number(!!a?.is_primary));
    for (const row of ordered) {
      if (!row?.public || row.role !== "admin" || !row.publication) continue;
      let feed;
      try { feed = publicationFeedUrl(row.publication); } catch { continue; }
      if (seen.has(feed)) continue;
      seen.add(feed);
      feeds.push(feed);
    }
    if (!feeds.length) fail("This Substack profile has no public publications with RSS feeds. Paste a publication homepage or /feed URL instead.");
    return {
      urls: feeds,
      label: `https://substack.com/@${handle}`,
      handle,
      profileName: typeof profile?.name === "string" ? profile.name.trim() : "",
    };
  }
  const url = feedUrl(input);
  return { urls: [url], label: url };
}
/** Normalize bylines / handles for comparison. */
export function normalizeAuthor(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/[_./-]+/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
const IGNORE_ALIAS = new Set(["", "your preview desk", "preview", "you", "unknown", "anonymous"]);
/** Build match aliases from Reads member + optional Substack profile. */
export function collectAuthorAliases(actor = {}, resolved = {}, owner = "", extra = "") {
  const raw = [
    actor.display_name,
    actor.displayName,
    actor.username,
    resolved.profileName,
    resolved.handle,
    extra,
    typeof owner === "string" && owner.startsWith("member#") ? owner.slice(7) : "",
  ];
  const aliases = [];
  const seen = new Set();
  for (const value of raw) {
    const normalized = normalizeAuthor(value);
    if (!normalized || IGNORE_ALIAS.has(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    aliases.push(normalized);
  }
  return aliases;
}
export function authorMatches(itemAuthor, aliases) {
  if (!aliases?.length) return true;
  const author = normalizeAuthor(itemAuthor);
  if (!author) return false;
  const tokens = author.split(" ").filter(Boolean);
  return aliases.some(alias => {
    if (author === alias) return true;
    if (tokens.includes(alias)) return true;
    if (alias.includes(" ") && author.includes(alias)) return true;
    return false;
  });
}
export function filterCandidatesByAuthor(candidates, aliases, { authorsOnly = true } = {}) {
  if (!authorsOnly || !aliases.length) {
    return { kept: candidates, skipped: 0, aliases, filtered: false };
  }
  const kept = candidates.filter(c => authorMatches(c.author, aliases));
  return { kept, skipped: candidates.length - kept.length, aliases, filtered: true };
}
async function defaultJsonFetch(url) {
  const host = new URL(url).hostname;
  const records = await dns.lookup(host, { all: true });
  if (!records.length || records.some(r => !publicAddress(r.address))) fail("That address is not a public internet feed.");
  const record = records[0];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => req.destroy(new Error("The profile lookup took too long.")), 10000);
    const req = https.get(url, {
      headers: { "User-Agent": "SocialDeskClub-Writes/0.1 (user-requested RSS import)", Accept: "application/json", "Accept-Encoding": "identity" },
      lookup: (_h, opts, cb) => opts?.all ? cb(null, [record]) : cb(null, record.address, record.family),
    }, response => {
      if (response.statusCode !== 200) { response.resume(); clearTimeout(timer); reject(new Error(`Profile lookup returned HTTP ${response.statusCode}.`)); return; }
      const chunks = []; let size = 0;
      response.on("data", chunk => {
        size += chunk.length;
        if (size > 2_000_000) req.destroy(new Error("Profile response too large."));
        else chunks.push(chunk);
      });
      response.on("end", () => {
        clearTimeout(timer);
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { reject(new Error("Profile response was not JSON.")); }
      });
      response.on("error", reject);
    });
    req.on("error", error => { clearTimeout(timer); reject(error); });
  });
}
// DNS is checked and pinned into https.request's lookup. Revalidate every redirect.
// Do not replace this with unvalidated fetch(url): it would allow DNS rebinding.
export async function safeFetch(input, redirects = 0) {
  const url = new URL(feedUrl(input));
  if (redirects > 3) fail("The feed redirected too many times.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const records = ipaddr.isValid(host) ? [{ address: host, family: ipaddr.parse(host).kind() === "ipv4" ? 4 : 6 }] : await dns.lookup(host, { all: true });
  if (!records.length || records.some(r => !publicAddress(r.address))) fail("That address is not a public internet feed.");
  const record = records[0];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => req.destroy(new Error("The feed took too long. Try again or import a file.")), 10000);
    const req = https.get(url, {
      headers: { "User-Agent": "SocialDeskClub-Writes/0.1 (user-requested RSS import)", Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml", "Accept-Encoding": "identity" },
      lookup: (_h, opts, cb) => opts?.all ? cb(null, [record]) : cb(null, record.address, record.family),
    }, response => {
      if ([301,302,303,307,308].includes(response.statusCode)) {
        response.resume(); clearTimeout(timer);
        if (!response.headers.location) return reject(new Error("The feed returned an empty redirect."));
        safeFetch(new URL(response.headers.location, url).toString(), redirects + 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) { response.resume(); clearTimeout(timer); reject(new Error(`The publication returned HTTP ${response.statusCode}. You can still import its export file.`)); return; }
      const chunks = []; let size = 0;
      response.on("data", chunk => {
        size += chunk.length;
        if (size > 4_000_000) req.destroy(new Error("This feed is larger than 4 MB. Import a smaller file instead."));
        else chunks.push(chunk);
      });
      response.on("end", () => { clearTimeout(timer); resolve({ text: Buffer.concat(chunks).toString("utf8"), url: url.toString() }); });
      response.on("error", reject);
    });
    req.on("error", error => { clearTimeout(timer); reject(error); });
  });
}
const BLOCK = new Set(["P","DIV","SECTION","ARTICLE","H1","H2","H3","H4","BLOCKQUOTE","LI","UL","OL","FIGURE","FIGCAPTION"]);
/** Keep HTTPS feed images as markdown markers; skip trackers / non-public schemes. */
function imageMarkdown(node) {
  let src = (node.getAttribute("src") || "").trim();
  const alt = (node.getAttribute("alt") || "").trim().replace(/[\[\]]/g, "");
  const width = node.getAttribute("width");
  const height = node.getAttribute("height");
  if (width === "1" && height === "1") return "";
  // Substack often wraps CDN URLs; prefer the durable original from data-attrs when present.
  const rawAttrs = node.getAttribute("data-attrs");
  if (rawAttrs) {
    try {
      const attrs = JSON.parse(rawAttrs);
      if (typeof attrs?.src === "string" && /^https:\/\//i.test(attrs.src)) src = attrs.src.trim();
    } catch { /* keep src */ }
  }
  if (!src || /medium\.com\/_\/stat/i.test(src) || /^data:/i.test(src)) return "";
  let url;
  try { url = new URL(src); } catch { return alt ? `[Image: ${alt}]\n` : ""; }
  if (url.protocol !== "https:" || url.username || url.password) return alt ? `[Image: ${alt}]\n` : "";
  const href = url.toString().replace(/[)\s]/g, encodeURIComponent);
  return `![${alt}](${href})\n\n`;
}
export function htmlText(html) {
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  document.querySelectorAll("script,style,iframe,object,embed,form,nav,noscript").forEach(n => n.remove());
  const render = (node, pre = false) => {
    if (node.nodeType === 3) return pre ? node.textContent : node.textContent.replace(/[\t\n\r ]+/g, " ");
    if (node.nodeType !== 1) return "";
    if (node.tagName === "BR") return "\n";
    if (node.tagName === "IMG") return imageMarkdown(node);
    const text = [...node.childNodes].map(n => render(n, pre || node.tagName === "PRE")).join("");
    return BLOCK.has(node.tagName) || node.tagName === "PRE" ? text + "\n\n" : text;
  };
  // Never normalize spaces inside PRE; HTML paragraphs naturally become stanzas.
  return [...document.body.childNodes].map(n => render(n)).join("").replace(/^\n+|\n+$/g, "");
}
function string(value) {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return string(value[0]);
  return value?.["#text"] ? string(value["#text"]) : "";
}
function candidate(data) {
  if (typeof data.body !== "string" || bytes(data.body) > 120000) fail("One writing exceeds the 120 KB text limit. Split it into smaller pieces.");
  const original = String(data.original ?? data.body);
  if (bytes(original) > 160000) fail("One source exceeds the 160 KB original-source limit. Import it as plain text.");
  const url = normalizeCanonicalUrl(data.url) || String(data.url || "");
  const key = String(data.key || stableImportKey({ url, postId: data.postId, title: data.title, publishedAt: data.publishedAt, fallback: hash(data.body) }));
  const coverUrl = normalizeCanonicalUrl(data.coverUrl) || firstImageUrl(data.body) || "";
  return {
    title: String(data.title || "Untitled").slice(0, 180),
    author: String(data.author || "").slice(0, 120),
    kind: ["poetry","story","essay","other"].includes(data.kind) ? data.kind : "essay",
    body: data.body,
    collection: String(data.collection || "").slice(0, 80),
    theme: ["forest","clay","linen","night"].includes(data.theme) ? data.theme : "linen",
    coverUrl,
    ...(data.layout?{layout:data.layout}:{}),
    versionName:typeof data.versionName==="string"?data.versionName.slice(0,80):"",
    source: {
      key,
      platform: data.platform || "File",
      url,
      postId: data.postId ? String(data.postId) : "",
      publishedAt: data.publishedAt ? String(data.publishedAt) : "",
      fetchedAt: new Date().toISOString(),
      original,
      hash: hash(data.body),
    },
  };
}
export function googleDraft(address,name,text) {
  let url;
  try{url=new URL(address);}catch{fail("Paste the Google Doc address so later drafts can be matched to this copy.");}
  const match=url.pathname.match(/^\/document\/d\/([a-zA-Z0-9_-]{10,200})(?:\/|$)/);
  if(url.protocol!=="https:"||url.hostname!=="docs.google.com"||url.username||url.password||url.port||!match)fail("Use a Google Docs address beginning https://docs.google.com/document/d/.");
  if(typeof text!=="string"||!text.trim())fail("Paste the draft or choose its plain-text export. An address alone does not give Writes access to a private Google Doc.");
  return [candidate({title:String(name||"Google Docs draft").replace(/\.txt$/i,""),body:text,original:text,key:"google-doc|"+match[1],platform:"Google Docs text copy",url:`https://docs.google.com/document/d/${match[1]}/edit`})];
}
export function parseFeed(xml, url) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) fail("Feeds containing document-type or entity declarations are not supported.");
  if (/^\s*</.test(xml) && !/<rss[\s>]|<feed[\s>]/i.test(xml)) fail("That address returned a web page, not an RSS feed. Use the publication homepage, /feed URL, or a Substack @profile.");
  const root = new XMLParser({ ignoreAttributes: false, processEntities: false, trimValues: false, parseTagValue: false }).parse(xml);
  let items = root.rss?.channel?.item || root.feed?.entry;
  if (!items) fail("No articles were found. Use the publication's RSS feed or import an export file.");
  if (!Array.isArray(items)) items = [items];
  const host = new URL(url).hostname;
  const generator = string(root.rss?.channel?.generator || root.feed?.generator);
  const platform = host.includes("medium") ? "Medium" : host.includes("substack") || /substack/i.test(generator) ? "Substack" : "RSS";
  return items.slice(0, 40).map(item => {
    let link = item.link;
    if (Array.isArray(link)) link = link.find(l => l["@_rel"] === "alternate") || link[0];
    const href = typeof link === "object" ? link?.["@_href"] : link;
    const content = string(item["content:encoded"] || item.content || item.description || item.summary);
    const body = htmlText(content);
    const postUrl = /^https?:\/\//i.test(href) ? href : (/^https?:\/\//i.test(string(item.guid || item.id)) ? string(item.guid || item.id) : "");
    return candidate({
      title: htmlText(string(item.title)),
      author: string(item["dc:creator"]) || string(item.author?.name) || string(item.author),
      body,
      original: content,
      url: postUrl,
      publishedAt: string(item.pubDate || item.published || item.updated),
      postId: string(item.guid || item.id),
      key: stableImportKey({ url: postUrl, postId: string(item.guid || item.id), title: htmlText(string(item.title)), publishedAt: string(item.pubDate || item.published || item.updated), fallback: hash(url + "|" + (string(item.guid || item.id) || href || string(item.title))) }),
      platform,
    });
  });
}
export function parseFile(name, text) {
  if (bytes(text) > 3_000_000) fail("Choose a text file smaller than 3 MB.");
  const extension = name.split(".").pop().toLowerCase();
  if (extension === "json") {
    let data; try { data = JSON.parse(text); } catch { fail("This JSON file is not valid."); }
    const works = Array.isArray(data) ? data : data.works || [data];
    if (!Array.isArray(works) || works.length > 40) fail("Import up to 40 writings at a time.");
    return works.map(w => candidate({ ...w, key: hash("file|" + (w.id || w.title) + "|" + w.body), platform: "Writes backup", original: w.source?.original || w.body, url: w.source?.url || "" }));
  }
  if (!["txt","md","html","htm"].includes(extension)) fail("Choose TXT, Markdown, HTML, JSON, or a ZIP containing those files.");
  let title = name.replace(/\.[^.]+$/, ""), body = text, original = text;
  if (["html","htm"].includes(extension)) {
    const { document } = parseHTML(text);
    title = document.querySelector("h1")?.textContent || document.querySelector("title")?.textContent || title;
    body = htmlText(document.querySelector("article")?.innerHTML || document.querySelector("body")?.innerHTML || text);
  }
  return [candidate({ title, body, original, key: hash("file|" + name + "|" + text), platform: "File" })];
}
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", i = 0, inQuotes = false;
  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => { if (row.some(c => c.length)) rows.push(row); row = []; };
  const input = String(text || "").replace(/^\uFEFF/, "");
  while (i < input.length) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += ch; i += 1; continue;
    }
    if (ch === '"') { inQuotes = true; i += 1; continue; }
    if (ch === ",") { pushField(); i += 1; continue; }
    if (ch === "\n") { pushField(); pushRow(); i += 1; continue; }
    if (ch === "\r") { i += 1; continue; }
    field += ch; i += 1;
  }
  pushField(); pushRow();
  if (!rows.length) return [];
  const headers = rows[0].map(h => h.trim());
  return rows.slice(1).map(cells => {
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = cells[idx] ?? ""; });
    return obj;
  });
}
export function publicationPostUrl(base, postId) {
  const root = normalizeCanonicalUrl(base) || String(base || "").replace(/\/+$/, "");
  if (!root) return "";
  const raw = String(postId || "");
  const slug = raw.includes(".") ? raw.slice(raw.indexOf(".") + 1) : "";
  if (!slug) return "";
  try {
    const url = new URL(root);
    url.pathname = "/p/" + slug;
    return normalizeCanonicalUrl(url.toString());
  } catch {
    return "";
  }
}
export function parseSubstackExport(files, { publicationUrl = "", defaultAuthor = "" } = {}) {
  const csvFile = files.find(f => /(^|\/)posts\.csv$/i.test(f.name));
  if (!csvFile) fail("This does not look like a Substack export (missing posts.csv).");
  const rows = parseCsv(csvFile.text);
  if (!rows.length) fail("The Substack export posts.csv had no rows.");
  const htmlById = new Map();
  for (const file of files) {
    const match = file.name.match(/(?:^|\/)posts\/([^/]+)\.html?$/i);
    if (match) htmlById.set(match[1], file.text);
  }
  const out = [];
  for (const row of rows) {
    const postId = row.post_id || row.id || "";
    const published = /^(true|1|yes)$/i.test(String(row.is_published || "").trim());
    if (!published && String(row.is_published || "") !== "") continue;
    const html = htmlById.get(postId) || htmlById.get(String(postId).split(".")[0]) || "";
    if (!html.trim()) continue;
    const title = String(row.title || "").trim() || postId;
    const body = htmlText(html);
    if (!body.trim()) continue;
    const url = publicationPostUrl(publicationUrl, postId);
    const author = String(row.author || row.writer || defaultAuthor || "").trim();
    out.push(candidate({
      title,
      author,
      body,
      original: html,
      url,
      postId,
      publishedAt: row.post_date || row.date || "",
      collection: String(row.type || "Substack export").slice(0, 80),
      platform: "Substack export",
      kind: "essay",
    }));
    if (out.length >= 200) break;
  }
  if (!out.length) fail("No published posts with HTML bodies were found in this Substack export.");
  return out;
}
export async function parseZip(base64, options = {}) {
  const buffer = Buffer.from(base64, "base64");
  const maxZip = options.substack ? 25_000_000 : 3_000_000;
  const maxExpanded = options.substack ? 80_000_000 : 12_000_000;
  const maxFile = options.substack ? 5_000_000 : 3_000_000;
  if (buffer.length > maxZip) fail(options.substack ? "Substack export ZIPs must be smaller than 25 MB." : "ZIP archives must be smaller than 3 MB.");
  const files = [];
  await new Promise((resolve, reject) => yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
    if (error) return reject(new Error("This ZIP archive could not be opened."));
    let count = 0, total = 0, stopped = false;
    const stop = error => { if (!stopped) { stopped = true; zip.close(); reject(error); } };
    zip.on("error", stop); zip.on("end", resolve);
    zip.on("entry", entry => {
      if (++count > 5000 || entry.uncompressedSize > maxFile || (total += entry.uncompressedSize) > maxExpanded) return stop(new Error("The expanded archive is too large."));
      if (entry.fileName.includes("..") || entry.fileName.startsWith("/") || entry.fileName.includes("\\")) return stop(new Error("Unsafe file path in archive."));
      if (!/\.(html?|txt|md|json|csv)$/i.test(entry.fileName) || /(^|\/)(__MACOSX|revisions|originals)\//.test(entry.fileName)) return zip.readEntry();
      // Skip huge email open/deliver CSVs in Substack exports
      if (/(^|\/)posts\/.*\.(opens|delivers)\.csv$/i.test(entry.fileName)) return zip.readEntry();
      if (/email_list|subscribers/i.test(entry.fileName) && /\.csv$/i.test(entry.fileName)) return zip.readEntry();
      zip.openReadStream(entry, (err, stream) => {
        if (err) return stop(err);
        const chunks = []; let size = 0;
        stream.on("data", c => { size += c.length; if (size > maxFile) { stream.destroy(); stop(new Error("An expanded file is too large.")); } else chunks.push(c); });
        stream.on("error", stop);
        stream.on("end", () => { if (!stopped) { files.push({ name: entry.fileName, text: Buffer.concat(chunks).toString("utf8") }); zip.readEntry(); } });
      });
    });
    zip.readEntry();
  }));
  const backup = files.find(f => /(^|\/)writes-library\.json$/i.test(f.name));
  if (backup) return parseFile(backup.name, backup.text);
  if (files.some(f => /(^|\/)posts\.csv$/i.test(f.name))) {
    return parseSubstackExport(files, {
      publicationUrl: options.publicationUrl || "",
      defaultAuthor: options.defaultAuthor || "",
    });
  }
  const writings = files.filter(f => !/(^|\/)(index|readme|manifest)\./i.test(f.name) && !/\.csv$/i.test(f.name)).slice(0, 40).flatMap(f => parseFile(f.name, f.text));
  if (!writings.length) fail("No supported writing files were found in this archive.");
  return writings.slice(0, 40);
}
