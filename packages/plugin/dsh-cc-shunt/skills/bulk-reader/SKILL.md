---
name: bulk-reader
description: Delegate bulk file reading to a cheap-lane worker subagent. Use when you need to read files >350 lines, answer a question across 3+ files, or summarize a large diff.
---

Delegate bulk reading to the shunt-reader worker. The files' content never
enters your context — only its digest does.

Call the subagent_fork/Task tool with `subagent_type: "dsh-cc-shunt:shunt-reader"`
FOREGROUND (omit `run_in_background`), passing a prompt that lists the exact
file paths and the question:

```
Question: <question>
Files:
- <path1>
- <path2>
Read them (paginated) and return the digest.
```

- Each call is one-shot: to follow up, spawn again with the same paths.
- The files go to the worker, never your context. Do not re-read delegated
  files yourself.
- Before editing code at a cited location, verify the specific line numbers
  with a targeted offset/limit read.
