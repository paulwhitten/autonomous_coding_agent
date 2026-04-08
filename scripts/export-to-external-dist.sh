#!/bin/bash
# export-to-external-dist.sh
#
# Exports a minimal distribution of the autonomous_copilot_agent project
# into ./external_dist (a separate git repo).
#
# Included:
#   - src/              Source code (including unit tests)
#   - workflows/         Workflow definitions and schema
#   - smoke_tests/       Smoke test suites (setup scripts, configs, READMEs)
#   - scripts/           Utility scripts (smoke-test-cli, validate-config, etc.)
#   - templates/         Prompt templates
#   - diagrams/          Architecture diagrams (.mmd sources + rendered images)
#   - examples/          Example configs (sample_mailbox, team collaboration)
#   - docker/            Dockerfile and compose for containerised runs
#   - README.md, QUICKSTART.md, ROLES.md, QUOTA.md
#   - WORKFLOW_HELLO_WORLD.md, CONFIG_VALIDATOR.md, A2A_INTEGRATION.md
#   - config.example.json, custom_instructions.example.json, .env.example
#   - roles.json, quota-presets.json
#   - package.json, tsconfig.json, jest.config.js
#   - .gitignore (generated for the distribution)
#
# Excluded:
#   - Internal dev notes (most top-level *.md docs)
#   - research/, coverage/, temp/, .copilot-tracking/
#   - node_modules/, dist/, .git/
#   - Smoke test runtime artifacts (runtime_mailbox/, agent/src/, etc.)
#
# Usage:
#   ./scripts/export-to-external-dist.sh [--dry-run] [--clean]
#
# Options:
#   --dry-run   Print what would be copied without writing anything
#   --clean     Remove all tracked content in external_dist before copying
#               (preserves .git/)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DIST_DIR="${PROJECT_ROOT}/external_dist"

DRY_RUN=false
CLEAN=false

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --clean)   CLEAN=true ;;
    -h|--help)
      head -35 "$0" | tail -30
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 2
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

log() { echo "[export] $*"; }

copy_file() {
  local src="$1" dst="$2"
  if $DRY_RUN; then
    echo "  COPY  ${src#"${PROJECT_ROOT}/"} -> ${dst#"${DIST_DIR}/"}"
    return
  fi
  mkdir -p "$(dirname "$dst")"
  cp "$src" "$dst"
}

copy_dir() {
  local src="$1" dst="$2"
  if $DRY_RUN; then
    echo "  CPDIR ${src#"${PROJECT_ROOT}/"} -> ${dst#"${DIST_DIR}/"}"
    return
  fi
  # Remove existing destination to prevent cp -r nesting (e.g. scripts/scripts/)
  rm -rf "$dst"
  mkdir -p "$(dirname "$dst")"
  cp -r "$src" "$dst"
}

# ---------------------------------------------------------------------------
# Validate prerequisites
# ---------------------------------------------------------------------------

if [ ! -d "${DIST_DIR}/.git" ]; then
  echo "ERROR: ${DIST_DIR} is not a git repository." >&2
  echo "       Initialize it first:  cd external_dist && git init" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Clean (optional)
# ---------------------------------------------------------------------------

if $CLEAN; then
  log "Cleaning external_dist (preserving .git/) ..."
  if ! $DRY_RUN; then
    find "${DIST_DIR}" -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} +
  else
    echo "  CLEAN  external_dist/* (except .git/)"
  fi
fi

# ---------------------------------------------------------------------------
# Source code (including unit tests)
# ---------------------------------------------------------------------------

log "Copying source code ..."
if $DRY_RUN; then
  echo "  CPDIR src/ -> src/"
else
  mkdir -p "${DIST_DIR}/src"
  if command -v rsync &>/dev/null; then
    rsync -a --delete \
      "${PROJECT_ROOT}/src/" "${DIST_DIR}/src/"
  else
    cp -r "${PROJECT_ROOT}/src/"* "${DIST_DIR}/src/" 2>/dev/null || true
  fi
fi

# ---------------------------------------------------------------------------
# Workflows
# ---------------------------------------------------------------------------

log "Copying workflows ..."
copy_dir "${PROJECT_ROOT}/workflows" "${DIST_DIR}/workflows"

# ---------------------------------------------------------------------------
# Smoke tests (excluding runtime artifacts)
# ---------------------------------------------------------------------------

log "Copying smoke tests ..."
if $DRY_RUN; then
  echo "  CPDIR smoke_tests/ -> smoke_tests/ (excluding runtime artifacts)"
