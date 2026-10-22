#!/usr/bin/env bash
set -euo pipefail

# Run the plain single-agent baseline for the Java target.  The Agent works in
# a temporary directory with no dataset/history parent; its result is copied
# into results only after the Agent exits.

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
dataset_root="$repo_root/experiments/enterprise-asset-upgrade"
target_source="$dataset_root/java-target-project"
requirements_source="$target_source/requirements"
results_root="${BASELINE_RESULTS_ROOT:-$dataset_root/results}"
run_id="${BASELINE_RUN_ID:-baseline-java-claude-deepseek-v41flash-$(date -u +%Y%m%dT%H%M%SZ)}"
agent_shell="${BASELINE_AGENT:-claude}"
model="${BASELINE_MODEL:-claude-sonnet-4-6[1m]}"
model_explicit=0
launcher="${CLAUDE_BIN:-claude}"
java_home="${JAVA_HOME:-/tmp/recast-java-tools/jdk-21}"
maven_bin="${MAVEN_BIN:-/tmp/recast-java-tools/apache-maven-3.9.9/bin/mvn}"

# Allow a verified clean skeleton snapshot to be used without overwriting a
# workspace that contains another experiment's uncommitted translation.
target_source="${BASELINE_TARGET_SOURCE:-$target_source}"
requirements_source="$target_source/requirements"

if [[ ! -x "$java_home/bin/java" ]]; then
  detected_java="$(command -v java || true)"
  if [[ -n "$detected_java" ]]; then
    detected_java="$(readlink -f "$detected_java" 2>/dev/null || printf '%s' "$detected_java")"
    java_home="$(dirname "$(dirname "$detected_java")")"
  fi
fi
if [[ ! -x "$maven_bin" ]]; then
  detected_maven="$(command -v mvn || true)"
  if [[ -n "$detected_maven" ]]; then maven_bin="$detected_maven"; fi
fi

