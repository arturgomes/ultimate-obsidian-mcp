import Database from "better-sqlite3";
import { readFileSync, statSync, existsSync, mkdirSync, readdirSync } from "fs";
import { homedir } from "os";
import { join, dirname, relative, sep } from "path";

// ── Portable FTS5 knowledge-base index ────────────────────────────────────────
// Source of truth = the markdown vault (in git). This index is a DERIVED, local,
// gitignored artifact — a pure deterministic function of the markdown, rebuilt
// locally on each machine. No embedding model, no vectors → identical everywhere.

export interface KbHit {
  text: string;
  source_relpath: string;
  heading_path: string;
  domain: string;
  score: number; // bm25(): lower = more relevant
}

export interface ReindexSummary {
  indexed: number;
  skipped: number;
  removed: number;
  chunks: number;
}

const DEFAULT_VAULT = "/Users/artur/Documents/Obsidian-Vault";
const SKIP_DIRS = new Set([".obsidian", ".trash", ".git", "node_modules"]);
const MAX_CHUNK = 1800; // chars; large heading bodies are split to keep hits focused

export function getVaultRoot(): string {
  return process.env.OBSIDIAN_VAULT_PATH ?? DEFAULT_VAULT;
}

/**
 * Path-substring globs (comma-separated, from CI_KB_EXCLUDE) whose files are
 * kept out of the index. Vault-specific scoping lives here in config, not in the
 * engine — e.g. "/markdown/" skips raw book-text mirrors and indexes only the
 * distilled cards, cutting index size ~4x with better precision.
 */
