import { createHash } from "crypto";

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
  const posix = path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/^(\.\/)+/, "");
  // Traversal is never a style question: a `..` segment lets a path escape the
  // scope check (and, once collapsed by the HTTP layer, land anywhere in the vault).
  if (posix.split("/").includes("..")) {
    throw new Error(`Write blocked: path contains a '..' segment: ${path}`);
  }
  const mode = guardMode();
  if (mode === "off") return [];
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

/** Key names whose value is a secret: `token`, `apiKey`, `pageToken`, `AWS_SECRET_ACCESS_KEY`, `passwords`… — not `tokenizer`, `secretary`. */
export const SECRET_KEY = /^[A-Za-z0-9_-]*?(?:secret|token|password|passwd|api[_-]?key)(?:s|[_-][A-Za-z0-9_-]*)?$/i;

// Unquoted values that are code or plain data, never a credential: type words,
// numbers, member expressions (`process.env.X`), variable references (`$VAR`,
// `<placeholder>`) and camelCase identifiers (`hashedPassword`). Quoted values are
// always treated as data and redacted.
const NOT_A_SECRET =
  /^(?:string|number|boolean|bigint|any|unknown|undefined|null|none|true|false|yes|no|bearer|\d+(?:\.\d+)?)$/i;

function looksLikeCode(v: string): boolean {
  return (
    NOT_A_SECRET.test(v) ||
    /^[A-Za-z_$][\w$]*(?:\.[\w$]+)+$/.test(v) ||
    /^[$<]/.test(v) ||
    /^[a-z]{2,}(?:[A-Z][a-z0-9]{2,})+$/.test(v)
  );
}

const KEY_VALUE =
  /(^|[^A-Za-z0-9_-])([A-Za-z0-9_-]*?(?:secret|token|password|passwd|api[_-]?key)(?:s|[_-][A-Za-z0-9_-]*)?)(["']?\s*[:=]\s*)(?:(["'])([^"'\n]*)\4|([^\s"',;()[\]{}]+))/gi;

// Provider-shaped credentials, matched wherever they appear. Run BEFORE the
// key/value rule so `token: Bearer <jwt>` loses the jwt, not just the word "Bearer".
const PROVIDER: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
];

/** Redact secret VALUES (never bare words or code) and report how many were replaced. */
export function scrubSecrets(content: string): { content: string; redactions: number } {
  if (process.env.OBSIDIAN_SECRET_SCRUB === "off") return { content, redactions: 0 };
  let redactions = 0;
  let out = content;
  const count = (rep: string) => () => {
    redactions++;
    return rep;
  };

  for (const re of PROVIDER) out = out.replace(re, count(MARK));
  out = out.replace(/\bBearer\s+(?!\[REDACTED)[A-Za-z0-9._~+/=-]{16,}/g, count(`Bearer ${MARK}`));
  out = out.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s@]+@/gi, (_m, scheme: string) => {
    redactions++;
    return `${scheme}${MARK}@`;
  });

  out = out.replace(
    KEY_VALUE,
    (m: string, lead: string, key: string, sep: string, q: string | undefined, qv: string | undefined, bare: string | undefined, offset: number, whole: string) => {
      if (q !== undefined) {
        const v = qv ?? "";
        if (v.length < 4 || v.includes(MARK)) return m;
        redactions++;
        return `${lead}${key}${sep}${q}${MARK}${q}`;
      }
      const v = bare ?? "";
      const next = whole[offset + m.length];
      if (v.length < 4 || v.startsWith("[REDACTED") || looksLikeCode(v) || next === "(") return m;
      redactions++;
      return `${lead}${key}${sep}${MARK}`;
    },
  );
  return { content: out, redactions };
}

/**
 * JSON-aware scrub for structured data: a string value under a secret-named key
 * is replaced, other strings get the text scrub. Numbers/booleans are kept, so the
 * result always serialises to valid JSON.
 */
export function scrubValue(v: unknown, key?: string): { value: unknown; redactions: number } {
  if (process.env.OBSIDIAN_SECRET_SCRUB === "off") return { value: v, redactions: 0 };
  if (typeof v === "string") {
    if (key !== undefined && SECRET_KEY.test(key) && v.length >= 4 && !v.includes(MARK)) {
      return { value: MARK, redactions: 1 };
    }
    const r = scrubSecrets(v);
    return { value: r.content, redactions: r.redactions };
  }
  if (Array.isArray(v)) {
    let n = 0;
    const value = v.map((x) => {
      const r = scrubValue(x, key);
      n += r.redactions;
      return r.value;
    });
    return { value, redactions: n };
  }
  if (v && typeof v === "object") {
    let n = 0;
    const value: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const r = scrubValue(x, k);
      n += r.redactions;
      value[k] = r.value;
    }
    return { value, redactions: n };
  }
  return { value: v, redactions: 0 };
}

