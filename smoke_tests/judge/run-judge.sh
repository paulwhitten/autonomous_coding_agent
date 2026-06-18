#!/bin/bash
# Judge helper — invoke LLM-as-Judge on one or more agent workspaces.
#
# Source this from a run-test.sh, then call run_judge with workspace paths.
#
# Usage:
#   source "$(dirname "$0")/../judge/run-judge.sh"
#   run_judge "$SCRIPT_DIR"                           # single-agent (auto-discovers agent/workspace)
#   run_judge "$SCRIPT_DIR" developer manager qa      # multi-agent (each role dir has agent/workspace)
#
# The function is non-blocking on failure — a judge error does not fail the test.

JUDGE_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/judge.ts"
JUDGE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

run_judge() {
  local test_dir="$1"
  shift

  # If no roles specified, use the default single-agent layout
  if [ $# -eq 0 ]; then
    local workspace="${test_dir}/agent/workspace"
    if [ -d "$workspace/tasks" ]; then
      echo ""
      echo "Running LLM judge..."
      npx --prefix "${test_dir}/agent" tsx "$JUDGE_SCRIPT" \
        --smoke-test "$test_dir" 2>&1 || echo "(Judge returned non-zero — report may be incomplete)"
    else
      echo "(Skipping judge — no workspace/tasks found)"
    fi
    return
  fi

  # Multi-role: judge each role's workspace separately
  for role in "$@"; do
    local workspace="${test_dir}/${role}/agent/workspace"
    if [ -d "$workspace/tasks" ]; then
      echo ""
      echo "Running LLM judge for ${role}..."
      npx --prefix "${test_dir}/${role}/agent" tsx "$JUDGE_SCRIPT" \
        --workspace "$workspace" \
        --test-name "$(basename "$test_dir")-${role}" \
        --output "${test_dir}/judge/$(date -u +%Y-%m-%d_%H-%M-%S)-${role}.json" 2>&1 \
        || echo "(Judge returned non-zero for ${role} — report may be incomplete)"
    else
      echo "(Skipping judge for ${role} — no workspace/tasks found)"
    fi
  done
}
