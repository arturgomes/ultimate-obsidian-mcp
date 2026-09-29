import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import { searchSessions, indexNote } from "./sqlite.js";
import { reindexVault } from "./kb.js";
import { handleTool } from "./tools.js";
import type { ObsidianClient } from "./client.js";

// Env is read per call, so setting it once at module load scopes this whole file
// (node --test runs each test file in its own process).
const home = mkdtempSync(join(tmpdir(), "us1-home-"));
const vault = join(home, "vault");
process.env.HOME = home;
process.env.OBSIDIAN_VAULT_PATH = vault;
process.env.CI_KB_INDEX = join(home, "kb", "kb_index.db");
process.env.OBSIDIAN_WRITE_LEDGER = "off";
delete process.env.CI_SESSION_PREFIXES;
delete process.env.CI_KB_EXCLUDE;

function put(rel: string, content: string): void {
  const abs = join(vault, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

const fm = (o: Record<string, string>) =>
  "---\n" + Object.entries(o).map(([k, v]) => `${k}: ${v}`).join("\n") + "\n---\n";

before(() => {
  put(
    "02-Notes/Sessions/SEATHQ-9999-x.md",
    fm({ type: "session", ticket: '"SEATHQ-9999"', date: "2026-09-01" }) +
      "# Session\n\n## Open Failures\n- search crashed on SEATHQ-9999 lookup\n\n## Lessons\n- sanitize fts queries before match\n",
  );
  put(
    "02-Notes/Sessions/SEATHQ-1000-y.md",
    fm({ type: "session", ticket: "SEATHQ-1000", date: "2026-08-01" }) +
      "# Other\n\n## Notes\n- 9999 retries happened once\n",
  );
  put(
    "02-Notes/Plans/2026-09/big.plan.md",
    fm({ type: "plan", ticket: "SEATHQ-9999" }) +
      "# Plan\n\nSEATHQ-9999 SEATHQ-9999 SEATHQ-9999 crashed crashed sanitize\n",
  );
  put(
    "wiki/tasks/2026-01-23-sit-14683-edit-affiliate.md",
    fm({ ticket: '"SIT-14683"', date: "2026-01-23" }) + "# Task\n\nedit affiliate group\n",
  );
  put(
    "wiki/tasks/2026-01-24-no-ticket-fm.md",
    "# Task\n\nunlabelled orphan wiki note about zebras\n",
  );
  put(
    "02-Notes/Sessions/untagged-note.md",
    fm({ type: "session" }) + "# Untagged\n\nunlabelled walrus observations\n",
  );
  // ranking pair: alphabetical order puts the weak match first
  put(
    "02-Notes/Sessions/aaa-low.md",
    fm({ type: "session", ticket: "LOW-1" }) + "# Low\n\ncache\n",
  );
  put(
    "02-Notes/Sessions/zzz-high.md",
    fm({ type: "session", ticket: "HIGH-2" }) + "# High\n\ncache cache cache cache cache cache\n",
  );
  reindexVault({ force: true });
});

after(() => {
  rmSync(home, { recursive: true, force: true });
});

test("US1 search_sessions: ticket id query does not throw and finds the right note first", () => {
  const hits = searchSessions("SEATHQ-9999", "all", 5);
  assert.ok(hits.length >= 1);
  assert.match(hits[0].vaultPath, /SEATHQ-9999-x\.md$/);
  assert.ok(!hits.some((h) => h.vaultPath.includes("big.plan")), "plan notes are not sessions");
});

test("US1 search_sessions: a path-shaped query does not throw", () => {
  assert.doesNotThrow(() => searchSessions("02-Notes/Sessions", "all", 5));
  assert.doesNotThrow(() => searchSessions('"; DROP TABLE kb; --', "all", 5));
});

test("US1 search_sessions: ticket filter matches a note whose frontmatter ticket was quoted", () => {
  const hits = searchSessions("affiliate", "SIT-14683", 5);
  assert.equal(hits.length, 1);
  assert.match(hits[0].vaultPath, /sit-14683/);
  assert.equal(searchSessions("affiliate", "sit-14683", 5).length, 1, "case-insensitive");
  assert.equal(searchSessions("affiliate", "SEATHQ-9999", 5).length, 0);
});

test("US1 search_sessions: results are ranked globally, not by index insertion order", () => {
  const hits = searchSessions("cache", "all", 5);
  assert.match(hits[0].vaultPath, /zzz-high\.md$/);
  assert.match(hits[1].vaultPath, /aaa-low\.md$/);
});

test("US1 search_sessions: sections restricts hits to the named headings", () => {
  const failures = searchSessions("crashed sanitize", "all", 5, ["Open Failures"]);
  assert.ok(failures.length >= 1);
  assert.ok(failures.every((h) => /Open Failures/.test(h.headingPath)));
  const lessons = searchSessions("crashed sanitize", "all", 5, ["lessons"]);
  assert.ok(lessons.length >= 1);
  assert.ok(lessons.every((h) => /Lessons/.test(h.headingPath)));
});

test("US1 index_note: accepts vault-relative and ~ paths, never files under GENERAL", () => {
  const rel = indexNote("02-Notes/Sessions/untagged-note.md");
  assert.doesNotMatch(rel, /GENERAL/);
  assert.match(rel, /untagged-note/);
  const tilde = indexNote("~/vault/02-Notes/Sessions/SEATHQ-9999-x.md");
  assert.match(tilde, /SEATHQ-9999/);
  assert.throws(() => indexNote("/etc/hosts"), /outside vault/);
  assert.throws(() => indexNote("02-Notes/Sessions/nope.md"), /not found/i);
});

test("US1 index_note: keywords land in frontmatter and the body is untouched", () => {
  indexNote("02-Notes/Sessions/SEATHQ-9999-x.md");
  const txt = readFileSync(join(vault, "02-Notes/Sessions/SEATHQ-9999-x.md"), "utf8");
  assert.match(txt, /^keywords: \[/m);
  assert.match(txt, /search crashed on SEATHQ-9999 lookup/);
});

test("US1 untagged wiki note falls back to the filename, not GENERAL", () => {
  const hits = searchSessions("zebras", "all", 5);
  assert.equal(hits.length, 1);
  assert.doesNotMatch(hits[0].title, /GENERAL/);
});

test("US1 auto-index: a session note written through the tool is searchable without index_note", async () => {
  const client = {
    async createOrUpdateFile(fp: string, content: string) {
      put(fp, content);
    },
    async getFile(fp: string) {
      return readFileSync(join(vault, fp), "utf8");
    },
    async checkExists() {
      return false;
    },
  } as unknown as ObsidianClient;

  await handleTool(
    "create_or_update_note",
    {
      filepath: "02-Notes/Sessions/NEW-42-fresh.md",
      content: fm({ type: "session", ticket: "NEW-42" }) + "# Fresh\n\nquokka telemetry finding\n",
      mode: "overwrite",
    },
    client,
  );
  const hits = searchSessions("quokka", "NEW-42", 5);
  assert.equal(hits.length, 1);

  const out = await handleTool("search_sessions", { query: "quokka" }, client);
  assert.match(out.content[0].text, /\[\[NEW-42-fresh\]\]/);
});

test("US1 search_sessions tool: ticket-id query returns wikilinked results", async () => {
  const out = await handleTool("search_sessions", { query: "SEATHQ-9999" }, {} as ObsidianClient);
  assert.match(out.content[0].text, /\[\[SEATHQ-9999-x\]\]/);
});
