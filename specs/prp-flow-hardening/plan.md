---
title: prp-flow-hardening
type: plan
created: 2026-09-28
schema_version: 1
source: Planning session (vault-native)
project: ultimate-obsidian-mcp
related: "[[ultimate-obsidian-mcp-prp-fit-report]]"
tags:
  - prp
  - ultimate-obsidian-mcp
  - plan
  - mcp-hardening
---

# Plan — PRP-flow hardening for ultimate-obsidian-mcp

Base: `main` → branch `feat/prp-flow-hardening`

> **Execution environment**: implementation runs inside a fresh git worktree on a new branch off
> the detected base branch (via `Skill(codebase-intelligence:worktree-lifecycle)` → ENTER), and the
> worktree is torn down on user satisfaction (EXIT: save-before-delete, confirm-before-remove).
> Falls back to an in-place branch if worktree support is unavailable.

## Summary

Fix the four defects that break prp-orchestrate / prp-plan / prp-implement vault calls today, then add
server-side write safety, a state-note CAS pair, discovery tools, and robustness fixes. Delivered as
S0 contracts + five independently testable slices; stopping after any slice leaves working code.

## User Story

As an agent running the PRP flows (orchestrate / plan / implement)
I want the vault MCP to search, index, write and verify notes correctly and mechanically
So that runs reuse prior work, never lose or corrupt state, and do not depend on prompt-only rules.

## Problem Statement

Verified on 2026-09-28 (commands in the fit report `02-Notes/Reports/2026-09/ultimate-obsidian-mcp-prp-fit-report.md`):
`search_sessions("SEATHQ-9999")` throws `no such column: 9999`; 6 of 97 `~/.claude/memory/*` index dirs
are named with literal quotes (`"SIT-14683"/`, `""/`); `index_note` fails on `~/…` paths and files
untagged notes under `GENERAL`; cross-ticket results are not globally ranked. Vault-write rules
(scope, month buckets, secret scrub) exist only in prompts and have drifted (un-bucketed files at the
root of `02-Notes/Reports/`).

## Solution Statement

Retire the per-ticket session DBs and serve session search from the **existing** KB FTS5 index
(`src/kb.ts`), which already heading-chunks every vault note, is already updated on every MCP write
(`selfIndexOnWrite`, `src/tools.ts:24`), and already sanitises queries. Add a plain `kb_note_meta`
side table (ticket / type / date per file) for ticket filtering and session scoping. Route every write
tool through one `performWrite` pipeline: guard → scrub → write → read-back sha → index → ledger →
structured result. Add `read_state`/`write_state`, `find_related_work`, `validate_note_links`,
`get_write_ledger`. Replace hand-rolled frontmatter parsing with the `yaml` library.

## Metadata

| Field | Value |
|---|---|
| Type | BUG_FIX + ENHANCEMENT |
| Complexity | HIGH (16 items, 9 files touched, 6 new modules) |
| Confidence | 8/10 for one-pass (main risks: native-module ABI in tests, FTS5 table migration) |
| Ticket | none — tag `[ultimate-obsidian-mcp]` |
| Systems | `ultimate-obsidian-mcp` only |

## Intelligence Context

**Ticket**: none (repo tag `ultimate-obsidian-mcp`)
**Branch**: `main` at plan time → implement on `feat/prp-flow-hardening`
**Memory sessions loaded**: 1 related report (fit review, 2026-09-28); prior plans `02-Notes/Plans/2026-04/ultimate-obsidian-mcp.plan.md`, `specs/image-attachments-on-writes/plan.md`

### Acceptance Criteria (authoritative — verbatim from the request)

**Bugs**
- AC-B1 `search_sessions` errors on ticket IDs … `SEATHQ-9999` fails with `no such column: 9999`, and a path fails with `fts5: syntax error near "/"` … sessions search doesn't [sanitise].
- AC-B2 Quotes in frontmatter end up in folder names … `ticket: "SIT-14683"` created the folder `~/.claude/memory/"SIT-14683"/` … searching by ticket misses them.
- AC-B3 `index_note` needs a full filesystem path, but the skills pass `~/...` … When a note has no ticket it also files it under `GENERAL`, which pr-description explicitly forbids.
- AC-B4 Searching all tickets isn't ranked across tickets … Whichever folders are listed first win, whatever the relevance.

**Additions**
- AC-A1 Index session notes automatically on write … removes the separate `index_note` call.
- AC-A2 Enforce the vault-writing rules in the server … allowed write folders, month folders for Plans/Reports, and redacting secrets before a write.
- AC-A3 Add `write_state` / `read_state` tools for `.state.md` files … check the JSON before saving and reject a write if the file changed since it was read.
- AC-A4 Add `find_related_work`. One ranked, de-duplicated search across Sessions/Plans/Reports/Tasks/Wiki by project code, ticket and keywords.
- AC-A5 Let `search_sessions` search only certain sections (Open Failures, Lessons, General Rules).
- AC-A6 Add a write log tool … the "empty list is a failure" check would be automatic.
- AC-A7 Add a link check. Verify that the note's typed links (`up`, `implements`, `affects`, `related`) point to notes that exist.
- AC-A8 Return structured results from write tools, such as `{ok, path, sha}`.

**Robustness**
- AC-R1 `manage_frontmatter` doesn't parse YAML. Lists and wikilinks are written unquoted, deleting a multi-line value leaves stray lines behind, and CRLF files look like they have no frontmatter.
- AC-R2 `move_note` is read + write + delete. That corrupts images and other binary files[.] (link rewriting: excluded — see Clarifications)
- AC-R3 Search can time out … hard 10-second timeout.
- AC-R4 `sqlite.ts` has no tests … hyphen query, the quoted ticket and the `~` path.

### Clarifications (Session 2026-09-28 — user answers)
- Write guard → **warn by default**; `OBSIDIAN_WRITE_GUARD=strict` rejects, `=off` disables.
- Secrets → **redact to `[REDACTED]` and write**, report count.
- `move_note` → **binary-safe only**; no wikilink rewriting.
- Shipping → **one plan, sliced** (S0 → US1 bugs → US2 writes → US3 state → US4 discovery → US5 robustness).

### QA Context (prior failures)
none (no ticket)

### Hard boundaries (NOT in scope)
- Wikilink rewriting on move; overwrite-protection on move destination.
- `read_section`, recursive/glob `list_vault`, stale-session (30-day) flag — suggested in the fit report but not in this request.
- Validating `.state.md` JSON against `orchestration-state.schema.json` (only "valid JSON object" is checked).
- Retry/backoff on network errors (only configurable timeouts).
- Deleting the legacy `~/.claude/memory/<TICKET>/session_index.db` dirs (left in place, reported by `reindex_kb`).
- Editing the codebase-intelligence plugin docs that name the old per-ticket DB path / `index_note` absolute-path usage — follow-up in that repo.
- Creating frontmatter when a note has none (`manage_frontmatter set` keeps its current "no frontmatter" error).
- Link checks run inside writes (tool only).

