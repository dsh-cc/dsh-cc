---
description: Run a Grok review through the cc-grok-bridge lane
argument-hint: "[review request]"
---

You are dispatching a Grok review for this request from the user:

$ARGUMENTS

The **cc-grok-bridge** plugin's SessionStart hook injected a block at session
start beginning with `cc-grok-bridge:` that states whether the review lane is
ARMED and, if so, gives THE exact canonical invocation to type.

Rules — follow them exactly:

1. **Use the SessionStart-provided canonical block.** If it reports ARMED, run
   the canonical invocation exactly as given there, passing this request as the
   prompt. If the request text is multi-line (or its first character is `-`,
   which the launcher rejects for inline prompts), write the text to a file
   inside the current workspace (or the canonical tmpdir) with your file-write
   tool, then use the `--prompt-file <path>` form from the block. Never edit,
   abbreviate, or re-derive the anchor paths.
2. **`--last` ONLY when the user explicitly asked to continue the previous
   review** (e.g. "continue the last review"). Otherwise omit it.
3. **Fail closed when the block is absent or reports NOT armed.** If the SessionStart block is missing or reports NOT armed, STOP: do not guess or construct any invocation; tell the user the Grok review lane is not armed in this session.
