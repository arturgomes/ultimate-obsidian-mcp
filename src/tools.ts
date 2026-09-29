import { z } from "zod";
import { join } from "path";
import { ObsidianClient } from "./client.js";
import { indexNote, searchSessions } from "./sqlite.js";
import {
  searchKb,
  reindexVault,
  indexVaultFile,
  getVaultRoot,
  removeVaultFile,
  findRelatedWork,
} from "./kb.js";
import { extractTypedLinks, resolveLinks } from "./links.js";
import {
  guardPath,
  scrubSecrets,
  scrubValue,
  appendLedger,
  readLedger,
  sha256,
  type WriteResult,
} from "./writes.js";
import { createHash } from "crypto";
import { parseFrontmatter, setFrontmatterKey, deleteFrontmatterKey } from "./frontmatter.js";
import { parseStateNote, renderStateNote, withLock } from "./state.js";
import {
  resolveAttachments,
  withEmbeds,
  type AttachmentInput,
  type ResolvedAttachment,
} from "./attachments.js";

type ToolContent = [{ type: "text"; text: string }];

export interface ToolResult {
  content: ToolContent;
  structuredContent?: Record<string, unknown>;
}

function text(s: string, structuredContent?: Record<string, unknown>): ToolResult {
  return structuredContent
    ? { content: [{ type: "text", text: s }], structuredContent }
    : { content: [{ type: "text", text: s }] };
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

/** Drop a deleted / moved-away note from the derived index. Best-effort. */
function pruneIndex(filepath: string): void {
  if (!filepath.endsWith(".md")) return;
  try {
    removeVaultFile(filepath);
  } catch {
    /* ignore — reindex_kb prunes deleted files */
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

interface FinishOpts {
  tool: string;
  filepath: string;
  op: string;
  line: string;
  warnings: string[];
  redactions: number;
  stored: ResolvedAttachment[];
}

/**
 * Post-write half of every write tool: read the note back for its sha, keep the
 * derived index current, log the write, and build the structured result. The
 * write has already happened, so nothing here may turn it into a failure.
 */
async function finishWrite(client: ObsidianClient, o: FinishOpts): Promise<ToolResult> {
  const warnings = [...o.warnings];
  let sha = "";
  let bytes = 0;
  try {
    if (o.filepath.toLowerCase().endsWith(".md")) {
      const back = await client.getFile(o.filepath);
      sha = sha256(back);
      bytes = Buffer.byteLength(back, "utf8");
    } else {
      // A text decode of an image/PDF is lossy; hash the real bytes.
      const back = await client.getBinary(o.filepath);
      sha = createHash("sha256").update(back).digest("hex");
      bytes = back.length;
    }
  } catch {
    warnings.push("read-back failed: sha unavailable");
  }
  selfIndexOnWrite(o.filepath);
  await appendLedger(client, { tool: o.tool, path: o.filepath, op: o.op, sha });

  const result: WriteResult = {
    ok: true,
    path: o.filepath,
    op: o.op,
    sha,
    bytes,
    warnings,
    redactions: o.redactions,
    attachments: o.stored.map((a) => a.vaultPath),
  };
  const extra = [
    ...warnings.map((w) => `  ⚠ ${w}`),
    ...(o.redactions > 0 ? [`  redacted ${o.redactions} secret value(s)`] : []),
  ];
  const line = writeReport(o.line, o.stored) + (extra.length ? "\n" + extra.join("\n") : "");
  return text(line, result as unknown as Record<string, unknown>);
}

interface WriteOpts {
  tool: string;
  filepath: string;
  op: string;
  content: string;
  attachments?: AttachmentInput[];
  line: string;
  write: (body: string) => Promise<void>;
  /** Content already scrubbed by the caller (structured data); skip the text scrub. */
  prescrubbed?: number;
}

/**
 * The one write pipeline: scope guard (may throw before any byte) → secret scrub
 * → attachments → write → read-back sha → index → ledger → structured result.
 */
async function performWrite(client: ObsidianClient, o: WriteOpts): Promise<ToolResult> {
  const warnings = guardPath(o.filepath);
  const { content, redactions } =
    o.prescrubbed !== undefined
      ? { content: o.content, redactions: o.prescrubbed }
      : scrubSecrets(o.content);
  const stored = await uploadAttachments(o.attachments, o.filepath, client);
  await o.write(withEmbeds(content, stored));
  return finishWrite(client, {
    tool: o.tool,
    filepath: o.filepath,
    op: o.op,
    line: o.line,
    warnings,
    redactions,
    stored,
  });
}

/** Parse a `manage_frontmatter set` value: JSON when it is JSON, else the raw string. */
function parseFmValue(raw: string): unknown {
  const t = raw.trim();
  if (/^\[\[.*\]\]$/.test(t)) return t;
  try {
    return JSON.parse(t);
  } catch {
    return raw;
  }
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

const ReadStateInput = z.object({
  filepath: z.string().describe("Vault-relative path of the .state.md note"),
});

const WriteStateInput = z.object({
  filepath: z.string().describe("Vault-relative path; must end in .state.md"),
  frontmatter: z.record(z.unknown()).describe("YAML frontmatter object for the note"),
  state: z.record(z.unknown()).describe("The single JSON state object (whole state, not a patch)"),
  expected_sha: z
    .string()
    .nullable()
    .describe(
      "sha from read_state (or the previous write_state result). null = the note must not exist yet. A mismatch rejects the write.",
    ),
});

const FindRelatedWorkInput = z.object({
  project: z.string().optional().describe("Project code, e.g. SEATHQ"),
  ticket: z.string().optional().describe("Ticket id; notes tagged with it rank above mentions"),
  keywords: z.array(z.string()).optional().describe("Extra keywords / goal terms"),
  folders: z
    .array(z.string())
    .optional()
    .describe(
      "Vault-relative folder prefixes to search (default 02-Notes/{Sessions,Plans,Reports,Tasks,Wiki}/)",
    ),
  limit: z.number().optional().describe("Max notes (default 5)"),
});

const ValidateNoteLinksInput = z.object({
  filepath: z.string().describe("Vault-relative path of the note whose typed links to check"),
});

const GetWriteLedgerInput = z.object({
  since: z
    .string()
    .optional()
    .describe("ISO timestamp; only writes at or after it (default: this server process start)"),
  path_prefix: z.string().optional().describe("Only writes whose vault path starts with this"),
});

const SearchSessionsInput = z.object({
  query: z.string().describe("BM25 full-text search query across session memory files"),
  ticket: z
    .string()
    .optional()
    .describe("Ticket ID to limit search (default: 'all' searches all tickets)"),
  limit: z.number().optional().describe("Max results (default 5)"),
  sections: z
    .array(z.string())
    .optional()
    .describe(
      "Only return chunks under these headings (e.g. [\"Open Failures\", \"Lessons\", \"General Rules\"]); matched case-insensitively",
    ),
});

const IndexNoteInput = z.object({
  vault_path: z
    .string()
    .describe("Vault-relative path, ~/... path, or absolute path (inside the vault) of the note to index"),
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

/** structuredContent shape of every tool whose success is always a write. */
const WRITE_RESULT_SCHEMA = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    path: { type: "string" },
    op: { type: "string" },
    sha: { type: "string", description: "sha256 of the note as read back after the write" },
    bytes: { type: "number" },
    warnings: { type: "array", items: { type: "string" } },
    redactions: { type: "number" },
    attachments: { type: "array", items: { type: "string" } },
  },
  required: ["ok", "path", "op", "sha", "bytes", "warnings", "redactions", "attachments"],
};

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
    outputSchema: WRITE_RESULT_SCHEMA,
  },
  {
    name: "patch_note",
    description:
      "Patch a note at a specific heading, block, frontmatter key, or end-of-file, optionally attaching local images that are copied beside the note and embedded",
    inputSchema: zodToJsonSchema(PatchNoteInput),
    outputSchema: WRITE_RESULT_SCHEMA,
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
    outputSchema: WRITE_RESULT_SCHEMA,
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
      "BM25 search over session notes (frontmatter type: session, or 02-Notes/Sessions/ + wiki/tasks/), globally ranked across tickets. Ticket ids and paths are safe to search. Optional ticket filter and sections filter.",
    inputSchema: zodToJsonSchema(SearchSessionsInput),
  },
  {
    name: "index_note",
    description:
      "Index a vault note now and refresh its frontmatter keywords. Writes made through this server are already indexed automatically; use this for notes edited elsewhere. Accepts vault-relative, ~/..., or absolute paths.",
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
    name: "find_related_work",
    description:
      "One ranked, deduped search across 02-Notes Sessions/Plans/Reports/Tasks/Wiki for a project code, ticket and keywords. Returns [[wikilinks]] with folder, date and a one-line why. Notes tagged with the ticket outrank mentions.",
    inputSchema: zodToJsonSchema(FindRelatedWorkInput),
  },
  {
    name: "validate_note_links",
    description:
      "Check that a note's typed relation links (up, documents, implements, affects, related) resolve to existing notes. Returns {ok, links, dangling}; dangling links are reported, not thrown.",
    inputSchema: zodToJsonSchema(ValidateNoteLinksInput),
  },
  {
    name: "read_state",
    description:
      "Read an orchestration .state.md note: returns {exists, sha, frontmatter, state}. Pass the sha back as expected_sha to write_state.",
    inputSchema: zodToJsonSchema(ReadStateInput),
  },
  {
    name: "write_state",
    description:
      "Write an orchestration .state.md note (frontmatter + one fenced json object) with compare-and-swap: rejects with sha_mismatch if the note changed since expected_sha, serialised across processes by a lock. Whole-note overwrite only.",
    inputSchema: zodToJsonSchema(WriteStateInput),
  },
  {
    name: "get_write_ledger",
    description:
      "List the vault writes performed through this MCP (path, op, sha, time) since a timestamp — default this server's start. The ledger itself lives in the vault as daily notes under 02-Notes/Sessions/write-ledger/YYYY-MM/. Backs the 'every note written' shutdown ledger; empty:true means nothing was written.",
    inputSchema: zodToJsonSchema(GetWriteLedgerInput),
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
): Promise<ToolResult> {
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
      return performWrite(client, {
        tool: name,
        filepath,
        op: mode,
        content,
        attachments,
        line: `OK: ${mode} → ${filepath}`,
        write: (body) => client.createOrUpdateFile(filepath, body, mode),
      });
    }

    case "patch_note": {
      const { filepath, operation, target_type, target, content, attachments } =
        PatchNoteInput.parse(args);
      return performWrite(client, {
        tool: name,
        filepath,
        op: `patch:${operation}@${target_type}`,
        content,
        attachments,
        line: `OK: patch ${operation}@${target_type} → ${filepath}`,
        write: (body) =>
          target_type === "end"
            ? client.createOrUpdateFile(filepath, body, "append")
            : client.patchFile(filepath, operation, target_type, target ?? "", body),
      });
    }

    case "delete_note": {
      const { filepath } = DeleteNoteInput.parse(args);
      await client.deleteFile(filepath);
      pruneIndex(filepath);
      await appendLedger(client, { tool: name, path: filepath, op: "delete", sha: "" });
      return text(`OK: deleted ${filepath}`);
    }

    case "check_exists": {
      const { filepath } = CheckExistsInput.parse(args);
      const exists = await client.checkExists(filepath);
      return text(`exists: ${exists}`);
    }

    case "move_note": {
      const { source_path, dest_path } = MoveNoteInput.parse(args);
      const warnings = guardPath(dest_path);
      await client.moveFile(source_path, dest_path);
      pruneIndex(source_path);
      return finishWrite(client, {
        tool: name,
        filepath: dest_path,
        op: "move",
        line: `OK: moved ${source_path} → ${dest_path}`,
        warnings,
        redactions: 0,
        stored: [],
      });
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
      return performWrite(client, {
        tool: name,
        filepath,
        op: "replace",
        content: updated,
        line: `OK: replaced in ${filepath}`,
        write: (body) => client.createOrUpdateFile(filepath, body, "overwrite"),
      });
    }

    case "manage_frontmatter": {
      const { filepath, operation, key, value } = ManageFrontmatterInput.parse(args);
      const content = await client.getFile(filepath);

      const fm = parseFrontmatter(content);
      if (!fm.hasFrontmatter) return text("Error: no frontmatter found in file");
      const present = Object.prototype.hasOwnProperty.call(fm.data, key);

      if (operation === "get") {
        if (!present) return text(`(key '${key}' not found)`);
        const v = fm.data[key];
        return text(typeof v === "string" ? v : JSON.stringify(v));
      }

      let newContent: string;
      if (operation === "set") {
        if (value === undefined) return text("Error: 'value' required for 'set' operation");
        newContent = setFrontmatterKey(content, key, parseFmValue(value));
      } else {
        if (!present) return text(`(key '${key}' not found)`);
        newContent = deleteFrontmatterKey(content, key);
      }
      return performWrite(client, {
        tool: name,
        filepath,
        op: `frontmatter:${operation}`,
        content: newContent,
        line: `OK: ${operation} frontmatter key '${key}' in ${filepath}`,
        write: (body) => client.createOrUpdateFile(filepath, body, "overwrite"),
      });
    }

    case "find_related_work": {
      const input = FindRelatedWorkInput.parse(args);
      const items = findRelatedWork(input);
      if (items.length === 0) return text("(no related work found)", { items });
      return text(
        items
          .map((i, n) => `${n + 1}. ${i.wikilink} — ${i.date || "undated"} — ${i.folder}\n   ${i.why}`)
          .join("\n\n"),
        { items },
      );
    }

    case "validate_note_links": {
      const { filepath } = ValidateNoteLinksInput.parse(args);
      const fm = parseFrontmatter(await client.getFile(filepath));
      const links = resolveLinks(extractTypedLinks(fm.data));
      const dangling = links.filter((l) => !l.resolved).map((l) => ({ key: l.key, target: l.target }));
      const structured = { ok: dangling.length === 0, links, dangling };
      if (dangling.length === 0) {
        return text(`OK: ${links.length} typed link(s) resolve in ${filepath}`, structured);
      }
      return text(
        `${dangling.length} dangling link(s) in ${filepath}:\n` +
          dangling.map((d) => `  ${d.key}: [[${d.target}]]`).join("\n"),
        structured,
      );
    }

    case "read_state": {
      const { filepath } = ReadStateInput.parse(args);
      if (!(await client.checkExists(filepath))) {
        return text(`(no state note at ${filepath})`, {
          exists: false,
          sha: null,
          frontmatter: null,
          state: null,
        });
      }
      const content = await client.getFile(filepath);
      const sha = sha256(content);
      const parsed = parseStateNote(content);
      return text(`state ${filepath} — sha ${sha}\n${JSON.stringify(parsed.state, null, 2)}`, {
        exists: true,
        sha,
        frontmatter: parsed.frontmatter,
        state: parsed.state,
      });
    }

    case "write_state": {
      const { filepath, frontmatter, state, expected_sha } = WriteStateInput.parse(args);
      if (!filepath.endsWith(".state.md")) {
        throw new Error("write_state only accepts a filepath ending in .state.md");
      }
      return withLock(filepath, async () => {
        const current = (await client.checkExists(filepath))
          ? sha256(await client.getFile(filepath))
          : null;
        if (current !== expected_sha) {
          throw new Error(
            `sha_mismatch: ${filepath} changed since it was read (expected ${expected_sha ?? "no note"}, current ${current ?? "no note"}) — re-read with read_state and retry`,
          );
        }
        // Scrub the structured values, not the rendered text: a text scrub is not
        // JSON-aware and could leave a fence read_state cannot parse.
        const fm = scrubValue(frontmatter);
        const st = scrubValue(state);
        const body = renderStateNote(
          fm.value as Record<string, unknown>,
          st.value as Record<string, unknown>,
        );
        parseStateNote(body); // never write a note read_state would reject
        return performWrite(client, {
          tool: name,
          filepath,
          op: "write_state",
          content: body,
          prescrubbed: fm.redactions + st.redactions,
          line: `OK: state → ${filepath}`,
          write: (body) => client.createOrUpdateFile(filepath, body, "overwrite"),
        });
      });
    }

    case "get_write_ledger": {
      const { since, path_prefix } = GetWriteLedgerInput.parse(args);
      if (since !== undefined && Number.isNaN(Date.parse(since))) {
        return text(`Error: invalid 'since' (expected an ISO timestamp): ${since}`);
      }
      const entries = await readLedger(client, {
        since: since ? new Date(since).toISOString() : undefined,
        pathPrefix: path_prefix,
      });
      const structured = { count: entries.length, empty: entries.length === 0, entries };
      if (entries.length === 0) {
        return text(`(no writes since ${since ?? "server start"})`, structured);
      }
      return text(
        entries.map((e) => `${e.path} — ${e.op} — ${e.sha.slice(0, 8) || "no-sha"}`).join("\n"),
        structured,
      );
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
      const { query, ticket, limit, sections } = SearchSessionsInput.parse(args);
      const results = searchSessions(query, ticket ?? "all", limit ?? 5, sections);
      if (results.length === 0) return text(`(no results for '${query}')`);
      const formatted = results
        .map((r, i) => {
          const filename = r.vaultPath.split("/").pop()?.replace(".md", "") ?? r.title;
          const where = sections?.length ? ` § ${r.headingPath}` : "";
          return `${i + 1}. [[${filename}]] — ${r.date}${where}\n   ${r.snippet}`;
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
        `KB reindex complete — indexed ${s.indexed}, skipped ${s.skipped}, removed ${s.removed} (${s.chunks} chunks written)` +
          (s.legacySessionDirs > 0
            ? `\nlegacy per-ticket session DB dirs (no longer read): ${s.legacySessionDirs}`
            : ""),
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
  if (schema instanceof z.ZodNullable) {
    return { anyOf: [buildSchema(schema.unwrap()), { type: "null" }] };
  }
  if (schema instanceof z.ZodRecord) return { type: "object", additionalProperties: true };
  if (schema instanceof z.ZodString) return { type: "string" };
  if (schema instanceof z.ZodNumber) return { type: "number" };
  if (schema instanceof z.ZodBoolean) return { type: "boolean" };
  if (schema instanceof z.ZodEnum) return { type: "string", enum: schema.options };
  if (schema instanceof z.ZodArray) return { type: "array", items: buildSchema(schema.element) };
  return {};
}