// ── Write ledger ──────────────────────────────────────────────────────────────
// Every write is recorded in the vault itself — one daily note per day under
// 02-Notes/Sessions/write-ledger/YYYY-MM/ — so the user owns the record, it syncs
// with the vault, and nothing about a session lives only in ~/.claude or /tmp.
// Ledger notes are kept out of the search index (see kb.ts getExcludes).

export interface LedgerEntry {
  ts: string;
  tool: string;
  path: string;
  op: string;
  sha: string;
  pid: number;
}

/** The subset of ObsidianClient the ledger needs (kept structural for tests). */
export interface LedgerClient {
  createOrUpdateFile(p: string, c: string, mode: "append" | "prepend" | "overwrite"): Promise<void>;
  getFile(p: string): Promise<string>;
  checkExists(p: string): Promise<boolean>;
}

const PROCESS_START = new Date();

export function ledgerDir(): string {
  return (process.env.OBSIDIAN_WRITE_LEDGER_DIR ?? "02-Notes/Sessions/write-ledger").replace(/\/+$/, "");
}

function ledgerEnabled(): boolean {
  return process.env.OBSIDIAN_WRITE_LEDGER !== "off";
}

/** Vault path of the ledger note for a UTC day, e.g. 02-Notes/Sessions/write-ledger/2026-09/2026-09-28.md */
export function ledgerNoteFor(day: string): string {
  return `${ledgerDir()}/${day.slice(0, 7)}/${day}.md`;
}

export function isLedgerPath(p: string): boolean {
  return p.startsWith(ledgerDir() + "/");
}

const LINE = /^- (\S+) \| ([^|]+) \| ([^|]+) \| (.+) \| ([0-9a-f]*|-) \| pid (\d+)$/;

function renderLine(e: LedgerEntry): string {
  // `|` never appears in a vault path we accept; replace defensively so the line stays parseable.
  const path = e.path.replace(/\|/g, "/");
  return `- ${e.ts} | ${e.tool} | ${e.op} | ${path} | ${e.sha || "-"} | pid ${e.pid}`;
}

const knownNotes = new Set<string>();

/** Best-effort: a ledger failure never fails the write it describes. */
export async function appendLedger(
  client: LedgerClient,
  e: Omit<LedgerEntry, "ts" | "pid">,
): Promise<void> {
  if (!ledgerEnabled() || isLedgerPath(e.path)) return;
  try {
    const entry: LedgerEntry = { ts: new Date().toISOString(), pid: process.pid, ...e };
    const day = entry.ts.slice(0, 10);
    const note = ledgerNoteFor(day);
    if (!knownNotes.has(note) && !(await client.checkExists(note))) {
      await client.createOrUpdateFile(
        note,
        `---\ntype: ledger\ndate: ${day}\ntags: [write-ledger]\n---\n\n# Vault write ledger — ${day}\n\n` +
          "Every note written through ultimate-obsidian-mcp: `time | tool | op | path | sha256 | process`.\n\n",
        "overwrite",
      );
    }
    knownNotes.add(note);
    await client.createOrUpdateFile(note, renderLine(entry) + "\n", "append");
  } catch {
    /* ignore — the write itself already succeeded */
  }
}

function daysBetween(from: Date, to: Date): string[] {
  const out: string[] = [];
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  while (d.getTime() <= end && out.length < 62) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** Ledger entries at or after `since` (default: this server process start), read from the vault. */
export async function readLedger(
  client: LedgerClient,
  opts: { since?: string; pathPrefix?: string } = {},
): Promise<LedgerEntry[]> {
  const since = opts.since ?? PROCESS_START.toISOString();
  const out: LedgerEntry[] = [];
  for (const day of daysBetween(new Date(since), new Date())) {
    let text: string;
    try {
      text = await client.getFile(ledgerNoteFor(day));
    } catch {
      continue; // no writes that day
    }
    for (const line of text.split("\n")) {
      const m = line.trim().match(LINE);
      if (!m) continue;
      const e: LedgerEntry = {
        ts: m[1],
        tool: m[2].trim(),
        op: m[3].trim(),
        path: m[4].trim(),
        sha: m[5] === "-" ? "" : m[5],
        pid: Number(m[6]),
      };
      if (e.ts < since) continue;
      if (opts.pathPrefix && !e.path.startsWith(opts.pathPrefix)) continue;
      out.push(e);
    }
  }
  return out;
}
