#!/usr/bin/env bash
#
# finalize-clean-tree.sh -- Deterministically finalize a workflow's working
# tree so it ends CLEAN (no uncommitted or untracked files).
#
# Invoked from the generic converter-workflow FINALIZE state's onExitCommands
# as the final process step, replacing the brittle inline "git clean + git
# add -A + porcelain gate" chain. This mirrors the scripts/auto-rebase.sh
# pattern: a deterministic, self-contained, independently testable script
# called from the workflow instead of multi-command JSON strings. The FINALIZE
# state commits the assignment's deliverables BEFORE invoking this script, so
# anything still untracked here is non-deliverable noise.
#
# The workflow engine runs onExitCommands with cwd = the project working
# folder (the git repo), so this script operates on that repo via cwd. The
# script itself lives OUTSIDE that repo (copied to agent/workspace/ by
# setup.sh) so it never dirties the tree it is cleaning.
#
# Behavior (all deterministic, no LLM involved):
#   1. Remove ALL untracked files and directories FIRST (git clean -fdx):
#      both gitignored build artifacts (transpiled *.js, dist/, .github/,
#      node_modules/) AND stray non-deliverable files/dirs the LLM may have
#      created outside the spec (src/, tests/, scratch notes). Every real
#      deliverable is committed by its own workflow state before this runs,
#      so anything still untracked here is non-deliverable noise. Cleaning
#      BEFORE any `git add` is essential: otherwise `git add -A` would stage
#      and commit that stray noise instead of removing it.
#   2. Commit any remaining modifications to already-tracked deliverables
#      (for example a modified README.md) with a fixed finalize message.
#      Idempotent: a no-op when there is nothing staged (e.g. on a retry).
#   3. Verify the working tree is clean. Exit non-zero if not, so the workflow
#      engine treats the transition as a failure and self-loops to retry.
#
# Exit codes: 0 = clean tree achieved, 1 = not a git work tree or tree dirty.

set -uo pipefail

echo "finalize-clean-tree: starting in $(pwd)"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "finalize-clean-tree: ERROR -- cwd is not a git work tree" >&2
  exit 1
fi

# 1. Remove all untracked files/dirs (ignored artifacts + non-deliverable
#    noise). Tracked-but-modified files (e.g. README.md) are left untouched.
REMOVED="$(git clean -fdx)"
if [ -n "$REMOVED" ]; then
  echo "finalize-clean-tree: removed untracked artifacts:"
  echo "$REMOVED" | sed 's/^/  /'
else
  echo "finalize-clean-tree: no untracked files to remove"
fi

# 2. Commit any remaining changes to tracked deliverables (idempotent).
git add -A
if git diff --cached --quiet; then
  echo "finalize-clean-tree: no staged changes to commit"
else
  git commit -m "chore: finalize converter working tree"
  echo "finalize-clean-tree: committed remaining tracked changes"
fi

# 3. Gate: the working tree must be clean at completion.
STATUS="$(git status --porcelain)"
if [ -n "$STATUS" ]; then
  echo "finalize-clean-tree: ERROR -- working tree still dirty:" >&2
  echo "$STATUS" | sed 's/^/  /' >&2
  exit 1
fi

echo "finalize-clean-tree: working tree is clean"
exit 0
