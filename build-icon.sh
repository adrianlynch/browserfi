#!/usr/bin/env bash
# build-icon.sh <key> <svg-url-or-path>
# Build icons/<key>.png — a 1024×1024 macOS-style icon with the source SVG
# glyph in white centered on a celeste squircle.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ICONS_DIR="${SCRIPT_DIR}/icons"
mkdir -p "$ICONS_DIR"

# --- visual params (env-overridable) -----------------------------------------
CANVAS=1024
SQUIRCLE_INSET="${SQUIRCLE_INSET:-100}"   # margin from canvas edge to squircle
SQUIRCLE_RADIUS="${SQUIRCLE_RADIUS:-185}" # corner radius
GLYPH_SIZE="${GLYPH_SIZE:-560}"           # glyph bounding box
BG_COLOR="${BG_COLOR:-#34CDD7}"           # squircle fill (celeste)
FG_COLOR="${FG_COLOR:-#FFFFFF}"           # glyph fill (white)

usage() {
  cat <<USAGE
Usage: $(basename "$0") <key> <svg-url-or-path>

Env overrides: BG_COLOR FG_COLOR GLYPH_SIZE SQUIRCLE_INSET SQUIRCLE_RADIUS
USAGE
}

[[ $# -eq 2 ]] || { usage; exit 2; }
KEY="$1"
SRC="$2"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
src_svg="${work}/src.svg"

if [[ "$SRC" =~ ^https?:// ]]; then
  curl -fsS "$SRC" -o "$src_svg"
else
  cp "$SRC" "$src_svg"
fi

# Parse viewBox (expects "0 0 W H")
vb=$(sed -n 's/.*viewBox="\([^"]*\)".*/\1/p' "$src_svg" | head -1)
[[ -n "$vb" ]] || { echo "error: no viewBox found in source SVG" >&2; exit 1; }
read -r _ _ vb_w vb_h <<< "$vb"

# Inner content = everything between the outer <svg ...> and </svg>, with
# fill attributes stripped so the wrapper <g fill="..."> takes effect.
inner=$(sed -e '1d' -e '$d' "$src_svg" | sed -E 's/ fill="[^"]*"//g')

# Scale the glyph to fit GLYPH_SIZE while preserving aspect.
read -r glyph_scale glyph_tx glyph_ty <<< "$(awk -v vb_w="$vb_w" -v vb_h="$vb_h" \
  -v glyph="$GLYPH_SIZE" -v canvas="$CANVAS" 'BEGIN {
    s = (vb_w > vb_h) ? glyph / vb_w : glyph / vb_h
    drawn_w = vb_w * s
    drawn_h = vb_h * s
    printf "%.6f %.3f %.3f", s, (canvas - drawn_w) / 2, (canvas - drawn_h) / 2
  }')"

bg_size=$((CANVAS - 2 * SQUIRCLE_INSET))
out_svg="${work}/out.svg"
cat > "$out_svg" <<SVG
<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">
  <rect x="${SQUIRCLE_INSET}" y="${SQUIRCLE_INSET}" width="${bg_size}" height="${bg_size}" rx="${SQUIRCLE_RADIUS}" ry="${SQUIRCLE_RADIUS}" fill="${BG_COLOR}"/>
  <g transform="translate(${glyph_tx}, ${glyph_ty}) scale(${glyph_scale})" fill="${FG_COLOR}" fill-rule="evenodd">
${inner}
  </g>
</svg>
SVG

dest="${ICONS_DIR}/${KEY}.png"
sips -s format png "$out_svg" --out "$dest" >/dev/null
echo "wrote ${dest}"
