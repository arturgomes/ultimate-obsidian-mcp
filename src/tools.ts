import { z } from "zod";
import { join } from "path";
import { ObsidianClient } from "./client.js";
import { indexNote, searchSessions } from "./sqlite.js";
import { searchKb, reindexVault, indexVaultFile, getVaultRoot } from "./kb.js";
import {
  resolveAttachments,
  withEmbeds,
  type AttachmentInput,
  type ResolvedAttachment,
} from "./attachments.js";

type ToolContent = [{ type: "text"; text: string }];

function text(s: string): ToolContent {
  return [{ type: "text", text: s }];
}

/**
 * Keep the derived FTS5 KB index in lockstep with an MCP-performed vault write.
 * Best-effort: a failure here must never fail the underlying write — the
 * SessionStart catch-up reindex covers any miss.
 */
function selfIndexOnWrite(filepath: string): void {
  if (!filepath.endsWith(".md")) return;
  try {
    indexVaultFile(join(getVaultRoot(), filepath));
  } catch {
    /* ignore — SessionStart reindex will reconcile */
  }
}

/**
 * Copy every attachment into the vault beside its note, BEFORE the note itself is
 * written. A rejection here leaves the note untouched, so a note never ships an
 * embed pointing at an image that failed to upload.
 */
async function uploadAttachments(
  inputs: AttachmentInput[] | undefined,
  noteFilepath: string,
  client: ObsidianClient,
): Promise<ResolvedAttachment[]> {
  if (!inputs || inputs.length === 0) return [];
  const resolved = await resolveAttachments(inputs, noteFilepath, (p) => client.checkExists(p));
  for (const a of resolved) {
    await client.putBinary(a.vaultPath, a.bytes, a.contentType);
  }
  return resolved;
}

function writeReport(line: string, stored: ResolvedAttachment[]): string {
  if (stored.length === 0) return line;
  return [line, ...stored.map((a) => `  + attachment → ${a.vaultPath}`)].join(String.fromCharCode(10));
}

// ── Tool input schemas ────────────────────────────────────────────────────────

const ListVaultInput = z.object({
  path: z.string().optional().describe("Directory path (omit for vault root)"),
});

const ReadNoteInput = z.object({
  filepath: z.string().describe("Vault-relative file path"),
});

const ReadBatchInput = z.object({
  filepaths: z.array(z.string()).describe("List of vault-relative file paths"),
});

const AttachmentSchema = z.object({
  path: z.string().describe("Local filesystem path to the image file to attach"),
  name: z
    .string()
    .optional()
    .describe("Override for the stored filename (default: the source basename)"),
});

const AttachmentsParam = z
  .array(AttachmentSchema)
  .optional()
  .describe(
    "Images to copy into the vault beside this note. Each is stored in the note's own folder and an embed is appended to the written content. Supported: png, jpg, jpeg, gif, webp, svg, bmp, avif.",
  );

const CreateOrUpdateNoteInput = z.object({
  filepath: z.string().describe("Vault-relative file path"),
  content: z.string().describe("File content"),
  mode: z
    .enum(["append", "prepend", "overwrite"])
    .describe("Write mode: append | prepend | overwrite"),
  attachments: AttachmentsParam,
});

const PatchNoteInput = z.object({
  filepath: z.string().describe("Vault-relative file path"),
  operation: z.enum(["append", "prepend", "replace"]).describe("Patch operation"),
  target_type: z
    .enum(["heading", "block", "frontmatter", "end"])
    .describe("Target type. Use 'end' to append to end-of-file without a heading target"),
  target: z.string().optional().describe("Target heading/block/key (not needed for 'end')"),
  content: z.string().describe("Content to insert"),
  attachments: AttachmentsParam,
});

const DeleteNoteInput = z.object({
  filepath: z.string().describe("Vault-relative file path"),
});

const CheckExistsInput = z.object({
  filepath: z.string().describe("Vault-relative file path to check"),
});

const MoveNoteInput = z.object({
  source_path: z.string().describe("Source vault-relative file path"),
  dest_path: z.string().describe("Destination vault-relative file path"),
});

const GrepNoteInput = z.object({
  filepath: z.string().describe("Vault-relative file path to search within"),
  pattern: z.string().describe("Search pattern (string or regex)"),
  use_regex: z.boolean().optional().describe("Treat pattern as regex (default: false)"),
});

const SearchVaultInput = z.object({
  query: z.string().describe("Search query"),
  context_length: z
    .number()
    .optional()
    .describe("Context characters around each match (default 100)"),
});

