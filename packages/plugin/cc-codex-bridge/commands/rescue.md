---
description: Run a Codex rescue review through the cc-codex-bridge lane
argument-hint: "[rescue request]"
---

You are dispatching a Codex rescue for this request from the user:

$ARGUMENTS

The **cc-codex-bridge** plugin's SessionStart hook injected a block at session
start beginning with `cc-codex-bridge:` that states whether the rescue lane is
ARMED and, if so, gives THE exact canonical invocation to type.

Rules — follow them exactly:

1. **Use the SessionStart-provided canonical block.** If it reports ARMED, run
   the canonical invocation exactly as given there, passing this request as the
   prompt. If the request text is multi-line (or contains characters that are
   awkward as one shell word), write the text to a file inside the current
   workspace (or the canonical tmpdir) with your file-write tool, then use the
   `--prompt-file <path>` form from the block. Never edit, abbreviate, or
   re-derive the anchor paths.
2. **`--last` ONLY when the user explicitly asked to continue the previous
   rescue** (e.g. "continue the last rescue"). Otherwise omit it.
3. **Fail closed when the block is absent or reports NOT armed.** If the
   SessionStart block is missing (e.g. the session resumed without it) or says
   the lane is not armed, you MUST NOT guess or construct the canonical
   invocation — fall back to the normal, approval-requiring Codex rescue path
   (the stock `/codex:rescue` flow, expecting the usual permission checkpoint)
   and tell the user that is what you did.
