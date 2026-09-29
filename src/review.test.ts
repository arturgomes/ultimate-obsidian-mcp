// Regression tests for the adversarial review of feat/prp-flow-hardening (R1–R12).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, openSync, closeSync, writeFileSync, utimesSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import { scrubSecrets, guardPath, appendLedger, readLedger } from "./writes.js";
import { normTicket, noteMeta, reindexVault } from "./kb.js";
import { searchSessions, indexNote } from "./sqlite.js";
import { setFrontmatterKey, deleteFrontmatterKey, parseFrontmatter } from "./frontmatter.js";
import { withLock, lockFileFor } from "./state.js";
import { handleTool } from "./tools.js";
import type { ObsidianClient } from "./client.js";

const home = mkdtempSync(join(tmpdir(), "review-"));
const vault = join(home, "vault");
process.env.OBSIDIAN_VAULT_PATH = vault;
process.env.CI_KB_INDEX = join(home, "kb.db");
process.env.CI_WRITE_LEDGER = join(home, "ledger.jsonl");
process.env.CI_LOCK_DIR = join(home, "locks");
process.env.OBSIDIAN_WRITE_GUARD = "off";
delete process.env.CI_KB_EXCLUDE;
delete process.env.OBSIDIAN_SECRET_SCRUB;

function put(rel: string, content: string): void {
  const abs = join(vault, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

// R1 — scrub must not rewrite code that holds no secret
test("R1 scrub leaves type annotations, identifiers and calls alone", () => {
  for (const src of [
    "function login(user: string, password: string) {",
    "interface Cfg { apiKey: string; token: number }",
    "const token = getToken();",
    "tokenizer: unicode61",
    "secretary: Alice",
    '{"pageToken": 12345, "csrfToken": 123456}',
    "token: [REDACTED]",
    "const apiKey = process.env.OBSIDIAN_API_KEY;",
    "API_KEY=$OBSIDIAN_API_KEY node dist/index.js",
    "password: hashedPassword,",
    "token: <your-token>",
  ]) {
    assert.deepEqual(scrubSecrets(src), { content: src, redactions: 0 }, src);
  }
});

// R2 — secrets that used to slip through
test("R2 scrub catches Bearer-after-key, prefixed env keys and quoted values with spaces", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop";
  const a = scrubSecrets(`token: Bearer ${jwt}`);
  assert.doesNotMatch(a.content, /eyJ/, a.content);

  const b = scrubSecrets("AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCY");
  assert.equal(b.content, "AWS_SECRET_ACCESS_KEY=[REDACTED]");
  const c = scrubSecrets("SECRET_KEY=django-insecure-abc123");
  assert.equal(c.content, "SECRET_KEY=[REDACTED]");

  const d = scrubSecrets("password: 'p@ss w0rd!'");
  assert.equal(d.content, "password: '[REDACTED]'");

  const e = scrubSecrets(`raw jwt ${jwt} in a log`);
  assert.doesNotMatch(e.content, /eyJ/);

  assert.equal(scrubSecrets("OBSIDIAN_API_KEY=0123456789abcdef0123456789abcdef").redactions, 1);
  assert.equal(scrubSecrets("password: 'hashedPassword'").redactions, 1, "quoted is always data");

  const f = scrubSecrets('{"access_token": "abcd1234efgh"}');
  assert.deepEqual(JSON.parse(f.content), { access_token: "[REDACTED]" });
});

// R3 — write_state never produces a note read_state cannot parse
test("R3 write_state keeps the json fence valid when state holds secret-shaped keys", async () => {
  const files = new Map<string, string>();
  const client = {
    async checkExists(p: string) {
      return files.has(p);
    },
    async getFile(p: string) {
      const v = files.get(p);
      if (v === undefined) throw new Error("nf");
      return v;
    },
    async createOrUpdateFile(p: string, c: string) {
      files.set(p, c);
    },
  } as unknown as ObsidianClient;
  const fp = "02-Notes/Sessions/R-3.state.md";
  await handleTool(
    "write_state",
    {
      filepath: fp,
      frontmatter: { type: "session" },
      state: { pageToken: 12345, csrfToken: "abcdefgh1234", nested: { password: "hunter2hunter2" } },
      expected_sha: null,
    },
    client,
  );
  const r = await handleTool("read_state", { filepath: fp }, client);
  const st = (r.structuredContent as { state: Record<string, unknown> }).state;
  assert.equal(st.pageToken, 12345);
  assert.equal(st.csrfToken, "[REDACTED]");
  assert.deepEqual(st.nested, { password: "[REDACTED]" });
});

// R4 — CRLF notes chunk and scope like LF notes
test("R4 CRLF session notes keep heading paths and do not index frontmatter as body", () => {
  put(
    "02-Notes/Sessions/crlf.md",
    "---\r\ntype: session\r\nticket: CRLF-1\r\n---\r\n# S\r\n\r\n## Lessons\r\n- wombat rule\r\n",
  );
  reindexVault({ force: true });
  const hits = searchSessions("wombat", "all", 5, ["Lessons"]);
  assert.equal(hits.length, 1);
  assert.match(hits[0].headingPath, /Lessons/);
  assert.equal(searchSessions("CRLF-1 type session", "CRLF-1", 5).every((h) => !/type: session/.test(h.snippet)), true);
});

// R5 — `..` cannot bypass the guard
test("R5 guardPath rejects traversal in every mode and accepts a leading ./", () => {
  for (const mode of ["warn", "strict", "off"]) {
    process.env.OBSIDIAN_WRITE_GUARD = mode;
    assert.throws(() => guardPath("02-Notes/Sessions/../../05-Private/x.md"), /\.\./, mode);
  }
  process.env.OBSIDIAN_WRITE_GUARD = "strict";
  assert.deepEqual(guardPath("./02-Notes/Sessions/x.md"), []);
  process.env.OBSIDIAN_WRITE_GUARD = "off";
});

// R6 — quoted ticket arguments normalise
test("R6 normTicket strips quotes", () => {
  assert.equal(normTicket('"SIT-14683"'), "SIT-14683");
  assert.equal(normTicket("'sit-14683'"), "SIT-14683");
});

// R7 — dates and plain words in filenames are not tickets
test("R7 filename ticket needs an uppercase project code and ignores dates", () => {
  assert.equal(noteMeta("02-Notes/Sessions/session-2026-09-28.md", "").ticket, "session-2026-09-28");
  assert.equal(noteMeta("x/2026-09-28-sprint-42-retro.md", "").ticket, "2026-09-28-sprint-42-retro");
  assert.equal(noteMeta("x/SEATHQ-1234-fix.md", "").ticket, "SEATHQ-1234");
  assert.equal(noteMeta("x/2026-09-28-SEATHQ-77-fix.md", "").ticket, "SEATHQ-77");
});

// R8 — the lock is owned: nobody else's lock is released or stolen while fresh
test("R8 release never deletes a lock owned by someone else", async () => {
  const fp = "02-Notes/Sessions/R-8.state.md";
  const lock = lockFileFor(fp);
  await withLock(fp, async () => {
    writeFileSync(lock, "someone-else"); // lock replaced under us
  });
  assert.equal(existsSync(lock), true, "foreign lock survives our release");
  assert.equal(readFileSync(lock, "utf8"), "someone-else");
});

test("R8 a stale lock is broken exactly once; a fresh one is not", async () => {
  const fp = "02-Notes/Sessions/R-8b.state.md";
  const lock = lockFileFor(fp);
  closeSync(openSync(lock, "wx"));
  const old = new Date(Date.now() - 10 * 60_000);
  utimesSync(lock, old, old);
  let inside = 0;
  let max = 0;
  const run = () =>
    withLock(fp, async () => {
      inside++;
      max = Math.max(max, inside);
      await new Promise((r) => setTimeout(r, 30));
      inside--;
    });
  await Promise.all([run(), run(), run()]);
  assert.equal(max, 1, "never two holders at once");
});

// R9 — binary move reports the sha of the bytes
test("R9 move_note of a binary hashes the real bytes", async () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x80]);
  const store = new Map<string, Buffer>([["a/x.png", bytes]]);
  const client = {
    async moveFile(a: string, b: string) {
      store.set(b, store.get(a)!);
      store.delete(a);
    },
    async getBinary(p: string) {
      return store.get(p)!;
    },
    async getFile(p: string) {
      return store.get(p)!.toString("utf8");
    },
  } as unknown as ObsidianClient;
  const out = await handleTool("move_note", { source_path: "a/x.png", dest_path: "b/x.png" }, client);
  const sc = out.structuredContent as { sha: string; bytes: number };
  const { createHash } = await import("crypto");
  assert.equal(sc.sha, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(sc.bytes, 8);
});

