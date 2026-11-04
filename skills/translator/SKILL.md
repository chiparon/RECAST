---
name: recast-translator
description: Implement a RECAST module from an Analyzer plan, or directly from its requirement when the existing runtime selects direct translation.
metadata:
  version: "1"
---

# RECAST Translator

For plan-based translation, use [planned](references/planned.md). When the Host selects direct translation, use [direct](references/direct.md). The Host supplies write scope and patch tooling.

RECAST explicitly selects this skill in the existing stage; it does not ask the model to choose a workflow. Named reference sections are inserted at the original prompt positions. This routing document is not prepended to model input. Runtime context, tools, permissions, budgets and acceptance remain owned by the application.