const SearchReplaceInput = z.object({
  filepath: z.string().describe("Vault-relative file path"),
  search: z.string().describe("Text to find"),
  replace: z.string().describe("Replacement text"),
  use_regex: z.boolean().optional().describe("Treat search as regex (default: false)"),
});

const ManageFrontmatterInput = z.object({
  filepath: z.string().describe("Vault-relative file path"),
  operation: z.enum(["get", "set", "delete"]).describe("Frontmatter operation"),
  key: z.string().describe("Frontmatter key"),
  value: z.string().optional().describe("Value (required for 'set')"),
});

const GetPeriodicNoteInput = z.object({
  period: z
    .enum(["daily", "weekly", "monthly", "quarterly", "yearly"])
    .describe("Periodic note period"),
});

const GetVaultInfoInput = z.object({});

const SearchSessionsInput = z.object({
  query: z.string().describe("BM25 full-text search query across session memory files"),
  ticket: z
    .string()
    .optional()
    .describe("Ticket ID to limit search (default: 'all' searches all tickets)"),
  limit: z.number().optional().describe("Max results (default 5)"),
});

const IndexNoteInput = z.object({
  vault_path: z
    .string()
    .describe("Absolute path to the vault session file to index into SQLite FTS5"),
});

const SearchKbInput = z.object({
  query: z
    .string()
    .describe(
      "Natural-language question or expanded synonym list. Tokenized to a BM25 FTS5 query (stopwords dropped, terms OR-ed, longer terms prefix-matched).",
    ),
  limit: z.number().optional().describe("Max ranked hits (default 6)"),
});

const ReindexKbInput = z.object({
  force: z
    .boolean()
    .optional()
    .describe("Rebuild every file (default: incremental — only changed/new/deleted files)"),
});

// ── Tool registry ─────────────────────────────────────────────────────────────

export const TOOLS = [
  {
    name: "list_vault",
    description: "List files in a vault directory (omit path for root)",
    inputSchema: zodToJsonSchema(ListVaultInput),
  },
  {
    name: "read_note",
    description: "Read the full content of a vault note",
    inputSchema: zodToJsonSchema(ReadNoteInput),
  },
  {
    name: "read_batch",
    description: "Read multiple vault notes at once, concatenated with headers",
    inputSchema: zodToJsonSchema(ReadBatchInput),
  },
  {
    name: "create_or_update_note",
    description:
      "Create or update a vault note (append / prepend / overwrite), optionally attaching local images that are copied beside the note and embedded",
    inputSchema: zodToJsonSchema(CreateOrUpdateNoteInput),
  },
  {
    name: "patch_note",
    description:
      "Patch a note at a specific heading, block, frontmatter key, or end-of-file, optionally attaching local images that are copied beside the note and embedded",
    inputSchema: zodToJsonSchema(PatchNoteInput),
  },
  {
    name: "delete_note",
    description: "Delete a vault note",
    inputSchema: zodToJsonSchema(DeleteNoteInput),
  },
  {
    name: "check_exists",
    description: "Check whether a vault file exists (returns true/false, never throws on 404)",
    inputSchema: zodToJsonSchema(CheckExistsInput),
  },
  {
    name: "move_note",
    description: "Move (rename/archive) a vault note to a new path",
    inputSchema: zodToJsonSchema(MoveNoteInput),
  },
  {
    name: "grep_note",
    description:
      "Return all lines in a vault note matching a pattern, with 1-based line numbers",
    inputSchema: zodToJsonSchema(GrepNoteInput),
  },
  {
    name: "search_vault",
    description: "Full-text search across the entire vault using Obsidian search",
    inputSchema: zodToJsonSchema(SearchVaultInput),
  },
  {
    name: "search_replace_in_note",
    description: "Find and replace text within a vault note",
    inputSchema: zodToJsonSchema(SearchReplaceInput),
  },
  {
    name: "manage_frontmatter",
    description: "Get, set, or delete a single YAML frontmatter key in a vault note",
    inputSchema: zodToJsonSchema(ManageFrontmatterInput),
  },
  {
    name: "get_periodic_note",
    description: "Get the current daily/weekly/monthly/quarterly/yearly periodic note",
    inputSchema: zodToJsonSchema(GetPeriodicNoteInput),
  },
  {
    name: "get_vault_info",
    description: "Get Obsidian REST API server information and vault name",
    inputSchema: zodToJsonSchema(GetVaultInfoInput),
  },
  {
    name: "search_sessions",
    description:
      "BM25 full-text search across SQLite-indexed session memory files (~/.claude/memory/). Replaces session_indexer.py --search",
    inputSchema: zodToJsonSchema(SearchSessionsInput),
  },
  {
    name: "index_note",
    description:
      "Index a vault session file into SQLite FTS5 and update its frontmatter keywords. Replaces session_indexer.py --index-session + --extract-keywords",
    inputSchema: zodToJsonSchema(IndexNoteInput),
  },
  {
    name: "search_kb",
    description:
      "BM25 knowledge-base search over the whole vault via a local FTS5 index (no embeddings, no vectors). Returns ranked chunks with text, source_relpath, heading_path, domain. Backs the ask-kb / consult-kb skills.",
    inputSchema: zodToJsonSchema(SearchKbInput),
  },
  {
    name: "reindex_kb",
    description:
      "Rebuild the local FTS5 knowledge-base index from the markdown vault. Incremental by default (only changed/new/deleted files); pass force to rebuild all. Deterministic, no model — safe to run at session start or on a fresh machine.",
    inputSchema: zodToJsonSchema(ReindexKbInput),
  },
  {
    name: "check_health",
    description:
      "Check Obsidian REST API connectivity. Returns server version and auth status. Use this to verify the MCP is working.",
    inputSchema: zodToJsonSchema(z.object({})),
  },
];

