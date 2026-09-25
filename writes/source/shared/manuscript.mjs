/** Markdown image markers written by HTML→text import for HTTPS feed images. */
export const IMAGE_MD_RE = /!\[([^\]]*)\]\((https:\/\/[^)\s]+)\)/g;

export function firstImageUrl(text = "") {
  const match = IMAGE_MD_RE.exec(String(text));
  IMAGE_MD_RE.lastIndex = 0;
  return match ? match[2] : "";
}

/** First public HTTPS image from raw HTML (RSS content:encoded / Substack export). */
export function firstImageUrlFromHtml(html = "") {
  const input = String(html || "");
  if (!input.includes("<")) return "";
  // Substack often puts the durable CDN URL in data-attrs JSON.
  for (const match of input.matchAll(/data-attrs=(["'])(.*?)\1/gi)) {
    try {
      const attrs = JSON.parse(match[2].replace(/&quot;/g, '"').replace(/&#39;/g, "'"));
      const src = typeof attrs?.src === "string" ? attrs.src.trim() : "";
      if (/^https:\/\//i.test(src) && !/medium\.com\/_\/stat/i.test(src)) return src;
    } catch { /* keep scanning */ }
  }
  for (const match of input.matchAll(/<img\b[^>]*\bsrc=(["'])(.*?)\1[^>]*>/gi)) {
    const tag = match[0];
    const src = (match[2] || "").trim();
    if (/width\s*=\s*["']?1["']?/i.test(tag) && /height\s*=\s*["']?1["']?/i.test(tag)) continue;
    if (!src || /^data:/i.test(src) || /medium\.com\/_\/stat/i.test(src)) continue;
    if (/^https:\/\//i.test(src)) return src;
  }
  return "";
}

export function normalizeCanonicalUrl(input) {
  if (!input || typeof input !== "string") return "";
  try {
    const url = new URL(input.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    url.protocol = "https:";
    url.hash = "";
    url.search = "";
    url.hostname = url.hostname.toLowerCase();
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return "";
  }
}

/** Prefer stored cover, then markdown body, then original HTML (covers [Image]-only bodies). */
export function coverFromWork(work = {}) {
  const stored = String(work.coverUrl || "").trim();
  if (/^https:\/\//i.test(stored)) return stored;
  return firstImageUrl(work.body) || firstImageUrlFromHtml(work.source?.original) || "";
}

export function splitManuscript(text = "") {
  const parts = [];
  let last = 0;
  for (const match of String(text).matchAll(IMAGE_MD_RE)) {
    if (match.index > last) parts.push({ type: "text", value: text.slice(last, match.index) });
    parts.push({ type: "image", alt: match[1], src: match[2] });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ type: "text", value: text.slice(last) });
  return parts.length ? parts : [{ type: "text", value: text }];
}

/** Escape text for HTML export; turn image markers into safe <img> tags. */
export function htmlFromManuscript(text, esc) {
  return splitManuscript(text).map(part => {
    if (part.type === "image") {
      return `<img class="manuscript-image" src="${esc(part.src)}" alt="${esc(part.alt)}" loading="lazy" referrerpolicy="no-referrer">`;
    }
    return `<pre>${esc(part.value)}</pre>`;
  }).join("");
}
