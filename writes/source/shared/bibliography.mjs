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