### Assumptions (unresolved unknowns)
- The KB index is built on every machine at SessionStart (`kb-cli.ts` catch-up hook). search_sessions now depends on it and returns the same `KB index not built … run reindex_kb` error as `search_kb` otherwise.
- Legacy session notes outside `02-Notes/Sessions/` live under `wiki/tasks/` (all 6 quoted-dir DBs point there, verified via `sqlite3`). Default session prefixes = `02-Notes/Sessions/,wiki/tasks/`, overridable by `CI_SESSION_PREFIXES`; notes with frontmatter `type: session` are always in scope.
- The write ledger is a local JSONL of write *metadata* (path, sha, time), not a copy of any vault artifact, so it does not violate the vault-persistence no-local-mirror rule.
- Parallel teammates each spawn their own MCP process, so CAS locking and the ledger must be cross-process (filesystem), not in-memory.

### KB Principles applied
- Reuse the existing FTS5 engine and its query sanitiser instead of a second index — single source of derived state (`src/kb.ts` header comment: "DERIVED, local … pure deterministic function of the markdown").
- One write boundary (prior plan, `specs/image-attachments-on-writes/plan.md` "Rejected alternative — fs.copyFile"): every vault mutation stays on `ObsidianClient`; only derived indexes touch the filesystem.
- KB search returned no domain principles beyond prior plans for this repo — "KB not consulted for FTS/YAML domain beyond project history".

### Context7 Library Facts

#### @modelcontextprotocol/sdk@1.29.0 (installed)
- `CallToolResult = { content: ContentBlock[]; structuredContent?: unknown; isError?: boolean }` — confirmed ✅
- `Tool.outputSchema?: { [key: string]: unknown }` (JSON-schema-shaped object) — confirmed ✅
- Gotcha: if a tool declares `outputSchema`, `structuredContent` MUST be present on every non-error result (McpServer validates; clients may too). Keep the text block as well — text-only consumers read `content`.

#### Obsidian Local REST API (openapi)
- `PUT /vault/{filename}` accepts any Content-Type (binary upload) — confirmed ✅ (prior plan)
- `POST /commands/{commandId}/` 204 — confirmed ✅; **no rename/move endpoint exists** in the spec — confirmed ✅ (move stays read→write→delete).
- `GET /vault/{filename}` with `responseType: "arraybuffer"` returning raw bytes for non-markdown — UNVERIFIED — confirm at implement time (axios option is standard; server behaviour for binary GET to be tested against a real `.png`).

#### yaml (eemeli) — new dependency `yaml@^2`
- `parseDocument(str): Document` — confirmed ✅; `doc.toString()` preserves comments/order, throws if `doc.errors` non-empty — confirmed ✅; `doc.toJS()` — confirmed ✅
- `doc.set(key, value)`, `doc.delete(key)`, `doc.get(key)` — UNVERIFIED — confirm at implement time
- Exact latest 2.x version — UNVERIFIED — confirm at implement time (`npm view yaml version`)

#### better-sqlite3@^9.6.0 (installed)
- `bm25(table)` + `snippet(table, col, '**','**','...',64)` already used in-repo (`src/kb.ts:303`, `src/sqlite.ts:118`) — confirmed by code
- Gotcha: native module in `node_modules` is built for Node 20 (ABI 115). `npm test` under the default Node 23 fails with `NODE_MODULE_VERSION 115 … requires 131`. Run gates with Node 20: `PATH=$HOME/.nvm/versions/node/v20.20.0/bin:$PATH`.

### Prior session decisions
- 2026-09-28 fit review: fixes P0 first; enforce persistence rules at the MCP boundary.
- Image-attachments plan: tests are `node:test` + `node:assert`, zero test deps; handlers tested with a fake `ObsidianClient` (`src/tools.test.ts:21`).

### Discovery source summary
| Category | File:Line | Source |
|---|---|---|
| FLOW | `src/tools.ts:295` `handleTool` switch dispatch | explorer (direct read) |
| FLOW | `src/tools.ts:24` `selfIndexOnWrite` best-effort KB index | direct read |
| FLOW | `src/index.ts:757` wraps handler result as `{content}` / `isError` | direct read |
| QUERY | `src/kb.ts:280` `buildMatchExpr` sanitiser | direct read |
| BUG | `src/sqlite.ts` `searchSessions` raw `MATCH ?` + per-DB LIMIT | direct read + sqlite3 repro |
| BUG | `src/sqlite.ts` `parseFrontmatter` no quote strip; `indexNote` `existsSync(vaultPath)`, `?? "GENERAL"` | direct read + `ls ~/.claude/memory` |
| FM | `src/tools.ts:393` line-based frontmatter edit | direct read |
| MOVE | `src/client.ts` `moveFile` via `getFile` (text) | direct read |
| TIMEOUT | `src/client.ts` `timeout: 10000` | direct read |
| TEST | `src/tools.test.ts:21` fake client pattern; `npm test` = 25 pass on Node 20 | run |
| CONTRACT | `shared/vault-persistence.md` write-scope list, month buckets, typed keys | plugin docs |
| CONTRACT | `shared/secret-scrub.md` grep predicate | plugin docs |
| CONTRACT | `skills/mediator/SKILL.md` `.state.md` = frontmatter + one fenced `json` block | plugin docs |

## UX Design

### Before
```
agent ──search_sessions("SEATHQ-9999")──▶ per-ticket DBs ──▶ ✗ "no such column: 9999"
agent ──create_or_update_note(session)──▶ REST write ──▶ KB index   (sessions DB NOT updated)
agent ──index_note("~/Documents/…")────▶ ✗ File not found            (or ticket=GENERAL)
agent ──create_or_update_note(.state.md, overwrite)──▶ blind overwrite (lost update possible)
agent ──write──▶ "OK: overwrite → path"   (text only; no sha; no scope/scrub; no ledger)
```

### After
```
agent ──search_sessions(q, ticket?, sections?)──▶ KB index (session scope, global bm25) ──▶ ranked hits
agent ──any write──▶ performWrite: guard(warn|strict) → scrub → REST write → read-back sha
                                   → KB index (+note meta) → ledger ──▶ {ok,path,sha,warnings,redactions}
agent ──read_state / write_state(expected_sha)──▶ lock → compare sha → write | ✗ sha_mismatch
agent ──find_related_work(project,ticket,keywords)──▶ one ranked, deduped list of wikilinks
agent ──validate_note_links(path)──▶ {ok, dangling[]}
agent ──get_write_ledger(since)──▶ {count, empty, entries[]}
```

| Location | Before | After | Impact |
|---|---|---|---|
| `search_sessions` | crashes on `-` `/`; per-DB ranking | sanitised, globally ranked, `sections` filter | orchestrate Step V works |
| `index_note` | absolute path only, `GENERAL` fallback | vault-relative / `~` / absolute; ticket→filename→project→stem | pr-description call works |
| write tools | text `OK:` line | same text line + `structuredContent` | skills verify mechanically |
| new tools | — | `read_state` `write_state` `find_related_work` `validate_note_links` `get_write_ledger` | fewer calls, no lost updates |

## Mandatory Reading

| File | Why |
|---|---|
| `src/tools.ts` (all) | every handler changes; TOOLS registry + zod→JSON-schema helper |
| `src/kb.ts` (all) | index engine being extended |
| `src/sqlite.ts` (all) | being replaced |
| `src/client.ts` (all) | move/binary/timeout |
| `src/tools.test.ts` | test + fake-client pattern to mirror |
| `src/index.ts` | result passthrough |
| plugin `shared/vault-persistence.md`, `shared/secret-scrub.md`, `skills/mediator/SKILL.md` §state | rules the server now enforces |

## Patterns to Mirror