// R10 — invalid YAML does not stop indexing
test("R10 index_note still indexes a note whose frontmatter is invalid YAML", () => {
  put("02-Notes/Sessions/badyaml.md", "---\ntitle: foo: bar\ntype: session\n---\n# B\n\nplatypus note\n");
  const out = indexNote("02-Notes/Sessions/badyaml.md");
  assert.match(out, /keywords not updated/i);
  assert.equal(searchSessions("platypus", "all", 5).length, 1);
});

// R11 — rotation does not hide this session's writes
test("R11 readLedger includes the rotated file", () => {
  const file = join(home, "rot.jsonl");
  process.env.CI_WRITE_LEDGER = file;
  process.env.CI_WRITE_LEDGER_MAX_BYTES = "150";
  const since = new Date(Date.now() - 1000).toISOString();
  for (let i = 0; i < 4; i++) appendLedger({ tool: "t", path: `p/${i}.md`, op: "o", sha: "s" });
  assert.ok(existsSync(file + ".1"));
  assert.equal(readLedger({ since }).length, 4);
  process.env.CI_WRITE_LEDGER = join(home, "ledger.jsonl");
  delete process.env.CI_WRITE_LEDGER_MAX_BYTES;
});

// R12 — non-string YAML keys are addressable by their text
test("R12 numeric / boolean keys can be deleted and set in place", () => {
  const src = "---\n1: one\ntrue: yes\ntitle: t\n---\nbody\n";
  const d = deleteFrontmatterKey(src, "1");
  assert.deepEqual(Object.keys(parseFrontmatter(d).data), ["true", "title"]);
  const s = setFrontmatterKey(src, "1", "uno");
  assert.equal(parseFrontmatter(s).data["1"], "uno");
  assert.equal((s.match(/^"?1"?:/gm) ?? []).length, 1, s);
  const t = deleteFrontmatterKey(src, "true");
  assert.deepEqual(Object.keys(parseFrontmatter(t).data), ["1", "title"]);
});
