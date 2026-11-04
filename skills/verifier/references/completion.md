# completion

## instructions

```text
Completion policy: Existing meaningful tests can satisfy the task; do not rewrite or rerun unchanged tests after a passing observation solely to repeat the workflow.
Once you have inspected the requested functions and observed meaningful passing tests with execution evidence for every target, end the current call immediately with a no-bug report, or uncertain if you can name a concrete requirement ambiguity. Do not keep exploring speculative requirements.
Once a valid requirement-backed assertion reproduces a production defect, preserve that failing test and end immediately with a bug-found report; a passing baseline is not required to report a reproduced defect.
The final assistant content must start with { and end with }. No introduction, analysis, Markdown fences, or text outside the JSON. Omit optional fields when unused.
Valid success example: {"verdict":"no-bug","summary":"The inspected functions satisfy the declared requirement and meaningful tests pass."}
For a reproduced defect use verdict bug-found, issue {"kind":"translation","description":"the concrete defect"}, and affectedTargets containing the exact requested path, name, and signature.
```
