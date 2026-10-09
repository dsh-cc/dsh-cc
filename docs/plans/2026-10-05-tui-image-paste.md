# TUI clipboard image paste

Status: proposed. Branch `dev-tui-image-paste`.

## 1. Problem

Pasting a screenshot into the dsh-cc TUI drops it silently. Nothing appears in
the composer and no error is shown, so the user's only signal is that nothing
happened.

An image paste arrives as an **empty bracketed paste**: the terminal emits
`\x1b[200~` immediately followed by `\x1b[201~`, carrying no payload, because
bracketed paste is a text protocol and the terminal has no clipboard-type
information to send. `Editor.handleInput` gates its paste branch on
`pasteContent.length > 0`, so the empty case falls through and is discarded.

Claude Code solves this by reading the OS pasteboard itself the moment it sees
the paste, writing the image to a per-session directory, and referencing it in
the message. This plan does the same thing, against dsh-cc's own seams.

## 2. Verified evidence (source)

All line numbers are against `main` @ `bc8d259` (v0.9.0-rc.1).

**The drop point.**

- `packages/ui/pi-tui/src/components/editor.ts:628-645` — bracketed-paste
  buffering. `:639` is `if (pasteContent.length > 0)`, so an empty paste never
  reaches `handlePaste`. This is the exact reason nothing appears.
- The same shape appears in `components/input.ts` and `components/masked-input.ts`
  (the secret field, which additionally strips `[\r\n\t]`).

**The transport is already image-capable.**

- `packages/ui/tui/src/harness/driver-queue.ts:37-40` — `asUserMessage` builds
  `content: [{ type: 'text', text }]`. User content is already a typed block
  array, so an image is a block addition, not a new pipeline.
- `@deepseek-ai/dsh-llm` declares
  `ImageBlock = { type: 'image', attachment: ImageAttachmentRef; offloaded?: true }`,
  documented role-neutral but with the note that only `user` messages may carry
  images today (assistant adapters declare text-only output).
- `{ type: 'image', attachment }` in a user message is **self-sufficient**: the
  provider walks message content itself. `dsh-llm-deepseek/lib/index.js:1395-1423`
  (`prepareImages`) reads each ref via `attachments.readImageRequest(ref, target, signal)`
  and emits `{type:'image', source:{type:'base64', media_type, data}}`
  (`:1591-1607`). No separate registration or upload step exists.

**The attachment seam.**

- Service name is `attachments` — `dsh-attachment/lib/index.js:207`
  (`super(ctx, "attachments")`), with the registry augmentation at
  `dsh-attachment/lib/types/index.d.ts:12-16`. Obtained as `ctx.get('attachments')`.
- `saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef>`
  (`dsh-attachment/lib/types/index.d.ts:73`), where `SaveImageAttachment` is
  `{ data: Uint8Array; mediaType: ImageMediaType; name?: string }`
  (`types.d.ts:115-121`) and `ImageMediaType` is
  `image/png|image/jpeg|image/webp|image/gif` (`types.d.ts:5`).
- `attachment-local` is mounted by the base composition
  (`dsh-base/cordis.patch.yml:138`), whose own comment states the design:
  *"Durable image bytes live outside the append-only session log. Messages keep
  content-addressed references that this shared backend resolves for provider
  requests and authorized history reads."* That is precisely the shape here.

**Reference implementation to mirror.**

- `dsh-commands/lib/types/index.js:424` `admitCommandAttachments(store, attachments, ...)`
  → `:445` `admitEncodedImages(store, images)` → `:452`
  `blocks.push(Object.freeze({ type: 'image', attachment: ref }))`. The caller at
  `dsh-commands/lib/index.js:358-364` resolves the store as
  `this.ctx.get("attachments")`. This is the canonical
  bytes → `saveImage` → image-block sequence.
- `dsh-tool-fs/lib/index.js:1003-1015` is the other consumer
  (`read_image`), and `:955-962` builds its result-side image block.

**The editor already anticipates this feature.**

- `editor.ts:1038` — `insertTextAtCursor` is documented as being for
  *"programmatic insertion (e.g., clipboard image markers)"*. The marker idiom is
  named in-tree but nothing produces one.
- `editor.ts:21-25,309-314` — the existing `[paste #N …]` marker machinery:
  `PASTE_MARKER_REGEX`, `pastes: Map<number, string>`, `pasteCounter`,
  `expandPasteMarkers`.
- `editor.ts:233-236` — `EditorOptions` (`paddingX`, `autocompleteMaxVisible`),
  the constructor-option seam.
- `tui-alt-screen.ts:1085-1090` — the established injectable-callback precedent
  for clipboard work, with the rationale recorded: a bare OSC 52 write can report
  success while leaving the system clipboard untouched, so the host injects a real
  implementation and only success is reported. The read direction should mirror
  this rather than shelling out from inside the editor.

**Wiring facts.**

- `packages/ui/tui/src/components/root.ts:103` — `const editor = new Editor(tui, createEditorTheme(theme))`,
  the only `new Editor(` in the repo. `:112` attaches bash mode.
