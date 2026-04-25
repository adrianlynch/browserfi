# bundle-chromium

Per-context Chromium app bundles for macOS. Each bundle has its own bundle id,
display name, icon, and `--user-data-dir` profile, so AeroSpace (or any window
manager that routes by app id) can send each browser to its own workspace, and
each context gets independent cookies, extensions, localStorage, and restored
sessions.

## Why

A single Chromium app shares one bundle id, one profile, and one localStorage
namespace. That makes it impossible to:

- route different Chromium windows to different AeroSpace workspaces by app id,
- keep two dev servers on `localhost:4321` from stomping on each other's
  storage,
- have different signed-in sessions per project.

Duplicating the `.app` with a fresh bundle id and a wrapper that pins
`--user-data-dir` solves all three.

## Requirements

- macOS
- `/Applications/Chromium.app` (or set `SOURCE_APP` in `bundles.conf`)
- Built-in tools only: `codesign`, `PlistBuddy`, `sips`, `iconutil`,
  `lsregister`. No Homebrew dependencies.

## Quick start

1. Edit [bundles.conf](bundles.conf) — list the contexts you want. Each entry
   is `key|display_name|workspace`.
2. (Optional) Build icons for each key — see [Custom icons](#custom-icons).
3. Run `./make-bundles.sh`.

The script creates one `.app` per entry in `/Applications`, wires up its
profile under `~/ChromiumProfiles/<key>/`, and prints AeroSpace
`[[on-window-detected]]` snippets for any entries with a workspace set.

Re-running is safe: existing bundles are skipped (icons are still re-applied).
Pass `--force` to fully rebuild a bundle from scratch — profile data is
preserved either way.

## Custom icons

Drop a square PNG (1024×1024 ideal) or a pre-built `.icns` into `icons/`,
named after the bundle key:

```
icons/<key>.png
icons/<key>.icns
```

`make-bundles.sh` picks them up by convention, converts PNG → ICNS via
`sips` + `iconutil`, replaces `Contents/Resources/app.icns`, deletes the
`CFBundleIconName` key from `Info.plist` (so macOS reads `app.icns` instead of
the Chromium `Assets.car`), re-signs ad-hoc, and refreshes Launch Services so
the new icon appears immediately.

### Building from an SVG

`build-icon.sh` composes a macOS-style icon (squircle background, centered
glyph) from a source SVG:

```bash
./build-icon.sh <key> <svg-url-or-path>
```

Defaults to white glyph on a celeste (`#34CDD7`) squircle. Override with env
vars:

```bash
BG_COLOR='#FF6B6B' FG_COLOR='#FFFFFF' \
  ./build-icon.sh my-context https://example.com/icon.svg
```

The result is written to `icons/<key>.png`. Run `./make-bundles.sh` afterwards
to apply it to the bundle.

## AeroSpace integration

Each bundle is detectable by app id:

```toml
[[on-window-detected]]
if.app-id = 'com.adrian.chromium-<key>'
run = 'move-node-to-workspace <workspace>'
```

`make-bundles.sh` prints these snippets for every entry that has a workspace
set in `bundles.conf`. Paste them into `~/.aerospace.toml`.

## Project layout

```
bundles.conf      # bundle definitions and global defaults
make-bundles.sh   # creates / updates the .apps from bundles.conf
build-icon.sh     # builds a white-on-celeste squircle PNG from a source SVG
icons/            # per-bundle icon files (<key>.png or <key>.icns)
```

## Caveats

- **Code signing.** Bundles are re-signed ad-hoc, so they don't have full
  Gatekeeper trust. First launch may need **System Settings → Privacy &
  Security → Open Anyway** (the right-click → Open shortcut was removed in
  Sequoia). Subsequent launches are unrestricted.
- **Updates.** Chromium's auto-updater checks the original install path and
  won't propagate to duplicated bundles. Re-run `./make-bundles.sh --force`
  after updating Chromium itself.
