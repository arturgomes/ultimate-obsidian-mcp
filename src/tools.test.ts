import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { createHash } from "crypto";
import { handleTool } from "./tools.js";
import type { ObsidianClient } from "./client.js";

const scratch = mkdtempSync(join(tmpdir(), "tools-test-"));

// Legacy (pre-guard) tests write to arbitrary paths; US2 tests set the guard explicitly.
process.env.OBSIDIAN_WRITE_GUARD = "off";
process.env.CI_WRITE_LEDGER = join(scratch, "ledger.jsonl");
process.env.OBSIDIAN_VAULT_PATH = join(scratch, "vault");
process.env.CI_KB_INDEX = join(scratch, "kb.db");

function image(name: string, bytes = 6): string {
  const p = join(scratch, name);
  writeFileSync(p, Buffer.alloc(bytes, 7));
  return p;
}

interface Call {
  op: string;
  args: unknown[];
}

function fakeClient(existing: string[] = []) {
  const calls: Call[] = [];
  const files = new Map<string, string>();
  const client = {
    async createOrUpdateFile(...args: unknown[]) {
      calls.push({ op: "createOrUpdateFile", args });
      const [fp, content, mode] = args as [string, string, string];
      const prev = files.get(fp) ?? "";
      files.set(fp, mode === "append" ? prev + content : mode === "prepend" ? content + prev : content);
    },
    async patchFile(...args: unknown[]) {
      calls.push({ op: "patchFile", args });
      const [fp, , , , content] = args as [string, string, string, string, string];
      files.set(fp, (files.get(fp) ?? "") + content);
    },
    async putBinary(...args: unknown[]) {
      calls.push({ op: "putBinary", args });
    },
    async getFile(fp: string) {
      const v = files.get(fp);
      if (v === undefined) throw new Error("not found");
      return v;
    },
    async moveFile(from: string, to: string) {
      calls.push({ op: "moveFile", args: [from, to] });
      files.set(to, files.get(from) ?? "");
      files.delete(from);
    },
    async checkExists(p: string) {
      calls.push({ op: "checkExists", args: [p] });
      return existing.includes(p);
    },
  } as unknown as ObsidianClient;
  return { client, calls, files };
}

const ops = (calls: Call[]) => calls.filter((c) => c.op !== "checkExists").map((c) => c.op);

// ── FR-012 / SC-004: no attachments ⇒ unchanged behaviour ────────────────────

test("create_or_update_note without attachments writes the content verbatim", async () => {
  const { client, calls } = fakeClient();
  const content = "# Title\n\nbody\n\n\n";
  const out = await handleTool(
    "create_or_update_note",
    { filepath: "02-Notes/a.md", content, mode: "overwrite" },
    client,
  );

  assert.deepEqual(ops(calls), ["createOrUpdateFile"]);
  assert.deepEqual(calls[0].args, ["02-Notes/a.md", content, "overwrite"]);
  assert.equal(out.content[0].text, "OK: overwrite → 02-Notes/a.md");
});

test("patch_note without attachments patches the content verbatim", async () => {
  const { client, calls } = fakeClient();
  await handleTool(
    "patch_note",
    {
      filepath: "n.md",
      operation: "append",
      target_type: "heading",
      target: "Log",
      content: "entry",
    },
    client,
  );

  assert.deepEqual(ops(calls), ["patchFile"]);
  assert.deepEqual(calls[0].args, ["n.md", "append", "heading", "Log", "entry"]);
});

// ── FR-009 / FR-010 / FR-011: attachments upload first, then embed ───────────

test("create_or_update_note uploads every attachment before writing the note", async () => {
  const { client, calls } = fakeClient();
  const out = await handleTool(
    "create_or_update_note",
    {
      filepath: "02-Notes/a.md",
      content: "body",
      mode: "append",
      attachments: [{ path: image("one.png") }, { path: image("two.jpg") }],
    },
    client,
  );

  assert.deepEqual(ops(calls), ["putBinary", "putBinary", "createOrUpdateFile"]);
  assert.deepEqual(calls.filter((c) => c.op === "putBinary").map((c) => c.args[0]), [
    "02-Notes/one.png",
    "02-Notes/two.jpg",
  ]);
  assert.equal(calls.find((c) => c.op === "putBinary")?.args[2], "image/png");

  const written = calls.find((c) => c.op === "createOrUpdateFile")?.args[1];
  assert.equal(written, "body\n\n![[one.png]]\n![[two.jpg]]\n");

  assert.match(out.content[0].text, /02-Notes\/one\.png/);
  assert.match(out.content[0].text, /02-Notes\/two\.jpg/);
});

