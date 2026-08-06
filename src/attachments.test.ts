import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  contentTypeFor,
  renderEmbeds,
  resolveAttachments,
  sanitizeName,
  vaultJoin,
  withEmbeds,
  type ResolvedAttachment,
} from "./attachments.js";

const scratch = mkdtempSync(join(tmpdir(), "attach-test-"));

function fixture(name: string, bytes = 8): string {
  const p = join(scratch, name);
  writeFileSync(p, Buffer.alloc(bytes, 1));
  return p;
}

const neverExists = async () => false;

// ── sanitizeName (FR-005) ────────────────────────────────────────────────────

test("sanitizeName strips wikilink-breaking and path characters", () => {
  assert.equal(sanitizeName("a[b]c|d#e^f.png"), "a-b-c-d-e-f.png");
  assert.equal(sanitizeName("dir/sub/shot.png"), "shot.png");
  assert.equal(sanitizeName("we:ird*name?.png"), "we-ird-name-.png");
});

test("sanitizeName collapses runs and trims edge dots and spaces", () => {
  assert.equal(sanitizeName("a###b.png"), "a-b.png");
  assert.equal(sanitizeName("  spaced shot.png  "), "spaced shot.png");
  assert.equal(sanitizeName("...hidden.png"), "hidden.png");
});

test("sanitizeName falls back when nothing usable remains", () => {
  assert.equal(sanitizeName("///"), "attachment");
});

// ── contentTypeFor (FR-006, FR-008) ──────────────────────────────────────────

test("contentTypeFor maps every supported image extension", () => {
  assert.equal(contentTypeFor("a.png"), "image/png");
  assert.equal(contentTypeFor("a.jpg"), "image/jpeg");
  assert.equal(contentTypeFor("a.JPEG"), "image/jpeg");
  assert.equal(contentTypeFor("a.gif"), "image/gif");
  assert.equal(contentTypeFor("a.webp"), "image/webp");
  assert.equal(contentTypeFor("a.svg"), "image/svg+xml");
  assert.equal(contentTypeFor("a.bmp"), "image/bmp");
  assert.equal(contentTypeFor("a.avif"), "image/avif");
});

test("contentTypeFor rejects a non-image extension by name", () => {
  assert.throws(() => contentTypeFor("report.pdf"), /\.pdf/);
  assert.throws(() => contentTypeFor("noext"), /extension/i);
});

// ── vaultJoin (FR-004) ───────────────────────────────────────────────────────

test("vaultJoin places the file beside the note, with no leading slash at root", () => {
  assert.equal(vaultJoin("02-Notes", "a.png"), "02-Notes/a.png");
  assert.equal(vaultJoin("", "a.png"), "a.png");
  assert.equal(vaultJoin(".", "a.png"), "a.png");
});

// ── embeds (FR-010, FR-012) ──────────────────────────────────────────────────

const fake = (storedName: string): ResolvedAttachment => ({
  storedName,
  vaultPath: `02-Notes/${storedName}`,
  bytes: Buffer.alloc(0),
  contentType: "image/png",
});

test("renderEmbeds emits one wikilink embed per attachment, in order", () => {
  assert.equal(renderEmbeds([fake("a.png"), fake("b.png")]), "![[a.png]]\n![[b.png]]");
  assert.equal(renderEmbeds([]), "");
});

test("withEmbeds returns content byte-identical when there are no attachments", () => {
  const content = "# Title\n\nbody\n\n\n";
  assert.equal(withEmbeds(content, []), content);
});

test("withEmbeds appends embeds after the content with one blank line", () => {
  assert.equal(withEmbeds("# Title\n\nbody", [fake("a.png")]), "# Title\n\nbody\n\n![[a.png]]\n");
  assert.equal(withEmbeds("body\n\n\n", [fake("a.png")]), "body\n\n![[a.png]]\n");
});

// ── resolveAttachments (FR-003, FR-004, FR-007, FR-013) ──────────────────────

test("resolveAttachments reads bytes and targets the note's own directory", async () => {
  const src = fixture("shot.png", 12);
  const [a] = await resolveAttachments([{ path: src }], "02-Notes/day.md", neverExists);
  assert.equal(a.storedName, "shot.png");
  assert.equal(a.vaultPath, "02-Notes/shot.png");
  assert.equal(a.contentType, "image/png");
  assert.equal(a.bytes.length, 12);
});

test("resolveAttachments honours an explicit name override", async () => {
  const src = fixture("ugly name.png");
  const [a] = await resolveAttachments([{ path: src, name: "clean.png" }], "n.md", neverExists);
  assert.equal(a.storedName, "clean.png");
  assert.equal(a.vaultPath, "clean.png");
});

test("resolveAttachments suffixes a name already present in the vault", async () => {
  const src = fixture("dup.png");
  const exists = async (p: string) => p === "02-Notes/dup.png";
  const [a] = await resolveAttachments([{ path: src }], "02-Notes/n.md", exists);
  assert.equal(a.storedName, "dup-1.png");
});

test("resolveAttachments suffixes collisions within the same batch", async () => {
  const one = fixture("same.png");
  const two = join(scratch, "sub-same.png");
  writeFileSync(two, Buffer.alloc(4, 2));
  const out = await resolveAttachments(
    [{ path: one }, { path: two, name: "same.png" }],
    "02-Notes/n.md",
    neverExists,
  );
  assert.deepEqual(
    out.map((a) => a.storedName),
    ["same.png", "same-1.png"],
  );
});

test("resolveAttachments rejects a missing source path, naming it", async () => {
  const missing = join(scratch, "nope.png");
  await assert.rejects(
    () => resolveAttachments([{ path: missing }], "n.md", neverExists),
    (err: Error) => err.message.includes(missing),
  );
});

test("resolveAttachments rejects a non-image before reading anything", async () => {
  const src = fixture("doc.pdf");
  await assert.rejects(() => resolveAttachments([{ path: src }], "n.md", neverExists), /\.pdf/);
});

test("resolveAttachments enforces the size cap, reporting actual and limit", async () => {
  const src = fixture("big.png", 2048);
  const prev = process.env.OBSIDIAN_MAX_ATTACHMENT_BYTES;
  process.env.OBSIDIAN_MAX_ATTACHMENT_BYTES = "1024";
  try {
    await assert.rejects(
      () => resolveAttachments([{ path: src }], "n.md", neverExists),
      (err: Error) => err.message.includes("2048") && err.message.includes("1024"),
    );
  } finally {
    if (prev === undefined) delete process.env.OBSIDIAN_MAX_ATTACHMENT_BYTES;
    else process.env.OBSIDIAN_MAX_ATTACHMENT_BYTES = prev;
  }
});

test("resolveAttachments returns an empty list for no input", async () => {
  assert.deepEqual(await resolveAttachments([], "n.md", neverExists), []);
});
