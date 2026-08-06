# ultimate-obsidian-mcp

A Model Context Protocol (MCP) server that gives Claude Code full read/write access to an [Obsidian](https://obsidian.md) vault via the [Obsidian Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin.

Built for Claude Code CLI (v2.x). 17 tools covering vault navigation, note CRUD, full-text search, frontmatter management, periodic notes, and session memory indexing.

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
# Tools registered: 17
# ✅ MCP server OK — 17 tools registered
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

### Search

| Tool | Description |
|---|---|
| `search_vault` | Full-text search across the entire vault via Obsidian search |
| `manage_frontmatter` | Get, set, or delete a single YAML frontmatter key |

### Session memory (SQLite FTS5)

These tools support the [codebase-intelligence](https://github.com/arturgomes/codebase-intelligence) Claude Code plugin's cross-session memory system.

| Tool | Description |
|---|---|
| `index_note` | Index a vault session file into SQLite FTS5 and update its `keywords:` frontmatter |
| `search_sessions` | BM25 full-text search across all indexed session files |

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
  sqlite.ts    — SQLite FTS5 session index for search_sessions / index_note
scripts/
  test-mcp.sh  — Smoke test simulating Claude Code's restricted spawn env
  migrate.ts   — Migration from legacy ~/.claude/memory/ task-memory format
```

---

## License

MIT
