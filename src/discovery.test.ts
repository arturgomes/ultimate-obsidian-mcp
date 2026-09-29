import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import { reindexVault } from "./kb.js";
import { handleTool } from "./tools.js";
import { extractTypedLinks } from "./links.js";
import type { ObsidianClient } from "./client.js";

const home = mkdtempSync(join(tmpdir(), "us4-"));
const vault = join(home, "vault");
process.env.OBSIDIAN_VAULT_PATH = vault;
process.env.CI_KB_INDEX = join(home, "kb.db");
process.env.CI_WRITE_LEDGER = join(home, "ledger.jsonl");
process.env.OBSIDIAN_WRITE_GUARD = "off";
delete process.env.CI_KB_EXCLUDE;

function put(rel: string, content: string): void {
  const abs = join(vault, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

const client = {
  async getFile(fp: string) {
    return readFileSync(join(vault, fp), "utf8");
  },
} as unknown as ObsidianClient;

before(() => {
  put(
    "02-Notes/Sessions/SEATHQ-55-a.md",
    "---\ntype: session\nticket: SEATHQ-55\ndate: 2026-09-10\n---\n# Session\n\n## Notes\nSEATHQ-55 pricing bug\n\n## Lessons\nSEATHQ-55 needs a retry guard\n",
  );
  put(
    "02-Notes/Plans/2026-09/seathq-55-b.plan.md",
    "---\ntype: plan\nticket: SEATHQ-55\n---\n# Plan\n\nfix SEATHQ-55 pricing\n",
  );
  put("02-Notes/Wiki/c.md", "---\ntype: wiki\n---\n# C\n\nhistory: SEATHQ-55 was seen before\n");
  put("05-Other/d.md", "---\ntype: other\n---\n# D\n\nSEATHQ-55 outside the searched folders\n");
  put("02-Notes/Sessions/e.md", "---\ntype: session\n---\n# E\n\ninvoice billing reconciliation\n");
  put("02-Notes/Reports/2026-09/r.md", "# R\n\nreport body\n");
  reindexVault({ force: true });
});

after(() => rmSync(home, { recursive: true, force: true }));

test("US4 find_related_work: ticket search is deduped, ranked, and folder-scoped", async () => {
  const out = await handleTool("find_related_work", { ticket: "SEATHQ-55" }, client);
  const sc = out.structuredContent as { items: Array<{ path: string; wikilink: string; folder: string; why: string; date: string }> };
  const paths = sc.items.map((i) => i.path);
  assert.equal(new Set(paths).size, paths.length, "each note once");
  assert.deepEqual([...paths].sort(), [
    "02-Notes/Plans/2026-09/seathq-55-b.plan.md",
    "02-Notes/Sessions/SEATHQ-55-a.md",
    "02-Notes/Wiki/c.md",
  ]);
  assert.ok(!paths.includes("05-Other/d.md"));
  assert.equal(paths[paths.length - 1], "02-Notes/Wiki/c.md", "notes tagged with the ticket outrank mentions");
  const a = sc.items.find((i) => i.path.endsWith("SEATHQ-55-a.md"))!;
  assert.equal(a.wikilink, "[[SEATHQ-55-a]]");
  assert.equal(a.folder, "02-Notes/Sessions");
  assert.equal(a.date, "2026-09-10");
  assert.ok(a.why.length > 0);
  assert.match(out.content[0].text, /\[\[SEATHQ-55-a\]\]/);
});

test("US4 find_related_work: keywords only, folders override, and a required-input check", async () => {
  const k = await handleTool("find_related_work", { keywords: ["billing"] }, client);
  assert.deepEqual(
    (k.structuredContent as { items: Array<{ path: string }> }).items.map((i) => i.path),
    ["02-Notes/Sessions/e.md"],
  );
  const f = await handleTool("find_related_work", { ticket: "SEATHQ-55", folders: ["05-Other/"] }, client);
  assert.deepEqual(
    (f.structuredContent as { items: Array<{ path: string }> }).items.map((i) => i.path),
    ["05-Other/d.md"],
  );
  await assert.rejects(handleTool("find_related_work", {}, client), /at least one/);
  const none = await handleTool("find_related_work", { keywords: ["zzzznothing"] }, client);
  assert.match(none.content[0].text, /no related work/);
});

test("US4 find_related_work: path-shaped and hostile input never throws", async () => {
  await assert.doesNotReject(handleTool("find_related_work", { keywords: ['a/b "c" (d)'] }, client));
});

test("US4 extractTypedLinks handles aliases, headings, lists, and empty targets", () => {
  const links = extractTypedLinks({
    up: "[[SEATHQ-55]]",
    implements: "[[plan|the plan]]",
    related: ["[[c#Heading]]", "[[]]"],
    affects: ["[[undefined]]"],
    title: "[[ignored]]",
  });
  assert.deepEqual(
    links.map((l) => `${l.key}:${l.target}`),
    ["up:SEATHQ-55", "implements:plan", "related:c", "related:", "affects:undefined"],
  );
});

test("US4 validate_note_links: exactly one dangling when up is missing and related resolves", async () => {
  put(
    "02-Notes/Reports/2026-09/links1.md",
    '---\nup: "[[SEATHQ-55]]"\nrelated:\n  - "[[c]]"\nimplements: "[[seathq-55-b.plan|the plan]]"\n---\nbody\n',
  );
  const out = await handleTool(
    "validate_note_links",
    { filepath: "02-Notes/Reports/2026-09/links1.md" },
    client,
  );
  const sc = out.structuredContent as {
    ok: boolean;
    links: Array<{ key: string; resolved: boolean; path?: string }>;
    dangling: Array<{ key: string; target: string }>;
  };
  assert.equal(sc.ok, false);
  assert.deepEqual(sc.dangling, [{ key: "up", target: "SEATHQ-55" }]);
  assert.equal(sc.links.find((l) => l.key === "related")?.path, "02-Notes/Wiki/c.md");
  assert.equal(sc.links.find((l) => l.key === "implements")?.path, "02-Notes/Plans/2026-09/seathq-55-b.plan.md");
});

test("US4 validate_note_links: ok when all resolve; path targets and dangling placeholders", async () => {
  put(
    "02-Notes/Reports/2026-09/links2.md",
    '---\nup: "[[SEATHQ-55-a]]"\nrelated: ["[[02-Notes/Wiki/c]]"]\n---\nbody\n',
  );
  const ok = await handleTool("validate_note_links", { filepath: "02-Notes/Reports/2026-09/links2.md" }, client);
  assert.equal((ok.structuredContent as { ok: boolean }).ok, true);

  put("02-Notes/Reports/2026-09/links3.md", '---\nup: "[[undefined]]"\ndocuments: "[[]]"\n---\nbody\n');
  const bad = await handleTool("validate_note_links", { filepath: "02-Notes/Reports/2026-09/links3.md" }, client);
  assert.equal((bad.structuredContent as { dangling: unknown[] }).dangling.length, 2);

  put("02-Notes/Reports/2026-09/links4.md", "# no frontmatter\n");
  const none = await handleTool("validate_note_links", { filepath: "02-Notes/Reports/2026-09/links4.md" }, client);
  assert.deepEqual((none.structuredContent as { ok: boolean; links: unknown[] }).links, []);
});
