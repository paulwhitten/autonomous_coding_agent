#!/usr/bin/env bash
# Render all Mermaid .mmd files in diagrams/ to SVG and PNG.
#
# Usage: ./scripts/render-diagrams.sh
#
# Outputs are placed next to the .mmd source files:
#   diagrams/foo.mmd -> diagrams/foo.svg, diagrams/foo.png
#
# Applies a post-processing fix for Mermaid issue #6424 where
# foreignObject elements are sized too tightly, clipping the
# bottom line of text in many SVG renderers. The fix adds
# overflow="visible" as an XML attribute on every foreignObject.
#
# See: https://github.com/mermaid-js/mermaid/issues/6424
#
# Requires: npx (Node.js), sed

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DIAGRAMS_DIR="$ROOT_DIR/diagrams"
CONFIG="$DIAGRAMS_DIR/.mermaidrc.json"

if [[ ! -f "$CONFIG" ]]; then
    echo "Error: config not found at $CONFIG" >&2
    exit 1
fi

count=0
for src in "$DIAGRAMS_DIR"/*.mmd; do
    [[ -f "$src" ]] || continue
    name="$(basename "$src" .mmd)"

    # --- SVG ---
    svg="$DIAGRAMS_DIR/$name.svg"
    echo "Rendering $name.svg ..."
    npx -y @mermaid-js/mermaid-cli -i "$src" -o "$svg" -c "$CONFIG" 2>&1

    # Post-process: fix foreignObject clipping (mermaid#6424).
    # The SVG spec defaults foreignObject overflow to "hidden".
    # Mermaid computes foreignObject height ~3px too short per line,
    # so the last line of multi-line labels gets clipped. Adding
    # overflow="visible" lets the text paint outside the tight box.
    sed -i 's/<foreignObject /<foreignObject overflow="visible" /g' "$svg"

    # --- PNG ---
    png="$DIAGRAMS_DIR/$name.png"
    echo "Rendering $name.png ..."
    npx -y @mermaid-js/mermaid-cli -i "$src" -o "$png" -c "$CONFIG" -s 2 2>&1

    echo "  -> $svg, $png"
    count=$((count + 1))
done

echo "Done. Rendered $count diagram(s)."
