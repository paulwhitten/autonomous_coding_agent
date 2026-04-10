#!/bin/bash

# Setup script for the V-Model Regulatory Evidence smoke test
#
# Creates THREE agent environments (RA + Developer + QA) with a shared
# mailbox and a shared git origin. Each agent clones the origin into its
# workspace/project/ directory so artifacts flow between agents via git.
# Agents route directly to each other via peer routing (teamMembers config).
#
#   RA:        REQUIREMENTS_DEFINITION (left top of V) + ACCEPTANCE (right top)
#   Developer: IMPLEMENTING (bottom of V) + REWORK
#   QA:        VERIFICATION (right ascending)

set -eE
trap 'echo "FATAL: setup.sh failed at line $LINENO (exit $?)" >&2' ERR

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

HARNESS_ROOT="$(cd ../.. && pwd)"

# ----------------------------------------------------------------
# Ensure root-level dependencies are installed (pino, tsx, etc.)
# The smoke-test-cli.ts script imports from ${HARNESS_ROOT}/src/
# which requires node_modules at the project root.
# ----------------------------------------------------------------
if [ ! -d "${HARNESS_ROOT}/node_modules" ]; then
  echo "Installing root-level dependencies (first run)..."
  ( cd "${HARNESS_ROOT}" && npm install --silent 2>&1 | tail -5 )
fi

echo "================================================================"
echo "V-MODEL REGULATORY EVIDENCE SMOKE TEST -- SETUP"
echo "================================================================"
echo ""
echo "Standard:  HIPAA Security Rule (45 CFR 164)"
echo "V-Model:   RA (requirements) -> Dev (implement) -> QA (verify) -> RA (accept)"
echo "Agents:    3 -- RA + Developer + QA (peer routing, no manager)"
echo ""

# ----------------------------------------------------------------
# Kill leftover processes from previous regulatory test runs only.
# Use a narrow pattern that matches the smoke_tests/regulatory agent
# paths to avoid killing unrelated agents (e.g. project team agents).
# ----------------------------------------------------------------
echo "Killing any leftover regulatory test agent processes..."
pkill -f "node.*smoke_tests/regulatory.*/dist/index.js" 2>/dev/null || true
sleep 1
pkill -9 -f "node.*smoke_tests/regulatory.*/dist/index.js" 2>/dev/null || true

# ----------------------------------------------------------------
# Clean previous artifacts
# ----------------------------------------------------------------
echo "Cleaning previous test artifacts..."
rm -rf runtime_mailbox origin.git
for AGENT_DIR in ra developer qa; do
  rm -rf ${AGENT_DIR}/agent/src ${AGENT_DIR}/agent/dist ${AGENT_DIR}/agent/node_modules
  rm -rf ${AGENT_DIR}/agent/package*.json ${AGENT_DIR}/agent/tsconfig.json ${AGENT_DIR}/agent/config.json
  rm -rf ${AGENT_DIR}/agent/workspace ${AGENT_DIR}/agent/logs ${AGENT_DIR}/agent/templates ${AGENT_DIR}/agent/roles.json
done
rm -f ra-test.log developer-test.log qa-test.log

# ----------------------------------------------------------------
# Create shared bare git origin
# ----------------------------------------------------------------
echo ""
echo "--- Creating shared bare git origin ---"
git init --bare origin.git --quiet
# Force default branch to 'main' in the bare repo so all pushes land on main
git config -f origin.git/config init.defaultBranch main
git symbolic-ref --short HEAD 2>/dev/null || true  # already refs/heads/main
# Seed with an initial commit so clones start with a branch
TMPDIR_SEED=$(mktemp -d)
git clone origin.git "$TMPDIR_SEED/seed" --quiet 2>/dev/null
pushd "$TMPDIR_SEED/seed" > /dev/null
git config user.email "smoke-test@local"
git config user.name "Smoke Test"
# Force branch name to 'main' regardless of system default
git checkout -b main 2>/dev/null || true
echo "# Healthcare Records Data Validation Pipeline" > README.md
mkdir -p evidence docs

# ----------------------------------------------------------------
# Seed .gitignore (robust -- explicitly blocks only known patterns
# so LLM agents do not replace it with a blanket '*' pattern)
# ----------------------------------------------------------------
cat > .gitignore << 'GITIGNORE'
node_modules/
dist/
*.js.map
*.tsbuildinfo
coverage/
.DS_Store
.github/
GITIGNORE

# ----------------------------------------------------------------
# Empty repo -- just README, .gitignore, and placeholder dirs.
# The Developer agent must create all source, tests, and config
# files from scratch per the RA's requirements specification.
# ----------------------------------------------------------------
echo "# Placeholder" > evidence/.gitkeep
echo "# Placeholder" > docs/.gitkeep

git add -A && git commit -m "Initial empty project scaffold" --quiet
git push origin main --quiet 2>/dev/null
popd > /dev/null
rm -rf "$TMPDIR_SEED"
echo "  Bare origin ready at origin.git (branch: main, empty -- developer builds everything)"

