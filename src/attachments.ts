import { readFile, stat } from "fs/promises";
import { basename, extname } from "path";

// ── Image attachments for vault writes ────────────────────────────────────────
// Resolution is pure-ish and fully decided BEFORE any byte reaches the vault:
// every attachment is validated, read, and given a collision-free destination
// first, so a bad attachment aborts the call while the note is still untouched.

export interface AttachmentInput {
  /** Local filesystem path to the image to copy into the vault. */
  path: string;
  /** Override for the stored filename (defaults to the source basename). */
  name?: string;
}

export interface ResolvedAttachment {
  /** Vault-relative destination, e.g. "02-Notes/shot.png". */
  vaultPath: string;
  /** Final basename after sanitisation and collision suffixing. */
  storedName: string;
  bytes: Buffer;
  contentType: string;
}

/** Existence probe over vault-relative paths — injected so this module stays testable. */
export type ExistsFn = (vaultPath: string) => Promise<boolean>;

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
};

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Characters that break an Obsidian wikilink, a vault path, or a filesystem.
 * Spaces are deliberately kept - Obsidian resolves an embed with spaces fine.
 */
const UNSAFE = /[\[\]|#^/\\:*?"<>]/g;

function maxAttachmentBytes(): number {
  const raw = process.env.OBSIDIAN_MAX_ATTACHMENT_BYTES;
  if (!raw) return DEFAULT_MAX_BYTES;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BYTES;
}

/**
 * Reduce an arbitrary string to a filename that is safe in a vault path AND
 * inside `![[...]]`. Any path component is dropped first, so a caller cannot
 * escape the note's directory via `name`.
 */
export function sanitizeName(raw: string): string {
  const cleaned = basename(raw.replace(/\\/g, "/"))
    .replace(UNSAFE, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[.\s]+|[.\s]+$/g, "");
  return cleaned === "" ? "attachment" : cleaned;
}

export function contentTypeFor(name: string): string {
  const ext = extname(name).toLowerCase();
  if (ext === "") throw new Error(`Attachment '${name}' has no file extension — cannot infer an image type`);
  const mime = IMAGE_MIME[ext];
  if (!mime) {
    throw new Error(
      `Attachment type '${ext}' is not a supported image (allowed: ${Object.keys(IMAGE_MIME).join(", ")})`,
    );
  }
  return mime;
}

/** Join a vault directory and a filename without producing a leading slash at the root. */
export function vaultJoin(dir: string, name: string): string {
  const d = dir.replace(/\/+$/, "");
  return d === "" || d === "." ? name : `${d}/${name}`;
}

/** Vault-relative directory containing `filepath` ("" when it sits at the vault root). */
function vaultDirOf(filepath: string): string {
  const idx = filepath.replace(/\\/g, "/").lastIndexOf("/");
  return idx === -1 ? "" : filepath.slice(0, idx);
}

/**
 * First filename in `dir` that collides with neither an existing vault file nor a
 * name already claimed earlier in this same batch. Never overwrites.
 */
async function nextFreeName(
  dir: string,
  name: string,
  exists: ExistsFn,
  taken: Set<string> = new Set(),
): Promise<string> {
  const ext = extname(name);
  const stem = ext === "" ? name : name.slice(0, -ext.length);
  for (let i = 0; ; i++) {
    const candidate = i === 0 ? name : `${stem}-${i}${ext}`;
    if (!taken.has(candidate) && !(await exists(vaultJoin(dir, candidate)))) return candidate;
  }
}

async function readImageBytes(srcPath: string): Promise<Buffer> {
  let size: number;
  try {
    const info = await stat(srcPath);
    if (!info.isFile()) throw new Error("not a regular file");
    size = info.size;
  } catch (err) {
    throw new Error(`Attachment not readable: ${srcPath} (${(err as Error).message})`);
  }

  const limit = maxAttachmentBytes();
  if (size > limit) {
    throw new Error(`Attachment too large: ${srcPath} is ${size} bytes, limit is ${limit} bytes`);
  }

  try {
    return await readFile(srcPath);
  } catch (err) {
    throw new Error(`Attachment not readable: ${srcPath} (${(err as Error).message})`);
  }
}

/**
 * Validate and load every attachment, assigning each a collision-free destination
 * beside `noteFilepath`. Throws on the first bad attachment — by contract this runs
 * before the note write, so a rejection leaves the note untouched.
 */
export async function resolveAttachments(
  inputs: AttachmentInput[],
  noteFilepath: string,
  exists: ExistsFn,
): Promise<ResolvedAttachment[]> {
  const dir = vaultDirOf(noteFilepath);
  const taken = new Set<string>();
  const resolved: ResolvedAttachment[] = [];

  for (const input of inputs) {
    const desired = sanitizeName(input.name ?? input.path);
    const contentType = contentTypeFor(desired);
    const bytes = await readImageBytes(input.path);
    const storedName = await nextFreeName(dir, desired, exists, taken);
    taken.add(storedName);
    resolved.push({ vaultPath: vaultJoin(dir, storedName), storedName, bytes, contentType });
  }

  return resolved;
}

export function renderEmbeds(attachments: ResolvedAttachment[]): string {
  return attachments.map((a) => `![[${a.storedName}]]`).join("\n");
}

/** Append one embed per attachment after the written content. No attachments ⇒ content unchanged. */
export function withEmbeds(content: string, attachments: ResolvedAttachment[]): string {
  if (attachments.length === 0) return content;
  return `${content.replace(/\s+$/, "")}\n\n${renderEmbeds(attachments)}\n`;
}