- **Env-configured paths, read per call** — `src/kb.ts:52` `getKbDbPath()` reads `CI_KB_INDEX` each call (testable). `src/sqlite.ts:13` computes `MEMORY_ROOT` at import — do not copy that.
- **Best-effort derived index** — `src/tools.ts:24` `selfIndexOnWrite`: index failure never fails the write.
- **Validate-everything-before-first-byte** — `src/attachments.ts` header comment + `uploadAttachments` (`src/tools.ts:38`).
- **Tests** — `node:test`, `assert/strict`, temp dirs via `mkdtempSync(join(tmpdir(), …))`, fake client recording calls (`src/tools.test.ts:1-45`).
- **Errors** — tool errors as thrown `Error` → `src/index.ts:761` wraps as `isError: true`.

## Constitution Check

No `.claude/constitution.md` in this repo — gates are advisory, recorded for the eventual one.

```
G-SIMPLICITY       : ⚠️ — new modules: paths.ts, fts.ts, frontmatter.ts, writes.ts, state.ts, links.ts
                        (each has ≥2 consumers or is a named requirement; sqlite.ts shrinks to a thin facade)
G-ANTI-ABSTRACTION : ✅ — no classes/interfaces hierarchies; plain functions over plain data.
                        performWrite has 5 consumers (create_or_update_note, patch_note,
                        search_replace_in_note, manage_frontmatter, move_note)
G-INTEGRATION-FIRST: ✅ — contracts K1–K5 frozen in S0 with failing tests before consumers
```

## Complexity Tracking

| Violation | Why needed | Simpler alternative rejected because |
|---|---|---|
| `kb_note_meta` side table + KB `schema_version` forced rebuild | ticket filter + session scope need per-file metadata; FTS5 virtual tables cannot `ALTER TABLE ADD COLUMN` | keeping per-ticket DBs keeps AC-B2 (quoted dirs) and AC-B4 (bm25 scores from different corpora are not comparable), and needs a second write hook for AC-A1 |
| New runtime dependency `yaml` | AC-R1 requires real YAML (lists, multi-line values, quoting `[[…]]`) | extending the line-based parser is exactly what produced AC-R1's three defects; `js-yaml` rejected because `yaml.parseDocument` preserves comments and key order on round-trip |
| Cross-process lockfile for `write_state` | AC-A3 "reject a write if the file changed since it was read" across teammate MCP processes | read-compare-write without a lock has a TOCTOU window between two processes; in-memory mutex does not span processes |

## Contracts

| id | interface | file | provides | consumes | contract test |
|---|---|---|---|---|---|
| K1 | `resolveVaultPath(input): { rel: string; abs: string }` — accepts vault-relative, `~/…`, or absolute-inside-vault; throws `Path outside vault` otherwise | `src/paths.ts` | S0 | sqlite.ts (index_note), kb.ts, links.ts | `npm test -- --test-name-pattern=K1` |
| K2 | `buildMatchExpr(q)` (moved, re-exported from kb.ts) + `buildPhraseMatchExpr(q)`: raw terms with non-alnum chars become quoted phrases of their alnum parts (`SEATHQ-9999` → `"seathq 9999"`), others as today; OR-joined; never throws | `src/fts.ts` | S0 | kb.ts (search_kb, search_sessions, find_related_work) | `…=K2` |
| K3 | `parseFrontmatter(content): { data: Record<string, unknown>; hasFrontmatter: boolean; eol: "\n"\|"\r\n" }`, `setFrontmatterKey(content, key, value: unknown): string`, `deleteFrontmatterKey(content, key): string`, `fmString(v: unknown): string \| undefined` | `src/frontmatter.ts` | S0 | kb.ts meta, sqlite.ts, tools.ts manage_frontmatter, links.ts | `…=K3` |
| K4 | `interface WriteResult { ok: true; path: string; op: string; sha: string; bytes: number; warnings: string[]; redactions: number; attachments: string[] }`; `guardPath(path): string[]` (throws in strict); `scrubSecrets(s): { content: string; redactions: number }`; `appendLedger(e)`; `readLedger({ since?, pathPrefix? })` | `src/writes.ts` | S0 | tools.ts, state.ts | `…=K4` |
| K5 | `handleTool(...) : Promise<ToolResult>` where `ToolResult = { content: ToolContent; structuredContent?: Record<string, unknown> }` | `src/tools.ts` | S0 | index.ts, all tests | `…=K5` |

Each contract test is written first and must fail (module/symbol missing) before its implementation task.

## Files to Change

| File | Action | Lane | Tasks |
|---|---|---|---|
| `package.json` | UPDATE (dep `yaml`) | core | T3 |
| `src/paths.ts` | CREATE | core | T1 |
| `src/fts.ts` | CREATE | core | T2 |
| `src/frontmatter.ts` | CREATE | core | T3 |
| `src/writes.ts` | CREATE | core | T4 (shape), T9 |
| `src/contracts.test.ts` | CREATE | qa | T1–T5 |
| `src/tools.ts` | UPDATE | tools | T5, T7, T10, T11, T13, T14, T15, T16 |
| `src/index.ts` | UPDATE | tools | T5 |
| `src/tools.test.ts` | UPDATE | qa | T5, T12, T17 |
| `src/kb.ts` | UPDATE | index | T6, T14 |
| `src/sqlite.ts` | UPDATE (thin facade) | index | T6 |
| `src/sqlite.test.ts` | CREATE | qa | T8 |
| `src/state.ts` | CREATE | core | T13 |
| `src/state.test.ts` | CREATE | qa | T13 |
| `src/links.ts` | CREATE | index | T15 |
| `src/discovery.test.ts` | CREATE | qa | T14, T15 |
| `src/client.ts` | UPDATE | client | T17 |
| `src/attachments.ts` | UPDATE (export `contentTypeFor`) | client | T17 |
| `src/client.test.ts` | CREATE | qa | T17 |
| `README.md` | UPDATE | docs | T18 |

## NOT Building

See Hard boundaries above. Additionally: no new MCP transport, no switch to `McpServer.registerTool` (low-level `Server` stays; `outputSchema` is added to the TOOLS entries by hand), no change to KB chunking or `search_kb` output shape.

## Step-by-Step Tasks

Order: contracts (S0) → US1 bugs+session search → US2 write safety → US3 state → US4 discovery → US5 robustness.
`tools.ts` and `kb.ts` are single-writer files: every task touching them is `parallel: false`.

### S0 — Contracts (foundational)

```
task:
  id: T1
  title: Create resolveVaultPath (K1) with failing contract test first
  story: foundational
  parallel: true
  files: [src/paths.ts, src/contracts.test.ts]
  why: AC-B3 — index_note must accept ~ and vault-relative paths
  ac_mapping: [AC-B3, AC-R4]
  mirror: src/kb.ts:30 getVaultRoot() (env per call)
  imports: [os.homedir, path.{isAbsolute,join,normalize,relative,resolve,sep}, ./kb.js getVaultRoot]
  expected_gate: PATH=$HOME/.nvm/versions/node/v20.20.0/bin:$PATH npm test -- --test-name-pattern=K1
  gotchas:
    - getVaultRoot lives in kb.ts; import it, do not duplicate DEFAULT_VAULT
    - reject rel paths that start with ".." after normalize (vault escape)
    - "~" alone and "~/x" only; do not expand "~user"
  blast_radius: green
  steps:
    1. Write K1 tests in src/contracts.test.ts: "02-Notes/a.md" → rel same, abs = root/rel; "~/…/Vault/02-Notes/a.md" with OBSIDIAN_VAULT_PATH=that root → rel "02-Notes/a.md"; "/etc/passwd" → throws /outside vault/; "../x.md" → throws. Run: fails (module missing).
    2. Implement resolveVaultPath: expand leading "~/" via homedir; if absolute → rel = relative(root, abs) and reject if it starts with ".." or isAbsolute; else rel = normalize(input) and reject leading ".."; return posix rel.
    3. Gate green.
```