# ----------------------------------------------------------------
# Setup all 4 agents (copy source, install deps)
# ----------------------------------------------------------------
setup_agent() {
  local AGENT_NAME=$1
  local AGENT_DIR=$2
  echo ""
  echo "--- Setting up ${AGENT_NAME} agent ---"
  mkdir -p ${AGENT_DIR}/agent
  cp -r ../../src ${AGENT_DIR}/agent/
  cp -r ../../templates ${AGENT_DIR}/agent/
  cp ../../package.json ${AGENT_DIR}/agent/
  cp ../../tsconfig.json ${AGENT_DIR}/agent/
  cp ../../roles.json ${AGENT_DIR}/agent/
  cp ${AGENT_DIR}/agent/config.template.json ${AGENT_DIR}/agent/config.json

  # Clone shared origin into workspace/project
  mkdir -p ${AGENT_DIR}/agent/workspace
  git clone "$(pwd)/origin.git" ${AGENT_DIR}/agent/workspace/project --quiet 2>/dev/null
  pushd ${AGENT_DIR}/agent/workspace/project > /dev/null
  git config user.email "${AGENT_DIR}@smoke-test.local"
  git config user.name "${AGENT_NAME}"
  git config init.defaultBranch main
  popd > /dev/null
  echo "  Cloned origin.git -> ${AGENT_DIR}/agent/workspace/project/"

  echo "Installing ${AGENT_NAME} agent dependencies..."
  ( cd ${AGENT_DIR}/agent && npm install --silent 2>&1 | tail -5 ) || {
    echo "WARNING: npm install for ${AGENT_NAME} exited non-zero (continuing)"
  }
}

setup_agent "RA (Requirements Analyst)" "ra"
setup_agent "Developer" "developer"
setup_agent "QA" "qa"

# CLI available after npm install
CLI="npx --prefix developer/agent tsx ${HARNESS_ROOT}/scripts/smoke-test-cli.ts"

# ----------------------------------------------------------------
# Build shared mailbox structure
# ----------------------------------------------------------------
echo ""
echo "--- Creating shared mailbox ---"
$CLI init-mailbox --base runtime_mailbox --agent smoke-reg-ra  --role requirements-analyst
$CLI init-mailbox --base runtime_mailbox --agent smoke-reg-dev --role developer
$CLI init-mailbox --base runtime_mailbox --agent smoke-reg-qa  --role qa

# ----------------------------------------------------------------
# Seed RA: Only vmodel-001 initially
#
# Each REQ flows through the full V-model:
#   RA(REQUIREMENTS) -> Dev(IMPLEMENTING) -> QA(VERIFICATION) -> RA(ACCEPTANCE) -> DONE
#
# Only vmodel-001 is seeded here. The run-test.sh script monitors
# the RA log for "Workflow task reached terminal state" and seeds
# vmodel-002 and vmodel-003 sequentially after the prior task
# completes. This prevents the race condition where Dev started
# task 2 before task 1 was QA-verified and merged.
# ----------------------------------------------------------------
echo ""
echo "--- Seeding RA: vmodel-001 (tasks 002 + 003 seeded by run-test.sh on completion) ---"

$CLI pack-workflow \
  --base runtime_mailbox --agent smoke-reg-ra --role requirements-analyst --queue normal \
  --workflow-id v-model-evidence \
  --task-id vmodel-001 \
  --state REQUIREMENTS_DEFINITION \
  --target-role requirements-analyst \
  --prompt "REQ-HCDP-001: Create a CLI application called hcdp-validate. The CLI shall run via npx ts-node src/cli.ts and exit 0 when called with no arguments. Write a requirements spec (docs/requirements-specification.md) covering REQ-HCDP-001 and an acceptance criteria checklist (docs/acceptance-criteria-checklist.md). Requirement traceability shall be maintained in the acceptance verdict, traceability matrix, and verification reports -- not in source code comments. Push to origin and report completion." \
  --from smoke-reg-ra_requirements-analyst \
  --to smoke-reg-ra_requirements-analyst \
  --subject "V-Model: REQUIREMENTS_DEFINITION -- REQ-HCDP-001 Bare CLI"
echo "  Seeded task vmodel-001: REQ-HCDP-001 (Bare CLI)"
echo "  Tasks 002 + 003 will be seeded by run-test.sh after prior task reaches DONE"

echo ""
echo "================================================================"
echo "Setup complete.  3 serial V-Model tasks (script-orchestrated):"
echo ""
echo "  Task 1 (vmodel-001): REQ-HCDP-001 -- Bare CLI app          [seeded now]"
echo "  Task 2 (vmodel-002): REQ-HCDP-002 -- JSONL record type     [seeded by run-test.sh]"
echo "  Task 3 (vmodel-003): REQ-HCDP-003 -- Referential integrity [seeded by run-test.sh]"
echo ""
echo "  Each task flows: RA -> Dev -> QA -> RA -> DONE"
echo "  No manager agent -- agents route directly via teamMembers."
echo ""
echo "Shared mailbox: runtime_mailbox/"
echo "Workflow:       workflow.json"
echo ""
echo "Run: ./run-test.sh"
echo "================================================================"
