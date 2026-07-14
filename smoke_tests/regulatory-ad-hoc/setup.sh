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
  cp ../../package-lock.json ${AGENT_DIR}/agent/
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
  ( cd ${AGENT_DIR}/agent && npm ci --silent 2>&1 | tail -5 ) || {
    echo "WARNING: npm ci for ${AGENT_NAME} exited non-zero (continuing)"
  }
}

setup_agent "RA (Requirements Analyst)" "ra"
setup_agent "Developer" "developer"
setup_agent "QA" "qa"

# CLI available after npm ci
CLI="npx --prefix developer/agent tsx ${HARNESS_ROOT}/scripts/smoke-test-cli.ts"

# ----------------------------------------------------------------
# Build shared mailbox structure
# ----------------------------------------------------------------
echo ""
echo "--- Creating shared mailbox ---"
$CLI init-mailbox --base runtime_mailbox --agent smoke-regah-ra  --role requirements-analyst
$CLI init-mailbox --base runtime_mailbox --agent smoke-regah-dev --role developer
$CLI init-mailbox --base runtime_mailbox --agent smoke-regah-qa  --role qa

# ----------------------------------------------------------------
# Seed RA: Only REQ-HCDP-001 initially (plain ad-hoc message).
#
# AD-HOC MODE: there is NO workflow engine. The RA receives a plain
# mailbox message and must self-drive the entire V-model by hand:
#   - run all git commands itself (fetch, commit, push, merge)
#   - hand off to the Developer via send_message()
#   - the Developer implements + tests + pushes, then hands off to QA
#   - QA verifies + merges + writes evidence, then hands back to RA
#   - the RA writes the acceptance verdict, closing the V
# The per-role handoff protocol lives in each agent's
# custom_instructions.json (Ad-Hoc V-Model Protocol section).
#
# Only REQ-HCDP-001 is seeded here. run-test.sh monitors the RA
# workspace acceptance-verdict.md for an ACCEPTED verdict on the
# current requirement, then seeds REQ-HCDP-002 and REQ-HCDP-003
# sequentially. This mirrors the serial task structure of the
# workflow-driven variant so the two are directly comparable.
# ----------------------------------------------------------------
echo ""
echo "--- Seeding RA: REQ-HCDP-001 (plain message; 002 + 003 seeded by run-test.sh) ---"

$CLI create-message \
  --base runtime_mailbox --agent smoke-regah-ra --role requirements-analyst --queue normal \
  --from smoke-regah-ra_requirements-analyst \
  --to smoke-regah-ra_requirements-analyst \
  --subject "V-Model REQUIREMENTS: REQ-HCDP-001 Bare CLI" \
  --body "You are the Requirements Analyst and the orchestrator of an ad-hoc V-model. There is NO workflow engine. You must drive the whole cycle yourself by running git commands and handing off to teammates via send_message(). Follow the Ad-Hoc V-Model Protocol in your instructions.

REQUIREMENT REQ-HCDP-001: Create a CLI application called hcdp-validate. The CLI shall run via npx ts-node src/cli.ts and exit 0 when called with no arguments.

Your steps for this requirement:
1. In workspace/project, git fetch origin, checkout main, and git reset --hard origin/main so you start from the latest shared state.
2. Create or update docs/requirements-specification.md with a section headed '## REQ-HCDP-001:' including Requirement Identifier, Title, Purpose, Scope, Out of Scope, and Traceability subsections.
3. Create or update docs/acceptance-criteria-checklist.md with objectively verifiable acceptance criteria for REQ-HCDP-001.
4. Run: git add -A, git commit -m 'requirements: REQ-HCDP-001 spec and checklist', git push origin main. You run git yourself -- nothing runs it for you.
5. Hand off to the Developer: send_message(toHostname='smoke-regah-dev', toRole='developer', subject='IMPLEMENT: REQ-HCDP-001 Bare CLI', content includes the requirement text and the instruction to implement, test, push to origin main, and then hand off to QA).

Requirement traceability shall be maintained in the acceptance verdict, traceability matrix, and verification reports -- not in source code comments." \
  --filename "001_req_hcdp_001.md"
echo "  Seeded REQ-HCDP-001 (Bare CLI) as a plain ad-hoc message"
echo "  REQ-HCDP-002 + REQ-HCDP-003 will be seeded by run-test.sh after each acceptance"

echo ""
echo "================================================================"
echo "Setup complete.  3 serial V-Model requirements (LLM-orchestrated):"
echo ""
echo "  Req 1 (REQ-HCDP-001): Bare CLI app          [seeded now]"
echo "  Req 2 (REQ-HCDP-002): JSONL record type     [seeded by run-test.sh]"
echo "  Req 3 (REQ-HCDP-003): Referential integrity [seeded by run-test.sh]"
echo ""
echo "  Each requirement flows: RA -> Dev -> QA -> RA (all handoffs via send_message)"
echo "  No workflow engine -- the LLM agents run git, tests, and sequencing themselves."
echo ""
echo "Shared mailbox: runtime_mailbox/"
echo "Mode:           ad-hoc (no workflow.json)"
echo ""
echo "Run: ./run-test.sh"
echo "================================================================"
