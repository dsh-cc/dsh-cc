# Annotation working files (not committed data — committed merged output only)

## Protocol (docs/plans/2026-10-12-verifiable-workspace-agent.md §8)

Annotation unit = sentence; protocol = dual annotation with user adjudication.

1. Export sentences:
   `node packages/evaluation/vwa-eval/scripts/annotate.mjs export > sentences.json`
2. Annotator A and annotator B independently produce files with this schema
   (one row per sentence):
   ```json
   { "path": "docs/dev.md", "index": 12, "predicate": "verifiable", "detail": "why" }
   ```
   `predicate` is `verifiable` or `not`.
3. The user adjudicates the DISAGREEING rows into a third file (same schema;
   optional `adjudicator` field on the first row).
4. Merge:
   `node packages/evaluation/vwa-eval/scripts/annotate.mjs merge A.json B.json adjudication.json > annotations/gold-annotations.json`
   Agreements pass through; disagreements enter the merged file ONLY via the
   adjudication (they are never auto-resolved).
5. Detector recall:
   `node packages/evaluation/vwa-eval/scripts/annotate.mjs recall annotations/gold-annotations.json`