- `editor.onSubmit` is set in `components/root-bash.ts:108`, calling
  `driver.submit(text)` at `:129`.
- `driver-types.ts:55` — `submit(text?: string): Promise<void>`.
- `driver-queue.ts:204` — `const submit = async (rt: DriverQueueCtx, text?: string)`.
  `rt.ctx` is available (`driver-ctx.ts:366-367`, wired from `driver.ts:394`), and
  `dispatchQueued` already uses `rt.ctx.get('ccPlugins')` at `:76`.
- `driver-queue.ts:289` — a second, separate dispatch site:
  `rt.current.agent.followup(createUserMessage({ content: [{ type: 'text', text: draft }], ... }))`.
  Both sites need threading.
- **`asUserMessage` at `:37` is module-level with no `ctx` in scope.** Its caller
  `dispatchQueued` (`:54`) has `rt`; the images/ctx must be threaded in as an
  explicit parameter, or the construction moved into the caller.
- `attachments` is not currently looked up anywhere in the tui package; that
  lookup is new.

**Provider-side gates (must hold or the turn throws).**

- `dsh-llm-deepseek/lib/index.js:1415` — the route model must declare image
  input, else `LlmError(..., "UNSUPPORTED_CONTENT")`: *"requires a vision model
  and attachment service"*.
- `:1416` — images are rejected outside `user` messages and `tool` results.
- `:1418` — `assertImagesFit(...)` may throw `IMAGE_OFFLOAD_REQUIRED_CODE` when
  the inline base64 budget is exceeded; the Files-API path then applies.

## 3. Design

### 3.1 Capture at paste time, spill to disk (R1)

When the paste branch sees `pasteContent.length === 0`, invoke an injected
clipboard reader. On success, write the bytes to a private cache dir and insert a
marker at the cursor; on failure, do nothing at all (silent, matching today's
behavior for an unsupported paste).

**Rejected: holding bytes in memory until submit.** The marker must stay honest —
paste two images, or copy something else in between, and a deferred read attaches
the wrong bytes. Spilling to disk at paste time also keeps composer memory
bounded and matches Claude Code's `~/.claude/uploads/<session-uuid>/<hash>-image.jpg`
shape.

**Rejected: capture at submit time.** Cheaper, but wrong for the two-paste case
and for any clipboard change between paste and submit.

### 3.2 Marker, not a path (R2)

The composer shows `[Image #N]`, reusing the `[paste #N]` grammar and its
marker-aware segmentation. A raw file path would leak a cache path into the
prompt text and into composer history; the marker keeps the prompt clean and the
path is an implementation detail of the submission.

### 3.3 Reader is injected, not imported (R3)

`EditorOptions` gains an optional `onPasteImage?: () => Promise<PastedImage | undefined>`
alongside `paddingX` / `autocompleteMaxVisible`. pi-tui is a vendored port
(`PORTING.md`) with only `marked` and `get-east-asian-width` as dependencies and
no Node platform code; the editor must not learn about `osascript`. The host
(`packages/ui/tui`) owns the platform readers, exactly as it owns `copySelection`
for the write direction.

Platform readers, in preference order, each best-effort and non-throwing:

| Platform | Mechanism |
|---|---|
| macOS | AppKit `NSPasteboard` via `osascript -l JavaScript` (`public.png`, falling back to `public.tiff`) |
| Linux | `wl-paste --type image/png` (Wayland), then `xclip -selection clipboard -t image/png -o` (X11) |
| Windows | PowerShell `Get-Clipboard -Format Image` |
| none | no-op; the paste stays silently dropped as today |

Layout note: the byte-reading half of this already exists and is verified as
`clipimg` (`~/.local/bin/clipimg`); the JXA lands on `NSFileHandle` writing to
stdout rather than `writeToFileAtomically('/dev/stdout')`, which silently yields
6 bytes because it renames a temp file into place.

### 3.4 Composer → driver must carry images (R4)

`editor.onSubmit` currently passes text only, so the marker would reach the model
as literal `[Image #1]` prose. The submission must carry the resolved images
alongside the text.

Chosen shape: the editor exposes the resolved submission (`text` plus an ordered
image list), and `root-bash.ts` passes it to `driver.submit`. `Driver.submit`
widens to accept images; `driver-queue.ts` threads them into **both** dispatch
sites (`:37`/`dispatchQueued` and `:289`).

Images are admitted to durable refs via `saveImage` **before** the message is
built, per §2's canonical sequence — never by hand-building a ref, which would
fail digest verification at provider read time.

### 3.5 Queued submissions keep their images (R5)

The outbox stores `{ text }` chips. A queued submission's images must travel with
its chip, or a paste made while the agent is busy loses the image (or worse,
attaches a later one). `dispatchQueued` takes the images with the text.

### 3.6 Failure behavior (R6)

Every capture failure is silent and non-fatal, preserving today's UX rather than
introducing a new error surface:

- no reader available for the platform
- pasteboard holds no image
- read or decode failure
- `saveImage` rejection at submit

