#!/usr/bin/env node
// Standalone KB reindex entry — used by the SessionStart catch-up hook.
// Incremental by default (fast no-op when the vault is unchanged); --force rebuilds all.
// Config via env: OBSIDIAN_VAULT_PATH, CI_KB_INDEX, CI_KB_EXCLUDE.
import { reindexVault } from "./kb.js";

const force = process.argv.includes("--force");
try {
  const s = reindexVault({ force });
  process.stdout.write(
    `[kb] reindex: indexed ${s.indexed}, skipped ${s.skipped}, removed ${s.removed}, chunks ${s.chunks}\n`,
  );
} catch (err) {
  process.stderr.write(`[kb] reindex failed: ${(err as Error).message}\n`);
  process.exit(0); // never block session start on a KB miss
}