```
task:
  id: T2
  title: Move buildMatchExpr to fts.ts and add buildPhraseMatchExpr (K2)
  story: foundational
  parallel: true
  files: [src/fts.ts, src/contracts.test.ts]
  why: AC-B1 — hyphenated IDs and paths must not reach FTS5 as syntax
  ac_mapping: [AC-B1, AC-R4]
  mirror: src/kb.ts:268-287 (STOPWORDS + buildMatchExpr)
  imports: []
  expected_gate: PATH=$HOME/.nvm/versions/node/v20.20.0/bin:$PATH npm test -- --test-name-pattern=K2
  gotchas:
    - T2 only CREATES fts.ts; kb.ts re-export happens in T6 (kb.ts is lane "index") — until then fts.ts duplicates the function body, T6 deletes the kb.ts copy
    - phrase parts use the same [a-z0-9]{2,} rule; drop 1-char parts; a phrase with 1 part degrades to a bare token
    - phrases are never prefix-starred
  blast_radius: green
  steps:
    1. K2 tests: buildPhraseMatchExpr("SEATHQ-9999") === '"seathq 9999"'; ("02-Notes/Sessions") === '"02 notes sessions"'; ("auth fix SEATHQ-1") contains 'auth' and '"seathq 1"'? (1-char part dropped → 'seathq*'); ("") === ""; ('"; DROP') never throws and has no raw quote except phrase delimiters. Fails first.
    2. Implement: split on whitespace; per raw term: parts = lower().match(/[a-z0-9]{2,}/g) minus STOPWORDS; if raw term had any non-alnum separator and parts.length ≥ 2 → `"${parts.join(" ")}"`; else each part as buildMatchExpr does (prefix `*` when ≥4). Dedupe; join " OR ".
    3. Copy buildMatchExpr + STOPWORDS verbatim into fts.ts and export both.
```

```
task:
  id: T3
  title: Create YAML-backed frontmatter module (K3) and add yaml dependency
  story: foundational
  parallel: true
  files: [src/frontmatter.ts, src/contracts.test.ts, package.json]
  why: AC-B2 (quote stripping), AC-R1 (lists, wikilinks, multi-line delete, CRLF)
  ac_mapping: [AC-B2, AC-R1, AC-R4]
  mirror: src/tools.ts:397 current fence regex (to replace)
  imports: [yaml.parseDocument]
  expected_gate: PATH=$HOME/.nvm/versions/node/v20.20.0/bin:$PATH npm test -- --test-name-pattern=K3
  gotchas:
    - confirm doc.set/doc.delete/doc.get exist in installed yaml 2.x (UNVERIFIED in plan)
    - fence regex must accept \r\n: /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/
    - on write, restore the original eol for the frontmatter block; body bytes untouched
    - parse errors (invalid YAML) → hasFrontmatter true, data {} and setFrontmatterKey throws "Invalid frontmatter YAML: …" (never silently rewrite a broken block)
    - Obsidian dates: `date: 2026-09-28` must stay a string → parseDocument default (core schema) keeps it a string; assert in test
  blast_radius: yellow
  steps:
    1. npm install yaml@^2 (record exact version in the report).
    2. K3 tests: ticket: "SIT-14683" → fmString === "SIT-14683"; ticket: "" → fmString undefined; CRLF file detected with eol "\r\n"; set tags ["a","[[B]]"] → re-parse yields array and serialized text quotes "[[B]]"; delete a key whose value is a 3-line block list leaves no "- " orphans; comments and other keys' order preserved; date stays "2026-09-28". Fail first.
    3. Implement with parseDocument on the normalised (\n) block; setFrontmatterKey/deleteFrontmatterKey rebuild "---{eol}{yaml}---{eol}" + untouched body.
    4. fmString: string → trimmed, "" → undefined; number → String(v); else undefined.
```

```
task:
  id: T4
  title: Freeze WriteResult + writes.ts signatures (K4) as stubs with failing tests
  story: foundational
  parallel: true
  files: [src/writes.ts, src/contracts.test.ts]
  why: AC-A2, AC-A6, AC-A8 share one result/guard/ledger shape
  ac_mapping: [AC-A2, AC-A6, AC-A8]
  mirror: src/attachments.ts exported interfaces style
  imports: []
  expected_gate: PATH=$HOME/.nvm/versions/node/v20.20.0/bin:$PATH npm test -- --test-name-pattern=K4
  gotchas:
    - stubs throw "not implemented" so K4 behaviour tests fail until T9
  blast_radius: green
  steps:
    1. Export WriteResult interface and the four function signatures from K4 with `throw new Error("not implemented")` bodies.
    2. K4 tests (behavioural, filled by T9): guardPath("02-Notes/Reports/x.md") → 1 warning mentioning "month"; guardPath("02-Notes/Reports/2026-09/x.md") → []; guardPath("99-Random/x.md") → 1 warning "outside write-scope"; strict mode throws; scrubSecrets('api_key: abc123') → content 'api_key: [REDACTED]', redactions 1. Fail now.
```

```
task:
  id: T5
  title: Change handleTool to return ToolResult (K5) and pass structuredContent through index.ts
  story: foundational
  parallel: false
  files: [src/tools.ts, src/index.ts, src/tools.test.ts]
  why: AC-A8 — structured results need a return channel beside text
  ac_mapping: [AC-A8]
  mirror: src/index.ts:757-764
  imports: []
  expected_gate: PATH=$HOME/.nvm/versions/node/v20.20.0/bin:$PATH npm test
  gotchas:
    - every existing `return text(...)` becomes `return { content: text(...) }` — mechanical; text strings unchanged byte-for-byte (skills parse "OK: …")
    - update the 25 existing tests from out[0].text to out.content[0].text; they must stay green
  blast_radius: yellow
  steps:
    1. Add `export interface ToolResult { content: ToolContent; structuredContent?: Record<string, unknown> }`.
    2. Wrap every return; index.ts returns `{ content: r.content, ...(r.structuredContent ? { structuredContent: r.structuredContent } : {}) }`.
    3. Update tools.test.ts accessors; full suite green.
```

### US1 (P1) — Session search and indexing are correct (bugs 1–4, A1, A5, R4)

Independent Test: in a temp vault with a session note `02-Notes/Sessions/SEATHQ-9999-x.md` (`ticket: "SEATHQ-9999"`, sections `## Open Failures`, `## Lessons`) and another ticket's note, `search_sessions({query:"SEATHQ-9999"})` returns the SEATHQ-9999 note first without error; `ticket:"SEATHQ-9999"` filters to it; `sections:["Open Failures"]` returns only chunks under that heading; writing a new session note via `create_or_update_note` makes it searchable with no `index_note` call; `index_note({vault_path:"02-Notes/Sessions/…"})` and `"~/…"` both succeed.

