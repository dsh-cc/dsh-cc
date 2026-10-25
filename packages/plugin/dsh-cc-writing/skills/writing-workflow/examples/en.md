# Examples: English language editing

These examples show the edit style of this plugin. Each one gives the original
sentence, the revised sentence, the edit intent, and the meaning that the edit
preserves. The sentences are original examples. They do not quote another
author's article.

The failure modes come from plan §9: ambiguity, repetition, empty transition,
nominalization, unsupported causal strengthening, and lost qualification. The
last example shows a case that stays unchanged.

## 1. Ambiguity

**Original**: Requests from the older client are retried after a delay.

**Revised**: Requests from the older client are retried after a 30-second delay.

**Intent**: Remove a double reading. "After a delay" can mean a fixed interval or
an unspecified wait.

**Preserved meaning**: The actor, the affected requests, and the retry still
stand. The number now comes from the source, not from the edit.

## 2. Repetition

**Original**: The queue drains slowly at peak load. In other words, when many
requests arrive, the queue takes a long time to empty.

**Revised**: The queue drains slowly at peak load.

**Intent**: Delete a restatement that moves no argument forward. The second
sentence adds no fact.

**Preserved meaning**: The symptom, the condition, and the direction stay. No
cause is added.

## 3. Empty transition

**Original**: In conclusion, therefore, it is clear that the plan still carries
risk.

**Revised**: The plan still carries risk.

**Intent**: Remove three transitions that carry no logic. They cite no earlier
step and introduce no new link.

**Preserved meaning**: The conclusion and its strength stay. The risk stays
unnamed in size; it does not become "high risk".

## 4. Nominalization

**Original**: We performed an analysis of the logs and completed the
identification of the failing service.

**Revised**: We analyzed the logs and identified the failing service.

**Intent**: Turn "performed an analysis" and "completed the identification" back
into verbs, so each action has an actor.

**Preserved meaning**: The actions, their objects, and their order stay. The
target is still the failing service, not the failure.

## 5. Unsupported causal strengthening

**Original**: Timeouts dropped after the upgrade, which shows that the upgrade
fixed the timeout problem.

**Revised**: Timeouts dropped after the upgrade. The data does not show that the
upgrade caused the drop.

**Intent**: Keep a correlation as a correlation. "Which shows" turns a time order
into a cause.

**Preserved meaning**: The observed drop and its time relation stay. The claim
strength drops to what the evidence supports.

**Rejected alternative**: "Timeouts dropped." It loses the time relation, so the
reader cannot see what the evidence is.

## 6. Lost qualification

**Original**: Below 50 concurrent requests, the configuration is usually stable,
and we sometimes see a retry.

**Revised**: Below 50 concurrent requests, the configuration is usually stable.
A retry sometimes occurs.

**Intent**: Split the sentence for clarity, and keep the condition and the
hedges.

**Preserved meaning**: The threshold 50, "below", "usually", and "sometimes" all
stay. The retry is neither impossible nor frequent.

**Rejected alternative**: "The configuration is stable." It drops the threshold
and the hedges, and a limited result becomes a general one.

## 7. Leave unchanged

**Original**: The key is rotated by the operations team every 90 days.

**Revised**: The key is rotated by the operations team every 90 days.

**Intent**: Keep the sentence. This is the case where no edit applies.

**Preserved meaning**: The passive names a known actor and keeps the action in
focus. Any rewrite can change "every 90 days" into "regularly", which loses a
checkable fact. Here an edit carries more risk than the original sentence.

## How to use these examples

- One intent per edit: clarity, concision, or style. A merged intent cannot be
  attributed in the report.
- Keep numbers, quotations, terms, conditions, and claim strength. The script
  compares only part of that set; the semantic review judges the rest.
- These examples are not a single approved literary voice. An explicit user rule
  overrides both the examples and the profile.
