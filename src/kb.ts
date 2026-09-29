import Database from "better-sqlite3";
import { readFileSync, statSync, existsSync, mkdirSync, readdirSync } from "fs";
import { homedir } from "os";
import { join, dirname, relative, sep, basename } from "path";
import { buildMatchExpr, buildPhraseMatchExpr } from "./fts.js";
import { parseFrontmatter, fmString } from "./frontmatter.js";

export { buildMatchExpr };

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
  /** Legacy ~/.claude/memory/<TICKET>/session_index.db dirs — no longer read, never deleted. */
  legacySessionDirs: number;
}

export interface SessionHit {
  path: string;
  ticket: string;
  date: string;
  heading_path: string;
  snippet: string;
  score: number;
}

/** Bump when the derived tables change shape; a mismatch forces one full rebuild. */
const SCHEMA_VERSION = "2";

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
    CREATE TABLE IF NOT EXISTS kb_note_meta (
      path TEXT PRIMARY KEY, ticket TEXT, type TEXT, date TEXT, project TEXT
    );
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

const ID_IN_NAME = /(?:^|-)([A-Za-z][A-Za-z0-9]+-\d+)/;
const ID_LIKE = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

/** Normalise a ticket so quoted / lower-case forms compare equal. */
export function normTicket(t: string): string {
  const s = t.trim();
  return ID_LIKE.test(s) ? s.toUpperCase() : s;
}

export interface NoteMeta {
  ticket: string;
  type: string;
  date: string;
  project: string;
}

/**
 * Per-note metadata. Ticket resolution never yields an empty value or GENERAL:
 * frontmatter ticket → id in the filename → frontmatter project → filename stem.
 */
export function noteMeta(relpath: string, content: string): NoteMeta {
  const { data } = parseFrontmatter(content);
  const stem = basename(relpath, ".md");
  const fromName = stem.match(ID_IN_NAME)?.[1];
  const ticket = normTicket(
    fmString(data.ticket) ?? fromName ?? fmString(data.project) ?? stem,
  );
  return {
    ticket,
    type: fmString(data.type) ?? "",
    date: fmString(data.date) ?? "",
    project: fmString(data.project) ?? "",
  };
}

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
  const m = noteMeta(relpath, content);
  db.prepare(
    "INSERT OR REPLACE INTO kb_note_meta (path, ticket, type, date, project) VALUES (?, ?, ?, ?, ?)",
  ).run(relpath, m.ticket, m.type, m.date, m.project);
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
  const summary: ReindexSummary = {
    indexed: 0,
    skipped: 0,
    removed: 0,
    chunks: 0,
    legacySessionDirs: countLegacySessionDirs(),
  };
  const stored = db.prepare("SELECT v FROM kb_meta WHERE k = 'schema_version'").get() as
    | { v: string }
    | undefined;
  const force = opts.force || stored?.v !== SCHEMA_VERSION;

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
        if (!force && prev === f.mtime) {
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
          db.prepare("DELETE FROM kb_note_meta WHERE path = ?").run(path);
          summary.removed++;
        }
      }
      db.prepare("INSERT OR REPLACE INTO kb_meta (k, v) VALUES ('last_build', ?)").run(
        String(Date.now()),
      );
      db.prepare("INSERT OR REPLACE INTO kb_meta (k, v) VALUES ('schema_version', ?)").run(
        SCHEMA_VERSION,
      );
    });
    tx();
    return summary;
  } finally {
    db.close();
  }
}

// ── Query ───────────────────────────────────────────────────────────────────

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


// ── Legacy + maintenance helpers ──────────────────────────────────────────────

function countLegacySessionDirs(): number {
  const root = join(homedir(), ".claude", "memory");
  if (!existsSync(root)) return 0;
  try {
    return readdirSync(root, { withFileTypes: true }).filter(
      (d) => d.isDirectory() && existsSync(join(root, d.name, "session_index.db")),
    ).length;
  } catch {
    return 0;
  }
}

