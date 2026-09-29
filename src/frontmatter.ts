import { parseDocument, type Document } from "yaml";

// ── YAML frontmatter ──────────────────────────────────────────────────────────
// Parsed with a real YAML parser: quoted scalars, lists, multi-line values and
// CRLF files all behave. Edits round-trip comments and key order.

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
  const doc = parseDocument(m[1]);
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
  const doc = parseDocument(m[1]);
  if (doc.errors.length) throw new Error(`Invalid frontmatter YAML: ${doc.errors[0].message}`);
  mutate(doc);
  const empty = doc.contents === null || (doc.toJS() as object | null) == null ||
    Object.keys(doc.toJS() as object).length === 0;
  const yaml = empty ? "" : doc.toString({ lineWidth: 0 }).replace(/\n+$/, "");
  const block = `---${eol}${yaml.replace(/\n/g, eol)}${eol}---`;
  const tail = /\r?\n$/.test(m[0]) ? eol : "";
  return block + tail + content.slice(m[0].length);
}

export function setFrontmatterKey(
  content: string,
  key: string,
  value: unknown,
  opts: { flow?: boolean } = {},
): string {
  return edit(content, (doc) => {
    if (opts.flow && Array.isArray(value)) {
      const node = doc.createNode(value);
      (node as { flow?: boolean }).flow = true;
      doc.set(key, node);
    } else {
      doc.set(key, value);
    }
  });
}

export function deleteFrontmatterKey(content: string, key: string): string {
  return edit(content, (doc) => {
    doc.delete(key);
  });
}
