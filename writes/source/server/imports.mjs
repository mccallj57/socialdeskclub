import https from "node:https";
import dns from "node:dns/promises";
import crypto from "node:crypto";
import ipaddr from "ipaddr.js";
import { XMLParser } from "fast-xml-parser";
import { parseHTML } from "linkedom";
import yauzl from "yauzl";

export function fail(message, status = 400) { const e = new Error(message); e.status = status; throw e; }
export const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const bytes = value => Buffer.byteLength(value, "utf8");
export function publicAddress(address) {
  try { return ipaddr.process(address).range() === "unicast"; } catch { return false; }
}
export function feedUrl(input) {
  let url;
  try { url = new URL(input.trim()); } catch { fail("Enter a complete https:// publication or RSS address."); }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) fail("Use a public HTTPS address without credentials or a custom port.");
  if (url.hostname === "medium.com" && !url.pathname.startsWith("/feed/")) url.pathname = "/feed/" + url.pathname.replace(/^\//, "");
  if (url.hostname.endsWith(".substack.com") && ["/", ""].includes(url.pathname)) url.pathname = "/feed";
  url.hash = "";
  return url.toString();
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
  const src = (node.getAttribute("src") || "").trim();
  const alt = (node.getAttribute("alt") || "").trim().replace(/[\[\]]/g, "");
  const width = node.getAttribute("width");
  const height = node.getAttribute("height");
  if (width === "1" && height === "1") return "";
  if (!src || /medium\.com\/_\/stat/i.test(src) || /^data:/i.test(src)) return "";
  let url;
  try { url = new URL(src); } catch { return alt ? `[Image: ${alt}]\n` : ""; }
  if (url.protocol !== "https:" || url.username || url.password) return alt ? `[Image: ${alt}]\n` : "";
  // Prefer full-size Medium CDN variants when the feed ships a max/N path.
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
  return { title: String(data.title || "Untitled").slice(0, 180), author: String(data.author || "").slice(0, 120), kind: ["poetry","story","essay","other"].includes(data.kind) ? data.kind : "essay", body: data.body, collection: String(data.collection || "").slice(0, 80), theme: ["forest","clay","linen","night"].includes(data.theme) ? data.theme : "linen", ...(data.layout?{layout:data.layout}:{}),versionName:typeof data.versionName==="string"?data.versionName.slice(0,80):"", source: { key: String(data.key || hash(data.body)), platform: data.platform || "File", url: data.url || "", fetchedAt: new Date().toISOString(), original, hash: hash(data.body) } };
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
  const root = new XMLParser({ ignoreAttributes: false, processEntities: false, trimValues: false, parseTagValue: false }).parse(xml);
  let items = root.rss?.channel?.item || root.feed?.entry;
  if (!items) fail("No articles were found. Use the publication's RSS feed or import an export file.");
  if (!Array.isArray(items)) items = [items];
  return items.slice(0, 40).map(item => {
    let link = item.link;
    if (Array.isArray(link)) link = link.find(l => l["@_rel"] === "alternate") || link[0];
    const href = typeof link === "object" ? link?.["@_href"] : link;
    const content = string(item["content:encoded"] || item.content || item.description || item.summary);
    const platform = new URL(url).hostname.includes("medium") ? "Medium" : new URL(url).hostname.includes("substack") ? "Substack" : "RSS";
    return candidate({ title: htmlText(string(item.title)), author: string(item["dc:creator"]) || string(item.author?.name) || string(item.author), body: htmlText(content), original: content, url: /^https?:\/\//i.test(href) ? href : "", key: hash(url + "|" + (string(item.guid || item.id) || href || string(item.title))), platform });
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
export async function parseZip(base64) {
  const buffer = Buffer.from(base64, "base64");
  if (buffer.length > 3_000_000) fail("ZIP archives must be smaller than 3 MB.");
  const files = [];
  await new Promise((resolve, reject) => yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
    if (error) return reject(new Error("This ZIP archive could not be opened."));
    let count = 0, total = 0, stopped = false;
    const stop = error => { if (!stopped) { stopped = true; zip.close(); reject(error); } };
    zip.on("error", stop); zip.on("end", resolve);
    zip.on("entry", entry => {
      if (++count > 500 || entry.uncompressedSize > 3_000_000 || (total += entry.uncompressedSize) > 12_000_000) return stop(new Error("The expanded archive is too large. Import up to 40 smaller writings."));
      if (entry.fileName.includes("..") || entry.fileName.startsWith("/") || entry.fileName.includes("\\")) return stop(new Error("Unsafe file path in archive."));
      if (!/\.(html?|txt|md|json)$/i.test(entry.fileName) || /(^|\/)(__MACOSX|revisions|originals)\//.test(entry.fileName)) return zip.readEntry();
      zip.openReadStream(entry, (err, stream) => {
        if (err) return stop(err);
        const chunks = []; let size = 0;
        stream.on("data", c => { size += c.length; if (size > 3_000_000) { stream.destroy(); stop(new Error("An expanded file is too large.")); } else chunks.push(c); });
        stream.on("error", stop);
        stream.on("end", () => { if (!stopped) { files.push({ name: entry.fileName, text: Buffer.concat(chunks).toString("utf8") }); zip.readEntry(); } });
      });
    });
    zip.readEntry();
  }));
  const backup = files.find(f => /(^|\/)writes-library\.json$/i.test(f.name));
  if (backup) return parseFile(backup.name, backup.text);
  const writings = files.filter(f => !/(^|\/)(index|readme|manifest)\./i.test(f.name)).slice(0, 40).flatMap(f => parseFile(f.name, f.text));
  if (!writings.length) fail("No supported writing files were found in this archive.");
  return writings.slice(0, 40);
}
