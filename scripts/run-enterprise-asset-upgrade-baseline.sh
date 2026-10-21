#!/usr/bin/env bash
set -euo pipefail

# Run a plain Coding Agent baseline against an isolated copy of the target.
# The agent starts inside results/<run-id>/target-project; history repositories
# are deliberately neither copied nor added to the agent's tool directories.

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
dataset_root="$repo_root/experiments/enterprise-asset-upgrade"
target_source="$dataset_root/target-project"
requirements_source="$target_source/requirements"
results_root="${BASELINE_RESULTS_ROOT:-$dataset_root/results}"
run_id="${BASELINE_RUN_ID:-baseline-$(date -u +%Y%m%dT%H%M%SZ)}"
prompt_file=""
agent_shell="${BASELINE_AGENT:-claude}"
# DeepSeek's public API model id deepseek-flash serves DeepSeek-V4.1-Flash.
# Claude Code maps a claude-sonnet model name to that DeepSeek model. The
# sonnet [1m] alias keeps the long context mode while remaining accepted by
# the current Claude Code model registry.
model="${BASELINE_MODEL:-claude-sonnet-4-6[1m]}"
model_explicit=0

# A baseline must be sourced from an explicit clean snapshot when the working
# target directory belongs to another experiment.
target_source="${BASELINE_TARGET_SOURCE:-$target_source}"
requirements_source="$target_source/requirements"

