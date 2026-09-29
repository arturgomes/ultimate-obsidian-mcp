import test from "node:test";
import assert from "node:assert/strict";
import { closeSync, mkdtempSync, openSync, utimesSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { handleTool } from "./tools.js";
import { lockFileFor, parseStateNote, renderStateNote } from "./state.js";
import type { ObsidianClient } from "./client.js";

const scratch = mkdtempSync(join(tmpdir(), "state-test-"));
process.env.OBSIDIAN_WRITE_GUARD = "off";
process.env.OBSIDIAN_WRITE_LEDGER = "off";
process.env.CI_LOCK_DIR = join(scratch, "locks");
process.env.CI_STATE_LOCK_TIMEOUT_MS = "300";
process.env.OBSIDIAN_VAULT_PATH = join(scratch, "vault");
process.env.CI_KB_INDEX = join(scratch, "kb.db");

function fakeClient() {
  const files = new Map<string, string>();
  let calls = 0;
  const client = {
    async checkExists(p: string) {
      calls++;
      return files.has(p);
    },
    async getFile(p: string) {
      calls++;
      const v = files.get(p);
      if (v === undefined) throw new Error("not found");
      return v;
    },
    async createOrUpdateFile(p: string, c: string) {
      calls++;
      files.set(p, c);
    },
  } as unknown as ObsidianClient;
  return { client, files, calls: () => calls };
}

const PATH = "02-Notes/Sessions/T-1-x.state.md";
const fmA = { title: "State", type: "session", run: "T-1-x" };

test("US3 render/parse round-trips frontmatter and one json fence", () => {
  const text = renderStateNote(fmA, { slices: [{ id: "S0", receipts: [] }], n: 1 });
  const p = parseStateNote(text);
  assert.deepEqual(p.state, { slices: [{ id: "S0", receipts: [] }], n: 1 });
  assert.equal(p.frontmatter.run, "T-1-x");
});

test("US3 write_state creates with expected_sha null; read_state returns sha, frontmatter, state", async () => {
  const { client } = fakeClient();
  const w = await handleTool(
    "write_state",
    { filepath: PATH, frontmatter: fmA, state: { a: 1 }, expected_sha: null },
    client,
  );
  const wsha = (w.structuredContent as { sha: string }).sha;
  assert.match(wsha, /^[0-9a-f]{64}$/);

  const r = await handleTool("read_state", { filepath: PATH }, client);
  const sc = r.structuredContent as { exists: boolean; sha: string; frontmatter: object; state: object };
  assert.equal(sc.exists, true);
  assert.equal(sc.sha, wsha, "write result sha is valid as the next expected_sha");
  assert.deepEqual(sc.state, { a: 1 });
  assert.equal((sc.frontmatter as { run: string }).run, "T-1-x");
});

test("US3 a stale expected_sha is rejected and the note is left unchanged", async () => {
  const { client, files } = fakeClient();
  const w1 = await handleTool(
    "write_state",
    { filepath: PATH, frontmatter: fmA, state: { v: 1 }, expected_sha: null },
    client,
  );
  const sha1 = (w1.structuredContent as { sha: string }).sha;
  await handleTool(
    "write_state",
    { filepath: PATH, frontmatter: fmA, state: { v: 2 }, expected_sha: sha1 },
    client,
  );
  const after2 = files.get(PATH);

  await assert.rejects(
    handleTool(
      "write_state",
      { filepath: PATH, frontmatter: fmA, state: { v: 3 }, expected_sha: sha1 },
      client,
    ),
    /sha_mismatch/,
  );
  assert.equal(files.get(PATH), after2);
});

test("US3 expected_sha null on an existing note is a mismatch; a sha on a missing note too", async () => {
  const { client } = fakeClient();
  await handleTool("write_state", { filepath: PATH, frontmatter: fmA, state: {}, expected_sha: null }, client);
  await assert.rejects(
    handleTool("write_state", { filepath: PATH, frontmatter: fmA, state: {}, expected_sha: null }, client),
    /sha_mismatch/,
  );
  await assert.rejects(
    handleTool(
      "write_state",
      { filepath: "02-Notes/Sessions/none.state.md", frontmatter: fmA, state: {}, expected_sha: "abc" },
      client,
    ),
    /sha_mismatch/,
  );
});

test("US3 two concurrent writers with the same sha: exactly one wins", async () => {
  const { client } = fakeClient();
  const w = await handleTool(
    "write_state",
    { filepath: PATH, frontmatter: fmA, state: { v: 0 }, expected_sha: null },
    client,
  );
  const sha = (w.structuredContent as { sha: string }).sha;
  const attempt = (v: number) =>
    handleTool("write_state", { filepath: PATH, frontmatter: fmA, state: { v }, expected_sha: sha }, client).then(
      () => "ok",
      (e: Error) => e.message,
    );
  const results = await Promise.all([attempt(1), attempt(2)]);
  assert.equal(results.filter((r) => r === "ok").length, 1, JSON.stringify(results));
  assert.equal(results.filter((r) => /sha_mismatch/.test(r)).length, 1, JSON.stringify(results));
});

test("US3 invalid inputs are rejected before any client call", async () => {
  const { client, calls } = fakeClient();
  await assert.rejects(
    handleTool("write_state", { filepath: "02-Notes/Sessions/a.md", frontmatter: {}, state: {}, expected_sha: null }, client),
    /\.state\.md/,
  );
  await assert.rejects(
    handleTool("write_state", { filepath: PATH, frontmatter: {}, state: [1, 2], expected_sha: null }, client),
  );
  await assert.rejects(
    handleTool("write_state", { filepath: PATH, frontmatter: {}, state: {}, expected_sha: 5 }, client),
  );
  assert.equal(calls(), 0);
});

test("US3 a held lock times out; a stale lock is broken", async () => {
  const { client } = fakeClient();
  const lock = lockFileFor(PATH);
  const fd = openSync(lock, "wx");
  closeSync(fd);
  await assert.rejects(
    handleTool("write_state", { filepath: PATH, frontmatter: fmA, state: {}, expected_sha: null }, client),
    /lock busy/,
  );
  const old = new Date(Date.now() - 120_000);
  utimesSync(lock, old, old);
  await handleTool("write_state", { filepath: PATH, frontmatter: fmA, state: {}, expected_sha: null }, client);
  assert.equal(existsSync(lock), false, "lock released after the write");
});

test("US3 read_state: missing note reports exists:false; malformed fences are named", async () => {
  const { client, files } = fakeClient();
  const r = await handleTool("read_state", { filepath: PATH }, client);
  assert.deepEqual(r.structuredContent, { exists: false, sha: null, frontmatter: null, state: null });

  files.set(PATH, "---\ntitle: x\n---\n\n```json\n{}\n```\n\n```json\n{}\n```\n");
  await assert.rejects(handleTool("read_state", { filepath: PATH }, client), /exactly one/);
  files.set(PATH, "---\ntitle: x\n---\n\n```json\n{not json\n```\n");
  await assert.rejects(handleTool("read_state", { filepath: PATH }, client), /not valid JSON/);
  files.set(PATH, "---\ntitle: x\n---\n\n```json\n[1]\n```\n");
  await assert.rejects(handleTool("read_state", { filepath: PATH }, client), /JSON object/);
});
