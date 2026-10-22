#!/usr/bin/env bash
set -euo pipefail

# Codex + DeepSeek V4.1-Flash baseline for the Java target.
# The generic Java runner creates an isolated CODEX_HOME and runs the Java
# hidden JUnit suite only after Codex exits.
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
default_source="$repo_root/experiments/enterprise-asset-upgrade/results/java-integration-original-skeleton-20261010"

exec env \
  BASELINE_AGENT=codex \
  BASELINE_MODEL="${BASELINE_MODEL:-deepseek-flash}" \
  BASELINE_TARGET_SOURCE="${BASELINE_TARGET_SOURCE:-$default_source}" \
  bash "$script_dir/run-enterprise-asset-upgrade-java-baseline.sh" "$@"