A `saveImage` failure at submit time must not lose the text: the prompt is sent
with the marker stripped and a notice shown.

### 3.7 Route capability gate (R7)

An image submission to a route whose model declares no image input throws
`UNSUPPORTED_CONTENT` at `prepareImages`. Detect it before dispatch where the
route is resolvable and surface a notice naming the model, rather than letting the
turn fail deep in assembly.

### 3.8 Capability manifest (R8)

A new `ux.*` row in `docs/claude-code-capabilities.yaml` (proposed id
`ux.image-paste`), with `evidence` entries for each new source and test file, then
`pnpm docs:parity` and commit the regenerated `docs/cc-parity-matrix.md` +
README block. The manifest is the authored source of truth; hand-editing the
generated artifacts is a CI failure by design (`AGENTS.md`, capability manifest
section).

### 3.9 Test surface (R9)

`packages/ui/pi-tui` has **no test harness at all** — no `tests/`, no vitest
dependency, and `new Editor(` appears exactly once repo-wide, in `root.ts:103`.
There is no fake-TUI or fake-theme double to copy.

Obligation, smallest first:

1. Pure helpers (marker format/parse, cache-path derivation) as exported
   functions testable without a TUI, covered from `packages/ui/tui/tests/` where
   vitest and the `@dsh-cc/pi-tui` import path already exist
   (`tests/input-masked.spec.ts:8` imports components from `@dsh-cc/pi-tui` and
   drives them with direct `handleInput(...)` calls; bracketed paste is fed as
   `input.handleInput('\x1b[200~…\x1b[201~')`).
2. The paste branch through the editor itself, which needs a TUI/theme double
   invented for it — this is the real cost of the slice and should be budgeted.
3. A driver-queue spec asserting the image block reaches `agent.followup` for
   both dispatch sites, using the existing fake-context conventions.

### 3.10 Scope guard (R10)

`insertTextAtCursor` must stay marker-aware: the marker is an atomic segment, and
`expandPasteMarkers`/`getExpandedText` must not expand image markers into text.
Deleting a marker discards its image.

## 4. Non-goals

- Image paste in the web/desktop surfaces (they already have real browser image
  intake via `dsh-client-ui-conversation`).
- Attaching arbitrary non-image clipboard content.
- Terminal-graphics rendering of attached images. `pi-tui/lib/terminal-image.ts`
  (`encodeKitty`/`encodeITerm2`) is the render-**out** direction and is not
  involved; the harness normalizes to webp for the model.
- Drag-and-drop or file-picker image intake.
- MCP and hooks as image carriers — both flatten non-text payloads by design.

## 5. Residual risks

- **Test-harness invention (R9.2).** The editor-level spec needs a double with no
  in-repo precedent; this is the likeliest place for the slice to balloon.
- **`saveImage` at submit time is async** on the submit path. A failure between
  capture and dispatch must degrade to text-only (§3.6), and the ordering against
  `waitForModel()` (`driver-queue.ts:~247`) needs care.
- **Clipboard readers are OS- and session-specific.** No reader path (SSH, tmux
  without pasteboard access, headless) must stay a silent no-op.
- **Marker/history interaction**: `saveHistory` persists prompt text, so a
  submitted `[Image #1]` enters recall history as literal text. Storing the
  marker is intended (the image is not replayable from history); confirm the
  recalled chip does not later re-attach a stale image.

## 6. Open questions (non-blocking)

- Should the cache dir be garbage-collected on session end, or left to the OS temp
  reaper? Claude Code's `~/.claude/uploads/<session-uuid>/` is per-session.
- Should a marker render its dimensions (`[Image #1 1552x1012]`) the way
  `[paste #N +123 lines]` renders a size? Cheap and probably yes.
- Does upstream want this behind a setting (e.g. `tui.imagePaste`) or on by
  default? Default-on with silent-degrade is the proposed answer.

## 7. Implementation slices (suggested)

1. `EditorOptions.onPasteImage`, empty-paste detection, image-marker insert +
   atomic-segment handling, pure marker helpers + their specs. (No platform code;
   fully testable.)
2. TUI host: platform clipboard readers + cache spill; wire the option in
   `root.ts`; reader selection unit tests with fakes.
3. Submission threading: editor `onSubmit` payload → `driver.submit` →
   `driver-queue.ts:37` and `:289`, `saveImage` admission, §3.6/§3.7 failure
   handling, driver-queue specs.
4. Manifest row + `pnpm docs:parity`, `pnpm check:capabilities`,
   `pnpm check:parity`, and the standard gate set.

## 8. Review ledger

- Not yet reviewed. The repo's plan-first convention calls for a cold
  Staff-Engineer pass before implementation; that has not happened.
- Verification status: **source-verified, not runtime-verified.** Every claim in
  §2 was read from installed package sources or the repo tree. A local
  end-to-end run against a dsh-cc profile has not been performed, and the
  locally installed profile is 0.8.3 while this plan targets 0.9.0-rc.1.
