#!/bin/bash
# Setup script for converter-workflow smoke test
#
# Workflow-driven counterpart to converter-ad-hoc. A single developer
# agent is driven through a GENERIC, deliverable-agnostic state machine
# (workflow.json: DEVELOP -> TEST -> FINALIZE -> DONE). The LLM only writes
# source, test, and doc files in DEVELOP; the workflow engine runs Jest and
# performs every git commit plus working-tree hygiene via onExitCommands.
#
# The three deliverables (build module, add kilogramsToPounds, write README)
# are three SEPARATE assignments, each with its own taskId, carrying the
# WHAT in taskPrompt (assignments/*.md). This mirrors converter-ad-hoc's
# three mailbox messages; the only intended difference is who runs the
# deterministic steps (engine here, LLM in ad-hoc).
#
# Assignments are seeded SERIALLY, one at a time, to avoid mailbox interleave
# on a single agent: setup.sh seeds only assignment 1 (converter-01) here;
# run-test.sh waits for each assignment to reach a terminal state, then seeds
# the next (regulatory-workflow pattern). Serial seeding guarantees only one
# task is ever in the mailbox, so a DEVELOP rework self-loop cannot clobber a
# later assignment's not-yet-committed work.

set -eE
trap 'echo "FATAL: setup.sh failed at line $LINENO (exit $?)" >&2' ERR

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

HARNESS_ROOT="$(cd ../.. && pwd)"

# Ensure root-level dependencies are installed (smoke-test-cli imports from root src/)
if [ ! -d "${HARNESS_ROOT}/node_modules" ]; then
  echo "Installing root-level dependencies (first run)..."
  ( cd "${HARNESS_ROOT}" && npm install --silent 2>&1 | tail -5 )
fi

echo "Setting up converter-workflow smoke test..."

# Kill any leftover agent processes from previous runs
echo "Killing any leftover converter-workflow test agent processes..."
pkill -f "node.*smoke_tests/converter-workflow.*/dist/index.js" 2>/dev/null || true
sleep 1
pkill -9 -f "node.*smoke_tests/converter-workflow.*/dist/index.js" 2>/dev/null || true

# Clean previous test artifacts
echo "Cleaning previous test artifacts..."
rm -rf runtime_mailbox
rm -rf agent/src agent/templates agent/dist agent/node_modules agent/workspace agent/logs
rm -f agent/package-lock.json agent/package.json agent/tsconfig.json agent/config.json agent/roles.json
rm -f test.log

# Copy source code from parent
echo "Copying source code..."
cp -r ../../src agent/
cp -r ../../templates agent/
cp ../../package.json agent/
cp ../../package-lock.json agent/
cp ../../tsconfig.json agent/
cp ../../roles.json agent/

# Copy config template (workflowFile configured — workflow-driven mode)
echo "Setting up configuration..."
cp agent/config.template.json agent/config.json

# Initialize git repo in the project working folder
echo "Initializing git repo in project folder..."
mkdir -p agent/workspace/project
cd agent/workspace/project
git init
git config user.name "Converter Workflow Smoke Test Agent"
git config user.email "converter-wf-agent@test.local"

# Seed Jest + TypeScript scaffolding so the workflow's `npx jest` exit
# commands actually run the TS tests. Without this, jest cannot parse
# TypeScript and the deterministic test gate would fail. ts-jest is already
# present in agent/node_modules (copied via package-lock + npm ci).
cat > package.json <<'PKG_EOF'
{
  "name": "converter",
  "version": "1.0.0",
  "scripts": { "test": "jest" }
}
PKG_EOF
cat > jest.config.cjs <<'JEST_EOF'
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
};
JEST_EOF
cat > tsconfig.json <<'TSC_EOF'
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true
  }
}
TSC_EOF
# Note: `npx jest` run from this folder resolves jest/ts-jest by walking up
# the directory tree to agent/node_modules (Node module resolution). No local
# node_modules or symlink is needed.

# Create initial commit so the repo is not bare
# Ignore the .github/ directory the agent runtime generates at startup
# (role-based copilot-instructions.md); it is framework scaffolding, not an
# agent deliverable, so it must not dirty the project working tree.
# Also ignore transpiled TypeScript output (e.g. a compiled converter.js from
# running tsc): it is a build artifact, not a deliverable, and must not be left
# untracked or committed.
cat > .gitignore <<'GITIGNORE_EOF'
.github/
node_modules/
coverage/
dist/

# Transpiled TypeScript output (build artifacts, not deliverables).
# Ignore ALL transpiled JS (converter.js AND converter.test.js etc.) so a
# stray `npx tsc` run by the LLM cannot leave untracked files that dirty the
# working tree. Source is .ts and the Jest config is .cjs, so *.js is safe.
*.js
*.js.map
*.d.ts
GITIGNORE_EOF
echo "# Converter Workflow Project" > README.md
git add -A
git commit -m "chore: initial project setup"
cd "$SCRIPT_DIR"

# Stage the deterministic hygiene finalize script one level ABOVE the project
# git repo (agent/workspace/). The UPDATE_README state invokes it as
# `bash ../finalize-clean-tree.sh` with cwd = agent/workspace/project, so it
# operates on the project repo while living outside it (never dirtying the
# tree it cleans). Mirrors the scripts/auto-rebase.sh pattern.
echo "Installing finalize-clean-tree hygiene script..."
cp scripts/finalize-clean-tree.sh agent/workspace/finalize-clean-tree.sh
chmod +x agent/workspace/finalize-clean-tree.sh

# Install dependencies
echo "Installing dependencies..."
cd agent
npm ci
cd ..

# CLI available after npm ci
CLI="npx --prefix agent tsx ${HARNESS_ROOT}/scripts/smoke-test-cli.ts"

# Create mailbox structure
echo "Creating mailbox structure..."
$CLI init-mailbox --base runtime_mailbox --agent converter-wf-dev --role developer

# ----------------------------------------------------------------
# Seed the FIRST workflow assignment (converter-01) at the initial
# DEVELOP state. The taskPrompt carries the deliverable spec (the WHAT);
# the generic workflow carries the process (the HOW). run-test.sh seeds
# converter-02 and converter-03 serially after each prior task reaches a
# terminal state.
# ----------------------------------------------------------------

echo "Seeding workflow assignment 1 of 3 (converter-01)..."
$CLI pack-workflow \
  --base runtime_mailbox --agent converter-wf-dev --role developer --queue normal \
  --workflow-id converter-workflow \
  --task-id converter-01 \
  --state DEVELOP \
  --target-role developer \
  --prompt "@assignments/01-create-module.md" \
  --context '{"commitMessage":"feat: add unit converter module"}' \
  --from converter-wf-dev_developer \
  --to converter-wf-dev_developer \
  --subject "Workflow Assignment converter-01: create converter module" \
  --filename "001_converter_01.md"

echo ""
echo "converter-workflow smoke test setup complete!"
echo ""
echo "To run the test:"
echo "  ./run-test.sh"