/** Drop a note from every derived table (delete / move-away). */
export function removeVaultFile(relpath: string): void {
  const db = openKbDb();
  try {
    db.prepare("DELETE FROM kb WHERE source_relpath = ?").run(relpath);
    db.prepare("DELETE FROM kb_files WHERE path = ?").run(relpath);
    db.prepare("DELETE FROM kb_note_meta WHERE path = ?").run(relpath);
  } finally {
    db.close();
  }
}

// ── Session search ────────────────────────────────────────────────────────────

function sessionPrefixes(): string[] {
  const raw = process.env.CI_SESSION_PREFIXES ?? "02-Notes/Sessions/,wiki/tasks/";
  return raw.split(",").map((p) => p.trim()).filter(Boolean);
}

export interface SessionSearchOpts {
  ticket?: string;
  sections?: string[];
  limit?: number;
}

/**
 * BM25 search restricted to session notes (frontmatter `type: session` or a
 * session path prefix), globally ranked over one corpus. With `sections`, only
 * chunks under a matching heading are returned (one hit per chunk); otherwise
 * hits are deduped to the best chunk per note.
 */
export function searchSessionsKb(query: string, opts: SessionSearchOpts = {}): SessionHit[] {
  const limit = opts.limit ?? 5;
  const dbPath = getKbDbPath();
  if (!existsSync(dbPath)) {
    throw new Error(`KB index not built: ${dbPath} — run reindex_kb`);
  }
  const match = buildPhraseMatchExpr(query);
  if (!match) return [];

  const prefixes = sessionPrefixes();
  const params: Array<string | number> = [match];
  const scope = ["m.type = 'session'"];
  for (const p of prefixes) {
    scope.push("substr(m.path, 1, ?) = ?");
    params.push(p.length, p);
  }
  let where = `kb MATCH ? AND (${scope.join(" OR ")})`;

  const ticket = opts.ticket && opts.ticket !== "all" ? normTicket(opts.ticket) : undefined;
  if (ticket) {
    where += " AND m.ticket = ? COLLATE NOCASE";
    params.push(ticket);
  }
  const sections = (opts.sections ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (sections.length > 0) {
    where += ` AND (${sections.map(() => "kb.heading_path LIKE ?").join(" OR ")})`;
    for (const s of sections) params.push(`%${s}%`);
  }
  params.push(limit * (sections.length > 0 ? 20 : 5));

  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT kb.source_relpath AS path, m.ticket AS ticket, m.date AS date,
                kb.heading_path AS heading_path,
                snippet(kb, 0, '**', '**', '...', 64) AS snippet,
                bm25(kb) AS score, f.mtime AS mtime
         FROM kb
         JOIN kb_note_meta m ON m.path = kb.source_relpath
         LEFT JOIN kb_files f ON f.path = kb.source_relpath
         WHERE ${where}
         ORDER BY score LIMIT ?`,
      )
      .all(...params) as Array<SessionHit & { mtime: number | null }>;

    const seen = new Set<string>();
    const out: SessionHit[] = [];
    for (const r of rows) {
      if (sections.length > 0) {
        const segs = r.heading_path.split(" > ").map((s) => s.trim().toLowerCase());
        if (!segs.some((seg) => sections.includes(seg))) continue;
      } else {
        if (seen.has(r.path)) continue;
        seen.add(r.path);
      }
      out.push({
        path: r.path,
        ticket: r.ticket,
        date: r.date || (r.mtime ? new Date(r.mtime).toISOString().slice(0, 10) : ""),
        heading_path: r.heading_path,
        snippet: r.snippet,
        score: r.score,
      });
      if (out.length >= limit) break;
    }
    return out;
  } catch (err) {
    throw new Error(`FTS5 query error: ${(err as Error).message}`);
  } finally {
    db.close();
  }
}

// ── Related-work discovery ────────────────────────────────────────────────────

const RELATED_FOLDERS = [
  "02-Notes/Sessions/",
  "02-Notes/Plans/",
  "02-Notes/Reports/",
  "02-Notes/Tasks/",
  "02-Notes/Wiki/",
];

export interface RelatedWorkOpts {
  project?: string;
  ticket?: string;
  keywords?: string[];
  folders?: string[];
  limit?: number;
}

export interface RelatedItem {
  wikilink: string;
  path: string;
  folder: string;
  date: string;
  why: string;
  score: number;
}

/** Vault-relative paths of every indexed note. Throws when the index is not built. */
export function listIndexedPaths(): string[] {
  const dbPath = getKbDbPath();
  if (!existsSync(dbPath)) throw new Error(`KB index not built: ${dbPath} — run reindex_kb`);
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare("SELECT path FROM kb_files").all() as Array<{ path: string }>).map(
      (r) => r.path,
    );
  } finally {
    db.close();
  }
}

/**
 * One ranked, deduped search across the notes folders for a project code, ticket
 * and keywords. Notes whose frontmatter ticket equals `ticket` are boosted above
 * notes that merely mention it.
 */
export function findRelatedWork(opts: RelatedWorkOpts): RelatedItem[] {
  const limit = opts.limit ?? 5;
  const terms = [opts.ticket, opts.project, ...(opts.keywords ?? [])].filter(
    (t): t is string => !!t && t.trim() !== "",
  );
  if (terms.length === 0) {
    throw new Error("find_related_work needs at least one of project, ticket, keywords");
  }
  const dbPath = getKbDbPath();
  if (!existsSync(dbPath)) throw new Error(`KB index not built: ${dbPath} — run reindex_kb`);
  const match = buildPhraseMatchExpr(terms.join(" "));
  if (!match) return [];

  const folders = opts.folders && opts.folders.length > 0 ? opts.folders : RELATED_FOLDERS;
  const params: Array<string | number> = [];
  let boost = "0";
  if (opts.ticket) {
    boost = "CASE WHEN m.ticket = ? COLLATE NOCASE THEN 5 ELSE 0 END";
    params.push(normTicket(opts.ticket));
  }
  params.push(match);
  const scope: string[] = [];
  for (const f of folders) {
    scope.push("substr(m.path, 1, ?) = ?");
    params.push(f.length, f);
  }
  params.push(limit * 8);

  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT kb.source_relpath AS path, m.date AS date, kb.heading_path AS heading_path,
                snippet(kb, 0, '', '', '...', 32) AS snippet,
                bm25(kb) - (${boost}) AS score, f.mtime AS mtime
         FROM kb
         JOIN kb_note_meta m ON m.path = kb.source_relpath
         LEFT JOIN kb_files f ON f.path = kb.source_relpath
         WHERE kb MATCH ? AND (${scope.join(" OR ")})
         ORDER BY score, f.mtime DESC LIMIT ?`,
      )
      .all(...params) as Array<{
      path: string;
      date: string;
      heading_path: string;
      snippet: string;
      score: number;
      mtime: number | null;
    }>;

    const seen = new Set<string>();
    const out: RelatedItem[] = [];
    for (const r of rows) {
      if (seen.has(r.path)) continue;
      seen.add(r.path);
      const why = `${r.heading_path ? r.heading_path + ": " : ""}${r.snippet}`.replace(/\s+/g, " ").trim();
      out.push({
        wikilink: `[[${basename(r.path, ".md")}]]`,
        path: r.path,
        folder: dirname(r.path),
        date: r.date || (r.mtime ? new Date(r.mtime).toISOString().slice(0, 10) : ""),
        why: why.length > 200 ? why.slice(0, 197) + "..." : why,
        score: r.score,
      });
      if (out.length >= limit) break;
    }
    return out;
  } catch (err) {
    throw new Error(`FTS5 query error: ${(err as Error).message}`);
  } finally {
    db.close();
  }
}
