#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target_project="$(realpath "${1:?target project required}")"
suite="${2:-all}"
[[ "$suite" == "all" || "$suite" == "engineering" ]] || { echo "Unknown suite: $suite" >&2; exit 2; }
maven_bin="${MAVEN_BIN:-mvn}"
export PATH="${JAVA_HOME:?}/bin:$PATH"
"$maven_bin" -q -f "$target_project/pom.xml" -DskipTests clean package
eval_root="$(mktemp -d /tmp/recast-full-coverage-eval.XXXXXX)"
trap 'rm -rf "$eval_root"' EXIT
if [[ "$suite" == "engineering" ]]; then
  test_package="src/test/java/com/example/assetupgrade/hidden"
  mkdir -p "$eval_root/$test_package"
  cp "$script_dir/$test_package/FullEngineeringHiddenTest.java" "$script_dir/$test_package/EngineeringProjectAccess.java" "$eval_root/$test_package/"
else
  cp -a "$script_dir/src" "$eval_root/src"
fi
# Retain the target's real build and dependencies in a private copy.
python3 "$script_dir/prepare-evaluator.py" "$target_project" "$eval_root"
set +e
"$maven_bin" -B -f "$eval_root/target-project/pom.xml" test
eval_status=$?
set -e
mkdir -p "$(dirname "$target_project")/evaluation-reports"
if [[ -d "$eval_root/target-project/target/surefire-reports" ]]; then
  cp -a "$eval_root/target-project/target/surefire-reports"/. "$(dirname "$target_project")/evaluation-reports/"
fi

exit "$eval_status"