test("patch_note embeds attachments inside the patched body", async () => {
  const { client, calls } = fakeClient();
  await handleTool(
    "patch_note",
    {
      filepath: "02-Notes/n.md",
      operation: "append",
      target_type: "heading",
      target: "Evidence",
      content: "see below",
      attachments: [{ path: image("shot.png") }],
    },
    client,
  );

  assert.deepEqual(ops(calls), ["putBinary", "patchFile"]);
  assert.equal(calls.find((c) => c.op === "patchFile")?.args[4], "see below\n\n![[shot.png]]\n");
});

test("attachments avoid overwriting a name already in the vault", async () => {
  const { client, calls } = fakeClient(["02-Notes/taken.png"]);
  await handleTool(
    "create_or_update_note",
    {
      filepath: "02-Notes/a.md",
      content: "body",
      mode: "append",
      attachments: [{ path: image("taken.png") }],
    },
    client,
  );

  assert.equal(calls.find((c) => c.op === "putBinary")?.args[0], "02-Notes/taken-1.png");
});

test("a bad attachment aborts the call and leaves the note unwritten", async () => {
  const { client, calls } = fakeClient();
  await assert.rejects(() =>
    handleTool(
      "create_or_update_note",
      {
        filepath: "02-Notes/a.md",
        content: "body",
        mode: "append",
        attachments: [{ path: join(scratch, "does-not-exist.png") }],
      },
      client,
    ),
  );
  assert.deepEqual(ops(calls), []);
});

test("a non-image attachment is rejected before any upload", async () => {
  const { client, calls } = fakeClient();
  await assert.rejects(
    () =>
      handleTool(
        "create_or_update_note",
        {
          filepath: "a.md",
          content: "body",
          mode: "append",
          attachments: [{ path: image("notes.pdf") }],
        },
        client,
      ),
    /\.pdf/,
  );
  assert.deepEqual(ops(calls), []);
});

// ── The attachments parameter must be describable to an MCP client ───────────

test("the exposed JSON schema documents attachments on both write tools", async () => {
  const { TOOLS } = await import("./tools.js");
  for (const name of ["create_or_update_note", "patch_note"]) {
    const tool = TOOLS.find((t) => t.name === name);
    assert.ok(tool, `${name} is registered`);
    const props = (tool.inputSchema as { properties: Record<string, { description?: string }> })
      .properties;
    assert.ok(props.attachments, `${name} exposes attachments`);
    assert.match(props.attachments.description ?? "", /image/i);
    const required = (tool.inputSchema as { required: string[] }).required;
    assert.ok(!required.includes("attachments"), `${name} keeps attachments optional`);
  }
});


// ── US2: guarded, scrubbed, verifiable, logged writes ─────────────────────────

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

function withGuard<T>(mode: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.OBSIDIAN_WRITE_GUARD;
  process.env.OBSIDIAN_WRITE_GUARD = mode;
  return fn().finally(() => {
    process.env.OBSIDIAN_WRITE_GUARD = prev;
  });
}

test("US2 write result: sha, warnings, redactions in structuredContent; text first line unchanged", async () => {
  await withGuard("warn", async () => {
    const { client } = fakeClient();
    const out = await handleTool(
      "create_or_update_note",
      {
        filepath: "02-Notes/Reports/x.md",
        content: "# R\napi_key: sk-abcdefghijklmnopqrstuvwx\n",
        mode: "overwrite",
      },
      client,
    );
    assert.equal(out.content[0].text.split("\n")[0], "OK: overwrite → 02-Notes/Reports/x.md");
    const sc = out.structuredContent as Record<string, unknown>;
    assert.equal(sc.ok, true);
    assert.equal(sc.path, "02-Notes/Reports/x.md");
    assert.equal(sc.redactions, 1);
    assert.match(String((sc.warnings as string[])[0]), /month/);
    const stored = await client.getFile("02-Notes/Reports/x.md");
    assert.match(stored, /api_key: \[REDACTED\]/);
    assert.doesNotMatch(stored, /sk-abc/);
    assert.equal(sc.sha, sha(stored));
    assert.equal(sc.bytes, Buffer.byteLength(stored));
  });
});

