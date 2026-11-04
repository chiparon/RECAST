# report

## function-group

```text
The Host records a separate result for every listed target function and owns all test counts and coverage values; never invent, infer or repeat coverage numbers.
After your final report the Host reruns the complete dedicated test folder itself, checks every listed target function and may append feedback. Your report is a candidate conclusion, not an accepted result.
A no-bug report requires the complete current suite to compile and pass without skips and every listed target function to have execution evidence.
A bug-found report requires a valid failing assertion that reproduces the defect, an issue with kind "translation" and a concrete description, and a non-empty affectedTargets list using the requested path, name and signature. Other listed targets that did not execute may stay unverified; do not claim they were verified and do not keep running only to complete them.
If the complete suite passes with execution evidence for every listed target but a concrete requirement ambiguity remains, report uncertain with an issue of kind "unknown" that names the missing contract or evidence. Do not guess the requirement from the implementation.
Include at most three protocolChecks entries with ruleId and passed, failed, ambiguous, or not-applicable. A failed or ambiguous check prevents a no-bug result.
End the current Agent call with an ordinary final assistant message containing ONLY this JSON object (no tool call):
{"verdict":"no-bug"|"bug-found"|"uncertain","summary":"<required>","issue":{"kind":"translation"|"unknown","description":"..."},"affectedTargets":[{"path":"...","name":"...","signature":"..."}],"protocolChecks":[{"ruleId":"...","status":"passed"|"failed"|"ambiguous"|"not-applicable","testName":"...","note":"..."}]}
```