```
task:
  id: T6
  title: Extend KB index with kb_note_meta, schema_version, and session search
  story: US1
  parallel: false
  files: [src/kb.ts, src/sqlite.ts]
  why: AC-B1/B2/B4 + AC-A1/A5 — one globally ranked, auto-updated, section-aware index
  ac_mapping: [AC-B1, AC-B2, AC-B4, AC-A1, AC-A5]
  mirror: src/kb.ts:62 openKbDb (CREATE IF NOT EXISTS), :150 indexFileInto, :289 searchKb
  imports: [./fts.js {buildMatchExpr, buildPhraseMatchExpr}, ./frontmatter.js {parseFrontmatter, fmString}, ./paths.js resolveVaultPath]
  expected_gate: PATH=$HOME/.nvm/versions/node/v20.20.0/bin:$PATH npm test -- --test-name-pattern=US1
  gotchas:
    - kb_note_meta(path TEXT PRIMARY KEY, ticket TEXT, type TEXT, date TEXT, project TEXT) is a PLAIN table; delete its row wherever kb_files rows are deleted (prune loop :250)
    - kb_meta 'schema_version' < 2 ⇒ reindexVault forces a full rebuild once, then writes 2. indexVaultFile on a v1 DB must still work (writes meta for that file)
    - ticket resolution order (AC-B3 "never GENERAL"): fmString(ticket) → filename match /^([A-Z][A-Z0-9]+-\d+)/ → fmString(project) → filename stem. Store upper-case ticket when it matches the ID regex
    - session scope SQL: m.type = 'session' OR path LIKE prefix% for each CI_SESSION_PREFIXES entry (default "02-Notes/Sessions/,wiki/tasks/"); read env per call
    - ranking: SELECT … bm25(kb) score … ORDER BY score LIMIT limit*5, then dedupe by source_relpath keeping best chunk, slice(limit). One DB ⇒ one corpus ⇒ comparable scores (AC-B4)
    - sections filter: heading_path's top-level segment after the H1, i.e. match any breadcrumb segment exactly (heading_path split " > ") case-insensitively; with sections set, do NOT dedupe by file (return chunks)
    - query uses buildPhraseMatchExpr; empty expr ⇒ []
    - kb.ts keeps `export { buildMatchExpr } from "./fts.js"`; delete its local copy + STOPWORDS
    - CI_KB_EXCLUDE could exclude session notes — document, do not special-case
  blast_radius: yellow
  steps:
    1. Add meta table + schema_version to openKbDb; write meta inside indexFileInto from parseFrontmatter(content).
    2. Export `searchSessionsKb(query, { ticket?, sections?, limit? }): SessionHit[]` where SessionHit = { path, ticket, date, heading_path, snippet, score }. Throw same "KB index not built … run reindex_kb" error as searchKb when DB missing.
    3. Export `removeVaultFile(relpath)` (delete kb + kb_files + kb_note_meta rows) for delete/move.
    4. In reindexVault summary add `legacySessionDirs: number` = count of dirs under ~/.claude/memory containing session_index.db (report only; never delete).
    5. Rewrite src/sqlite.ts as a thin facade: `searchSessions(query, ticket="all", limit=5, sections?)` → searchSessionsKb; `indexNote(input)` → resolveVaultPath, indexVaultFile(abs), then keyword frontmatter update via setFrontmatterKey(content,"keywords",[…]) written with writeFileSync (existing behaviour — explicit index_note only, never on auto-index). Return "Indexed <ticket> → <rel>\nKeywords: …". Drop per-ticket DB code.
```

```
task:
  id: T7
  title: Wire search_sessions sections param + index_note path forms + auto-index prune on delete/move
  story: US1
  parallel: false
  files: [src/tools.ts]
  why: AC-A5 tool surface; AC-B3 path forms; AC-A1 consistency on delete/move
  ac_mapping: [AC-A5, AC-B3, AC-A1]
  mirror: src/tools.ts:154 SearchSessionsInput, :434 search_sessions handler
  imports: [./kb.js removeVaultFile]
  expected_gate: PATH=$HOME/.nvm/versions/node/v20.20.0/bin:$PATH npm test -- --test-name-pattern=US1
  gotchas:
    - keep output line format `N. [[stem]] — date\n   snippet`; append ` § heading_path` when sections given
    - zodToJsonSchema helper handles z.array(z.string()) already (src/tools.ts:505)
    - update tool descriptions: search_sessions no longer "~/.claude/memory"; index_note "vault-relative, ~/…, or absolute path"
    - delete_note/move_note call removeVaultFile(source) best-effort (try/catch like selfIndexOnWrite)
  blast_radius: green
  steps:
    1. Add `sections: z.array(z.string()).optional()` to SearchSessionsInput; pass through.
    2. Rename IndexNoteInput description; handler unchanged call.
    3. Add best-effort removeVaultFile to delete_note and move_note (source) handlers.
```

```
task:
  id: T8
  title: sqlite/session tests — hyphen, path query, quoted ticket, ~ path, ranking, sections, auto-index
  story: US1
  parallel: true
  files: [src/sqlite.test.ts]
  why: AC-R4 + US1 Independent Test
  ac_mapping: [AC-R4, AC-B1, AC-B2, AC-B3, AC-B4, AC-A1, AC-A5]
  mirror: src/tools.test.ts:1-45 (temp dir + fake client)
  imports: [node:test, node:assert/strict, fs, os, path, ./sqlite.js, ./kb.js, ./tools.js]
  expected_gate: PATH=$HOME/.nvm/versions/node/v20.20.0/bin:$PATH npm test -- --test-name-pattern=US1
  gotchas:
    - set OBSIDIAN_VAULT_PATH, CI_KB_INDEX, CI_SESSION_PREFIXES to temp paths BEFORE calls (env read per call — T1/T6 guarantee this)
    - auto-index test: fake client whose createOrUpdateFile writes the file into the temp vault on disk, then selfIndexOnWrite picks it up
    - name every test with prefix "US1" so the pattern gate selects them
  blast_radius: green
  steps:
    1. Fixture: temp vault with SEATHQ-9999 session (quoted ticket, two sections), SEATHQ-1000 session mentioning "9999" once, a plan note (not session scope); reindexVault({force:true}).
    2. Tests: "SEATHQ-9999" no throw + first hit is SEATHQ-9999 note; "02-Notes/Sessions" no throw; ticket filter "SEATHQ-9999" matches quoted-frontmatter note; ranking across tickets = by score not insertion order; sections ["Open Failures"] only that heading; plan note never returned; indexNote("02-Notes/…"), indexNote("~/…" via HOME-relative temp root) succeed; untagged note stem fallback ≠ "GENERAL"; create_or_update_note of a new session note then search finds it without indexNote.
```

**Checkpoint US1** — demoable: orchestrate Step V `search_sessions` on a ticket ID works.

### US2 (P2) — Writes are guarded, scrubbed, verifiable, and logged (A2, A6, A8)

Independent Test: `create_or_update_note({filepath:"02-Notes/Reports/x.md", content:"api_key: sk-abc…", mode:"overwrite"})` succeeds with `structuredContent.warnings` containing a month-bucket warning, `redactions: 1`, a 64-hex `sha`, the stored text containing `[REDACTED]`; with `OBSIDIAN_WRITE_GUARD=strict` the same call errors and writes nothing; `get_write_ledger({since})` lists the write; with no writes it returns `empty: true`.

