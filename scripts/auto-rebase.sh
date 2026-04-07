#!/usr/bin/env bash
#
# auto-rebase.sh -- Rebase with automatic resolution of additive conflicts
#
# Usage:  bash auto-rebase.sh [TARGET_BRANCH]
#         Default TARGET_BRANCH: origin/main
#
# Replaces the bare "git rebase origin/main" in the MERGING workflow state.
# Handles the common case where multiple tasks add additive declarations to
# shared index files (lib.rs, __init__.py, index.ts, etc.) -- conflicts that
# are purely additive and safe to auto-merge by keeping both sides.
#
# Supported languages / file types:
#   Rust        (.rs)         pub mod, pub use, #[cfg(...)], comments
#   TOML        (Cargo.toml)  [section], key = value, comments
#   Python      (__init__.py) from/import, __all__ entries, comments
#   TypeScript  (.ts, .tsx)   export/import, comments
#   JavaScript  (.js, .jsx, .mjs, .cjs)  export/import, require, comments
#   C/C++       (.h, .hpp)    #include, #pragma, extern, comments
#   Go          (.go)         import lines inside import blocks, comments
#   CMake       (CMakeLists.txt) add_subdirectory, add_library, comments
#
# Safety: only auto-resolves conflicts where EVERY line in both sides of
# the conflict is a safe additive pattern for that file type.
# Any non-trivial conflict aborts the rebase and exits non-zero.

set -uo pipefail

TARGET_BRANCH="${1:-origin/main}"
MAX_ITERATIONS=20

# ------------------------------------------------------------------
# validate_conflict_file -- check that ALL conflict regions in a file
# contain only safe additive lines.  Returns 0 if safe, 1 otherwise.
# ------------------------------------------------------------------
validate_conflict_file() {
    local file="$1"
    python3 - "$file" << 'PYEOF'
import sys, re, os

filepath = sys.argv[1]
basename = os.path.basename(filepath)

with open(filepath) as f:
    content = f.read()

# Extract all conflict blocks
pattern = r'<<<<<<<[^\n]*\n(.*?)=======\n(.*?)>>>>>>>[^\n]*\n'
conflicts = re.findall(pattern, content, re.DOTALL)

if not conflicts:
    print(f"  WARNING: no conflict markers found in {filepath}")
    sys.exit(1)

# ---- Language-specific safe patterns ----
# Each pattern matches a single line that is safe to keep from both sides.

SAFE_RS = re.compile(
    r'^\s*('
    r'(pub(\(crate\))?\s+)?mod\s+\w+\s*;'     # mod / pub mod / pub(crate) mod
    r'|(pub(\(crate\))?\s+)?use\s+.*;\s*'      # use / pub use (full paths incl ::*)
    r'|#\[cfg\([^\)]*\)\]'                      # #[cfg(...)]
    r'|//.*'                                     # comments (// //! ///)
    r'|/\*.*\*/\s*'                              # single-line block comments
    r')\s*$'
)

SAFE_TOML = re.compile(
    r'^\s*('
    r'\[[\w.\-"]*\]'                       # [section] or [section.sub]
    r'|[\w-]+\s*=.*'                       # key = value
    r'|"[^"]*"\s*,?\s*'                    # quoted strings in arrays
    r'|#.*'                                # comments
    r')?\s*$'
)

SAFE_PY = re.compile(
    r'^\s*('
    r'from\s+[\w.]+\s+import\s+.*'        # from x import y
    r'|import\s+[\w.]+'                    # import x
    r'|"[\w_]+"\s*,?\s*'                   # __all__ entries
    r"|'[\w_]+'\s*,?\s*"                   # __all__ entries (single quotes)
    r'|__all__\s*[+=]'                     # __all__ = [...] or +=
    r'|\]'                                 # closing bracket
    r'|\['                                 # opening bracket
    r'|#.*'                                # comments
    r')?\s*$'
)

SAFE_TS_JS = re.compile(
    r'^\s*('
    r'export\s+.*'                          # export statements (re-exports, named, default)
    r'|import\s+.*'                         # import statements
    r'|(const|let|var)\s+\w+\s*=\s*require\(.*\)' # require()
    r'|//.*'                                # single-line comments
    r'|/\*.*\*/\s*'                         # single-line block comments
    r'|}\s*;?\s*'                           # closing braces
    r')?\s*$'
)

SAFE_C_H = re.compile(
    r'^\s*('
    r'#\s*include\s+[<"].*[>"]'            # #include <x> or "x"
    r'|#\s*pragma\s+once'                  # #pragma once
    r'|#\s*ifndef\s+\w+'                   # include guards
    r'|#\s*define\s+\w+'                   # include guards
    r'|#\s*endif'                          # include guards
    r'|extern\s+"C"'                       # extern "C" declarations
    r'|//.*'                               # single-line comments
    r'|/\*.*\*/\s*'                        # single-line block comments
    r'|\*.*'                               # multi-line comment continuation
    r')?\s*$'
)

SAFE_GO = re.compile(
    r'^\s*('
    r'"[\w./-]+"'                          # import path
    r'|[\w]+\s+"[\w./-]+"'                 # aliased import
    r'|\.\s+"[\w./-]+"'                    # dot import
    r'|_\s+"[\w./-]+"'                     # blank import
    r'|//.*'                               # comments
    r'|\)'                                 # closing paren
    r'|\('                                 # opening paren
    r')?\s*$'
)

SAFE_CMAKE = re.compile(
    r'^\s*('
    r'add_subdirectory\s*\(.*\)'           # add_subdirectory(dir)
    r'|add_library\s*\(.*\)'              # add_library(target ...)
    r'|target_link_libraries\s*\(.*\)'    # target_link_libraries(...)
    r'|find_package\s*\(.*\)'             # find_package(...)
    r'|include\s*\(.*\)'                  # include(module)
    r'|set\s*\(.*\)'                      # set(VAR ...)
    r'|#.*'                               # comments
    r')?\s*$'
)

# ---- Map file extensions / names to patterns ----

def get_pattern(fpath):
    base = os.path.basename(fpath)

    # Exact name matches first
    if base == 'Cargo.toml':
        return SAFE_TOML, 'TOML'
    if base == '__init__.py':
        return SAFE_PY, 'Python'
    if base == 'CMakeLists.txt':
        return SAFE_CMAKE, 'CMake'

    # Extension-based matching
    ext = os.path.splitext(fpath)[1].lower()
    ext_map = {
        '.rs':   (SAFE_RS, 'Rust'),
        '.toml': (SAFE_TOML, 'TOML'),
        '.py':   (SAFE_PY, 'Python'),
        '.ts':   (SAFE_TS_JS, 'TypeScript'),
        '.tsx':  (SAFE_TS_JS, 'TypeScript'),
        '.js':   (SAFE_TS_JS, 'JavaScript'),
        '.jsx':  (SAFE_TS_JS, 'JavaScript'),
        '.mjs':  (SAFE_TS_JS, 'JavaScript'),
        '.cjs':  (SAFE_TS_JS, 'JavaScript'),
        '.h':    (SAFE_C_H, 'C/C++'),
        '.hpp':  (SAFE_C_H, 'C/C++'),
        '.go':   (SAFE_GO, 'Go'),
    }
    return ext_map.get(ext, (None, None))

pat, lang = get_pattern(filepath)

if pat is None:
    print(f"  UNSUPPORTED file type: {filepath}")
    sys.exit(1)

print(f"  Validating {filepath} as {lang}...")

for i, (ours, theirs) in enumerate(conflicts):
    for side_name, side in [("ours", ours), ("theirs", theirs)]:
        for line in side.rstrip('\n').split('\n'):
            stripped = line.strip()
            if not stripped:
                continue
            if not pat.match(stripped):
                print(f"  UNSAFE conflict {i+1} ({side_name}): {stripped}")
                sys.exit(1)

print(f"  All {len(conflicts)} conflict(s) in {filepath} are safe additive {lang} declarations")
sys.exit(0)
PYEOF
}

