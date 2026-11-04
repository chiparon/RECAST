---
name: recast-analyzer
description: Plan RECAST module translation or a project integration pass using the target skeleton, public requirement and bounded historical evidence.
metadata:
  version: "1"
---

# RECAST Analyzer

Use the module or integration sections selected by the Analyzer prompt builder in [instructions](references/instructions.md). Return a read-only implementation plan.

RECAST explicitly selects this skill in the existing stage; it does not ask the model to choose a workflow. Named reference sections are inserted at the original prompt positions. This routing document is not prepended to model input. Runtime context, tools, permissions, budgets and acceptance remain owned by the application.
