import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { reindexVault, searchKb } from "./kb.js";

const FILES = ["Sessions/a.md", "Sessions-old/b.md", "Books/c.md"];

function withVault(fn: () => void): void {
  const scratch = mkdtempSync(join(tmpdir(), "kb-test-"));
  const vault = join(scratch, "vault");
  for (const rel of FILES) {
    mkdirSync(join(vault, rel, ".."), { recursive: true });
    writeFileSync(join(vault, rel), `# Heading for ${rel}\n\nNotes about idempotency in ${rel}.\n`);
  }
  const prev = { vault: process.env.OBSIDIAN_VAULT_PATH, idx: process.env.CI_KB_INDEX };
  process.env.OBSIDIAN_VAULT_PATH = vault;
  process.env.CI_KB_INDEX = join(scratch, "idx", "kb.db");
  try {
    reindexVault({ force: true });
    fn();
  } finally {
    for (const [k, v] of [["OBSIDIAN_VAULT_PATH", prev.vault], ["CI_KB_INDEX", prev.idx]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}

const paths = (hits: { source_relpath: string }[]) => hits.map((h) => h.source_relpath).sort();

test("searchKb pathPrefix restricts hits to a folder on a segment boundary", () => {
  withVault(() => {
    assert.deepEqual(paths(searchKb("idempotency", 10)), [...FILES].sort());
    assert.deepEqual(paths(searchKb("idempotency", 10, "Sessions")), ["Sessions/a.md"]);
    assert.deepEqual(paths(searchKb("idempotency", 10, "Sessions/")), ["Sessions/a.md"]);
    assert.deepEqual(paths(searchKb("idempotency", 10, "Sessions-old")), ["Sessions-old/b.md"]);
    assert.deepEqual(searchKb("idempotency", 10, "Nope"), []);
    assert.deepEqual(paths(searchKb("idempotency", 10, "")), [...FILES].sort());
  });
});
