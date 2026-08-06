# Spec — Image attachments on document writes

Status: **READY** (Definition-of-Ready gate passed 2026-08-06)
Slug: `image-attachments-on-writes`

## Goal

Let a caller attach local image files to an `ultimate-obsidian-mcp` note write. The server copies each
image into the vault beside the target note and appends an Obsidian embed to the written content, so a
single tool call produces a note that already renders its images.

## Clarifications

### Session 2026-08-06

- **Q: Where does the image binary come from?** → A local filesystem path. The MCP copies the image
  into the same folder as the markdown file.
- **Q: Where do attached images land in the vault?** → Beside the target note (same directory).
- **Q: API shape?** → An optional `attachments[]` parameter on the existing write tools, not a new
  standalone tool.
- **Q: How does the link get into the note?** → Auto-append an `![[filename]]` embed at the end of the
  written content.

## Assumptions (not clarified — routine defaults, stated for the record)

- **A-1** Attachments upload **before** the note write. Any attachment failure aborts the whole call
  and leaves the note untouched. Rationale: an orphaned binary is inert; a note embedding a missing
  image is visibly broken. A partial run can therefore leave already-uploaded images in the vault.
- **A-2** Only image extensions are accepted (`png jpg jpeg gif webp svg bmp avif`). The goal says
  "images"; arbitrary binary upload is out of scope.
- **A-3** Default size cap 10 MB per attachment, overridable via `OBSIDIAN_MAX_ATTACHMENT_BYTES`.
- **A-4** Name collisions in the destination folder are resolved by suffixing `-1`, `-2`, … The
  existing file is never overwritten.
- **A-5** For `mode: "prepend"`, embeds attach to the **content being written**, so they land at the
  end of the newly prepended block, not at the end of the file.

## User stories (priority order)

### US1 — Attach images when creating or updating a note (P1)

As a caller, I write a note and hand it one or more local image paths, and the note comes back
already embedding those images from the same folder.

**Independent Test:** call `create_or_update_note` with `filepath: "02-Notes/x.md"`, some content, and
one attachment pointing at a local PNG. Assert: `02-Notes/x.png` exists in the vault, and `x.md` ends
with `![[x.png]]`.

### US2 — Attach images when patching a note (P2)

As a caller, I patch a section of an existing note and attach an image to that patch.

**Independent Test:** call `patch_note` against an existing heading with one attachment. Assert the
image is stored beside the note and the embed appears inside the patched section.

## Functional requirements

| ID | Requirement |
|----|-------------|
| FR-001 | `create_or_update_note` accepts an optional `attachments[]`, each item `{ path: string, name?: string }`. |
| FR-002 | `patch_note` accepts the same optional `attachments[]` with identical semantics. |
| FR-003 | Each attachment's bytes are read from the given local filesystem path; an unreadable/missing path is an error naming the path. |
| FR-004 | The destination is the **same vault directory as the target note** (`dirname(filepath)`). |
| FR-005 | The stored filename is `name` when given, else the source basename; it is sanitized to a safe vault filename. |
| FR-006 | Only image extensions are accepted (`png jpg jpeg gif webp svg bmp avif`); anything else is rejected with the offending extension named. |
| FR-007 | An attachment larger than the configured cap is rejected, reporting actual and permitted size. |
| FR-008 | Bytes are written through `ObsidianClient` via `PUT /vault/{path}` with the extension's MIME type — the same write boundary as every other vault mutation. |
| FR-009 | All attachments are uploaded **before** the note write; any failure aborts the call and the note is not written. |
| FR-010 | One `![[storedName]]` embed per attachment is appended to the written content, in input order. |
| FR-011 | The tool result reports the note path and every stored attachment path. |
| FR-012 | With `attachments` omitted or empty, behavior is byte-identical to the current implementation. |
| FR-013 | A destination collision never overwrites: the stored name is suffixed until free. |

## Success criteria

| ID | Criterion | Kind |
|----|-----------|------|
| SC-001 | The project typechecks and builds with zero errors. | buildable |
| SC-002 | Unit tests cover filename sanitization, collision suffixing, extension/MIME resolution, size-cap rejection, and embed rendering — all passing. | buildable |
| SC-003 | A single write call carrying one image yields a note that renders that image in Obsidian with no follow-up call. | outcome |
| SC-004 | A write call with no attachments issues exactly the same vault request as before the change. | buildable |

## Scenarios

- **Happy:** one PNG, note in `02-Notes/` → image at `02-Notes/<name>.png`, embed appended.
- **Happy:** three images → three uploads, three embeds, input order preserved.
- **Edge:** note at vault root (`dirname` = `""`) → image stored at vault root, no leading slash.
- **Edge:** two attachments with the same basename → second stored as `<name>-1.<ext>`.
- **Edge:** source basename contains spaces/unicode → sanitized, embed matches the stored name.
- **Failure:** second of three images missing on disk → nothing written to the note; error names that path.
- **Failure:** `.pdf` passed → rejected before any upload.
- **Failure:** 20 MB image under a 10 MB cap → rejected before any upload.

## Out of scope

- Non-image binary attachment.
- Remote URL or base64 image sources.
- Placeholder-token embed placement mid-document.
- Resolving Obsidian's configured attachment folder (`attachmentFolderPath`) — explicitly overridden
  by the "beside the target note" decision.
- Image resizing, format conversion, EXIF stripping, deduplication by content hash.

## Definition of Done

- FR-001 … FR-013 implemented and traceable to a task.
- SC-001, SC-002, SC-004 pass mechanically.
- No new runtime dependency.
- `README.md` documents the `attachments[]` parameter on both tools.
- Existing callers that pass no `attachments` are unaffected.
