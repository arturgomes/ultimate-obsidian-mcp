# ultimate-obsidian-mcp

A Model Context Protocol (MCP) server that gives Claude Code full read/write access to an [Obsidian](https://obsidian.md) vault via the [Obsidian Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin.

Built for Claude Code CLI (v2.x). 24 tools covering vault navigation, note CRUD, full-text search, YAML frontmatter, periodic notes, session-memory search, orchestration state, related-work discovery, and a guarded, logged write path.

---

## Prerequisites

- **Obsidian** with the [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin enabled
- **Node.js** v18+ (v20 recommended)
- **Claude Code CLI** v2.x (`claude --version`)

---

## Installation

### 1. Install the Obsidian Local REST API plugin

In Obsidian: Settings → Community plugins → Browse → search "Local REST API" → Install → Enable.

Copy the API key from the plugin settings. The default endpoint is `http://127.0.0.1:27123`.

### 2. Clone and build

```bash
git clone https://github.com/arturgomes/ultimate-obsidian-mcp.git
cd ultimate-obsidian-mcp
npm install
npm run build
```

Verify the build:

```bash
ls dist/
# client.js  index.js  sqlite.js  tools.js  ...
```

### 3. Register with Claude Code CLI

> **Important**: Claude Code CLI reads MCP config from `~/.claude.json`, not from `~/.claude/settings.json`. Always use `claude mcp add` to register servers.

```bash
claude mcp add-json -s user ultimate-obsidian '{
  "type": "stdio",
  "command": "/absolute/path/to/node",
  "args": ["/absolute/path/to/ultimate-obsidian-mcp/dist/index.js"],
  "env": {
    "OBSIDIAN_API_KEY": "your-api-key-here",
    "OBSIDIAN_BASE_URL": "http://127.0.0.1:27123"
  }
}'
```

Replace the placeholders:

| Placeholder | How to find it |
|---|---|
| `/absolute/path/to/node` | `which node` |
| `/absolute/path/to/ultimate-obsidian-mcp/dist/index.js` | Full path to the cloned repo |
| `your-api-key-here` | Obsidian → Settings → Local REST API → API Key |

**Use absolute paths** — Claude Code spawns MCPs in a restricted environment where `$PATH` may not include NVM or Homebrew paths.

Example for NVM users:

```bash
claude mcp add-json -s user ultimate-obsidian '{
  "type": "stdio",
  "command": "/Users/yourname/.nvm/versions/node/v20.20.0/bin/node",
  "args": ["/Users/yourname/projects/ultimate-obsidian-mcp/dist/index.js"],
  "env": {
    "OBSIDIAN_API_KEY": "your-api-key-here",
    "OBSIDIAN_BASE_URL": "http://127.0.0.1:27123"
  }
}'
```

### 4. Verify

```bash
claude mcp get ultimate-obsidian
# ultimate-obsidian:
#   Scope: User config (available in all your projects)
#   Status: ✓ Connected
```

Start a new Claude Code session. The tools will appear in the deferred tools list as `mcp__ultimate-obsidian__*`.

To confirm the server is starting correctly, check the log file after the first new session:

```
! cat ~/Library/Logs/Claude/mcp-server-ultimate-obsidian.log
# [ultimate-obsidian-mcp] starting — baseUrl=http://127.0.0.1:27123
```

---

## Smoke test

Simulate Claude Code's restricted spawn environment before registering:

```bash
bash scripts/test-mcp.sh
# Startup log (stderr):
#   [ultimate-obsidian-mcp] starting — baseUrl=http://127.0.0.1:27123
#
# Tools registered: 24
# ✅ MCP server OK — 24 tools registered
#
# Testing check_health tool...
# Health check result: Obsidian REST API reachable ✅
```

Edit the `NODE`, `DIST`, `API_KEY`, and `BASE_URL` variables at the top of `scripts/test-mcp.sh` to match your paths.

---

## Tools

### Vault navigation

| Tool | Description |
|---|---|
| `list_vault` | List files in a vault directory (omit path for root) |
| `get_vault_info` | Obsidian REST API server info and vault name |
| `get_periodic_note` | Get the current daily / weekly / monthly / quarterly / yearly note |

### Note read

| Tool | Description |
|---|---|
| `read_note` | Read the full content of a vault note |
| `read_batch` | Read multiple notes at once |
| `check_exists` | Check whether a file exists — returns `true`/`false`, never throws on 404 |
| `grep_note` | Return lines matching a pattern with 1-based line numbers |

### Note write

| Tool | Description |
|---|---|
| `create_or_update_note` | Create or update a note (`append` / `prepend` / `overwrite`) |
| `patch_note` | Patch at a specific heading, block, frontmatter key, or end-of-file |
| `delete_note` | Delete a vault note |
| `move_note` | Move (rename / archive) a note to a new path |
| `search_replace_in_note` | Find-and-replace within a note (string or regex) |

#### Write safety (every write tool)

`create_or_update_note`, `patch_note`, `search_replace_in_note`, `manage_frontmatter`, `move_note` and
`write_state` share one pipeline: **scope guard → secret scrub → write → read-back → index → ledger**.

Each returns the usual `OK: …` first line **plus** `structuredContent` (`create_or_update_note`,
`patch_note` and `move_note` also declare an `outputSchema`):

```jsonc
{ "ok": true, "path": "02-Notes/Sessions/x.md", "op": "overwrite",
  "sha": "<sha256 of the note as read back>", "bytes": 1234,
  "warnings": [], "redactions": 0, "attachments": [] }
```

- **Scope guard.** Writes should land under `02-Notes/{Sessions,Plans,Reports,Specs,pr-descriptions}/`
  or `03-Systems/`, and a file directly in `02-Notes/Plans/` or `02-Notes/Reports/` should live in a
  `YYYY-MM/` folder. By default a violation is a **warning** in the result; `OBSIDIAN_WRITE_GUARD=strict`
  rejects the write before any byte is sent, `off` disables the check.
- **Secret scrub.** Secret *values* (`api_key: …`, `"token": "…"`, `Bearer …`, private keys,
  `scheme://user:pass@`, AWS/GitHub/Slack/`sk-` tokens) are replaced with `[REDACTED]` before writing;
  the count is in `redactions`. Prose that merely contains the word "token" is untouched.
- **Ledger — in the vault.** Every write appends a line `time | tool | op | path | sha256 | process` to
  a daily note `02-Notes/Sessions/write-ledger/YYYY-MM/YYYY-MM-DD.md` (kept out of the search index).
  Read it back with `get_write_ledger`. No session record is kept in `~/.claude` or `/tmp`.

#### Orchestration state (`read_state` / `write_state`)

`*.state.md` notes are frontmatter plus exactly one fenced `json` object. `write_state` is a
compare-and-swap: pass the `sha` from `read_state` (or the previous write) as `expected_sha`, or `null`
to create. A stale sha is rejected with `sha_mismatch` and the note is left unchanged. Writes are
serialised across processes by a lock file, so parallel teammates cannot lose each other's updates.

#### Image attachments

`create_or_update_note` and `patch_note` both accept an optional `attachments[]`. Each entry names a
local image file; the server copies it into the vault **beside the target note** and appends an
`![[embed]]` to the content it writes, so one call produces a note that already renders its images.

```jsonc
{
  "filepath": "02-Notes/Reports/2026-08/audit.md",
  "content": "## Evidence\n\nThe failing dashboard:",
  "mode": "append",
  "attachments": [
    { "path": "/Users/me/Desktop/Screenshot 2026-08-06.png", "name": "dashboard.png" }
  ]
}
```

writes the image to `02-Notes/Reports/2026-08/dashboard.png` and appends `![[dashboard.png]]`.

| Field | Required | Meaning |
|---|---|---|
| `path` | yes | Local filesystem path to the image, read by the MCP server process |
| `name` | no | Override for the stored filename (default: the source basename) |

Behaviour worth knowing:

- **Supported types:** `png` `jpg` `jpeg` `gif` `webp` `svg` `bmp` `avif`. Anything else is rejected.
- **Never overwrites.** A name already present in the destination folder is suffixed `-1`, `-2`, …
- **Attachments upload before the note is written.** If any attachment is missing, oversized, or the
  wrong type, the call fails and the note is left untouched — a note never embeds an image that
  failed to upload. Attachments already uploaded when a later one fails do remain in the vault.
- **Filenames are sanitised** so the stored name is always safe inside `![[…]]`; any directory
  component in `name` is dropped, so an attachment cannot escape the note's own folder.
- **With `attachments` omitted, nothing changes** — the write is byte-identical to before.

### Search and frontmatter

| Tool | Description |
|---|---|
| `search_vault` | Full-text search across the entire vault via Obsidian search |
| `manage_frontmatter` | Get, set, or delete a YAML frontmatter key. Real YAML: lists and `[[wikilinks]]` are quoted correctly, multi-line values delete cleanly, CRLF notes work. `value` is parsed as JSON when it is JSON (`'["a","b"]'`), else kept as a string |

### Session memory and discovery (local FTS5 index)

These tools support the [codebase-intelligence](https://github.com/arturgomes/codebase-intelligence) Claude Code plugin's cross-session memory system. Sessions are served from the same derived FTS5 index as `search_kb` (rebuilt by `reindex_kb`, kept current by every write made through this server).

| Tool | Description |
|---|---|
| `search_sessions` | BM25 search over session notes (`type: session`, or `02-Notes/Sessions/` + `wiki/tasks/`), ranked across all tickets. Ticket ids (`SEATHQ-9999`) and paths are safe to search. Optional `ticket` filter and `sections` (e.g. `["Open Failures","Lessons"]`) |
| `index_note` | Index a note now and refresh its `keywords:` frontmatter. Accepts vault-relative, `~/…` or absolute paths. Only needed for notes edited outside this server |
| `find_related_work` | One ranked, deduped search across Sessions/Plans/Reports/Tasks/Wiki by `project`, `ticket`, `keywords`; notes tagged with the ticket outrank mentions |
| `validate_note_links` | Check that typed relation links (`up`, `documents`, `implements`, `affects`, `related`) resolve to existing notes |
| `read_state` / `write_state` | Orchestration state notes with sha compare-and-swap (see above) |
| `get_write_ledger` | Writes performed since a time (default: server start); `empty: true` when none |

**Where things live.** Every record — session notes, state notes, plans, reports, the write ledger — is a
vault note. Outside the vault there are only rebuildable caches: the FTS5 index (`CI_KB_INDEX`, rebuilt
from the vault by `reindex_kb`) and `write_state` lock files. The old per-ticket
`~/.claude/memory/<TICKET>/session_index.db` files are no longer read; `reindex_kb` reports any that remain.

### Diagnostics

| Tool | Description |
|---|---|
| `check_health` | Verify Obsidian REST API connectivity — returns server version and auth status |

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `OBSIDIAN_API_KEY` | *(required)* | API key from the Local REST API plugin |
| `OBSIDIAN_BASE_URL` | `http://127.0.0.1:27123` | REST API endpoint |
| `OBSIDIAN_MAX_ATTACHMENT_BYTES` | `10485760` (10 MB) | Per-image size cap for `attachments[]` |
| `OBSIDIAN_VAULT_PATH` | `/Users/artur/Documents/Obsidian-Vault` | Vault root on disk (used by the local index) |
| `OBSIDIAN_TIMEOUT_MS` | `10000` | Timeout for ordinary REST calls |
| `OBSIDIAN_SEARCH_TIMEOUT_MS` | `60000` | Timeout for `search_vault` |
| `OBSIDIAN_WRITE_GUARD` | `warn` | `warn` \| `strict` \| `off` — see Write safety |
| `OBSIDIAN_WRITE_SCOPE` | the `02-Notes/…` + `03-Systems/` list above | Comma-separated allowed write prefixes |
| `OBSIDIAN_SECRET_SCRUB` | on | `off` disables secret redaction |
| `CI_KB_INDEX` | `~/.claude/kb/kb_index.db` | Path of the derived FTS5 index |
| `CI_KB_EXCLUDE` | *(none)* | Comma-separated path substrings kept out of the index (also hides them from `search_sessions`, `find_related_work`, `validate_note_links`) |
| `CI_SESSION_PREFIXES` | `02-Notes/Sessions/,wiki/tasks/` | Extra path prefixes treated as session notes (`type: session` always counts) |
| `OBSIDIAN_WRITE_LEDGER` | on | `off` stops recording writes |
| `OBSIDIAN_WRITE_LEDGER_DIR` | `02-Notes/Sessions/write-ledger` | Vault folder of the daily ledger notes |
| `CI_LOCK_DIR` | `<os tmpdir>/ultimate-obsidian-mcp-locks` | `write_state` lock files (ephemeral, not records) |

---

## Troubleshooting

### Tools not appearing in Claude Code after registration

Claude Code reads MCP config only at session start. After running `claude mcp add-json`, open a **new** Claude Code session.

### `~/Library/Logs/Claude/mcp-server-ultimate-obsidian.log` does not exist

The log file is created only when Claude Code successfully spawns the server process. Its absence means the spawn failed silently — almost always a path problem.

Check:
1. `claude mcp get ultimate-obsidian` — is the command path correct?
2. Run `scripts/test-mcp.sh` to test the spawn in an isolated environment
3. Ensure the `command` field uses an **absolute path** to node, not just `node`

### `OBSIDIAN_API_KEY environment variable required`

The env vars are missing from the MCP registration. Remove and re-add:

```bash
claude mcp remove ultimate-obsidian -s user
claude mcp add-json -s user ultimate-obsidian '{ ... }'
```

### Obsidian is not running / REST API returns connection refused

The Local REST API plugin only serves while Obsidian is open. Start Obsidian before using the tools. Use `check_health` to verify connectivity.

### `mcpServers` in `~/.claude/settings.json` is not working

`~/.claude/settings.json` is **not** read by Claude Code CLI for MCP configuration. That key is used by the Claude Desktop App. The CLI reads from `~/.claude.json` — always use `claude mcp add` or `claude mcp add-json` to register servers.

---

## Development

```bash
# Type-check only
npx tsc --noEmit

# Tests (better-sqlite3 is a native module: run under the Node version you installed with, e.g. Node 20)
npm test

# Build
npm run build

# Test startup (requires Obsidian running)
OBSIDIAN_API_KEY=your-key node dist/index.js </dev/null 2>&1 &
sleep 1; kill %1 2>/dev/null

# Full smoke test
bash scripts/test-mcp.sh
```

Source layout:

```
src/
  index.ts     — MCP server entry point, startup log, request handlers
  tools.ts     — Tool registry (TOOLS array) and handleTool dispatcher
  client.ts    — ObsidianClient: typed wrappers around the REST API
  kb.ts        — derived FTS5 index: KB search, session search, related-work discovery
  sqlite.ts    — search_sessions / index_note facade over kb.ts
  fts.ts       — safe FTS5 query construction
  frontmatter.ts — YAML frontmatter parse/edit (yaml)
  paths.ts     — vault path resolution (relative, ~/, absolute)
  writes.ts    — scope guard, secret scrub, write ledger
  state.ts     — .state.md parse/render + cross-process lock
  links.ts     — typed-relation link check
scripts/
  test-mcp.sh  — Smoke test simulating Claude Code's restricted spawn env
  migrate.ts   — Migration from legacy ~/.claude/memory/ task-memory format
```

---

## License

MIT
