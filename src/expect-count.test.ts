import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { handleTool } from "./tools.js";
import type { ObsidianClient } from "./client.js";

const scratch = mkdtempSync(join(tmpdir(), "expect-count-test-"));

// finishWrite self-indexes; keep it (and the guard/ledger) off the real vault.
process.env.OBSIDIAN_WRITE_GUARD = "off";
process.env.OBSIDIAN_WRITE_LEDGER = "off";
process.env.OBSIDIAN_VAULT_PATH = join(scratch, "vault");
process.env.CI_KB_INDEX = join(scratch, "kb.db");

const FP = "02-Notes/n.md";

function fakeClient(initial: string) {
  const writes: string[] = [];
  const files = new Map<string, string>([[FP, initial]]);
  const client = {
    async getFile(fp: string) {
      const v = files.get(fp);
      if (v === undefined) throw new Error("not found");
      return v;
    },
    async createOrUpdateFile(fp: string, content: string) {
      writes.push(content);
      files.set(fp, content);
    },
  } as unknown as ObsidianClient;
  return { client, writes, files };
}

const reply = (r: Awaited<ReturnType<typeof handleTool>>) => r.content[0].text;

test("expect_count absent: replaces every match with exactly one write", async () => {
  const { client, writes, files } = fakeClient("foo and foo");
  await handleTool("search_replace_in_note", { filepath: FP, search: "foo", replace: "bar" }, client);
  assert.equal(writes.length, 1);
  assert.equal(files.get(FP), "bar and bar");
});

test("expect_count equal to the match count writes", async () => {
  const { client, writes, files } = fakeClient("foo and foo");
  await handleTool(
    "search_replace_in_note",
    { filepath: FP, search: "foo", replace: "bar", expect_count: 2 },
    client,
  );
  assert.equal(writes.length, 1);
  assert.equal(files.get(FP), "bar and bar");
});

test("expect_count 1 vs 2 matches reports the mismatch and writes nothing", async () => {
  const { client, writes, files } = fakeClient("foo and foo");
  const r = await handleTool(
    "search_replace_in_note",
    { filepath: FP, search: "foo", replace: "bar", expect_count: 1 },
    client,
  );
  assert.ok(reply(r).includes("Found 2 matches, expected 1 — no change written"), reply(r));
  assert.equal(writes.length, 0);
  assert.equal(files.get(FP), "foo and foo");
});

test("expect_count in regex mode counts global matches; mismatch writes nothing", async () => {
  const { client, writes } = fakeClient("a1 b22 c3");
  const r = await handleTool(
    "search_replace_in_note",
    { filepath: FP, search: "\\d+", replace: "N", use_regex: true, expect_count: 2 },
    client,
  );
  assert.ok(reply(r).includes("Found 3 matches, expected 2 — no change written"), reply(r));
  assert.equal(writes.length, 0);
});

test("expect_count 0 with no match leaves the no-change message and writes nothing", async () => {
  const { client, writes } = fakeClient("foo and foo");
  const r = await handleTool(
    "search_replace_in_note",
    { filepath: FP, search: "zzz", replace: "bar", expect_count: 0 },
    client,
  );
  assert.ok(reply(r).includes("(no changes — pattern not found)"), reply(r));
  assert.equal(writes.length, 0);
});

test("expect_count negative is rejected", async () => {
  const { client, writes } = fakeClient("foo and foo");
  await assert.rejects(() =>
    handleTool("search_replace_in_note", { filepath: FP, search: "foo", replace: "bar", expect_count: -1 }, client),
  );
  assert.equal(writes.length, 0);
});

test("expect_count non-integer is rejected", async () => {
  const { client, writes } = fakeClient("foo and foo");
  await assert.rejects(() =>
    handleTool("search_replace_in_note", { filepath: FP, search: "foo", replace: "bar", expect_count: 1.5 }, client),
  );
  assert.equal(writes.length, 0);
});