else
  mkdir -p "${DIST_DIR}/smoke_tests"
  if command -v rsync &>/dev/null; then
    rsync -a --delete \
      --exclude='runtime_mailbox/' \
      --exclude='temp/' \
      --exclude='agent/src/' \
      --exclude='agent/templates/' \
      --exclude='agent/dist/' \
      --exclude='agent/node_modules/' \
      --exclude='agent/workspace/' \
      --exclude='agent/logs/' \
      --exclude='agent/package.json' \
      --exclude='agent/package-lock.json' \
      --exclude='agent/tsconfig.json' \
      --exclude='agent/config.json' \
      --exclude='agent/roles.json' \
      --exclude='agent/.npmrc' \
      --exclude='agent/.github/' \
      --exclude='agent/jest.config.*' \
      --exclude='agent/*.md' \
      --exclude='agent/*.txt' \
      --exclude='agent/*.sh' \
      --exclude='agent/*.js' \
      --exclude='agent/mailbox/' \
      --exclude='origin.git/' \
      --exclude='*.log' \
      "${PROJECT_ROOT}/smoke_tests/" "${DIST_DIR}/smoke_tests/"
  else
    cp -r "${PROJECT_ROOT}/smoke_tests" "${DIST_DIR}/"
    # Remove runtime artifacts that would normally be gitignored
    find "${DIST_DIR}/smoke_tests" -type d -name 'runtime_mailbox' -exec rm -rf {} + 2>/dev/null || true
    find "${DIST_DIR}/smoke_tests" -type d -name 'temp' -exec rm -rf {} + 2>/dev/null || true
    find "${DIST_DIR}/smoke_tests" -path '*/agent/src' -exec rm -rf {} + 2>/dev/null || true
    find "${DIST_DIR}/smoke_tests" -path '*/agent/dist' -exec rm -rf {} + 2>/dev/null || true
    find "${DIST_DIR}/smoke_tests" -path '*/agent/node_modules' -exec rm -rf {} + 2>/dev/null || true
    find "${DIST_DIR}/smoke_tests" -path '*/agent/workspace' -exec rm -rf {} + 2>/dev/null || true
    find "${DIST_DIR}/smoke_tests" -path '*/agent/logs' -exec rm -rf {} + 2>/dev/null || true
    find "${DIST_DIR}/smoke_tests" -path '*/origin.git' -exec rm -rf {} + 2>/dev/null || true
    find "${DIST_DIR}/smoke_tests" -name '*.log' -delete 2>/dev/null || true
  fi
fi

# ---------------------------------------------------------------------------
# Scripts (utilities needed by smoke tests and general use)
# ---------------------------------------------------------------------------

log "Copying scripts ..."
copy_dir "${PROJECT_ROOT}/scripts" "${DIST_DIR}/scripts"

# ---------------------------------------------------------------------------
# Templates
# ---------------------------------------------------------------------------

log "Copying templates ..."
copy_dir "${PROJECT_ROOT}/templates" "${DIST_DIR}/templates"

# ---------------------------------------------------------------------------
# Diagrams
# ---------------------------------------------------------------------------

log "Copying diagrams ..."
copy_dir "${PROJECT_ROOT}/diagrams" "${DIST_DIR}/diagrams"

# ---------------------------------------------------------------------------
# Examples
# ---------------------------------------------------------------------------

log "Copying examples ..."
copy_dir "${PROJECT_ROOT}/examples" "${DIST_DIR}/examples"

# ---------------------------------------------------------------------------
# Docker
# ---------------------------------------------------------------------------

log "Copying docker configuration ..."
copy_dir "${PROJECT_ROOT}/docker" "${DIST_DIR}/docker"

# ---------------------------------------------------------------------------
# Root-level config and documentation files
# ---------------------------------------------------------------------------

log "Copying root-level files ..."

# Documentation
for f in README.md QUICKSTART.md ROLES.md QUOTA.md \
         WORKFLOW_HELLO_WORLD.md CONFIG_VALIDATOR.md \
         A2A_INTEGRATION.md; do
  if [ -f "${PROJECT_ROOT}/${f}" ]; then
    copy_file "${PROJECT_ROOT}/${f}" "${DIST_DIR}/${f}"
  fi
done

# Config examples and runtime config
for f in config.example.json config.schema.json custom_instructions.example.json .env.example \
         roles.json quota-presets.json; do
  if [ -f "${PROJECT_ROOT}/${f}" ]; then
    copy_file "${PROJECT_ROOT}/${f}" "${DIST_DIR}/${f}"
  fi
done

# Build/tooling config
for f in package.json tsconfig.json jest.config.js; do
  if [ -f "${PROJECT_ROOT}/${f}" ]; then
    copy_file "${PROJECT_ROOT}/${f}" "${DIST_DIR}/${f}"
  fi
done

# ---------------------------------------------------------------------------
# Generate a .gitignore for the distribution
# ---------------------------------------------------------------------------

log "Writing .gitignore ..."
if ! $DRY_RUN; then
  cat > "${DIST_DIR}/.gitignore" << 'GITIGNORE'
node_modules/
dist/
*.log
.env
.DS_Store

# Agent runtime artifacts
session_context.json
mailbox_state.json
config.json
workspace/
logs/
coverage/
debug/
tmp/
temp/

# Smoke test runtime artifacts
smoke_tests/**/temp/
smoke_tests/**/runtime_mailbox/
smoke_tests/**/origin.git/
smoke_tests/**/agent/src/
smoke_tests/**/agent/templates/
smoke_tests/**/agent/dist/
smoke_tests/**/agent/node_modules/
smoke_tests/**/agent/workspace/
smoke_tests/**/agent/logs/
smoke_tests/**/agent/package.json
smoke_tests/**/agent/package-lock.json
smoke_tests/**/agent/tsconfig.json
smoke_tests/**/agent/config.json
smoke_tests/**/agent/roles.json
smoke_tests/**/agent/.npmrc
smoke_tests/**/agent/.github/
smoke_tests/**/agent/jest.config.*
smoke_tests/**/agent/*.md
smoke_tests/**/agent/*.txt
smoke_tests/**/agent/*.sh
smoke_tests/**/agent/*.js
smoke_tests/**/agent/mailbox/
GITIGNORE
else
  echo "  WRITE .gitignore"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

if $DRY_RUN; then
  echo ""
  log "Dry run complete -- no files were written."
else
  echo ""
  log "Export complete."
  echo ""
  echo "Contents exported to: ${DIST_DIR}"
  echo ""
  echo "Next steps:"
  echo "  cd external_dist"
  echo "  git add -A"
  echo "  git status"
  echo "  git commit -m 'Update external distribution'"
  echo ""
fi
