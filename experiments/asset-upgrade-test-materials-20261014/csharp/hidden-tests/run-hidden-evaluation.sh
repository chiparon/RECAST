#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
evaluator_project="$script_dir/HiddenAcceptanceEvaluator.csproj"
target_project=""
output=""

usage() {
  cat <<'EOF'
Usage: csharp/hidden-tests/run-hidden-evaluation.sh \
  --target RESULT_TARGET_PROJECT [--output REPORT_JSON]

The evaluator is kept outside target-project. It is compiled against the
completed result only after the Coding Agent has exited.
EOF
}

while (($#)); do
  case "$1" in
    --target)
      [[ $# -ge 2 ]] || { echo "--target requires a path" >&2; exit 2; }
      target_project="$2"
      shift 2
      ;;
    --output)
      [[ $# -ge 2 ]] || { echo "--output requires a path" >&2; exit 2; }
      output="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

[[ -n "$target_project" ]] || { usage >&2; exit 2; }
target_project="$(realpath "$target_project")"
[[ -f "$target_project/src/AssetUpgradeGateway/AssetUpgradeGateway.csproj" ]] || {
  echo "Target project not found under: $target_project" >&2
  exit 1
}

if [[ -z "$output" ]]; then
  output="$target_project/../hidden-evaluation.json"
fi
output="$(realpath -m "$output")"

set +e
dotnet run --project "$evaluator_project" \
  -p:TargetProjectRoot="$target_project" \
  -- \
  --target "$target_project" \
  --output "$output"
status=$?
set -e

if [[ ! -f "$output" ]]; then
  python3 - "$output" "$target_project" "$status" <<'PY'
import json, pathlib, sys
output, target, status = sys.argv[1:]
pathlib.Path(output).parent.mkdir(parents=True, exist_ok=True)
report = {
    "SchemaVersion": 1,
    "Evaluator": "enterprise-asset-upgrade-hidden",
    "TargetProject": target,
    "Total": 24,
    "Passed": 0,
    "Failed": 24,
    "Score": 0,
    "RequirementTotal": 20,
    "RequirementPassed": 0,
    "QualityTotal": 4,
    "QualityPassed": 0,
    "InfrastructureError": f"Evaluator could not compile or start (exit {status}).",
}
pathlib.Path(output).write_text(json.dumps(report, indent=2) + "\n")
PY
fi
exit "$status"
