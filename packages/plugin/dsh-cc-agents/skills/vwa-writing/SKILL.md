---
name: vwa-writing
description: Write or review documents with VWA source evidence and argument checks. Use for VWA writing, evidence review, research articles, historical analysis, literary analysis, or technical reports that need traceable claims. Chinese triggers include 证据写作、论证审查、人文研究、历史文章、文学分析. Do not use for routine coding, translation, or copy editing without an evidence-review request.
---

# VWA writing

Keep the author workflow in this skill. Let the VWA tools decide review results.
Read [the tool contract](references/tool-contract.md) before the first VWA call.
Read [the writing rules](references/writing-rules.md) before you write or review the body.
Resolve these paths from this skill directory. Do not require a repository checkout.

## 1. Check the prerequisites

Discover the five VWA tools in the live tool catalog.
Use ToolSearch first if the host hides tools until discovery.
Do not infer tool access from settings alone.
Run the read-only check with the tool names that the host actually reports:

```sh
node <skill-directory>/scripts/preflight.mjs --workspace <workspace-root> --tools <comma-separated-discovered-tool-names>
```

Use `--dsh-home <path>` only if the host uses a different settings directory.
An absent `DSH_HOME` uses `~/.dsh`.
Do not print the full settings file or credentials.

If the check returns `blocked`, report all blockers in one message.
Give the user the applicable setup steps from the tool contract.
Do not change global settings, switch presets, or run user-only commands yourself.
Do not write project pointers, snapshots, HEAD files, or receipts by hand.
Resume after the user completes setup. Do not repeat completed setup steps.
A `ready-for-tools` result confirms prerequisites only. It does not validate project data or article quality.

## 2. Set the task

Use an existing project when it matches the user's task.
Set the question, language, domain, required questions, and expected core topics through `argument.update`.
Ask only for missing information that would change the task.
Do not assume the user's research question or required conclusion.
Let the evidence determine the answer.

For a new article, agree on the source scope and body path.
For an existing article, preserve the body unless the user requests changes.
You can read, register, map, bind, and review an existing article without rewriting it.

## 3. Register evidence and build the graph

Read the actual sources before `evidence.register`.
Register source metadata and exact excerpts through the tool.
Keep editions, locations, original wording, and context.
Do not label a copied model answer as an external source.
Do not upgrade source authenticity without evidence.
Record actual searches with `evidence.search_log` when searches occur.
A missing search is not a completed search.

Use `argument.update` to make claims, evidence groups, and arguments.
Separate facts, source reports, interpretations, causes, intentions, and evaluations.
Record scope, premises, warrants, assumptions, counterevidence, and limits.
Use the identifiers and revision returned by each successful call.
Do not invent source identifiers or modify the graph files directly.

When a source exceeds the review context window, register a distilled companion source with `lineage.parentSourceIds: ["src_original"]`. The companion's text should be a faithful summary or structured extract (e.g., counts, key passages). Both sources are reviewed independently; the companion's lineage makes the derivation explicit.

## 4. Write and bind the body

Use the normal write/edit tools for an authorized body change.
Put necessary limits, uncertainty, and material disputes in the relevant body paragraphs.
Keep source markers. Claim markers are optional author aids.
Remove internal claim markers before final review if they are not reader content.
Then bind the current body with `argument.update` using `op: "bind-artifact"`.
Preserve exact occurrence text and valid spans. Follow the live tool schema.
Every later body change needs a new binding and review.

## 5. Run the complete review

Call `argument.review` with `input.stage: "all"` and the bound `artifactId`.
Use a new UUID v4 requestId for a new request.
Use the same requestId and payload only to replay that request.
Wait for the returned host job through the host job tools.
Do not treat a started, pending, failed, or incomplete run as a passed review.

Inspect findings and current assessments before a repair.
Keep the user's source scope and edit authorization during a repair.
After a body or graph change, use the current revision and rebind as needed.
Allow one repair-and-review cycle unless the user requests more.
Each fresh request (without `continue`) opens a review cycle with the frozen project budget.
Continuations share that cycle's budget; they never add to it.
Do not raise frozen limits or erase findings to obtain a pass.
For review-only tasks, report proposed repairs without changing the body.

After a run ends `incomplete`, `budget-exhausted`, or `cancelled`, you may call
`argument.review` again with a new requestId and `input.continue: true`
to re-execute only the tasks without a completed record, the audit included.
The continuation spends only what is left of the same cycle's budget.
This is not a repair cycle and does not count against the repair budget.
Do not pass `continue: true` when you want a second opinion on completed tasks.
Use a fresh request without `continue` for that, within the repair rules.

Stop the review loop when the job fails without a continuable status,
when `argument.review` returns `BUDGET_EXHAUSTED` (the cycle budget is spent),
or when required evidence is absent.
`NOTHING_TO_CONTINUE` means every task already has a completed record; read the current results instead.
Report the unresolved items and the actual status.
Do not invent a completed review or a replacement grade.

## 6. Make and present the report

Call `argument.report` for the current artifact with `format: "markdown"` and `write: true`.
Present both the exact body path and the returned report path through the host presentation tool.
Wait for the host delivery result before you claim reviewed delivery.
A report, a candidate status, or a passed model call alone is not a delivered-reviewed result.
If presentation is unavailable, give the paths and state that delivery is not confirmed.
If the report fails, report the failure. Do not claim that a receipt exists.

State the answer, evidence strength, reasoning, disputes, and missing evidence in the final response.
Use the runtime's current grades and status.
Keep an unverified result visibly unverified.
Leave `/vwa sign` and `/vwa adjudicate` to the user.
Do not replace VWA review with a critic subagent's opinion.
