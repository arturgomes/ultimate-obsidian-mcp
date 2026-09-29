import { basename } from "path";
import { listIndexedPaths } from "./kb.js";

// ── Typed-relation link check ─────────────────────────────────────────────────
// The knowledge-graph ontology's relation keys must point at notes that exist; a
// dangling edge fails the vault's own graph gate. This checks them at write time.

export const RELATION_KEYS = ["up", "documents", "implements", "affects", "related"] as const;

export interface TypedLink {
  key: string;
  target: string;
}

export interface LinkResult extends TypedLink {
  resolved: boolean;
  path?: string;
}

function clean(t: string): string {
  return t.split("|")[0].split("#")[0].trim();
}

/** Wikilink targets in a value (empty `[[]]` kept so it is reported); a bare string counts as one target. */
function targetsOf(value: string): string[] {
  const wiki = [...value.matchAll(/\[\[([^\]]*)\]\]/g)];
  if (wiki.length > 0) return wiki.map((m) => clean(m[1]));
  const bare = clean(value);
  return bare ? [bare] : [];
}

/** Every link target under the typed relation keys, in key order. */
export function extractTypedLinks(data: Record<string, unknown>): TypedLink[] {
  const out: TypedLink[] = [];
  for (const key of RELATION_KEYS) {
    const v = data[key];
    const values = Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
    for (const item of values) {
      if (typeof item !== "string") continue;
      for (const target of targetsOf(item)) out.push({ key, target });
    }
  }
  return out;
}

/** Resolve link targets against the indexed vault: exact path (with or without .md) or unique-ish basename. */
export function resolveLinks(links: TypedLink[]): LinkResult[] {
  const paths = listIndexedPaths();
  const byPath = new Map(paths.map((p) => [p.toLowerCase(), p]));
  const byStem = new Map<string, string>();
  for (const p of paths) {
    const stem = basename(p, ".md").toLowerCase();
    if (!byStem.has(stem)) byStem.set(stem, p);
  }
  return links.map((l) => {
    const t = l.target.replace(/^\/+/, "").replace(/\.md$/i, "").toLowerCase();
    if (!t || t === "undefined" || t === "null") return { ...l, resolved: false };
    const hit = t.includes("/") ? byPath.get(`${t}.md`) : byStem.get(t);
    return hit ? { ...l, resolved: true, path: hit } : { ...l, resolved: false };
  });
}
