---
description: Run a Codex rescue review through the cc-codex-bridge lane
argument-hint: <text>
---

The **cc-codex-bridge** plugin is installed, but its approval-free rescue lane is
**not active yet in this release** — the bridge ships in stages, and this release
only carries the package skeleton, the shared command parser, and this placeholder
command.

Invoking Codex rescue today therefore goes through the **normal, approval-requiring
path** (the stock `/codex:rescue` flow): expect the usual permission checkpoint, and
do not attempt to construct the bridge's canonical bash invocation manually.

Once the lane is activated in a later release, this command will dispatch the
canonical, pre-approved Codex rescue invocation automatically; no action is needed
from you until then.