test("US2 strict guard rejects before any client call", async () => {
  await withGuard("strict", async () => {
    const { client, calls } = fakeClient();
    await assert.rejects(
      handleTool("create_or_update_note", { filepath: "99-Random/x.md", content: "x", mode: "overwrite" }, client),
      /Write blocked/,
    );
    assert.deepEqual(calls, []);
  });
});

test("US2 guard off: no warnings", async () => {
  await withGuard("off", async () => {
    const { client } = fakeClient();
    const out = await handleTool(
      "create_or_update_note",
      { filepath: "99-Random/x.md", content: "x", mode: "overwrite" },
      client,
    );
    assert.deepEqual((out.structuredContent as { warnings: string[] }).warnings, []);
    assert.equal(out.content[0].text, "OK: overwrite → 99-Random/x.md");
  });
});

test("US2 patch_note, move_note and attachments report structured results", async () => {
  await withGuard("warn", async () => {
    const { client } = fakeClient();
    await handleTool(
      "create_or_update_note",
      { filepath: "02-Notes/Sessions/a.md", content: "# A\n", mode: "overwrite" },
      client,
    );
    const p = await handleTool(
      "patch_note",
      { filepath: "02-Notes/Sessions/a.md", operation: "append", target_type: "end", content: "more\n" },
      client,
    );
    assert.equal((p.structuredContent as { ok: boolean }).ok, true);
    assert.equal((p.structuredContent as { sha: string }).sha, sha("# A\nmore\n"));

    const m = await handleTool(
      "move_note",
      { source_path: "02-Notes/Sessions/a.md", dest_path: "99-Random/a.md" },
      client,
    );
    const msc = m.structuredContent as { path: string; warnings: string[]; sha: string };
    assert.equal(msc.path, "99-Random/a.md");
    assert.match(msc.warnings[0], /outside write-scope/);
    assert.equal(msc.sha, sha("# A\nmore\n"));

    const at = await handleTool(
      "create_or_update_note",
      {
        filepath: "02-Notes/Sessions/img.md",
        content: "x",
        mode: "overwrite",
        attachments: [{ path: image("shot.png") }],
      },
      client,
    );
    assert.deepEqual((at.structuredContent as { attachments: string[] }).attachments, [
      "02-Notes/Sessions/shot.png",
    ]);
  });
});

test("US2 read-back failure still reports the write, with a warning", async () => {
  await withGuard("off", async () => {
    const client = {
      async createOrUpdateFile() {},
      async checkExists() {
        return false;
      },
    } as unknown as ObsidianClient;
    const out = await handleTool(
      "create_or_update_note",
      { filepath: "02-Notes/Sessions/z.md", content: "z", mode: "overwrite" },
      client,
    );
    const sc = out.structuredContent as { ok: boolean; sha: string; warnings: string[] };
    assert.equal(sc.ok, true);
    assert.equal(sc.sha, "");
    assert.match(sc.warnings.join(" "), /read-back failed/);
  });
});

test("US2 get_write_ledger lists writes since a time and reports empty", async () => {
  await withGuard("off", async () => {
    const before = new Date(Date.now() - 1000).toISOString();
    const { client } = fakeClient();
    await handleTool(
      "create_or_update_note",
      { filepath: "02-Notes/Sessions/ledger-a.md", content: "a", mode: "overwrite" },
      client,
    );
    const l = await handleTool("get_write_ledger", { since: before, path_prefix: "02-Notes/Sessions/ledger-" }, client);
    const sc = l.structuredContent as { count: number; empty: boolean; entries: Array<{ path: string; sha: string }> };
    assert.equal(sc.empty, false);
    assert.equal(sc.count, 1);
    assert.equal(sc.entries[0].path, "02-Notes/Sessions/ledger-a.md");
    assert.equal(sc.entries[0].sha, sha("a"));

    const future = new Date(Date.now() + 60000).toISOString();
    const e = await handleTool("get_write_ledger", { since: future }, client);
    assert.equal((e.structuredContent as { empty: boolean }).empty, true);
    assert.match(e.content[0].text, /no writes since/);

    const bad = await handleTool("get_write_ledger", { since: "not-a-date" }, client);
    assert.match(bad.content[0].text, /invalid 'since'/);
  });
});