// ── Tool handlers ─────────────────────────────────────────────────────────────

export async function handleTool(
  name: string,
  args: Record<string, unknown>,
  client: ObsidianClient,
): Promise<ToolContent> {
  switch (name) {
    case "list_vault": {
      const { path } = ListVaultInput.parse(args);
      const files = await client.listVault(path);
      return text(files.join("\n") || "(empty directory)");
    }

    case "read_note": {
      const { filepath } = ReadNoteInput.parse(args);
      return text(await client.getFile(filepath));
    }

    case "read_batch": {
      const { filepaths } = ReadBatchInput.parse(args);
      const results = await client.getFileBatch(filepaths);
      return text(results.map((r) => `# ${r.path}\n\n${r.content}\n\n---`).join("\n\n"));
    }

    case "create_or_update_note": {
      const { filepath, content, mode, attachments } = CreateOrUpdateNoteInput.parse(args);
      const stored = await uploadAttachments(attachments, filepath, client);
      await client.createOrUpdateFile(filepath, withEmbeds(content, stored), mode);
      selfIndexOnWrite(filepath);
      return text(writeReport(`OK: ${mode} → ${filepath}`, stored));
    }

    case "patch_note": {
      const { filepath, operation, target_type, target, content, attachments } =
        PatchNoteInput.parse(args);
      const stored = await uploadAttachments(attachments, filepath, client);
      const body = withEmbeds(content, stored);
      if (target_type === "end") {
        await client.createOrUpdateFile(filepath, body, "append");
      } else {
        await client.patchFile(filepath, operation, target_type, target ?? "", body);
      }
      selfIndexOnWrite(filepath);
      return text(writeReport(`OK: patch ${operation}@${target_type} → ${filepath}`, stored));
    }

    case "delete_note": {
      const { filepath } = DeleteNoteInput.parse(args);
      await client.deleteFile(filepath);
      return text(`OK: deleted ${filepath}`);
    }

    case "check_exists": {
      const { filepath } = CheckExistsInput.parse(args);
      const exists = await client.checkExists(filepath);
      return text(`exists: ${exists}`);
    }

    case "move_note": {
      const { source_path, dest_path } = MoveNoteInput.parse(args);
      await client.moveFile(source_path, dest_path);
      return text(`OK: moved ${source_path} → ${dest_path}`);
    }

    case "grep_note": {
      const { filepath, pattern, use_regex } = GrepNoteInput.parse(args);
      const matches = await client.grepFile(filepath, pattern, use_regex ?? false);
      if (matches.length === 0) return text("(no matches)");
      return text(matches.map((m) => `${m.line}: ${m.text}`).join("\n"));
    }

    case "search_vault": {
      const { query, context_length } = SearchVaultInput.parse(args);
      const results = await client.searchSimple(query, context_length ?? 100);
      if (results.length === 0) return text("(no results)");
      return text(JSON.stringify(results, null, 2));
    }

    case "search_replace_in_note": {
      const { filepath, search, replace, use_regex } = SearchReplaceInput.parse(args);
      const content = await client.getFile(filepath);
      let updated: string;
      if (use_regex) {
        let re: RegExp;
        try {
          re = new RegExp(search, "g");
        } catch (err) {
          return text(`Invalid regex: ${(err as Error).message}`);
        }
        updated = content.replace(re, replace);
      } else {
        updated = content.split(search).join(replace);
      }
      if (updated === content) return text("(no changes — pattern not found)");
      await client.createOrUpdateFile(filepath, updated, "overwrite");
      selfIndexOnWrite(filepath);
      return text(`OK: replaced in ${filepath}`);
    }

    case "manage_frontmatter": {
      const { filepath, operation, key, value } = ManageFrontmatterInput.parse(args);
      const content = await client.getFile(filepath);

      const fmMatch = content.match(/^(---\n)([\s\S]*?)(\n---)/);
      if (!fmMatch) return text("Error: no frontmatter found in file");

      const [, open, body, close] = fmMatch;
      const lines = body.split("\n");

      if (operation === "get") {
        const line = lines.find((l) => l.startsWith(`${key}:`));
        return text(line ? line.slice(key.length + 1).trim() : `(key '${key}' not found)`);
      }

      const filtered = lines.filter((l) => !l.startsWith(`${key}:`));

      if (operation === "set") {
        if (value === undefined) return text("Error: 'value' required for 'set' operation");
        filtered.push(`${key}: ${value}`);
      }

      const newContent = content.replace(
        /^---\n[\s\S]*?\n---/,
        `${open}${filtered.join("\n")}${close}`,
      );
      await client.createOrUpdateFile(filepath, newContent, "overwrite");
      selfIndexOnWrite(filepath);
      return text(`OK: ${operation} frontmatter key '${key}' in ${filepath}`);
    }

    case "get_periodic_note": {
      const { period } = GetPeriodicNoteInput.parse(args);
      return text(await client.getPeriodicNote(period));
    }

    case "get_vault_info": {
      const info = await client.getServerInfo();
      return text(JSON.stringify(info, null, 2));
    }

    case "search_sessions": {
      const { query, ticket, limit } = SearchSessionsInput.parse(args);
      const results = searchSessions(query, ticket ?? "all", limit ?? 5);
      if (results.length === 0) return text(`(no results for '${query}')`);
      const formatted = results
        .map((r, i) => {
          const filename = r.vaultPath.split("/").pop()?.replace(".md", "") ?? r.title;
          return `${i + 1}. [[${filename}]] — ${r.date}\n   ${r.snippet}`;
        })
        .join("\n\n");
      return text(`🔍 Search results for "${query}":\n\n${formatted}`);
    }

    case "index_note": {
      const { vault_path } = IndexNoteInput.parse(args);
      return text(indexNote(vault_path));
    }

    case "search_kb": {
      const { query, limit } = SearchKbInput.parse(args);
      const hits = searchKb(query, limit ?? 6);
      if (hits.length === 0) return text(`(no KB results for '${query}')`);
      return text(JSON.stringify({ query, hits }, null, 2));
    }

    case "reindex_kb": {
      const { force } = ReindexKbInput.parse(args);
      const s = reindexVault({ force: force ?? false });
      return text(
        `KB reindex complete — indexed ${s.indexed}, skipped ${s.skipped}, removed ${s.removed} (${s.chunks} chunks written)`,
      );
    }

    case "check_health": {
      const info = await client.getServerInfo();
      return text(`Obsidian REST API reachable ✅\n${JSON.stringify(info, null, 2)}`);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Minimal zod-to-JSON-schema helper ────────────────────────────────────────
// Avoids adding zod-to-json-schema as a dep — handles the shapes we actually use.

function zodToJsonSchema(schema: z.ZodTypeAny): object {
  return buildSchema(schema);
}

function buildSchema(schema: z.ZodTypeAny): object {
  const description = (schema._def as { description?: string }).description;
  const base = buildNode(schema);
  return description ? { ...base, description } : base;
}

function buildNode(schema: z.ZodTypeAny): object {
  if (schema instanceof z.ZodObject) {
    const props: Record<string, object> = {};
    const required: string[] = [];
    for (const [k, v] of Object.entries(schema.shape as Record<string, z.ZodTypeAny>)) {
      props[k] = buildSchema(v);
      if (!(v instanceof z.ZodOptional)) required.push(k);
    }
    return { type: "object", properties: props, required };
  }
  if (schema instanceof z.ZodOptional) return buildSchema(schema.unwrap());
  if (schema instanceof z.ZodString) return { type: "string" };
  if (schema instanceof z.ZodNumber) return { type: "number" };
  if (schema instanceof z.ZodBoolean) return { type: "boolean" };
  if (schema instanceof z.ZodEnum) return { type: "string", enum: schema.options };
  if (schema instanceof z.ZodArray) return { type: "array", items: buildSchema(schema.element) };
  return {};
}