```
task:
  id: T9
  title: Implement guardPath, scrubSecrets, ledger in writes.ts
  story: US2
  parallel: true
  files: [src/writes.ts]
  why: AC-A2 (scope, month bucket, redaction), AC-A6 (ledger)
  ac_mapping: [AC-A2, AC-A6]
  mirror: plugin shared/vault-persistence.md write-scope case list; shared/secret-scrub.md predicate
  imports: [fs.{appendFileSync,readFileSync,existsSync,mkdirSync,statSync,renameSync}, os.homedir, path]
  expected_gate: PATH=$HOME/.nvm/versions/node/v20.20.0/bin:$PATH npm test -- --test-name-pattern=K4
  gotchas:
    - scope default = "02-Notes/Sessions/,02-Notes/Plans/,02-Notes/Reports/,02-Notes/Specs/,02-Notes/pr-descriptions/,03-Systems/"; OBSIDIAN_WRITE_SCOPE overrides (comma list); mode from OBSIDIAN_WRITE_GUARD = warn (default) | strict | off
    - month rule: a FILE directly under 02-Notes/Plans/ or 02-Notes/Reports/ (no subfolder) ⇒ warning "not month-bucketed: expected 02-Notes/Reports/YYYY-MM/<name>". Subfolders (Weekly/, completed/2026-04/, SEATHQ-…/) pass
    - redact VALUES, never bare words ("tokenizer", "password reset flow" must survive). Patterns:
        (api[_-]?key|secret|token|password|passwd)(["']?\s*[:=]\s*["']?)([^\s"',}]{4,}) → keep $1$2, value → [REDACTED]  (keeps JSON valid)
        Bearer\s+[A-Za-z0-9._~+/=-]{16,}; -----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----;
        ([a-z][a-z0-9+.-]*://)[^\s:/@]+:[^\s@]+@ → $1[REDACTED]@; AKIA[0-9A-Z]{16}; gh[pousr]_[A-Za-z0-9]{36,}; sk-[A-Za-z0-9_-]{20,}; xox[abprs]-[A-Za-z0-9-]{10,}
      value already "[REDACTED]" is not re-counted. OBSIDIAN_SECRET_SCRUB=off disables
    - ledger path CI_WRITE_LEDGER default ~/.claude/memory/write-ledger.jsonl; one JSON line {ts, tool, path, op, sha, pid}; rotate to .1 when > 5 MB; appendLedger never throws (best-effort, like selfIndexOnWrite)
    - readLedger since default = process start time (module-load Date) so "this session" works per MCP process
  blast_radius: yellow
  steps:
    1. Implement guardPath returning warnings; strict ⇒ throw Error("Write blocked: " + warnings.join("; ")).
    2. Implement scrubSecrets with the pattern list; return count.
    3. Implement appendLedger/readLedger (filter ts ≥ since, path startsWith prefix).
    4. Extend K4 tests: prose "tokenizer" untouched; JSON `{"token": "abcd1234"}` stays JSON.parse-able after scrub; Weekly/ subfolder no warning; OBSIDIAN_WRITE_SCOPE override; ledger rotate.
```

```
task:
  id: T10
  title: performWrite pipeline + structured results on every write tool
  story: US2
  parallel: false
  files: [src/tools.ts]
  why: AC-A2 enforcement point, AC-A8 {ok,path,sha}
  ac_mapping: [AC-A2, AC-A8, AC-A6]
  mirror: src/tools.ts:318-338 (create_or_update_note / patch_note handlers)
  imports: [crypto.createHash, ./writes.js {guardPath, scrubSecrets, appendLedger, type WriteResult}]
  expected_gate: PATH=$HOME/.nvm/versions/node/v20.20.0/bin:$PATH npm test -- --test-name-pattern=US2
  gotchas:
    - order: guardPath (may throw BEFORE any byte) → scrub content → uploadAttachments → client write → read-back getFile → sha256(hex) of read-back → selfIndexOnWrite → appendLedger → result
    - read-back failure after a successful write ⇒ result ok:true with sha "" and warning "read-back failed" (write happened; do not report failure)
    - text first line stays exactly as today ("OK: overwrite → path", attachment lines); append " ⚠ N warning(s)" / " (redacted N)" suffix lines only when non-zero so existing tests still match their exact strings
    - apply to create_or_update_note, patch_note, search_replace_in_note (scrub updated content), manage_frontmatter (T16 reuses), move_note dest (guard dest)
    - add outputSchema (hand-written JSON schema of WriteResult) to those TOOLS entries; structuredContent present on every non-error return
    - fake client in tests needs getFile — extend fakeClient in tools.test.ts (T12)
  blast_radius: yellow
  steps:
    1. Write `async function performWrite(tool, filepath, content, doWrite: (c) => Promise<void>, client, attachments?)` returning ToolResult.
    2. Route the five handlers through it.
    3. Add outputSchema constant WRITE_RESULT_SCHEMA and attach to TOOLS entries.
```

```
task:
  id: T11
  title: get_write_ledger tool
  story: US2
  parallel: false
  files: [src/tools.ts]
  why: AC-A6 — "empty list is a failure" becomes mechanical
  ac_mapping: [AC-A6]
  mirror: src/tools.ts:169 SearchKbInput + :452 handler
  imports: [./writes.js readLedger]
  expected_gate: PATH=$HOME/.nvm/versions/node/v20.20.0/bin:$PATH npm test -- --test-name-pattern=US2
  gotchas:
    - input { since?: string (ISO), path_prefix?: string }; invalid ISO ⇒ error text, not throw from Date
    - structuredContent { count, empty, entries } ; text = one "path — op — sha[0:8]" line per entry, or "(no writes since …)"
  blast_radius: green
  steps:
    1. Add schema + TOOLS entry + handler.
```

```
task:
  id: T12
  title: US2 tests — guard warn/strict/off, scrub, sha, ledger, unchanged text lines
  story: US2
  parallel: false
  files: [src/tools.test.ts]
  why: US2 Independent Test
  ac_mapping: [AC-A2, AC-A6, AC-A8]
  mirror: src/tools.test.ts:21 fakeClient
  imports: [crypto]
  expected_gate: PATH=$HOME/.nvm/versions/node/v20.20.0/bin:$PATH npm test
  gotchas:
    - fakeClient gains an in-memory file map: createOrUpdateFile/putBinary store, getFile reads (so read-back sha is deterministic)
    - set CI_WRITE_LEDGER to a temp file per test file
    - prefix names "US2"; all 25 original tests still green
  blast_radius: green
  steps:
    1. Tests per Independent Test above + strict blocks with zero client calls + off mode no warnings + sha equals sha256 of stored content.
```

**Checkpoint US2** — demoable: every write returns `{ok,path,sha,warnings,redactions}`; ledger lists writes.

### US3 (P3) — State notes cannot lose updates (A3)

Independent Test: `write_state` with `expected_sha: null` creates `02-Notes/Sessions/X.state.md`; `read_state` returns `{exists:true, sha, frontmatter, state}`; a second `write_state` with the stale sha fails with `sha_mismatch` and the note is unchanged; a write with a non-object `state` or a filepath not ending `.state.md` is rejected before any client call.

