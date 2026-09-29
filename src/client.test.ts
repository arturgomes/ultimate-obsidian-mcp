import test from "node:test";
import assert from "node:assert/strict";

import { ObsidianClient, parseTimeoutMs } from "./client.js";
import { mimeForExtension } from "./attachments.js";

class StubClient extends ObsidianClient {
  log: string[] = [];
  files = new Map<string, Buffer>();
  failDelete = false;
  constructor() {
    super("http://127.0.0.1:1", "k");
  }
  override async getFile(p: string): Promise<string> {
    this.log.push(`getFile ${p}`);
    return (this.files.get(p) ?? Buffer.alloc(0)).toString("utf8");
  }
  override async getBinary(p: string): Promise<Buffer> {
    this.log.push(`getBinary ${p}`);
    return this.files.get(p) ?? Buffer.alloc(0);
  }
  override async putBinary(p: string, bytes: Buffer, ct: string): Promise<void> {
    this.log.push(`putBinary ${p} ${ct}`);
    this.files.set(p, bytes);
  }
  override async createOrUpdateFile(p: string, c: string, mode: "append" | "prepend" | "overwrite") {
    this.log.push(`createOrUpdateFile ${p} ${mode}`);
    this.files.set(p, Buffer.from(c));
  }
  override async deleteFile(p: string): Promise<void> {
    this.log.push(`deleteFile ${p}`);
    if (this.failDelete) throw new Error("boom");
    this.files.delete(p);
  }
}

test("US5 move_note: a binary file moves byte-for-byte via the binary path", async () => {
  const c = new StubClient();
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, 0xfe, 0x80]);
  c.files.set("a/shot.png", bytes);
  await c.moveFile("a/shot.png", "b/shot.png");
  assert.deepEqual(c.log, [
    "getBinary a/shot.png",
    "putBinary b/shot.png image/png",
    "deleteFile a/shot.png",
  ]);
  assert.deepEqual(c.files.get("b/shot.png"), bytes);
  assert.equal(c.files.has("a/shot.png"), false);
});

test("US5 move_note: unknown extensions use octet-stream; markdown keeps the text path", async () => {
  const c = new StubClient();
  c.files.set("a/x.pdf", Buffer.from("%PDF"));
  await c.moveFile("a/x.pdf", "b/x.pdf");
  assert.ok(c.log.includes("putBinary b/x.pdf application/octet-stream"));

  const m = new StubClient();
  m.files.set("a/n.md", Buffer.from("# n"));
  await m.moveFile("a/n.md", "b/n.md");
  assert.deepEqual(m.log, ["getFile a/n.md", "createOrUpdateFile b/n.md overwrite", "deleteFile a/n.md"]);
});

test("US5 move_note: a failed source delete names the destination", async () => {
  const c = new StubClient();
  c.files.set("a/shot.png", Buffer.from([1]));
  c.failDelete = true;
  await assert.rejects(c.moveFile("a/shot.png", "b/shot.png"), /written to b\/shot\.png.*delete manually/);
});

test("US5 timeouts: env-configurable with safe defaults", () => {
  assert.equal(parseTimeoutMs(undefined, 10000), 10000);
  assert.equal(parseTimeoutMs("500", 10000), 500);
  assert.equal(parseTimeoutMs("0", 10000), 10000);
  assert.equal(parseTimeoutMs("-5", 10000), 10000);
  assert.equal(parseTimeoutMs("abc", 10000), 10000);
});

test("US5 mimeForExtension: known images map, unknown is undefined", () => {
  assert.equal(mimeForExtension("a/b.PNG"), "image/png");
  assert.equal(mimeForExtension("a/b.pdf"), undefined);
  assert.equal(mimeForExtension("noext"), undefined);
});
