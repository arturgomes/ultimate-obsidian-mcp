import { createHash } from "crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
} from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

// ── Write boundary: scope guard, secret scrub, write ledger ───────────────────
// The vault-persistence rules used to live only in skill prompts. They are
// enforced here, once, for every write tool.

export interface WriteResult {
  ok: true;
  path: string;
  op: string;
  sha: string;
  bytes: number;
  warnings: string[];
  redactions: number;
  attachments: string[];
}

export function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

// ── Scope guard ───────────────────────────────────────────────────────────────

const DEFAULT_SCOPE = [
  "02-Notes/Sessions/",
  "02-Notes/Plans/",
  "02-Notes/Reports/",
  "02-Notes/Specs/",
  "02-Notes/pr-descriptions/",
  "03-Systems/",
];

type GuardMode = "warn" | "strict" | "off";

function guardMode(): GuardMode {
  const v = process.env.OBSIDIAN_WRITE_GUARD;
  return v === "strict" || v === "off" ? v : "warn";
}

function scopes(): string[] {
  const raw = process.env.OBSIDIAN_WRITE_SCOPE;
  if (!raw) return DEFAULT_SCOPE;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Check a vault-relative write path against the write-scope and month-bucket
 * rules. Returns warnings; in strict mode throws instead, before any byte is
 * written.
 */
export function guardPath(path: string): string[] {
  const mode = guardMode();
  if (mode === "off") return [];
  const posix = path.replace(/\\/g, "/").replace(/^\/+/, "");
  const warnings: string[] = [];

  if (!scopes().some((s) => posix.startsWith(s))) {
    warnings.push(`outside write-scope: ${posix}`);
  }
  const m = posix.match(/^(02-Notes\/(?:Plans|Reports))\/([^/]+)$/);
  if (m) warnings.push(`not month-bucketed: expected ${m[1]}/YYYY-MM/${m[2]}`);

  if (mode === "strict" && warnings.length > 0) {
    throw new Error(`Write blocked: ${warnings.join("; ")}`);
  }
  return warnings;
}

// ── Secret scrub ──────────────────────────────────────────────────────────────

const MARK = "[REDACTED]";
const PLAIN_VALUES = /^(true|false|null|none|yes|no)$/i;

/** Redact secret VALUES (never bare words) and report how many were replaced. */
export function scrubSecrets(content: string): { content: string; redactions: number } {
  if (process.env.OBSIDIAN_SECRET_SCRUB === "off") return { content, redactions: 0 };
  let redactions = 0;
  let out = content;

  out = out.replace(
    /((?:api[_-]?key|secret|token|password|passwd)["']?\s*[:=]\s*["']?)([^\s"',}]{4,})/gi,
    (m: string, pre: string, val: string) => {
      if (val === MARK || val.startsWith("[REDACTED") || PLAIN_VALUES.test(val)) return m;
      redactions++;
      return pre + MARK;
    },
  );

  const simple: Array<[RegExp, string]> = [
    [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g, `Bearer ${MARK}`],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, MARK],
    [/([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s@]+@/gi, `$1${MARK}@`],
    [/\bAKIA[0-9A-Z]{16}\b/g, MARK],
    [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, MARK],
    [/\bsk-[A-Za-z0-9_-]{20,}\b/g, MARK],
    [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, MARK],
  ];
  for (const [re, rep] of simple) {
    out = out.replace(re, (...args: unknown[]) => {
      redactions++;
      const groups = args.slice(1, -2) as string[];
      return rep.replace(/\$(\d)/g, (_m, n: string) => groups[Number(n) - 1] ?? "");
    });
  }
  return { content: out, redactions };
}

// ── Write ledger ──────────────────────────────────────────────────────────────
// Metadata about writes (path, sha, time) — not a copy of any vault artifact.

export interface LedgerEntry {
  ts: string;
  tool: string;
  path: string;
  op: string;
  sha: string;
  pid: number;
}

const PROCESS_START = new Date();
const DEFAULT_LEDGER_MAX = 5 * 1024 * 1024;

function ledgerPath(): string {
  return process.env.CI_WRITE_LEDGER ?? join(homedir(), ".claude", "memory", "write-ledger.jsonl");
}

function ledgerMax(): number {
  const n = Number(process.env.CI_WRITE_LEDGER_MAX_BYTES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LEDGER_MAX;
}

/** Best-effort: a ledger failure never fails the write it describes. */
export function appendLedger(e: Omit<LedgerEntry, "ts" | "pid">): void {
  try {
    const file = ledgerPath();
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file) && statSync(file).size > ledgerMax()) renameSync(file, `${file}.1`);
    const entry: LedgerEntry = { ts: new Date().toISOString(), pid: process.pid, ...e };
    appendFileSync(file, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    /* ignore */
  }
}

export function readLedger(opts: { since?: string; pathPrefix?: string } = {}): LedgerEntry[] {
  const file = ledgerPath();
  if (!existsSync(file)) return [];
  const since = opts.since ?? PROCESS_START.toISOString();
  const out: LedgerEntry[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as LedgerEntry;
      if (e.ts < since) continue;
      if (opts.pathPrefix && !e.path.startsWith(opts.pathPrefix)) continue;
      out.push(e);
    } catch {
      /* skip torn line */
    }
  }
  return out;
}
