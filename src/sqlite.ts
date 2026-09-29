import { existsSync, readFileSync, writeFileSync } from "fs";
import { indexVaultFile, noteMeta, searchSessionsKb } from "./kb.js";
import { parseFrontmatter, setFrontmatterKey } from "./frontmatter.js";
import { resolveVaultPath } from "./paths.js";

// ── Session memory search / indexing ──────────────────────────────────────────
// Sessions are served from the same derived FTS5 index as the KB (see kb.ts):
// one corpus, globally ranked, kept current by every MCP write. The per-ticket
// ~/.claude/memory/<TICKET>/session_index.db files are no longer read.

export interface SessionSearchResult {
  title: string;
  date: string;
  snippet: string;
  /** Vault-relative path of the session note. */
  vaultPath: string;
  headingPath: string;
}

export function searchSessions(
  query: string,
  ticket = "all",
  limit = 5,
  sections?: string[],
): SessionSearchResult[] {
  return searchSessionsKb(query, { ticket, limit, sections }).map((h) => ({
    title: h.ticket,
    date: h.date,
    snippet: h.snippet,
    vaultPath: h.path,
    headingPath: h.heading_path,
  }));
}

function extractKeywords(content: string, topN = 10): string[] {
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

/**
 * Index a vault note and refresh its `keywords:` frontmatter. Accepts a
 * vault-relative path, `~/...`, or an absolute path inside the vault.
 */
export function indexNote(input: string): string {
  const { rel, abs } = resolveVaultPath(input);
  if (!existsSync(abs)) throw new Error(`File not found: ${abs}`);

  const content = readFileSync(abs, "utf8");
  const keywords = extractKeywords(content);
  let note = "";
  if (parseFrontmatter(content).hasFrontmatter) {
    try {
      writeFileSync(abs, setFrontmatterKey(content, "keywords", keywords, { flow: true }), "utf8");
    } catch (err) {
      // A broken frontmatter block must not keep the note out of the index.
      note = `\n⚠ keywords not updated: ${(err as Error).message.split("\n")[0]}`;
    }
  }
  const status = indexVaultFile(abs);
  const { ticket } = noteMeta(rel, readFileSync(abs, "utf8"));
  return `Indexed ${ticket} → ${rel} (${status})\nKeywords: ${keywords.join(", ")}${note}`;
}