usage() {
  cat <<'EOF'
Usage: scripts/run-enterprise-asset-upgrade-java-baseline.sh [--run-id ID]

Environment:
  BASELINE_RUN_ID       Result directory name.
  BASELINE_RESULTS_ROOT Result root directory.
  BASELINE_MODEL        Claude Code model alias (default claude-sonnet-4-6[1m]).
  BASELINE_AGENT        Agent shell: claude or codex (default claude).
  BASELINE_TARGET_SOURCE Override the source skeleton directory.
  DEEPSEEK_API_KEY      DeepSeek key for the Claude Code Anthropic adapter.
  DEEPSEEK_API_BASE     DeepSeek Responses API base URL (Codex; default https://api.deepseek.com/).
  CODEX_BIN             Codex executable when BASELINE_AGENT=codex.
  CLAUDE_BIN            Claude Code executable.
  JAVA_HOME             JDK 21 directory.
  MAVEN_BIN             Maven executable.
  BASELINE_DRY_RUN=1    Copy and validate isolation without starting the Agent.
EOF
}

while (($#)); do
  case "$1" in
    --run-id)
      (($# >= 2)) || { echo "--run-id requires a value" >&2; exit 2; }
      run_id="$2"; shift 2 ;;
    --agent)
      (($# >= 2)) || { echo "--agent requires a value" >&2; exit 2; }
      agent_shell="$2"; shift 2 ;;
    --model)
      (($# >= 2)) || { echo "--model requires a value" >&2; exit 2; }
      model="$2"; model_explicit=1; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ "$agent_shell" == "codex" && "$model_explicit" == "0" && -z "${BASELINE_MODEL:-}" ]]; then
  model="deepseek-flash"
fi

[[ -d "$target_source" ]] || { echo "Java target not found: $target_source" >&2; exit 1; }
[[ -d "$requirements_source" ]] || { echo "Java requirements not found: $requirements_source" >&2; exit 1; }
[[ "$run_id" != *..* && "$run_id" != /* && "$run_id" != *"/"* ]] || { echo "Invalid run id: $run_id" >&2; exit 2; }

run_dir="$results_root/$run_id"
mkdir -p "$results_root"
if [[ -e "$run_dir" ]]; then
  echo "Refusing to overwrite existing baseline run: $run_dir" >&2
  exit 1
fi
mkdir -p "$run_dir"

if [[ "$agent_shell" == "codex" ]]; then
  launcher="${CODEX_BIN:-codex}"
elif [[ "$agent_shell" == "claude" ]]; then
  launcher="${CLAUDE_BIN:-claude}"
else
  echo "Unsupported agent shell: $agent_shell (expected claude or codex)" >&2
  exit 2
fi
command -v "$launcher" >/dev/null 2>&1 || { echo "Coding Agent executable not found: $launcher" >&2; exit 127; }
if [[ ! -x "$java_home/bin/java" ]]; then
  echo "JDK 21 executable not found under JAVA_HOME=$java_home" >&2
  exit 1
fi
if [[ ! -x "$maven_bin" ]]; then
  echo "Maven executable not found: $maven_bin" >&2
  exit 1
fi
if [[ "${BASELINE_DRY_RUN:-0}" != "1" ]]; then
  [[ -n "${DEEPSEEK_API_KEY:-}" ]] || { echo "DEEPSEEK_API_KEY is required for DeepSeek baseline." >&2; exit 1; }
fi

temp_root="$(mktemp -d /tmp/recast-java-baseline.XXXXXX)"
cleanup() {
  chmod -R u+w "$temp_root" 2>/dev/null || true
  rm -rf "$temp_root"
}
trap cleanup EXIT

codex_home=""
if [[ "$agent_shell" == "codex" && "${BASELINE_DRY_RUN:-0}" != "1" ]]; then
  codex_home="$temp_root/codex-home"
  mkdir -p "$codex_home"
  chmod 700 "$codex_home"
  cat > "$codex_home/config.toml" <<EOF
model_provider = "deepseek"
model = "$model"
model_reasoning_effort = "high"

[model_providers.deepseek]
name = "deepseek"
base_url = "${DEEPSEEK_API_BASE:-https://api.deepseek.com/}"
wire_api = "responses"
experimental_bearer_token = "$DEEPSEEK_API_KEY"
EOF
  chmod 600 "$codex_home/config.toml"
fi

mkdir -p "$temp_root/target-project"
cp -a "$target_source"/. "$temp_root/target-project"/
# A baseline must never inherit history views, repository metadata, or build
# output from the source workspace.
for transient in .forexpore .forexplore .git target; do
  if [[ -e "$temp_root/target-project/$transient" ]]; then
    chmod -R u+w "$temp_root/target-project/$transient" 2>/dev/null || true
    rm -rf "$temp_root/target-project/$transient"
  fi
done
mkdir -p "$temp_root/requirements"
cp -a "$requirements_source"/. "$temp_root/requirements/"

cat > "$temp_root/task-prompt.md" <<'EOF'
# Enterprise Asset Upgrade Java baseline

Implement the Java AssetUpgradeGateway project in the current directory as a
plain single-agent baseline. Read the Java source tree, README, and every task
file in the sibling `../requirements/` directory. Implement all four
requirements in the existing production-shaped skeleton, preserving the
declared ports and module boundaries. Add only implementation code and any
useful visible tests needed to validate the project. Run the Maven build and
record useful implementation notes in your final response.

This is the direct-agent control condition. Work only in the current
`java-target-project` directory. Do not inspect, search, index, import, or
reference any parent directory, history repository, source-repositories
directory, hidden evaluator, or RECAST/ForeXplore implementation. Do not edit
the copied requirements. Do not modify the original dataset; this directory
is a disposable copy created for this run.
EOF

cat > "$run_dir/run-manifest.json" <<EOF
{
  "runId": "${run_id}",
  "kind": "coding-agent-baseline",
  "language": "Java",
  "provider": "deepseek",
  "apiBase": "$(if [[ "$agent_shell" == "codex" ]]; then printf '%s' "${DEEPSEEK_API_BASE:-https://api.deepseek.com/}"; else printf '%s' "https://api.deepseek.com/anthropic"; fi)",
  "settingSources": "project,local",
  "model": "${model}",
  "apiModel": "deepseek-flash",
  "effectiveModel": "DeepSeek-V4.1-Flash",
  "agentShell": "${agent_shell}",
  "workspace": "java-target-project",
  "requirements": "requirements",
  "historyExposed": false,
  "hiddenTestsExposed": false,
  "sourceDataset": "java-target-project"
}
EOF
cp "$temp_root/task-prompt.md" "$run_dir/task-prompt.md"
cp -a "$temp_root/requirements" "$run_dir/requirements"

printf 'Starting Java baseline in %s\n' "$run_dir"
printf 'Agent shell: %s\nProvider: deepseek\nModel: %s\n' "$agent_shell" "$model"
printf 'History and hidden tests exposed: no\n'

started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [[ "${BASELINE_DRY_RUN:-0}" == "1" ]]; then
  printf '%s\n' '{"type":"dry-run","message":"Agent invocation skipped."}' > "$temp_root/agent-stream.jsonl"
  agent_status=0
else
  set +e
  if [[ "$agent_shell" == "codex" ]]; then
    (cd "$temp_root/target-project" && CODEX_HOME="$codex_home" "$launcher" exec \
      --model "$model" --cd "$temp_root/target-project" \
      --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --ephemeral --json \
      -o "$temp_root/agent-final.txt" - < "$temp_root/task-prompt.md") \
      2>&1 | tee "$temp_root/agent-stream.jsonl"
  else
    (
      cd "$temp_root/target-project"
      ANTHROPIC_BASE_URL="https://api.deepseek.com/anthropic" \
      ANTHROPIC_AUTH_TOKEN="$DEEPSEEK_API_KEY" \
      ANTHROPIC_API_KEY="$DEEPSEEK_API_KEY" \
      ANTHROPIC_MODEL="$model" \
      ANTHROPIC_DEFAULT_OPUS_MODEL="$model" \
      ANTHROPIC_DEFAULT_SONNET_MODEL="$model" \
      ANTHROPIC_DEFAULT_HAIKU_MODEL="$model" \
      CLAUDE_CODE_SUBAGENT_MODEL="$model" \
      CLAUDE_CODE_EFFORT_LEVEL="max" \
      CLAUDE_CODE_AUTO_COMPACT_WINDOW="786432" \
      "$launcher" --bare --setting-sources project,local --no-session-persistence \
        --permission-mode bypassPermissions --allow-dangerously-skip-permissions \
        --verbose --output-format stream-json --model "$model" \
        -p "$(cat "$temp_root/task-prompt.md")"
    ) 2>&1 | tee "$temp_root/agent-stream.jsonl"
  fi
  agent_status=${PIPESTATUS[0]}
  set -e
fi
finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Persist the disposable workspace only after the Agent is finished.
cp -a "$temp_root/target-project" "$run_dir/target-project"
cp "$temp_root/agent-stream.jsonl" "$run_dir/agent-stream.jsonl"

python3 - "$run_dir/run-result.json" "$run_id" "$started_at" "$finished_at" "$agent_status" "$run_dir/agent-stream.jsonl" <<'PY'
import json, pathlib, re, sys
out, run_id, started, finished, status, log_path = sys.argv[1:]
root = pathlib.Path(out).parent
files = [p for p in (root / "target-project").rglob("*") if p.is_file() and ".git" not in p.parts]
stream_result = {}
usage = {}
model_usage = {}
turn_result = {}
session_id = None
observed_models = set()
for line in pathlib.Path(log_path).read_text(errors="replace").splitlines():
    try:
        event = json.loads(line)
    except json.JSONDecodeError:
        continue
    if event.get("type") == "result":
        stream_result = event
        usage = event.get("usage", {}) or {}
        model_usage = event.get("modelUsage", {}) or {}
    if event.get("type") == "turn.completed":
        turn_result = event
        if not usage:
            usage = event.get("usage", {}) or {}
        if not model_usage:
            model_usage = event.get("modelUsage", {}) or {}
    if isinstance(event.get("model"), str):
        observed_models.add(event["model"])
    message = event.get("message")
    if isinstance(message, dict) and isinstance(message.get("model"), str):
        observed_models.add(message["model"])
    if event.get("type") == "thread.started":
        session_id = event.get("thread_id")
manifest = json.loads((root / "run-manifest.json").read_text())
final_text = stream_result.get("result", "") if isinstance(stream_result, dict) else ""
visible_match = re.search(r"Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+),\s*Skipped:\s*(\d+)", final_text)
visible_tests = None
if visible_match:
    total, failures, errors, skipped = map(int, visible_match.groups())
    visible_tests = {
        "total": total,
        "passed": max(total - failures - errors - skipped, 0),
        "failures": failures,
        "errors": errors,
        "skipped": skipped,
    }
result = {
    "runId": run_id,
    "kind": "coding-agent-baseline",
    "language": "Java",
    "startedAt": started,
    "finishedAt": finished,
    "exitCode": int(status),
    "success": int(status) == 0,
    "workspace": str(root / "target-project"),
    "requirements": str(root / "requirements"),
    "agentLog": str(root / "agent-stream.jsonl"),
    "historyExposed": False,
    "hiddenTestsExposed": False,
    "resultFileCount": len(files),
    "agentSessionId": stream_result.get("session_id") or session_id,
    "durationApiMs": stream_result.get("duration_api_ms"),
    "durationMs": stream_result.get("duration_ms"),
    "inputTokens": usage.get("input_tokens"),
    "outputTokens": usage.get("output_tokens"),
    "cacheCreationInputTokens": usage.get("cache_creation_input_tokens"),
    "cacheReadInputTokens": usage.get("cache_read_input_tokens"),
    "modelUsage": model_usage,
    "provider": manifest.get("provider"),
    "configuredApiBase": manifest.get("apiBase"),
    "settingSources": manifest.get("settingSources"),
    "agentShell": manifest.get("agentShell"),
    "apiModel": manifest.get("apiModel"),
    "effectiveModel": manifest.get("effectiveModel"),
    "agentModelUsageKeys": list(model_usage),
    "agentModel": manifest.get("model"),
    "observedApiModels": sorted(observed_models),
    "visibleTests": visible_tests,
    "claudeCodeListCostEstimateUsd": stream_result.get("total_cost_usd"),
    "providerBilling": {
        "provider": manifest.get("provider"),
        "amountUsd": None,
        "status": "not_reported_by_run_telemetry",
        "note": "Claude Code list-price estimate is not DeepSeek provider billing data.",
    },
}
pathlib.Path(out).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
PY

hidden_runner="$dataset_root/evaluation/java-hidden/run-hidden-tests.sh"
hidden_status=2
if [[ "${BASELINE_DRY_RUN:-0}" == "1" ]]; then
  hidden_status=0
  printf '%s\n' '{"type":"dry-run","message":"Hidden evaluator skipped."}' > "$run_dir/hidden-evaluation.log"
elif [[ -x "$hidden_runner" ]]; then
  set +e
  JAVA_HOME="$java_home" MAVEN_BIN="$maven_bin" "$hidden_runner" \
    "$run_dir/target-project" 2>&1 | tee "$run_dir/hidden-evaluation.log"
  hidden_status=${PIPESTATUS[0]}
  set -e
else
  echo "Java hidden runner not found: $hidden_runner" | tee "$run_dir/hidden-evaluation.log"
fi

# The Java runner is intentionally a Maven/JUnit runner and therefore exits
# nonzero on failures without producing JSON.  Convert its stable summary into
# a per-run report while retaining the full Maven log above.
if [[ ! -f "$run_dir/hidden-evaluation.json" ]]; then
  python3 - "$run_dir/hidden-evaluation.log" "$run_dir/hidden-evaluation.json" "$hidden_status" <<'PY'
import json, pathlib, re, sys
log_path, report_path, status = sys.argv[1:]
text = pathlib.Path(log_path).read_text(errors="replace") if pathlib.Path(log_path).is_file() else ""
matches = re.findall(r"Tests run: (\d+), Failures: (\d+), Errors: (\d+), Skipped: (\d+)", text)
total = failures = errors = skipped = 0
if matches:
    total, failures, errors, skipped = map(int, matches[-1])
failed_cases = re.findall(r"\[ERROR\]\s+([A-Za-z0-9_$.]+):\d+", text)
failed_cases = list(dict.fromkeys(failed_cases))
modules = {}
for case in failed_cases:
    cls = case.rsplit(".", 1)[0]
    module = "unknown"
    if "Attachment" in cls: module = "attachment"
    elif "Workflow" in cls: module = "workflow"
    elif "Reconciliation" in cls: module = "reconciliation"
    elif "Order" in cls: module = "order"
    modules.setdefault(module, {"failed": 0})["failed"] += 1
report = {
    "suite": "asset-upgrade-gateway-java-hidden",
    "status": int(status),
    "total": total,
    "passed": max(total - failures - errors - skipped, 0),
    "failed": failures + errors,
    "failures": failures,
    "errors": errors,
    "skipped": skipped,
    "failedCases": failed_cases,
    "moduleFailureCounts": modules,
    "log": str(pathlib.Path(log_path)),
}
pathlib.Path(report_path).write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
PY
fi

python3 - "$run_dir/run-result.json" "$run_dir/hidden-evaluation.json" "$hidden_status" <<'PY'
import json, pathlib, sys
result_path, evaluation_path, status = sys.argv[1:]
result = json.loads(pathlib.Path(result_path).read_text())
result["hiddenEvaluation"] = {"status": int(status), "report": evaluation_path}
evaluation = pathlib.Path(evaluation_path)
if evaluation.is_file():
    try:
        report = json.loads(evaluation.read_text())
    except json.JSONDecodeError:
        report = None
    if isinstance(report, dict):
        result["hiddenEvaluation"].update({
            "total": report.get("total", report.get("tests", report.get("Total"))),
            "passed": report.get("passed", report.get("Passed")),
            "failed": report.get("failed", report.get("Failed")),
        })
pathlib.Path(result_path).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
PY

printf 'Baseline exit code: %s\n' "$agent_status"
printf 'Result copy: %s\n' "$run_dir/target-project"
printf 'Agent log: %s\n' "$run_dir/agent-stream.jsonl"
printf 'Run result: %s\n' "$run_dir/run-result.json"
printf 'Hidden evaluation exit code: %s\n' "$hidden_status"
printf 'Hidden evaluation: %s\n' "$run_dir/hidden-evaluation.json"
exit "$agent_status"
