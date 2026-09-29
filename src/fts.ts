// ── FTS5 query construction ───────────────────────────────────────────────────
// Every string that reaches an FTS5 MATCH must come through here: raw user text
// treats `-`, `/`, quotes and parentheses as syntax and throws.

export const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "what", "how", "does",
  "should", "would", "could", "are", "was", "were", "our", "your", "when",
  "which", "into", "about", "can", "will", "have", "has", "not", "you",
]);

const TOKEN = /[a-z0-9]{2,}/g;

function starred(t: string): string {
  return t.length >= 4 ? `${t}*` : t;
}

/**
 * Natural-language question → safe FTS5 expression: strip punctuation, drop
 * stopwords, OR the terms, prefix-match longer tokens.
 */
export function buildMatchExpr(query: string): string {
  const tokens = (query.toLowerCase().match(TOKEN) ?? []).filter((t) => !STOPWORDS.has(t));
  const uniq = [...new Set(tokens)];
  if (uniq.length === 0) return "";
  return uniq.map(starred).join(" OR ");
}

/**
 * Like buildMatchExpr, but a whitespace-delimited term that contains separators
 * (`SEATHQ-9999`, `02-Notes/Sessions`) becomes one quoted phrase of its parts, so
 * an id matches as an id instead of as loose words. Never throws.
 */
export function buildPhraseMatchExpr(query: string): string {
  const out: string[] = [];
  for (const raw of query.split(/\s+/).filter(Boolean)) {
    const parts = (raw.toLowerCase().match(TOKEN) ?? []).filter((t) => !STOPWORDS.has(t));
    if (parts.length === 0) continue;
    if (parts.length >= 2 && /[^A-Za-z0-9]/.test(raw)) out.push(`"${parts.join(" ")}"`);
    else for (const p of parts) out.push(starred(p));
  }
  return [...new Set(out)].join(" OR ");
}
