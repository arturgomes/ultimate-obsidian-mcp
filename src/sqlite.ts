import Database from "better-sqlite3";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";

export interface SessionSearchResult {
  title: string;
  date: string;
  snippet: string;
  vaultPath: string;
}

const MEMORY_ROOT = join(homedir(), ".claude", "memory");

function getDbPath(ticket: string): string {
  const dir = join(MEMORY_ROOT, ticket);
  mkdirSync(dir, { recursive: true });
  return join(dir, "session_index.db");
}

function openDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS sessions USING fts5(
      title, content, keywords, tags, date, vault_path
    )
  `);
  return db;
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fm: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    fm[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return fm;
}

function extractKeywords(content: string, topN = 10): string[] {
  // Simple TF-based extraction — good enough without rank_bm25 pip dep
  const tokens = content.toLowerCase().match(/\b[a-z]{4,}\b/g) ?? [];
  const stopwords = new Set([
    "this", "that", "with", "from", "have", "been", "were", "will",
    "when", "what", "where", "which", "should", "would", "could",
    "than", "then", "they", "them", "their", "into", "also", "just",
  ]);
  const freq: Record<string, number> = {};
  for (const t of tokens) {
    if (!stopwords.has(t)) freq[t] = (freq[t] ?? 0) + 1;
  }
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([w]) => w);
}

function updateFrontmatterKeywords(filePath: string, keywords: string[]): void {
  let content = readFileSync(filePath, "utf8");
  const kwLine = `keywords: [${keywords.join(", ")}]`;
  if (/keywords:\s*\[.*?\]/.test(content)) {
    content = content.replace(/keywords:\s*\[.*?\]/, kwLine);
  } else {
    content = content.replace(/^(---\n[\s\S]*?)(---)/m, `$1${kwLine}\n$2`);
  }
  writeFileSync(filePath, content, "utf8");
}

export function indexNote(vaultPath: string): string {
  if (!existsSync(vaultPath)) throw new Error(`File not found: ${vaultPath}`);

  const content = readFileSync(vaultPath, "utf8");
  const fm = parseFrontmatter(content);
  const ticket = fm["ticket"] ?? "GENERAL";
  const branch = fm["branch"] ?? "unknown";
  const date = fm["date"] ?? new Date().toISOString().slice(0, 10);
  const keywords = fm["keywords"] ?? "[]";
  const tags = fm["tags"] ?? "[]";

  const dbPath = getDbPath(ticket);
  const db = openDb(dbPath);

  db.prepare("DELETE FROM sessions WHERE vault_path = ?").run(vaultPath);
  db.prepare(
    "INSERT INTO sessions (title, content, keywords, tags, date, vault_path) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(`${ticket}/${branch}`, content, keywords, tags, date, vaultPath);
  db.close();

  const extractedKeywords = extractKeywords(content);
  updateFrontmatterKeywords(vaultPath, extractedKeywords);

  return `Indexed ${ticket}/${branch} → ${dbPath}\nKeywords: ${extractedKeywords.join(", ")}`;
}

export function searchSessions(
  query: string,
  ticket = "all",
  limit = 5,
): SessionSearchResult[] {
  let dbPaths: string[];

  if (ticket === "all") {
    if (!existsSync(MEMORY_ROOT)) return [];
    dbPaths = readdirSync(MEMORY_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(MEMORY_ROOT, d.name, "session_index.db"))
      .filter((p) => existsSync(p));
  } else {
    const p = join(MEMORY_ROOT, ticket, "session_index.db");
    dbPaths = existsSync(p) ? [p] : [];
  }

  const results: SessionSearchResult[] = [];

  for (const dbPath of dbPaths) {
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db
        .prepare(
          "SELECT title, date, snippet(sessions, 1, '**', '**', '...', 64) as snippet, vault_path FROM sessions WHERE sessions MATCH ? ORDER BY rank LIMIT ?",
        )
        .all(query, limit) as Array<{
          title: string;
          date: string;
          snippet: string;
          vault_path: string;
        }>;

      for (const row of rows) {
        results.push({
          title: row.title,
          date: row.date,
          snippet: row.snippet,
          vaultPath: row.vault_path,
        });
      }
    } catch (err) {
      const msg = (err as Error).message;
      throw new Error(`FTS5 query syntax error: ${msg}`);
    } finally {
      db.close();
    }
  }

  return results.slice(0, limit);
}
