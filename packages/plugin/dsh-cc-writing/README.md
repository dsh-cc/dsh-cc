# @dsh-cc/plugin-dsh-cc-writing

English | [中文](README.zh.md)

Official dsh-cc plugin for article writing, article review, and language
editing. It provides three public skills and one supporting skill.

## Components

| Skill | Purpose | User task |
| --- | --- | --- |
| `article-writing` | Plan an argument, draft the sections, and revise the structure | Yes |
| `article-review` | Report structure, logic, and prose findings without body changes | Yes |
| `language-editing` | Improve clarity, concision, and style with local edits | Yes |
| `writing-workflow` | Shared run protocol, schemas, profiles, and scripts | No |

The three public skills accept Chinese and English articles. They cover
technical explanations, literature reviews, and opinion essays.

`writing-workflow` is a supporting skill. The public skills read it from the
installed directory. It never appears as a separate task.

## Install

Use a Claude-compatible client with plugin installation commands.

```text
/plugin marketplace add dsh-cc/dsh-cc
/plugin install dsh-cc-writing@dsh-cc
```

Restart dsh to load the plugin. Use `/skills` to find `article-writing`,
`article-review`, and `language-editing`.

Installation does not add the plugin to your enabled plugins by default. Install
it when you want the writing workflow.

## Update

Update the marketplace first. Then update the installed plugin cache.

```text
/plugin marketplace update dsh-cc
/plugin update dsh-cc-writing@dsh-cc
```

Restart dsh after the update. A marketplace update by itself does not update the
installed plugin.

## Use

Describe the task in natural language after discovery through `/skills`. An
explicit skill name takes priority over automatic matching.

Write a new article, or rewrite an existing structure:

```text
Use article-writing to write a Chinese article about the port closure.
The audience is regional logistics managers. Write docs/articles/port.md.
Keep the conditions and the uncertainty in the source reports.
```

Review an article without changes:

```text
Use article-review to review docs/articles/port.md for the same audience.
Do not change the article. Report the major findings first.
```

Polish the language and keep the meaning:

```text
Use language-editing to improve docs/articles/port.md. Keep every number,
quotation, and technical term. Change no claim.
```

The plugin asks for the audience when the request does not name one. For a new
article with no output path, it proposes `docs/articles/<slug>.md` and asks.

## What a run produces

Each run writes `runs/<runId>/` under a companion directory. For
`docs/articles/port.md`, the default companion is `docs/articles/port.writing/`.

The run holds the brief, the plan, the reviews, the edit proposals, the
preservation checks, and `editorial-report.md`. The body stays at the requested
path. The report lists the outcome, the findings, the changes, and the limits.

The scripts make no network calls and no model calls. They write no VWA project
files.

## Evidence mode

Ordinary mode needs no VWA setup. The plugin works without `dsh-cc-agents`.

Ask for VWA evidence review when the article claims need registered sources. The
plugin then uses the five VWA tools and keeps its editor report separate from the
VWA report.

Evidence mode needs the VWA runtime: the delivery tools, the semantic settings,
the VWA preset, and an initialized project. The plugin gives the missing steps in
one message. It does not change your settings. It does not switch modes for an
explicit evidence request.

A request for VWA evidence work without article changes still belongs to
`vwa-writing` in `dsh-cc-agents`. When you ask for both, `article-writing` runs
the workflow and uses the VWA adapter. `vwa-writing` does not start a second
editorial loop.

## Limits

- The scripts prove file identity and preservation properties only. Structural
  and semantic findings are model judgments, not proofs.
- A clean preservation check does not prove that the meaning survived.
- The scanner can miss Chinese numerals, implicit causality, and paraphrased
  quotation. The report states this limit.
- Version 1 supports one cooperative writer for each body. Use the default
  companion directory so the scripts reject a concurrent run.
- The editorial report is local derived data. An agent can edit it. It is not a
  tamper-proof receipt.
- An editorial result never sets a VWA grade. Only the VWA runtime and its user
  commands decide a review status.
- The plugin does not translate articles and does not edit DOCX or PDF files.

## Resources

The package includes the three public skills, the
[shared workflow](skills/writing-workflow/SKILL.md), the
[stage workflow](skills/writing-workflow/references/workflow.md), the
[artifact contracts](skills/writing-workflow/references/contracts.md), the
[review rubric](skills/writing-workflow/references/review-rubric.md), the
[VWA adapter](skills/writing-workflow/references/vwa-adapter.md), four profiles,
and the [Chinese](skills/writing-workflow/examples/zh.md) and
[English](skills/writing-workflow/examples/en.md) edit examples.

Relative resources resolve from the installed skill directory. A repository
checkout is not necessary.