# ------------------------------------------------------------------
# resolve_file -- strip conflict markers, keeping both sides
# ------------------------------------------------------------------
resolve_file() {
    local file="$1"
    sed -i '/^<<<<<<< /d; /^=======/d; /^>>>>>>> /d' "$file"
    git add "$file"
    echo "  Resolved: $file (kept both sides)"
}

# ------------------------------------------------------------------
# Main
# ------------------------------------------------------------------
echo "auto-rebase: rebasing onto ${TARGET_BRANCH}..."

# Attempt normal rebase
if git rebase "$TARGET_BRANCH" 2>&1; then
    echo "auto-rebase: clean rebase -- no conflicts"
    exit 0
fi

echo "auto-rebase: conflicts detected -- attempting auto-resolution..."

iteration=0
while [ $iteration -lt $MAX_ITERATIONS ]; do
    iteration=$((iteration + 1))

    # Get conflicted files
    CONFLICTED=$(git diff --name-only --diff-filter=U 2>/dev/null || true)

    if [ -z "$CONFLICTED" ]; then
        echo "auto-rebase: no more conflicts"
        break
    fi

    echo "auto-rebase: iteration $iteration -- conflicts in: $CONFLICTED"

    for file in $CONFLICTED; do
        # Validate that all conflict regions are safe additive patterns
        # (validate_conflict_file rejects unsupported file types internally)
        if ! validate_conflict_file "$file"; then
            echo "auto-rebase: ERROR -- cannot auto-resolve: $file"
            git rebase --abort 2>/dev/null || true
            exit 1
        fi

        # Strip conflict markers, keep both sides
        resolve_file "$file"
    done

    # Continue the rebase (suppress editor for commit message)
    if GIT_EDITOR=true git rebase --continue 2>&1; then
        echo "auto-rebase: completed successfully after $iteration iteration(s)"
        exit 0
    fi

    echo "auto-rebase: more commits to replay, continuing..."
done

echo "auto-rebase: ERROR -- exceeded max iterations ($MAX_ITERATIONS)"
git rebase --abort 2>/dev/null || true
exit 1
