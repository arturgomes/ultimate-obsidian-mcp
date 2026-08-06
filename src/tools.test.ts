import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { handleTool } from "./tools.js";
import type { ObsidianClient } from "./client.js";

const scratch = mkdtempSync(join(tmpdir(), "tools-test-"));

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
  const client = {
    async createOrUpdateFile(...args: unknown[]) {
      calls.push({ op: "createOrUpdateFile", args });
    },
    async patchFile(...args: unknown[]) {
      calls.push({ op: "patchFile", args });
    },
    async putBinary(...args: unknown[]) {
      calls.push({ op: "putBinary", args });
    },
    async checkExists(p: string) {
      calls.push({ op: "checkExists", args: [p] });
      return existing.includes(p);
    },
  } as unknown as ObsidianClient;
  return { client, calls };
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
  assert.equal(out[0].text, "OK: overwrite → 02-Notes/a.md");
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

  assert.match(out[0].text, /02-Notes\/one\.png/);
  assert.match(out[0].text, /02-Notes\/two\.jpg/);
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