usage() {
  cat <<'EOF'
Usage: scripts/run-enterprise-asset-upgrade-baseline.sh [options]

Options:
  --prompt-file FILE   Use an additional task prompt instead of the default.
  --run-id ID          Store this run under experiments/enterprise-asset-upgrade/results/ID.
  --agent NAME         Agent shell: claude (default) or codex.
  --model MODEL        Claude shell model alias (default: claude-sonnet-4-6[1m]).
  BASELINE_TARGET_SOURCE Override the source skeleton directory.
  --help               Show this help.

Environment:
  CODEX_BIN             Codex executable, defaults to codex.
  CLAUDE_BIN            Claude executable when --agent claude is selected.
  DEEPSEEK_API_KEY      DeepSeek key used by the Claude Code Anthropic adapter.
  DEEPSEEK_API_BASE     DeepSeek Responses API base URL (Codex; default https://api.deepseek.com/).
  BASELINE_RESULTS_ROOT  Override the results directory.
EOF
}

while (($#)); do
  case "$1" in
    --prompt-file)
      (($# >= 2)) || { echo "--prompt-file requires a path" >&2; exit 2; }
      prompt_file="$2"; shift 2 ;;
    --run-id)
      (($# >= 2)) || { echo "--run-id requires an id" >&2; exit 2; }
      run_id="$2"; shift 2 ;;
    --agent)
      (($# >= 2)) || { echo "--agent requires a name" >&2; exit 2; }
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

run_dir="$results_root/$run_id"

[[ -d "$target_source" ]] || { echo "Target project not found: $target_source" >&2; exit 1; }
[[ -d "$requirements_source" ]] || { echo "Requirements not found: $requirements_source" >&2; exit 1; }
[[ "$run_id" != *..* && "$run_id" != /* && "$run_id" != *"/"* ]] || { echo "Invalid run id: $run_id" >&2; exit 2; }
if [[ -n "$prompt_file" ]]; then
  [[ -f "$prompt_file" ]] || { echo "Prompt file not found: $prompt_file" >&2; exit 1; }
fi

mkdir -p "$run_dir"
if [[ -e "$run_dir/target-project" || -e "$run_dir/requirements" ]]; then
  echo "Refusing to overwrite existing baseline run: $run_dir" >&2
  exit 1
fi

# cp only the target project. In particular, source-repositories is never copied
# and is not passed through --add-dir or the prompt.
mkdir -p "$run_dir/target-project"
cp -a "$target_source"/. "$run_dir/target-project"/
for transient in .forexpore .forexplore .git target; do
  rm -rf "$run_dir/target-project/$transient"
done
mkdir -p "$run_dir/requirements"
cp -a "$requirements_source"/. "$run_dir/requirements/"

if [[ -n "$prompt_file" ]]; then
  cp "$prompt_file" "$run_dir/task-prompt.md"
else
  cat > "$run_dir/task-prompt.md" <<'EOF'
# Enterprise asset upgrade baseline

Implement the requested AssetUpgradeGateway target project as a plain single-agent baseline.
The current directory is the copied target project; read its C# source directly and read every
requirement from the sibling `../requirements/` directory.
Implement all four requirements, update or add tests where useful, and run the target project's
available tests/build commands. Record useful implementation notes in the final response.

This is an isolated baseline run. Work only in the current target-project directory. This run is
the direct-agent control condition: do not use the RECAST retrieval, Analyzer, Translator,
evidence-query, module-planning, or verification workflow. Do not
inspect, search, index, import, or reference any parent directory, sibling directory, history
repository, source-repositories directory, or RECAST/ForeXplore implementation. Do not edit the
copied requirements. Do not modify the original dataset; the current directory is a disposable
copy created specifically for this run.
EOF
fi

if [[ "$agent_shell" == "codex" ]]; then
  api_base="${DEEPSEEK_API_BASE:-https://api.deepseek.com/}"
else
  api_base="https://api.deepseek.com/anthropic"
fi

cat > "$run_dir/run-manifest.json" <<EOF
{
  "runId": "${run_id}",
  "kind": "coding-agent-baseline",
  "language": "C#",
  "provider": "deepseek",
  "apiBase": "${api_base}",
  "settingSources": "project,local",
  "model": "${model}",
  "apiModel": "deepseek-flash",
  "effectiveModel": "DeepSeek-V4.1-Flash",
  "agentShell": "${agent_shell}",
  "workspace": "target-project",
  "requirements": "requirements",
  "historyExposed": false,
  "hiddenTestsExposed": false,
  "sourceDataset": "target-project"
}
EOF

if [[ "$agent_shell" == "codex" ]]; then
  launcher="${CODEX_BIN:-codex}"
elif [[ "$agent_shell" == "claude" ]]; then
  launcher="${CLAUDE_BIN:-claude}"
else
  echo "Unsupported agent shell: $agent_shell (expected codex or claude)" >&2
  exit 2
fi
command -v "$launcher" >/dev/null 2>&1 || { echo "Coding Agent executable not found: $launcher" >&2; exit 127; }
if [[ "${BASELINE_DRY_RUN:-0}" != "1" ]]; then
  [[ -n "${DEEPSEEK_API_KEY:-}" ]] || { echo "DEEPSEEK_API_KEY is required for DeepSeek baseline." >&2; exit 1; }
fi

agent_temp_root=""
agent_workspace="$run_dir/target-project"
codex_home=""
if [[ "${BASELINE_DRY_RUN:-0}" != "1" ]]; then
  # Keep the Agent outside the repository containing this result directory.
  # Otherwise git can discover the monorepo's ancestor .git directory even
  # though no repository metadata was copied into the baseline workspace.
  agent_temp_root="$(mktemp -d /tmp/recast-csharp-baseline.XXXXXX)"
  agent_workspace="$agent_temp_root/target-project"
  mkdir -p "$agent_workspace"
  cp -a "$run_dir/target-project"/. "$agent_workspace"/
  chmod 700 "$agent_temp_root"
  if [[ "$agent_shell" == "codex" ]]; then
    codex_home="$agent_temp_root/codex-home"
    mkdir -p "$codex_home"
    chmod 700 "$codex_home"
  fi
  cleanup_agent_temp() {
    chmod -R u+w "$agent_temp_root" 2>/dev/null || true
    rm -rf "$agent_temp_root"
  }
  trap cleanup_agent_temp EXIT
fi
if [[ "$agent_shell" == "codex" && "${BASELINE_DRY_RUN:-0}" != "1" ]]; then
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
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf 'Starting baseline in %s\n' "$run_dir"
printf 'Agent shell: %s\n' "$agent_shell"
printf 'Provider: deepseek\n'
printf 'Model: %s\n' "$model"
printf 'History repositories exposed: no\n'

if [[ "${BASELINE_DRY_RUN:-0}" == "1" ]]; then
  printf '%s\n' '{"type":"dry-run","message":"Agent invocation skipped."}' | tee "$run_dir/agent-stream.jsonl"
  agent_status=0
else
  set +e
  if [[ "$agent_shell" == "codex" ]]; then
    (cd "$agent_workspace" && CODEX_HOME="$codex_home" "$launcher" exec \
      --model "$model" --cd "$agent_workspace" \
      --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --ephemeral --json \
      -o "$run_dir/agent-final.txt" - < "$run_dir/task-prompt.md") \
      2>&1 | tee "$run_dir/agent-stream.jsonl"
  else
    (
      cd "$agent_workspace"
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
      "$launcher" --bare --setting-sources project,local --no-session-persistence --permission-mode bypassPermissions \
        --allow-dangerously-skip-permissions --verbose --output-format stream-json \
        --model "$model" \
        -p "$(cat "$run_dir/task-prompt.md")"
    ) 2>&1 | tee "$run_dir/agent-stream.jsonl"
  fi
  agent_status=${PIPESTATUS[0]}
  set -e
fi

finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
# Persist the disposable Agent workspace only after the Agent exits. The
# evaluator always reads this copy, never the temporary staging directory.
if [[ "${BASELINE_DRY_RUN:-0}" != "1" ]]; then
  chmod -R u+w "$run_dir/target-project" 2>/dev/null || true
  rm -rf "$run_dir/target-project"
  mkdir -p "$run_dir/target-project"
  cp -a "$agent_workspace"/. "$run_dir/target-project"/
fi
python3 - "$run_dir/run-result.json" "$run_id" "$started_at" "$finished_at" "$agent_status" "$run_dir/agent-stream.jsonl" <<'PY'
import json, pathlib, sys
out, run_id, started, finished, status, log_path = sys.argv[1:]
root = pathlib.Path(out).parent
files = [p for p in (root / "target-project").rglob("*") if p.is_file() and ".git" not in p.parts]
stream_result = {}
turn_result = {}
thread_id = None
for line in pathlib.Path(log_path).read_text(errors="replace").splitlines():
    try:
        event = json.loads(line)
    except json.JSONDecodeError:
        continue
    if event.get("type") == "result":
        stream_result = event
    if event.get("type") == "thread.started":
        thread_id = event.get("thread_id")
    if event.get("type") == "turn.completed":
        turn_result = event
usage = stream_result.get("usage", {}) or turn_result.get("usage", {})
model_usage = stream_result.get("modelUsage", {})
model_name = next(iter(model_usage), None)
result = {
    "runId": run_id,
    "kind": "coding-agent-baseline",
    "startedAt": started,
    "finishedAt": finished,
    "exitCode": int(status),
    "success": int(status) == 0,
    "workspace": str(root / "target-project"),
    "requirements": str(root / "requirements"),
    "agentLog": str(root / "agent-stream.jsonl"),
    "historyExposed": False,
    "resultFileCount": len(files),
    "agentSessionId": stream_result.get("session_id") or thread_id,
    "agentModel": model_name,
    "durationApiMs": stream_result.get("duration_api_ms"),
    "durationMs": stream_result.get("duration_ms"),
    "inputTokens": usage.get("input_tokens"),
    "outputTokens": usage.get("output_tokens"),
    "cacheCreationInputTokens": usage.get("cache_creation_input_tokens"),
    "cacheReadInputTokens": usage.get("cache_read_input_tokens"),
    "thinkingTokens": usage.get("output_tokens_details", {}).get("thinking_tokens"),
    "modelUsage": model_usage,
}
manifest = json.loads((root / "run-manifest.json").read_text())
result["provider"] = manifest.get("provider")
result["configuredApiBase"] = manifest.get("apiBase")
result["settingSources"] = manifest.get("settingSources")
result["agentShell"] = manifest.get("agentShell")
result["apiModel"] = manifest.get("apiModel")
result["effectiveModel"] = manifest.get("effectiveModel")
result["agentModelUsageKeys"] = list(model_usage)
result["agentModel"] = manifest.get("model") or result["agentModel"]
result["claudeCodeListCostEstimateUsd"] = stream_result.get("total_cost_usd")
result["providerBilling"] = {
    "provider": manifest.get("provider"),
    "amountUsd": None,
    "status": "not_reported_by_run_telemetry",
    "note": "Claude Code's list-price estimate is not provider billing data.",
}
pathlib.Path(out).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
PY

# Run the evaluator only after the Coding Agent has exited. The evaluator lives
# outside target-project and is never copied into the Agent workspace.
hidden_evaluator="$dataset_root/evaluation/run-hidden-evaluation.sh"
hidden_status=2
if [[ "${BASELINE_DRY_RUN:-0}" == "1" ]]; then
  hidden_status=0
  printf '%s\n' '{"type":"dry-run","message":"Hidden evaluator skipped."}' > "$run_dir/hidden-evaluation.log"
elif [[ -f "$hidden_evaluator" ]]; then
  set +e
  bash "$hidden_evaluator" \
    --target "$run_dir/target-project" \
    --output "$run_dir/hidden-evaluation.json" \
    2>&1 | tee "$run_dir/hidden-evaluation.log"
  hidden_status=${PIPESTATUS[0]}
  set -e
else
  echo "Hidden evaluator not found: $hidden_evaluator" | tee "$run_dir/hidden-evaluation.log"
fi

python3 - "$run_dir/run-result.json" "$run_dir/hidden-evaluation.json" "$hidden_status" <<'PY'
import json, pathlib, sys
result_path, evaluation_path, status = sys.argv[1:]
result = json.loads(pathlib.Path(result_path).read_text())
evaluation = pathlib.Path(evaluation_path)
result["hiddenEvaluation"] = {
    "status": int(status),
    "report": str(evaluation),
}
if evaluation.is_file():
    try:
        report = json.loads(evaluation.read_text())
    except json.JSONDecodeError:
        report = None
    if isinstance(report, dict):
        result["hiddenEvaluation"].update({
            "total": report.get("Total"),
            "passed": report.get("Passed"),
            "failed": report.get("Failed"),
            "score": report.get("Score"),
            "requirementTotal": report.get("RequirementTotal"),
            "requirementPassed": report.get("RequirementPassed"),
            "qualityTotal": report.get("QualityTotal"),
            "qualityPassed": report.get("QualityPassed"),
        })
pathlib.Path(result_path).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
PY

printf 'Baseline exit code: %s\n' "$agent_status"
printf 'Result code copy: %s\n' "$run_dir/target-project"
printf 'Agent log: %s\n' "$run_dir/agent-stream.jsonl"
printf 'Run result: %s\n' "$run_dir/run-result.json"
printf 'Hidden evaluation exit code: %s\n' "$hidden_status"
printf 'Hidden evaluation: %s\n' "$run_dir/hidden-evaluation.json"
exit "$agent_status"
