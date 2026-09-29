import { createHash, randomUUID } from "crypto";
import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { stringify } from "yaml";
import { parseFrontmatter } from "./frontmatter.js";

// ── Orchestration state notes (`*.state.md`) ──────────────────────────────────
// Shape (mediator contract): YAML frontmatter + exactly one fenced ```json block
// holding a single JSON object. Whole-note overwrite only, guarded by a sha
// compare-and-swap so parallel writers cannot silently lose each other's update.

const JSON_FENCE = /```json[ \t]*\r?\n([\s\S]*?)\r?\n```/g;

export interface ParsedState {
  frontmatter: Record<string, unknown>;
  state: Record<string, unknown>;
}

export function parseStateNote(text: string): ParsedState {
  const fences = [...text.matchAll(JSON_FENCE)];
  if (fences.length !== 1) {
    throw new Error(`state note must contain exactly one \`\`\`json fence (found ${fences.length})`);
  }
  let state: unknown;
  try {
    state = JSON.parse(fences[0][1]);
  } catch (err) {
    throw new Error(`state json fence is not valid JSON: ${(err as Error).message}`);
  }
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error("state json fence must be a JSON object");
  }
  return { frontmatter: parseFrontmatter(text).data, state: state as Record<string, unknown> };
}

export function renderStateNote(
  frontmatter: Record<string, unknown>,
  state: Record<string, unknown>,
): string {
  const fm = Object.keys(frontmatter).length === 0 ? "" : stringify(frontmatter).trimEnd();
  return `---\n${fm}\n---\n\n\`\`\`json\n${JSON.stringify(state, null, 2)}\n\`\`\`\n`;
}

// ── Cross-process lock ────────────────────────────────────────────────────────
// Teammates run separate MCP processes, so an in-memory mutex would not span
// them. O_EXCL lock files do. A lock older than the stale window is broken.

function num(name: string, dflt: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

// Lock files are throwaway coordination, not records: they live in the OS temp dir.
export function lockFileFor(filepath: string): string {
  const dir = process.env.CI_LOCK_DIR ?? join(tmpdir(), "ultimate-obsidian-mcp-locks");
  mkdirSync(dir, { recursive: true });
  return join(dir, createHash("sha1").update(filepath).digest("hex") + ".lock");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function readToken(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Break a stale lock without ever deleting a fresh one. The lock is moved aside
 * atomically; if what we moved is not the stale lock we inspected (someone broke
 * it and re-acquired in between), it is linked back and left alone.
 */
function breakStale(lock: string, seen: string): void {
  const aside = `${lock}.${randomUUID()}.stale`;
  try {
    renameSync(lock, aside);
  } catch {
    return; // already gone or already moved by another breaker
  }
  if (readToken(aside) !== seen) {
    try {
      linkSync(aside, lock); // restore the live lock we took by mistake
    } catch {
      /* a new lock already exists; the live holder's release is token-checked */
    }
  }
  try {
    unlinkSync(aside);
  } catch {
    /* ignore */
  }
}

export async function withLock<T>(filepath: string, fn: () => Promise<T>): Promise<T> {
  const lock = lockFileFor(filepath);
  const timeout = num("CI_STATE_LOCK_TIMEOUT_MS", 5000);
  // Must exceed the longest legitimate hold: up to four REST calls, each with its own timeout.
  const stale = num("CI_STATE_LOCK_STALE_MS", 120_000);
  const token = `${process.pid}:${randomUUID()}`;
  const started = Date.now();

  for (;;) {
    try {
      const fd = openSync(lock, "wx");
      writeSync(fd, token);
      closeSync(fd);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const seen = readToken(lock);
      let age = 0;
      try {
        age = Date.now() - statSync(lock).mtimeMs;
      } catch {
        continue; // released between the EEXIST and the stat — retry now
      }
      if (seen !== undefined && age > stale) {
        breakStale(lock, seen);
        continue;
      }
      if (Date.now() - started > timeout) throw new Error(`state lock busy: ${filepath}`);
      await sleep(50);
    }
  }
  try {
    return await fn();
  } finally {
    // Release only our own lock; if it was broken and re-taken, it is not ours to delete.
    if (readToken(lock) === token) {
      try {
        unlinkSync(lock);
      } catch {
        /* already gone */
      }
    }
  }
}
