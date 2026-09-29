import { isMap, isScalar, parseDocument, type Document, type Pair } from "yaml";

// ── YAML frontmatter ──────────────────────────────────────────────────────────
// Parsed with a real YAML parser: quoted scalars, lists, multi-line values and
// CRLF files all behave. Edits round-trip comments and key order.

// Templater-style frontmatter (`{{date:YYYY-MM-DD}}` keys) makes yaml warn on stderr; nothing
// here acts on those warnings, and an MCP stdio server should keep stderr for real problems.
const PARSE_OPTS = { logLevel: "error" as const };

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export interface Frontmatter {
  data: Record<string, unknown>;
  hasFrontmatter: boolean;
  eol: "\n" | "\r\n";
}

function eolOf(content: string): "\n" | "\r\n" {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

export function parseFrontmatter(content: string): Frontmatter {
  const eol = eolOf(content);
  const m = content.match(FENCE);
  if (!m) return { data: {}, hasFrontmatter: false, eol };
  const doc = parseDocument(m[1], PARSE_OPTS);
  const js: unknown = doc.errors.length ? {} : doc.toJS();
  const data =
    js && typeof js === "object" && !Array.isArray(js) ? (js as Record<string, unknown>) : {};
  return { data, hasFrontmatter: true, eol };
}

/** A frontmatter scalar as a trimmed non-empty string, else undefined. */
export function fmString(v: unknown): string | undefined {
  if (typeof v === "string") {
    const s = v.trim();
    return s === "" ? undefined : s;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

function edit(content: string, mutate: (doc: Document) => void): string {
  const m = content.match(FENCE);
  if (!m) throw new Error("no frontmatter found in file");
  const eol = eolOf(content);
  const doc = parseDocument(m[1], PARSE_OPTS);
  if (doc.errors.length) throw new Error(`Invalid frontmatter YAML: ${doc.errors[0].message}`);
  mutate(doc);
  const js = doc.toJS() as Record<string, unknown> | null;
  const empty = !js || Object.keys(js).length === 0;
  const yaml = empty ? "" : doc.toString({ lineWidth: 0 }).replace(/\n+$/, "");
  const block = `---${eol}${yaml.replace(/\n/g, eol)}${eol}---`;
  const tail = /\r?\n$/.test(m[0]) ? eol : "";
  return block + tail + content.slice(m[0].length);
}

/**
 * The top-level pair whose key reads as `key`. `toJS()` stringifies every key, so a
 * frontmatter `1:` or `true:` is reported as "1"/"true" — but `doc.set("1")` would
 * not match the numeric scalar and would add a duplicate. Look pairs up by text.
 */
function findPair(doc: Document, key: string): Pair | undefined {
  if (!isMap(doc.contents)) return undefined;
  return doc.contents.items.find((p) => {
    const k = isScalar(p.key) ? p.key.value : p.key;
    return String(k) === key;
  }) as Pair | undefined;
}

export function setFrontmatterKey(
  content: string,
  key: string,
  value: unknown,
  opts: { flow?: boolean } = {},
): string {
  return edit(content, (doc) => {
    const node = doc.createNode(value);
    if (opts.flow && Array.isArray(value)) (node as { flow?: boolean }).flow = true;
    const pair = findPair(doc, key);
    if (pair) pair.value = node;
    else doc.set(key, node);
  });
}

export function deleteFrontmatterKey(content: string, key: string): string {
  return edit(content, (doc) => {
    const pair = findPair(doc, key);
    if (pair && isMap(doc.contents)) {
      doc.contents.items.splice(doc.contents.items.indexOf(pair), 1);
    }
  });
}
