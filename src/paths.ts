import { homedir } from "os";
import { isAbsolute, join, normalize, relative, resolve, sep } from "path";
import { getVaultRoot } from "./kb.js";

export interface VaultPath {
  /** Vault-relative POSIX path, e.g. "02-Notes/Sessions/a.md". */
  rel: string;
  /** Absolute filesystem path under the vault root. */
  abs: string;
}

/**
 * Resolve a caller-supplied path to a vault-relative + absolute pair. Accepts a
 * vault-relative path, `~/...`, or an absolute path inside the vault root.
 * Anything that lands outside the vault is rejected.
 */
export function resolveVaultPath(input: string): VaultPath {
  const root = resolve(getVaultRoot());
  let p = input.trim();
  if (p === "~" || p.startsWith("~/")) p = join(homedir(), p.slice(1));

  const rel = isAbsolute(p) ? relative(root, resolve(p)) : normalize(p);
  const posix = rel.split(sep).join("/");
  if (!posix || posix === ".." || posix.startsWith("../") || isAbsolute(posix)) {
    throw new Error(`Path outside vault: ${input}`);
  }
  return { rel: posix, abs: join(root, posix) };
}
