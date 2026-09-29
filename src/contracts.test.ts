import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";

import { resolveVaultPath } from "./paths.js";
import { buildMatchExpr, buildPhraseMatchExpr } from "./fts.js";
import {
  parseFrontmatter,
  setFrontmatterKey,
  deleteFrontmatterKey,
  fmString,
} from "./frontmatter.js";
import { guardPath, scrubSecrets, appendLedger, readLedger } from "./writes.js";

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    prev[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

// ── K1 resolveVaultPath ──────────────────────────────────────────────────────

test("K1 resolveVaultPath: vault-relative stays relative", () => {
  withEnv({ OBSIDIAN_VAULT_PATH: "/tmp/vault-k1" }, () => {
    const r = resolveVaultPath("02-Notes/a.md");
    assert.equal(r.rel, "02-Notes/a.md");
    assert.equal(r.abs, "/tmp/vault-k1/02-Notes/a.md");
  });
});

test("K1 resolveVaultPath: expands ~ and strips the vault root", () => {
  const root = join(homedir(), "k1-vault-does-not-need-to-exist");
  withEnv({ OBSIDIAN_VAULT_PATH: root }, () => {
    const r = resolveVaultPath("~/k1-vault-does-not-need-to-exist/02-Notes/a.md");
    assert.equal(r.rel, "02-Notes/a.md");
  });
});

test("K1 resolveVaultPath: rejects paths outside the vault", () => {
  withEnv({ OBSIDIAN_VAULT_PATH: "/tmp/vault-k1" }, () => {
    assert.throws(() => resolveVaultPath("/etc/passwd"), /outside vault/);
    assert.throws(() => resolveVaultPath("../x.md"), /outside vault/);
    assert.throws(() => resolveVaultPath("a/../../x.md"), /outside vault/);
  });
});

// ── K2 fts ───────────────────────────────────────────────────────────────────

test("K2 buildPhraseMatchExpr: hyphenated ids become quoted phrases", () => {
  assert.equal(buildPhraseMatchExpr("SEATHQ-9999"), '"seathq 9999"');
  assert.equal(buildPhraseMatchExpr("02-Notes/Sessions"), '"02 notes sessions"');
});

test("K2 buildPhraseMatchExpr: plain words keep prefix matching; a one-digit id stays a phrase", () => {
  assert.equal(buildPhraseMatchExpr("auth fix"), "auth* OR fix");
  assert.equal(buildPhraseMatchExpr("auth SEATHQ-1"), 'auth* OR "seathq 1"');
  assert.equal(buildPhraseMatchExpr("x-"), "");
});

test("K2 buildPhraseMatchExpr: empty and hostile input never throws", () => {
  assert.equal(buildPhraseMatchExpr(""), "");
  assert.equal(buildPhraseMatchExpr("---"), "");
  const e = buildPhraseMatchExpr('"; DROP TABLE kb; -- NEAR(a b)');
  assert.ok(!/[;()]/.test(e));
});

test("K2 buildMatchExpr keeps its legacy behaviour", () => {
  assert.equal(buildMatchExpr("how does retry backoff work"), "retry* OR backoff* OR work*");
});

// ── K3 frontmatter ───────────────────────────────────────────────────────────

test("K3 fmString strips YAML quotes and treats empty as undefined", () => {
  const a = parseFrontmatter('---\nticket: "SIT-14683"\n---\nbody');
  assert.equal(fmString(a.data.ticket), "SIT-14683");
  const b = parseFrontmatter('---\nticket: ""\n---\nbody');
  assert.equal(fmString(b.data.ticket), undefined);
  assert.equal(fmString(42), "42");
  assert.equal(fmString(["x"]), undefined);
});

test("K3 parseFrontmatter detects CRLF and keeps dates as strings", () => {
  const p = parseFrontmatter("---\r\ndate: 2026-09-28\r\ntitle: t\r\n---\r\nbody\r\n");
  assert.equal(p.hasFrontmatter, true);
  assert.equal(p.eol, "\r\n");
  assert.equal(p.data.date, "2026-09-28");
  assert.equal(parseFrontmatter("no fm").hasFrontmatter, false);
});

test("K3 setFrontmatterKey writes lists and quotes wikilinks", () => {
  const out = setFrontmatterKey("---\ntitle: t\n---\nbody\n", "tags", ["a", "[[B]]"]);
  const p = parseFrontmatter(out);
  assert.deepEqual(p.data.tags, ["a", "[[B]]"]);
  assert.match(out, /"\[\[B\]\]"/);
  assert.ok(out.endsWith("body\n"));
});

test("K3 deleteFrontmatterKey removes a multi-line value without orphans", () => {
  const src = "---\n# keep me\ntitle: t\ntags:\n  - a\n  - b\n  - c\nz: 1\n---\nbody\n";
  const out = deleteFrontmatterKey(src, "tags");
  assert.ok(!/^\s*- /m.test(out), out);
  assert.match(out, /# keep me/);
  assert.equal(parseFrontmatter(out).data.z, 1);
  assert.deepEqual(Object.keys(parseFrontmatter(out).data), ["title", "z"]);
});

test("K3 CRLF is preserved on edit", () => {
  const out = setFrontmatterKey("---\r\ntitle: t\r\n---\r\nbody\r\n", "k", "v");
  assert.ok(!/[^\r]\n/.test(out.split("body")[0]), JSON.stringify(out));
  assert.equal(parseFrontmatter(out).data.k, "v");
});

test("K3 invalid YAML is never silently rewritten", () => {
  assert.throws(
    () => setFrontmatterKey("---\na: [unclosed\n---\nbody", "k", "v"),
    /Invalid frontmatter YAML/,
  );
});

// ── K4 writes ────────────────────────────────────────────────────────────────

test("K4 guardPath: month bucket and write-scope warnings", () => {
  withEnv({ OBSIDIAN_WRITE_GUARD: undefined, OBSIDIAN_WRITE_SCOPE: undefined }, () => {
    const w1 = guardPath("02-Notes/Reports/x.md");
    assert.equal(w1.length, 1);
    assert.match(w1[0], /month/);
    assert.deepEqual(guardPath("02-Notes/Reports/2026-09/x.md"), []);
    assert.deepEqual(guardPath("02-Notes/Reports/Weekly/x.md"), []);
    const w2 = guardPath("99-Random/x.md");
    assert.equal(w2.length, 1);
    assert.match(w2[0], /outside write-scope/);
  });
});

test("K4 guardPath: strict throws, off is silent, scope override works", () => {
  withEnv({ OBSIDIAN_WRITE_GUARD: "strict" }, () => {
    assert.throws(() => guardPath("99-Random/x.md"), /Write blocked/);
  });
  withEnv({ OBSIDIAN_WRITE_GUARD: "off" }, () => {
    assert.deepEqual(guardPath("99-Random/x.md"), []);
  });
  withEnv({ OBSIDIAN_WRITE_GUARD: undefined, OBSIDIAN_WRITE_SCOPE: "99-Random/" }, () => {
    assert.deepEqual(guardPath("99-Random/x.md"), []);
  });
});

test("K4 scrubSecrets: redacts values, keeps prose and JSON validity", () => {
  withEnv({ OBSIDIAN_SECRET_SCRUB: undefined }, () => {
    const a = scrubSecrets("api_key: abc12345");
    assert.equal(a.content, "api_key: [REDACTED]");
    assert.equal(a.redactions, 1);

    const prose = "The tokenizer and the password reset flow are fine";
    assert.deepEqual(scrubSecrets(prose), { content: prose, redactions: 0 });

    const j = scrubSecrets('{"token": "abcd1234efgh", "n": 1}');
    assert.equal(j.redactions, 1);
    assert.deepEqual(JSON.parse(j.content), { token: "[REDACTED]", n: 1 });

    const u = scrubSecrets("postgres://user:hunter2@db:5432/x");
    assert.equal(u.content, "postgres://[REDACTED]@db:5432/x");

    assert.equal(scrubSecrets("Authorization: Bearer abcdefghijklmnop1234").redactions, 1);
    assert.equal(scrubSecrets("api_key: [REDACTED]").redactions, 0);
  });
  withEnv({ OBSIDIAN_SECRET_SCRUB: "off" }, () => {
    assert.equal(scrubSecrets("api_key: abc12345").redactions, 0);
  });
});

test("K4 ledger: append, filter by since/prefix, rotate", () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-"));
  const file = join(dir, "l.jsonl");
  withEnv({ CI_WRITE_LEDGER: file, CI_WRITE_LEDGER_MAX_BYTES: "200" }, () => {
    const before = new Date(Date.now() - 1000).toISOString();
    appendLedger({ tool: "t", path: "02-Notes/Sessions/a.md", op: "overwrite", sha: "aa" });
    appendLedger({ tool: "t", path: "02-Notes/Plans/b.md", op: "append", sha: "bb" });
    const all = readLedger({ since: before });
    assert.equal(all.length, 2);
    assert.equal(readLedger({ since: before, pathPrefix: "02-Notes/Plans/" }).length, 1);
    assert.equal(readLedger({ since: new Date(Date.now() + 60000).toISOString() }).length, 0);
    for (let i = 0; i < 5; i++) {
      appendLedger({ tool: "t", path: `02-Notes/Sessions/${i}.md`, op: "append", sha: "cc" });
    }
    assert.ok(existsSync(file + ".1"), "rotated");
    assert.ok(readFileSync(file, "utf8").length > 0);
  });
});
