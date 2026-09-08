---
name: code-writer
description: Delegate boilerplate code generation to a cheap-lane worker subagent. Use for tests, config stubs, type stubs, docstrings, or any generation where >80% is predictable from an existing reference file.
---

Delegate boilerplate generation to the shunt-writer worker. The generated
code never enters your context — the worker writes it to disk and returns
only a one-line confirmation.

Call the subagent_fork/Task tool with `subagent_type: "dsh-cc-shunt:shunt-writer"`
FOREGROUND (omit `run_in_background`):

```
Spec: <what to generate>
Reference: <reference-file-path> (mandatory — match its patterns)
Target: <output-path>
Write the output to Target and reply with only the one-line confirmation.
```

- A reference file is always required. Without one the worker generates
  context-free code.
- Follow-ups: pass the previously generated file as the new reference.
- After it returns, review the target with targeted reads and apply the
  ~5–20% needing judgment as surgical edits yourself.
