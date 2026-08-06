# Plan — Image attachments on document writes

Spec: `specs/image-attachments-on-writes/spec.md` (READY)
Base: `main` → branch `feat/image-attachments-on-writes`

## Intelligence context

- **Write boundary today.** Every vault mutation funnels through `ObsidianClient`
  (`src/client.ts:101` `createOrUpdateFile`, `:126` `patchFile`), which posts `text/markdown` to
  `PUT|POST /vault/{encoded}`. `encodePath` (`src/client.ts:35`) already handles per-segment URI
  encoding, so binary paths need no new encoding logic.
- **Verified externally (Context7, `/openapi/coddingtonbear_github_io_obsidian-local-rest-api_openapi_yaml`):**
  `PUT /vault/{filename}` declares request body `Content-Type: */*`. Its 400 response text names
  Content-Type as the thing to get right and calls `text/markdown` correct *for notes* specifically —
  i.e. non-note uploads are expected to carry their own MIME type. Binary upload is supported by the
  plugin; no new endpoint and no plugin version bump needed.
- **Rejected alternative — `fs.copyFile` into `getVaultRoot()`.** `src/kb.ts:30` already resolves the
  vault root on disk, so a direct copy was possible and shorter. Rejected: it opens a *second* write
  path into the vault next to `ObsidianClient`, and `getVaultRoot()` falls back to a hardcoded
  `/Users/artur/Documents/Obsidian-Vault` when `OBSIDIAN_VAULT_PATH` is unset. The KB indexer
  tolerates that because it is explicitly best-effort (`src/tools.ts:18`); an image copy cannot —
  a wrong root writes the bytes outside the vault while the note still embeds the link, producing a
  silently broken note. Same behavior, one boundary, no new failure mode.
- **`selfIndexOnWrite` is unaffected.** It early-returns on non-`.md` (`src/tools.ts:19`), so image
  writes correctly skip the FTS5 index.
- **Repo has no test or lint script.** `package.json` defines only build/start/migrate. Tests are
  added with `node:test` + `node:assert` (Node ≥18 builtins, zero new dependencies) covering the pure
  logic only; no live-Obsidian integration harness is introduced.

## Constitution gates (Phase -1)

No `.claude/constitution.md` in this repo, so these are advisory, recorded for the eventual one.

- **Simplicity** — one new module, one new client method, two touched handlers. No factory, no
  registry, no plugin layer. PASS.
- **Anti-Abstraction** — attachments are resolved by plain functions over plain data; no class, no
  interface hierarchy, no strategy object for a single source kind. PASS.
- **Integration-First** — the cross-boundary shape (`AttachmentInput`, `ResolvedAttachment`,
  `putBinary`) is frozen in S0 with failing tests before any handler consumes it. PASS.
- **Complexity Tracking** — no rows. Nothing here needs a justification.

## Frozen contract (S0 — immutable for the run)

```ts
// src/attachments.ts
export interface AttachmentInput { path: string; name?: string }
export interface ResolvedAttachment {
  vaultPath: string;     // vault-relative destination, e.g. "02-Notes/x.png"
  storedName: string;    // final basename after sanitize + collision suffix
  bytes: Buffer;
  contentType: string;   // e.g. "image/png"
}
export function renderEmbeds(a: ResolvedAttachment[]): string;   // "" when empty
export function withEmbeds(content: string, a: ResolvedAttachment[]): string;

// src/client.ts
putBinary(filepath: string, bytes: Buffer, contentType: string): Promise<void>;
```

Consumers: `src/tools.ts` (both write handlers). A lane may not edit this shape without re-freezing.

## Slices

### S0 — Foundational (blocking)

| # | Task | Tags | files: |
|---|------|------|--------|
| T1 | `putBinary` on `ObsidianClient`: `PUT /vault/{encoded}` with the given Content-Type, routed through the existing `call()` error wrapper. | `[US1][US2]` | `src/client.ts` |
| T2 | `src/attachments.ts`: MIME/extension table, `sanitizeName`, `nextFreeName` (collision suffixing), size-cap read, `resolveAttachments`, `renderEmbeds`, `withEmbeds`. | `[US1][US2]` | `src/attachments.ts` |
| T3 | `src/attachments.test.ts` (`node:test`) covering sanitize, collision, MIME, extension rejection, size cap, embed rendering. Written to FAIL first. | `[US1][US2]` | `src/attachments.test.ts` |
| T4 | `test` script in `package.json`; `zodToJsonSchema` description passthrough for non-string nodes so `attachments[]` is self-describing to MCP clients. | `[US1][US2]` | `package.json`, `src/tools.ts` |

### S1 — Attach on create/update (P1, US1)

| # | Task | Tags | files: |
|---|------|------|--------|
| T5 | `attachments[]` on `CreateOrUpdateNoteInput`; handler resolves+uploads first, then writes `withEmbeds(content)`, then reports stored paths. | `[US1]` | `src/tools.ts` |

**Checkpoint:** a create/update call with images produces a rendering note. Demoable alone.

### S2 — Attach on patch (P2, US2)

| # | Task | Tags | files: |
|---|------|------|--------|
| T6 | `attachments[]` on `PatchNoteInput`; same order-of-operations across both the `end` and targeted branches. | `[US2]` | `src/tools.ts` |
| T7 | `README.md` tool docs for `attachments[]`. | `[US1][US2]` | `README.md` |

**Checkpoint:** both write tools accept attachments; feature complete.

## Territory map

Serial single-writer fallback (agent teams disabled), so lanes execute in sequence; territories are
recorded because the disjointness assertion is an invariant at every tier.

| Lane | Owns |
|------|------|
| core | `src/client.ts`, `src/attachments.ts` |
| tools | `src/tools.ts` |
| tests | `src/attachments.test.ts` |
| docs | `README.md`, `package.json` |

Pairwise intersection: **empty**. Assertion holds.

## Coverage matrix (Phase 0.5)

| Requirement | Tasks | Gate |
|---|---|---|
| FR-001 | T5 | SC-001, SC-003 |
| FR-002 | T6 | SC-001, SC-003 |
| FR-003 | T2 | SC-002 |
| FR-004 | T2 | SC-002 |
| FR-005 | T2 | SC-002 |
| FR-006 | T2 | SC-002 |
| FR-007 | T2 | SC-002 |
| FR-008 | T1 | SC-001 |
| FR-009 | T5, T6 | SC-003 |
| FR-010 | T2, T5, T6 | SC-002 |
| FR-011 | T5, T6 | SC-003 |
| FR-012 | T5, T6 | SC-004 |
| FR-013 | T2 | SC-002 |

Every FR has ≥1 task. Every task maps to ≥1 FR (T3/T4/T7 serve SC-002/DoD, not scope creep — T4's
schema fix is required for FR-001's parameter to be describable to a client, T7 is a DoD line).
No requirement with zero tasks, no unmapped task, no file claimed by two lanes.

**Phase 0.5 verdict: 0 CRITICAL — fan-out permitted.**

## Validation commands

```bash
npx tsc --noEmit          # SC-001
npm run build             # SC-001
npm test                  # SC-002, SC-004
```