```
task:
  id: T13
  title: state.ts (parse/serialise fenced json, lock, CAS) + read_state / write_state tools
  story: US3
  parallel: false
  files: [src/state.ts, src/state.test.ts, src/tools.ts]
  why: AC-A3 — JSON checked before save; stale writer rejected
  ac_mapping: [AC-A3, AC-A8, AC-A2]
  mirror: plugin skills/mediator/SKILL.md state shape (frontmatter + one ```json fence)
  imports: [fs.{openSync,closeSync,unlinkSync,statSync,mkdirSync}, crypto.createHash, ./frontmatter.js, ./writes.js]
  expected_gate: PATH=$HOME/.nvm/versions/node/v20.20.0/bin:$PATH npm test -- --test-name-pattern=US3
  gotchas:
    - sha = sha256 of the FULL note text as read via client.getFile (same definition as WriteResult.sha, so a write_state result sha is valid as the next expected_sha)
    - read_state on a note with 0 or >1 ```json fences, or unparseable JSON ⇒ error naming the reason (never guess)
    - lock: ~/.claude/memory/locks/<sha1(filepath)>.lock via openSync(path,"wx"); stale after 30 s (unlink if mtime older); retry every 50 ms up to 5 s then error "state lock busy"; always unlink in finally
    - expected_sha null ⇒ note must not exist (checkExists) else sha_mismatch
    - serialise: frontmatter object via yaml stringify between --- fences, blank line, ```json\n JSON.stringify(state, null, 2) \n```\n
    - goes through scrub (JSON-safe per T9) + guard + ledger via performWrite core, mode overwrite
  blast_radius: yellow
  steps:
    1. state.ts: parseStateNote(text), renderStateNote(frontmatter, state), withLock(path, fn).
    2. Tools: read_state {filepath} → structuredContent {exists, sha, frontmatter, state}; write_state {filepath, frontmatter: object, state: object, expected_sha: string|null}. zodToJsonSchema needs z.record / z.null support — add ZodRecord → {type:"object"} and nullable → type [..,"null"] to buildNode.
    3. state.test.ts: create, read, stale sha rejected + content unchanged, lock contention (hold lock, second call waits then errors), invalid inputs rejected with zero client write calls.
```

**Checkpoint US3** — demoable: mediator can read-modify-write state safely.

### US4 (P4) — Discovery and link integrity (A4, A7)

Independent Test: temp vault with `02-Notes/Sessions/SEATHQ-5-a.md`, `02-Notes/Plans/2026-09/seathq-5-b.plan.md`, `02-Notes/Wiki/c.md` (mentions SEATHQ-5), `05-Other/d.md` (mentions SEATHQ-5): `find_related_work({ticket:"SEATHQ-5"})` returns a–c once each (deduped), ranked, never d, each with `[[stem]]` + folder + why-line; `validate_note_links` on a note with `up: "[[SEATHQ-5]]"` (missing) and `related: ["[[c]]"]` (present) reports exactly one dangling link.

```
task:
  id: T14
  title: find_related_work over the KB index
  story: US4
  parallel: false
  files: [src/kb.ts, src/tools.ts, src/discovery.test.ts]
  why: AC-A4 — one ranked, deduped call replacing 3–5
  ac_mapping: [AC-A4]
  mirror: src/kb.ts searchKb; T6 dedupe-by-file logic (reuse the helper, do not copy)
  imports: [./fts.js buildPhraseMatchExpr]
  expected_gate: PATH=$HOME/.nvm/versions/node/v20.20.0/bin:$PATH npm test -- --test-name-pattern=US4
  gotchas:
    - input {project?, ticket?, keywords?: string[], folders?: string[], limit? = 5}; at least one of project/ticket/keywords else error
    - folders default ["02-Notes/Sessions/","02-Notes/Plans/","02-Notes/Reports/","02-Notes/Tasks/","02-Notes/Wiki/"]; filter source_relpath LIKE prefix% (params, not string concat)
    - rank: bm25 best chunk per file; boost (score − 5) when meta.ticket == ticket or path contains ticket (case-insensitive); tiebreak kb_files.mtime desc
    - output item {wikilink:"[[stem]]", path, folder, date (meta.date or mtime ISO day), why: heading_path + ": " + snippet}
  blast_radius: green
  steps:
    1. kb.ts findRelatedWork(opts) sharing the dedupe helper from T6.
    2. Tool entry + handler (text list + structuredContent {items}).
    3. discovery.test.ts per Independent Test (prefix "US4").
```

```
task:
  id: T15
  title: validate_note_links (typed relation keys)
  story: US4
  parallel: false
  files: [src/links.ts, src/tools.ts, src/discovery.test.ts]
  why: AC-A7 — typed links must resolve
  ac_mapping: [AC-A7]
  mirror: plugin shared/vault-persistence.md "Typed frontmatter" (up, documents, implements, affects, related)
  imports: [./frontmatter.js parseFrontmatter, ./kb.js (kb_files path list accessor), ./paths.js]
  expected_gate: PATH=$HOME/.nvm/versions/node/v20.20.0/bin:$PATH npm test -- --test-name-pattern=US4
  gotchas:
    - keys = up, documents, implements, affects, related; value string or string[]; extract [[target|alias]] / [[target#heading]] → target
    - resolve: target with "/" ⇒ exact path (+".md" if no ext) in kb_files; else basename match (case-insensitive) among kb_files; empty target ([[]] / [[undefined]]) ⇒ dangling
    - requires the KB index (same missing-index error); read note content via client.getFile (vault is source of truth for the note itself)
    - result {ok, links:[{key,target,resolved,path?}], dangling:[…]}; ok=false iff dangling non-empty — NOT isError
  blast_radius: green
  steps:
    1. links.ts extractTypedLinks(data), resolveTargets(targets).
    2. Tool entry + handler; tests prefix "US4".
```

**Checkpoint US4** — demoable: orchestrate Step V = one `find_related_work` call.

### US5 (P5) — Robustness (R1, R2, R3) + docs

Independent Test: `manage_frontmatter set tags '["a","[[B]]"]'` then `get` returns the list and the file re-parses as YAML; deleting a multi-line key leaves no orphan lines; a CRLF note is edited and keeps CRLF; `move_note` of a 1 KB PNG produces byte-identical destination; `OBSIDIAN_TIMEOUT_MS=500` is honoured and `search_vault` uses `OBSIDIAN_SEARCH_TIMEOUT_MS` (default 60000).

```
task:
  id: T16
  title: manage_frontmatter on frontmatter.ts through performWrite
  story: US5
  parallel: false
  files: [src/tools.ts]
  why: AC-R1
  ac_mapping: [AC-R1, AC-A8]
  mirror: src/tools.ts:393-422 (replace body)
  imports: [./frontmatter.js]
  expected_gate: PATH=$HOME/.nvm/versions/node/v20.20.0/bin:$PATH npm test -- --test-name-pattern=US5
  gotchas:
    - value arrives as string: try JSON.parse → use if array/object/number/boolean; else keep the raw string (so "[[X]]" and "2026-09-28" stay strings; yaml quotes "[[X]]")
    - get returns YAML-serialised value (lists render as flow/block YAML), "(key 'x' not found)" unchanged
    - no-frontmatter error text unchanged ("Error: no frontmatter found in file")
  blast_radius: yellow
  steps:
    1. Replace handler body with parseFrontmatter / setFrontmatterKey / deleteFrontmatterKey + performWrite.
```

