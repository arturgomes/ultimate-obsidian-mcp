# Tasks — prp-flow-hardening

Gates run with Node 20 (`PATH=$HOME/.nvm/versions/node/v20.20.0/bin:$PATH`). Slice gate form that works on
Node 20: `npm run build:server && node --test --test-name-pattern=<ID> dist/*.test.js`
(the plan's `npm test -- --test-name-pattern=…` form passes the flag as a file path and fails).

## S0 — Contracts
- [x] T1 `src/paths.ts` resolveVaultPath (K1) — b221bf7
- [x] T2 `src/fts.ts` buildMatchExpr + buildPhraseMatchExpr (K2) — b221bf7
- [x] T3 `src/frontmatter.ts` + `yaml@^2.9.1` (K3) — b221bf7
- [x] T4 `src/writes.ts` WriteResult / guard / scrub / ledger (K4) — b221bf7
- [x] T5 `handleTool` → ToolResult, `structuredContent` passthrough (K5) — b221bf7

## US1 — Session search and indexing
- [x] T6 kb.ts `kb_note_meta`, schema v2, `searchSessionsKb`, `removeVaultFile`; sqlite.ts facade — d7f2c90
- [x] T7 tools: `sections`, index_note path forms, prune on delete/move — d7f2c90
- [x] T8 `src/sqlite.test.ts` — d7f2c90

## US2 — Guarded, scrubbed, verifiable, logged writes
- [x] T9 writes.ts guard / scrub / ledger — b221bf7, 738074e
- [x] T10 `performWrite` / `finishWrite` + `WRITE_RESULT_SCHEMA` — 78f93d1
- [x] T11 `get_write_ledger` — 78f93d1
- [x] T12 US2 tests — 78f93d1

## US3 — State CAS
- [x] T13 `src/state.ts`, `read_state` / `write_state`, tests — 0846383, 738074e

## US4 — Discovery and link integrity
- [x] T14 `find_related_work` — e49d3e2
- [x] T15 `validate_note_links` — e49d3e2, ab419ab

## US5 — Robustness + docs
- [x] T16 manage_frontmatter on frontmatter.ts via performWrite — 78f93d1
- [x] T17 binary-safe move, `getBinary`, timeouts — e31c751
- [x] T18 README — e31c751

## Review fixes (adversarial pass, `src/review.test.ts` R1–R12)
- [x] R1/R2 precise secret scrub (no code false positives; Bearer/JWT/prefixed keys/quoted values) — 738074e
- [x] R3 write_state scrubs structured values, parse-checks before writing — 738074e
- [x] R4 CRLF chunking — 738074e
- [x] R5 `..` traversal always rejected — 738074e
- [x] R6 quoted ticket arguments — 738074e
- [x] R7 filename tickets need an uppercase project code, dates ignored — 738074e
- [x] R8 owned lock token, safe stale break, 120 s stale window — 738074e
- [x] R9 binary move sha from real bytes — 738074e
- [x] R10 index_note survives invalid YAML — 738074e
- [x] R11 ledger reads the rotated file — 738074e
- [x] R12 numeric/boolean YAML keys — 738074e