// ── US5: YAML-aware manage_frontmatter ───────────────────────────────────────

import { parseFrontmatter } from "./frontmatter.js";

const FM = "02-Notes/Sessions/fm.md";

test("US5 manage_frontmatter set: lists and wikilinks round-trip as YAML", async () => {
  const { client, files } = fakeClient();
  files.set(FM, "---\ntitle: t\n---\nbody\n");
  const r = await handleTool(
    "manage_frontmatter",
    { filepath: FM, operation: "set", key: "tags", value: '["a","[[B]]"]' },
    client,
  );
  assert.equal(r.content[0].text.split("\n")[0], `OK: set frontmatter key 'tags' in ${FM}`);
  assert.equal((r.structuredContent as { ok: boolean }).ok, true);
  assert.deepEqual(parseFrontmatter(files.get(FM)!).data.tags, ["a", "[[B]]"]);

  const g = await handleTool("manage_frontmatter", { filepath: FM, operation: "get", key: "tags" }, client);
  assert.equal(g.content[0].text, '["a","[[B]]"]');

  await handleTool("manage_frontmatter", { filepath: FM, operation: "set", key: "up", value: "[[SEATHQ-1]]" }, client);
  assert.equal(parseFrontmatter(files.get(FM)!).data.up, "[[SEATHQ-1]]");
  assert.match(files.get(FM)!, /body\n$/);
});

test("US5 manage_frontmatter delete: multi-line value leaves no orphan lines", async () => {
  const { client, files } = fakeClient();
  files.set(FM, "---\ntitle: t\ntags:\n  - a\n  - b\nz: 1\n---\nbody\n");
  await handleTool("manage_frontmatter", { filepath: FM, operation: "delete", key: "tags" }, client);
  assert.ok(!/^\s*- /m.test(files.get(FM)!));
  assert.deepEqual(Object.keys(parseFrontmatter(files.get(FM)!).data), ["title", "z"]);
});

test("US5 manage_frontmatter: CRLF notes are editable and stay CRLF", async () => {
  const { client, files } = fakeClient();
  files.set(FM, "---\r\ntitle: t\r\n---\r\nbody\r\n");
  await handleTool("manage_frontmatter", { filepath: FM, operation: "set", key: "k", value: "v" }, client);
  const out = files.get(FM)!;
  assert.equal(parseFrontmatter(out).data.k, "v");
  assert.ok(!/[^\r]\n/.test(out), JSON.stringify(out));
});

test("US5 manage_frontmatter: unchanged error and not-found texts, no write on a missing delete", async () => {
  const { client, files, calls } = fakeClient();
  files.set("02-Notes/Sessions/plain.md", "# no frontmatter\n");
  const e = await handleTool(
    "manage_frontmatter",
    { filepath: "02-Notes/Sessions/plain.md", operation: "get", key: "x" },
    client,
  );
  assert.equal(e.content[0].text, "Error: no frontmatter found in file");

  files.set(FM, "---\ntitle: t\n---\nbody\n");
  const g = await handleTool("manage_frontmatter", { filepath: FM, operation: "get", key: "nope" }, client);
  assert.equal(g.content[0].text, "(key 'nope' not found)");
  const before = calls.length;
  const d = await handleTool("manage_frontmatter", { filepath: FM, operation: "delete", key: "nope" }, client);
  assert.equal(d.content[0].text, "(key 'nope' not found)");
  assert.equal(calls.filter((c) => c.op === "createOrUpdateFile").length, 0);
  assert.ok(calls.length >= before);

  const v = await handleTool("manage_frontmatter", { filepath: FM, operation: "set", key: "k" }, client);
  assert.equal(v.content[0].text, "Error: 'value' required for 'set' operation");
});