```
task:
  id: T17
  title: Binary-safe move + configurable timeouts in client
  story: US5
  parallel: true
  files: [src/client.ts, src/attachments.ts, src/client.test.ts]
  why: AC-R2, AC-R3
  ac_mapping: [AC-R2, AC-R3]
  mirror: src/client.ts putBinary; attachments.ts IMAGE_MIME table
  imports: [./attachments.js (export IMAGE_MIME or a contentTypeFor(ext) helper)]
  expected_gate: PATH=$HOME/.nvm/versions/node/v20.20.0/bin:$PATH npm test -- --test-name-pattern=US5
  gotchas:
    - add getBinary(filepath): Buffer via responseType "arraybuffer" (UNVERIFIED server behaviour — verify against a real .png before merging, record result)
    - moveFile: .md keeps text path (unchanged behaviour); other ext ⇒ getBinary + putBinary(contentTypeFor(ext) ?? "application/octet-stream")
    - timeouts: constructor reads OBSIDIAN_TIMEOUT_MS (default 10000) and OBSIDIAN_SEARCH_TIMEOUT_MS (default 60000, per-request override on searchSimple); invalid/≤0 ⇒ default
    - attachments.ts change is one export: `contentTypeFor(ext): string | undefined` over IMAGE_MIME
  blast_radius: yellow
  steps:
    1. getBinary + moveFile branch + timeouts.
    2. Tests with a fake axios? — no: unit-test contentTypeFor and a moveFile using a stubbed client subclass overriding getBinary/putBinary/deleteFile; timeout parsing as a pure exported function.
```

```
task:
  id: T18
  title: README — new tools, env vars, behaviour changes, Node 20 test note
  story: US5
  parallel: true
  files: [README.md]
  why: all ACs are user-visible behaviour
  ac_mapping: [AC-A1, AC-A2, AC-A3, AC-A4, AC-A5, AC-A6, AC-A7, AC-A8, AC-B3, AC-R3]
  mirror: README.md "Tools" tables + "Environment variables" table
  imports: []
  expected_gate: grep -q "write_state" README.md && grep -q "OBSIDIAN_WRITE_GUARD" README.md && grep -q "find_related_work" README.md
  gotchas:
    - tool count 19 → 24 (read_state, write_state, find_related_work, validate_note_links, get_write_ledger); update "17 tools" stale text too
    - document legacy ~/.claude/memory/<TICKET>/ dirs are no longer read and can be removed by the user
  blast_radius: green
  steps:
    1. Update tables, env var table (OBSIDIAN_WRITE_GUARD, OBSIDIAN_WRITE_SCOPE, OBSIDIAN_SECRET_SCRUB, CI_SESSION_PREFIXES, CI_WRITE_LEDGER, OBSIDIAN_TIMEOUT_MS, OBSIDIAN_SEARCH_TIMEOUT_MS), session memory section, dev note on Node 20.
```

**Checkpoint US5** — all 16 items done.

## AC Traceability

| Requirement | Story | Tasks | Gate |
|---|---|---|---|
| AC-B1 hyphen/path queries | US1 | T2, T6, T8 | `npm test -- --test-name-pattern=US1` |
| AC-B2 quoted ticket | US1 | T3, T6, T8 | same |
| AC-B3 `~` path + no GENERAL | US1 | T1, T6, T7, T8 | same |
| AC-B4 global ranking | US1 | T6, T8 | same |
| AC-A1 auto-index on write | US1 | T6, T7, T8 | same |
| AC-A5 section scope | US1 | T6, T7, T8 | same |
| AC-A2 write rules + redaction | US2 | T4, T9, T10, T12 | `…=US2`, `…=K4` |
| AC-A6 write ledger | US2 | T4, T9, T11, T12 | `…=US2` |
| AC-A8 structured results | US2 (+S0) | T4, T5, T10, T12 | `…=US2` |
| AC-A3 state CAS | US3 | T13 | `…=US3` |
| AC-A4 find_related_work | US4 | T14 | `…=US4` |
| AC-A7 link check | US4 | T15 | `…=US4` |
| AC-R1 YAML frontmatter | US5 (+S0) | T3, T16 | `…=US5`, `…=K3` |
| AC-R2 binary-safe move | US5 | T17 | `…=US5` |
| AC-R3 timeouts | US5 | T17 | `…=US5` |
| AC-R4 sqlite tests | US1 (+S0) | T1, T2, T3, T8 | `…=US1` |
| docs | US5 | T18 | grep gate |

No task without a requirement; no requirement without a task.

## Testing Strategy

- Unit (pure): fts, frontmatter, paths, writes (guard/scrub/ledger), state parse/render, links extraction, timeout parsing.
- Integration (temp vault on disk + temp KB index + fake client with in-memory file map): search_sessions, index_note, auto-index, find_related_work, validate_note_links, write_state CAS.
- Manual (live Obsidian, once before PR): binary GET of a real `.png` (UNVERIFIED API), `search_sessions("SEATHQ-9999")` against the real vault after `reindex_kb`.
- Edge cases: empty query, query of only punctuation, CRLF note, invalid YAML frontmatter, JSON value containing `token`, lock contention, missing KB index.

## Validation Commands

All with `PATH=$HOME/.nvm/versions/node/v20.20.0/bin:$PATH` prefix.

1. Typecheck: `npx tsc --noEmit`
2. Build: `npm run build`
3. Unit + integration: `npm test`
4. Slice gates: `npm test -- --test-name-pattern=US1` … `US5`, `K1`…`K4`
5. Smoke (live, Obsidian running): `bash scripts/test-mcp.sh` → tool count 24 (note: script path referenced in README; verify it exists — `git ls-files` shows no `scripts/`, so use the manual stdio start in README "Development" instead)
6. Live check: `reindex_kb` then `search_sessions {query:"SEATHQ-9999"}` returns results or `(no results …)` — never an FTS5 error.

## Acceptance Criteria checklist

- [ ] AC-B1 … AC-B4
- [ ] AC-A1 … AC-A8
- [ ] AC-R1 … AC-R4
- [ ] Original 25 tests still pass; text first lines of write tools byte-identical

## Completion Checklist

- [ ] All tasks done in slice order; each checkpoint gate green
- [ ] `yaml` exact version recorded; UNVERIFIED items (yaml set/delete, binary GET) confirmed or reworked
- [ ] README updated
- [ ] pre-pr-gate receipt; PR titled `[ultimate-obsidian-mcp] …` via pr-description
- [ ] Follow-up noted for codebase-intelligence docs (per-ticket DB path, index_note absolute-path examples)

## Risks and Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Forced KB rebuild (schema v2) slow on large vault at first session | M | incremental afterwards; kb-cli never blocks session start (`process.exit(0)` on failure) |
| Scrub false positives mangle notes | M | value-only patterns; prose tests; `OBSIDIAN_SECRET_SCRUB=off` escape hatch; redaction count in every result |
| Guard warnings noisy for legitimate folders (05-Knowledge-Base, daily notes) | H | warn-only default; `OBSIDIAN_WRITE_SCOPE` override |
| Test runner on Node 23 fails native ABI | H | gates pinned to Node 20 PATH; README note |
| Clients rejecting structuredContent that mismatches outputSchema | L | single hand-written schema shared by all write tools; test asserts keys |
| Session notes excluded by user `CI_KB_EXCLUDE` | L | documented |
