/** Stable bibliography category ids; labels are user-editable without reassigning works. */
export const DEFAULT_BIBLIOGRAPHY_CATEGORIES = [
  { id: "blog", label: "Blog", hint: "Posts and ongoing publication writing" },
  { id: "poetry", label: "Poetry", hint: "" },
  { id: "scholarly", label: "Scholarly papers", hint: "Research, formal papers, citations" },
  { id: "essay", label: "Essays", hint: "Nonfiction reflections and commentary" },
  { id: "story", label: "Stories", hint: "Narrative or fiction (rename to Fiction if you prefer)" },
  { id: "speech", label: "Speeches", hint: "" },
  { id: "interview", label: "News interviews", hint: "Press, Q&A, reported conversations" },
];

const KIND_TO_CATEGORY = {
  poetry: "poetry",
  story: "story",
  essay: "essay",
  other: "blog",
};

export function defaultCategories() {
  return DEFAULT_BIBLIOGRAPHY_CATEGORIES.map(c => ({ ...c }));
}

export function normalizeCategories(input) {
  const defaults = defaultCategories();
  if (!Array.isArray(input) || !input.length) return defaults;
  const byId = new Map(defaults.map(c => [c.id, { ...c }]));
  for (const row of input) {
    const id = String(row?.id || "").trim();
    if (!byId.has(id)) continue;
    const label = String(row.label || "").trim().slice(0, 60);
    const hint = String(row.hint ?? byId.get(id).hint ?? "").slice(0, 120);
    if (label) byId.set(id, { id, label, hint });
  }
  // Preserve default order; keep only known ids so renames never invent orphan keys.
  return defaults.map(d => byId.get(d.id));
}

export function categoryIdFromKind(kind) {
  return KIND_TO_CATEGORY[kind] || "blog";
}

/** Infer a bibliography category for imports when possible. */
export function inferCategoryId({ kind, title = "", platform = "", collection = "" } = {}) {
  const hay = `${title} ${collection} ${platform}`.toLowerCase();
  if (/\b(interview|q&a|q & a)\b/.test(hay)) return "interview";
  if (/\b(speech|keynote|remarks|testimony)\b/.test(hay)) return "speech";
  if (/\b(paper|journal|doi|scholarly|abstract)\b/.test(hay)) return "scholarly";
  if (kind && KIND_TO_CATEGORY[kind]) return KIND_TO_CATEGORY[kind];
  if (/substack|medium|blog|newsletter/i.test(platform) || /newsletter/i.test(collection)) return "blog";
  return categoryIdFromKind(kind || "essay");
}

export function labelForCategory(categories, id) {
  const list = normalizeCategories(categories);
  return list.find(c => c.id === id)?.label || list.find(c => c.id === "blog")?.label || "Blog";
}

function titleCaseHost(raw) {
  return String(raw || "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
}

/** Normalize a date field to YYYY-MM-DD (or "") for bibliography editing. */
export function normalizeDateField(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

/**
 * Infer venue label + homepage from import platform / URL.
 * Known pubs: Farmapper, Maisa Space, Medium, Substack custom domains.
 */
export function inferVenue({ platform = "", url = "", collection = "" } = {}) {
  const p = String(platform || "").trim();
  const u = String(url || "").trim();
  const col = String(collection || "").trim();
  let venueUrl = "";
  try {
    const parsed = new URL(u);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      venueUrl = parsed.origin + "/";
    }
  } catch { /* keep empty */ }

  const hay = `${u} ${col} ${p}`.toLowerCase();
  if (/farmapper/.test(hay)) {
    return { venue: "Farmapper", venueUrl: venueUrl || "https://www.blog.farmapper.com/" };
  }
  if (/maisaspace|maisa.?space/.test(hay)) {
    return { venue: "Maisa Space", venueUrl: venueUrl || "https://blog.maisaspace.org/" };
  }
  if (/medium\.com/.test(hay) || /^medium$/i.test(p)) {
    return { venue: "Medium", venueUrl: venueUrl || (u.startsWith("http") ? u : "https://medium.com/") };
  }
  if (/google\s*docs/i.test(p) || /docs\.google\.com/.test(hay)) {
    return { venue: "Google Docs", venueUrl: u.startsWith("http") ? u.slice(0, 2000) : venueUrl };
  }
  try {
    const host = new URL(u).hostname.replace(/^www\./i, "");
    if (host.endsWith(".substack.com")) {
      const sub = host.slice(0, -".substack.com".length);
      return { venue: sub ? titleCaseHost(sub) : "Substack", venueUrl: venueUrl || `https://${host}/` };
    }
    if (host && (/substack/i.test(p) || /\/p\//.test(u))) {
      const label = titleCaseHost(host.split(".")[0] || host);
      return { venue: label || "Substack", venueUrl: venueUrl || `https://${host}/` };
    }
  } catch { /* fall through */ }
  if (/substack/i.test(p)) return { venue: "Substack", venueUrl };
  if (p && !/^file$/i.test(p) && !/^pasted/i.test(p)) {
    return { venue: p.replace(/\s+export$/i, "").trim().slice(0, 120), venueUrl: venueUrl || u.slice(0, 2000) };
  }
  return { venue: "", venueUrl: venueUrl || "" };
}

/** Resolve editable biblio fields, preferring stored values then import metadata. */
export function resolveBiblioFields(work = {}) {
  const source = work.source || {};
  const inferred = inferVenue({
    platform: source.platform || work.platform || "",
    url: work.venueUrl || source.url || "",
    collection: work.collection || "",
  });
  const publishedAt = normalizeDateField(work.publishedAt) || normalizeDateField(source.publishedAt) || "";
  const writtenAt = normalizeDateField(work.writtenAt) || "";
  const venue = String(work.venue || "").trim() || inferred.venue;
  const venueUrl = String(work.venueUrl || "").trim()
    || (source.url && /^https?:/i.test(source.url) ? source.url : "")
    || inferred.venueUrl
    || "";
  return {
    publishedAt,
    writtenAt,
    venue: venue.slice(0, 120),
    venueUrl: venueUrl.slice(0, 2000),
  };
}

/** Sort key for CV-style lists: newest published first, then title. */
export function bibliographySort(a, b) {
  const da = normalizeDateField(a.publishedAt || a.writtenAt) || "";
  const db = normalizeDateField(b.publishedAt || b.writtenAt) || "";
  if (da && db && da !== db) return db.localeCompare(da);
  if (da && !db) return -1;
  if (!da && db) return 1;
  return String(a.title || "").localeCompare(String(b.title || ""));
}