function getExcludes(): string[] {
  return (process.env.CI_KB_EXCLUDE ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function isExcluded(relpath: string, excludes: string[]): boolean {
  const posix = relpath.split(sep).join("/");
  return excludes.some((e) => posix.includes(e));
}

function getKbDbPath(): string {
  const custom = process.env.CI_KB_INDEX;
  if (custom) {
    mkdirSync(dirname(custom), { recursive: true });
    return custom;
  }
  const dir = join(homedir(), ".claude", "kb");
  mkdirSync(dir, { recursive: true });
  return join(dir, "kb_index.db");
}

function openKbDb(dbPath = getKbDbPath()): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS kb USING fts5(
      text,
      source_relpath UNINDEXED,
      heading_path UNINDEXED,
      domain UNINDEXED
    );
    CREATE TABLE IF NOT EXISTS kb_files (path TEXT PRIMARY KEY, mtime INTEGER);
    CREATE TABLE IF NOT EXISTS kb_meta  (k TEXT PRIMARY KEY, v TEXT);
  `);
  return db;
}

// ── Markdown → heading-scoped chunks ──────────────────────────────────────────

interface Chunk {
  text: string;
  heading_path: string;
}

function stripFrontmatter(content: string): string {
  const m = content.match(/^---\n[\s\S]*?\n---\n?/);
  return m ? content.slice(m[0].length) : content;
}

function chunkByHeading(content: string): Chunk[] {
  const body = stripFrontmatter(content);
  const lines = body.split("\n");
  const stack: string[] = []; // heading breadcrumb by level
  let buf: string[] = [];
  let currentPath = "";
  const chunks: Chunk[] = [];

  const flush = () => {
    const text = buf.join("\n").trim();
    if (text) pushSplit(chunks, text, currentPath);
    buf = [];
  };

  for (const line of lines) {
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flush();
      const level = h[1].length;
      stack.length = level - 1;
      stack[level - 1] = h[2].trim();
      currentPath = stack.filter(Boolean).join(" > ");
      buf.push(line);
    } else {
      buf.push(line);
    }
  }
  flush();
  return chunks;
}

function pushSplit(out: Chunk[], text: string, heading_path: string): void {
  if (text.length <= MAX_CHUNK) {
    out.push({ text, heading_path });
    return;
  }
  // Split oversized sections on paragraph boundaries, keeping the heading_path.
  const paras = text.split(/\n\s*\n/);
  let acc = "";
  for (const p of paras) {
    if (acc && acc.length + p.length > MAX_CHUNK) {
      out.push({ text: acc.trim(), heading_path });
      acc = "";
    }
    acc += (acc ? "\n\n" : "") + p;
  }
  if (acc.trim()) out.push({ text: acc.trim(), heading_path });
}

function domainOf(relpath: string): string {
  const first = relpath.split(sep)[0];
  return first || "root";
}

// ── Filesystem walk ───────────────────────────────────────────────────────────

interface VaultFile {
  relpath: string;
  abspath: string;
  mtime: number;
}

function walkVault(root: string): VaultFile[] {
  const out: VaultFile[] = [];
  const excludes = getExcludes();
  const recurse = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        recurse(full);
      } else if (e.isFile() && e.name.endsWith(".md")) {
        const relpath = relative(root, full);
        if (isExcluded(relpath, excludes)) continue;
        out.push({ relpath, abspath: full, mtime: Math.floor(statSync(full).mtimeMs) });
      }
    }
  };
  recurse(root);
  return out;
}

// ── Indexing ──────────────────────────────────────────────────────────────────

function indexFileInto(db: Database.Database, root: string, abspath: string, mtime: number): number {
  const relpath = relative(root, abspath);
  const domain = domainOf(relpath);
  const content = readFileSync(abspath, "utf8");
  const chunks = chunkByHeading(content);

  db.prepare("DELETE FROM kb WHERE source_relpath = ?").run(relpath);
  const ins = db.prepare(
    "INSERT INTO kb (text, source_relpath, heading_path, domain) VALUES (?, ?, ?, ?)",
  );
  for (const c of chunks) ins.run(c.text, relpath, c.heading_path, domain);
  db.prepare("INSERT OR REPLACE INTO kb_files (path, mtime) VALUES (?, ?)").run(relpath, mtime);
  return chunks.length;
}

/** Index (or re-index) a single vault file by absolute path. Used for self-index-on-write. */
export function indexVaultFile(abspath: string): string {
  if (!existsSync(abspath)) throw new Error(`File not found: ${abspath}`);
  const root = getVaultRoot();
  const relpath = relative(root, abspath);
  if (isExcluded(relpath, getExcludes())) return `Skipped (excluded): ${relpath}`;
  const db = openKbDb();
  try {
    const mtime = Math.floor(statSync(abspath).mtimeMs);
    const n = indexFileInto(db, root, abspath, mtime);
    db.prepare("INSERT OR REPLACE INTO kb_meta (k, v) VALUES ('last_build', ?)").run(
      String(mtime),
    );
    return `Indexed ${relative(root, abspath)} → ${n} chunk(s)`;
  } finally {
    db.close();
  }
}

/**
 * Incremental reindex of the whole vault. Only files whose mtime changed are
 * re-chunked; deleted files are pruned. `force` rebuilds every file. Cheap even
 * on a cold cache — a few thousand stat() calls plus work only on the delta.
 */
export function reindexVault(opts: { force?: boolean } = {}): ReindexSummary {
  const root = getVaultRoot();
  if (!existsSync(root)) throw new Error(`Vault root not found: ${root} (set OBSIDIAN_VAULT_PATH)`);
  const db = openKbDb();
  const summary: ReindexSummary = { indexed: 0, skipped: 0, removed: 0, chunks: 0 };

  try {
    const files = walkVault(root);
    const known = new Map<string, number>();
    for (const row of db.prepare("SELECT path, mtime FROM kb_files").all() as Array<{
      path: string;
      mtime: number;
    }>) {
      known.set(row.path, row.mtime);
    }
    const onDisk = new Set(files.map((f) => f.relpath));

    const tx = db.transaction(() => {
      for (const f of files) {
        const prev = known.get(f.relpath);
        if (!opts.force && prev === f.mtime) {
          summary.skipped++;
          continue;
        }
        summary.chunks += indexFileInto(db, root, f.abspath, f.mtime);
        summary.indexed++;
      }
      // prune deleted files
      for (const path of known.keys()) {
        if (!onDisk.has(path)) {
          db.prepare("DELETE FROM kb WHERE source_relpath = ?").run(path);
          db.prepare("DELETE FROM kb_files WHERE path = ?").run(path);
          summary.removed++;
        }
      }
      db.prepare("INSERT OR REPLACE INTO kb_meta (k, v) VALUES ('last_build', ?)").run(
        String(Date.now()),
      );
    });
    tx();
    return summary;
  } finally {
    db.close();
  }
}

// ── Query ───────────────────────────────────────────────────────────────────

/**
 * Turn a natural-language question (or an expanded synonym list) into a safe
 * FTS5 MATCH expression: strip punctuation, drop stopwords, OR the terms, and
 * prefix-match longer tokens so retry/retries/retrying all hit. Ranking still
 * favours chunks matching more terms (BM25).
 */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "what", "how", "does",
  "should", "would", "could", "are", "was", "were", "our", "your", "when",
  "which", "into", "about", "can", "will", "have", "has", "not", "you",
]);

export function buildMatchExpr(query: string): string {
  const tokens = (query.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []).filter(
    (t) => !STOPWORDS.has(t),
  );
  const uniq = [...new Set(tokens)];
  if (uniq.length === 0) return "";
  return uniq.map((t) => (t.length >= 4 ? `${t}*` : t)).join(" OR ");
}

export function searchKb(query: string, limit = 6): KbHit[] {
  const dbPath = getKbDbPath();
  if (!existsSync(dbPath)) {
    throw new Error(`KB index not built: ${dbPath} — run reindex_kb`);
  }
  const match = buildMatchExpr(query);
  if (!match) return [];

  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT text, source_relpath, heading_path, domain, bm25(kb) AS score
         FROM kb WHERE kb MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(match, limit) as KbHit[];
    return rows;
  } catch (err) {
    throw new Error(`FTS5 query error: ${(err as Error).message}`);
  } finally {
    db.close();
  }
}
