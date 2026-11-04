---
name: recast-verifier
description: Verify one function or a function group through the existing RECAST Host, using either source equivalence or requirement-only verification.
metadata:
  version: "1"
---

# RECAST Verifier

Use [source-function](references/source-function.md) for single-function equivalence, [source-group](references/source-group.md) for mapped function groups, or [requirement-group](references/requirement-group.md) for target-only verification. Group modes also use [report](references/report.md). The Host appends [completion](references/completion.md) after its authoritative test setup.

RECAST explicitly selects this skill in the existing stage; it does not ask the model to choose a workflow. Named reference sections are inserted at the original prompt positions. This routing document is not prepended to model input. Runtime context, tools, permissions, budgets and acceptance remain owned by the application.
