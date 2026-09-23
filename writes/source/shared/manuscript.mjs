/** Markdown image markers written by HTML→text import for HTTPS feed images. */
export const IMAGE_MD_RE = /!\[([^\]]*)\]\((https:\/\/[^)\s]+)\)/g;

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
