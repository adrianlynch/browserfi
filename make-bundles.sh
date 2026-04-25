#!/usr/bin/env bash
# make-bundles.sh — create per-context Chromium bundles defined in bundles.conf
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${SCRIPT_DIR}/bundles.conf"
ICONS_DIR="${SCRIPT_DIR}/icons"

FORCE=0
for arg in "$@"; do
  case "$arg" in
    -f|--force) FORCE=1 ;;
    -h|--help)
      cat <<USAGE
Usage: $(basename "$0") [--force]

Reads ${CONFIG_FILE} and creates one Chromium bundle per entry.
Pass --force to recreate bundles that already exist (profile data is
preserved — only the .app is rebuilt).

Custom icons:
  Drop <key>.png (square, ideally 1024×1024) or <key>.icns in
  ${ICONS_DIR}/
  Icons are applied on every run, even for bundles that already exist.
USAGE
      exit 0
      ;;
    *)
      echo "error: unknown argument '$arg'" >&2
      exit 2
      ;;
  esac
done

[[ -f "$CONFIG_FILE" ]] || { echo "error: config not found at $CONFIG_FILE" >&2; exit 1; }
# shellcheck source=bundles.conf
source "$CONFIG_FILE"

[[ -d "$SOURCE_APP" ]] || { echo "error: SOURCE_APP not found at $SOURCE_APP" >&2; exit 1; }

mkdir -p "$PROFILES_DIR"

# Convert a PNG → ICNS by generating the standard iconset and running iconutil.
png_to_icns() {
  local src="$1" dest="$2"
  local work iconset
  work="$(mktemp -d)"
  iconset="${work}/icon.iconset"
  mkdir -p "$iconset"
  sips -z 16 16     "$src" --out "${iconset}/icon_16x16.png"      >/dev/null
  sips -z 32 32     "$src" --out "${iconset}/icon_16x16@2x.png"   >/dev/null
  sips -z 32 32     "$src" --out "${iconset}/icon_32x32.png"      >/dev/null
  sips -z 64 64     "$src" --out "${iconset}/icon_32x32@2x.png"   >/dev/null
  sips -z 128 128   "$src" --out "${iconset}/icon_128x128.png"    >/dev/null
  sips -z 256 256   "$src" --out "${iconset}/icon_128x128@2x.png" >/dev/null
  sips -z 256 256   "$src" --out "${iconset}/icon_256x256.png"    >/dev/null
  sips -z 512 512   "$src" --out "${iconset}/icon_256x256@2x.png" >/dev/null
  sips -z 512 512   "$src" --out "${iconset}/icon_512x512.png"    >/dev/null
  sips -z 1024 1024 "$src" --out "${iconset}/icon_512x512@2x.png" >/dev/null
  iconutil -c icns "$iconset" -o "$dest"
  rm -rf "$work"
}

# Apply icons/<key>.{icns,png} to the bundle if present. Returns 0 if applied.
apply_icon() {
  local key="$1" app_path="$2"
  local dest="${app_path}/Contents/Resources/app.icns"
  if [[ -f "${ICONS_DIR}/${key}.icns" ]]; then
    cp "${ICONS_DIR}/${key}.icns" "$dest"
    return 0
  fi
  if [[ -f "${ICONS_DIR}/${key}.png" ]]; then
    png_to_icns "${ICONS_DIR}/${key}.png" "$dest"
    return 0
  fi
  return 1
}

aerospace_snippets=()
icons_changed=0

for entry in "${BUNDLES[@]}"; do
  IFS='|' read -r key display workspace <<< "$entry"
  key="${key// /}"
  [[ -n "$key" ]] || { echo "warn: skipping empty entry" >&2; continue; }
  display="${display:-Chromium ${key}}"

  app_name="${APP_NAME_PREFIX}-${key}"
  app_path="${INSTALL_DIR}/${app_name}.app"
  bundle_id="${BUNDLE_ID_PREFIX}-${key}"
  profile_dir="${PROFILES_DIR}/${key}"

  echo "==> ${app_name}"
  built=0

  if [[ -d "$app_path" ]]; then
    if (( FORCE )); then
      echo "    removing existing bundle"
      rm -rf "$app_path"
    fi
  fi

  if [[ ! -d "$app_path" ]]; then
    echo "    copying $SOURCE_APP -> $app_path"
    cp -R "$SOURCE_APP" "$app_path"

    echo "    setting bundle id and display name"
    /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier ${bundle_id}" "${app_path}/Contents/Info.plist"
    /usr/libexec/PlistBuddy -c "Set :CFBundleName ${display}"        "${app_path}/Contents/Info.plist"
    /usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName ${display}" "${app_path}/Contents/Info.plist"

    # Drop CFBundleIconName so macOS uses CFBundleIconFile (app.icns) instead of
    # the AppIcon entry baked into Assets.car — otherwise our app.icns is ignored.
    /usr/libexec/PlistBuddy -c "Delete :CFBundleIconName" "${app_path}/Contents/Info.plist" 2>/dev/null || true

    exe_dir="${app_path}/Contents/MacOS"
    orig_bin="${exe_dir}/Chromium"
    [[ -f "${orig_bin}-real" ]] || mv "$orig_bin" "${orig_bin}-real"

    cat > "$orig_bin" <<EOF
#!/bin/bash
exec "\$(dirname "\$0")/Chromium-real" --user-data-dir="${profile_dir}" "\$@"
EOF
    chmod +x "$orig_bin"
    built=1
  else
    echo "    bundle exists (use --force to rebuild)"
  fi

  if apply_icon "$key" "$app_path"; then
    echo "    applied icon from icons/${key}.*"
    icons_changed=1
    built=1   # icon swap requires re-sign + xattr cleanup
  fi

  if (( built )); then
    echo "    stripping quarantine + extended attrs"
    xattr -cr "$app_path"
    echo "    re-signing ad-hoc"
    codesign --force --deep --sign - "$app_path"
    touch "$app_path"

    # Force Launch Services to forget the cached icon for this bundle id.
    LSREG=/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister
    "$LSREG" -u "$app_path" 2>/dev/null || true
    "$LSREG" -f "$app_path" 2>/dev/null || true
  fi

  mkdir -p "$profile_dir"
  echo "    profile at $profile_dir"

  [[ -n "${workspace:-}" ]] && aerospace_snippets+=("${bundle_id}|${workspace}")
done

if (( ${#aerospace_snippets[@]} > 0 )); then
  echo
  echo "AeroSpace rules (paste into ~/.aerospace.toml):"
  echo
  for snippet in "${aerospace_snippets[@]}"; do
    IFS='|' read -r bid ws <<< "$snippet"
    cat <<TOML
[[on-window-detected]]
if.app-id = '${bid}'
run = 'move-node-to-workspace ${ws}'

TOML
  done
fi

if (( icons_changed )); then
  echo "Icons updated. Refreshing Dock and Finder so the new icons appear..."
  killall Dock 2>/dev/null || true
  killall Finder 2>/dev/null || true
fi
