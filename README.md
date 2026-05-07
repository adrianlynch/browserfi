# browserfi

Per-context browser app bundles for macOS. Each generated `.app` gets its own
bundle id, display name, icon, and profile directory, so AeroSpace or any window
manager that routes by app id can send each browser context to its own
workspace.

## Why

A single browser app normally shares one bundle id, one profile, and one storage
namespace. That makes it hard to:

- route different browser windows to different AeroSpace workspaces by app id,
- keep multiple local dev servers from sharing localStorage and cookies,
- use different signed-in sessions per project.

browserfi duplicates the source browser `.app`, changes its metadata, installs a
small launcher wrapper that pins the profile path, applies a custom icon, and
re-signs the result ad-hoc.

## Requirements

- macOS
- Node.js 20+
- One or more supported browsers installed in `/Applications`
- Built-in macOS tools: `codesign`, `PlistBuddy`, `sips`, `iconutil`, `xattr`,
  and `lsregister`

Supported browser adapters:

- `chromium`
- `chrome`
- `chrome-canary`
- `brave`
- `edge`
- `firefox`

Safari is intentionally unsupported because it does not expose a clean
per-launch profile directory flag.

## Install

From npm, once published:

```bash
npm install -g browserfi
```

From source:

```bash
npm install
npm run build
./dist/cli.js help
```

Homebrew support should be packaged as a tap formula that installs the npm
package or a built release artifact. The intended command is:

```bash
brew install adrianlynch/tap/browserfi
```

## Quick Start

1. Edit [.browserfi.toml](.browserfi.toml).
2. Drop optional per-bundle icons into `icons/<key>.png` or `icons/<key>.icns`.
3. Run the interactive UI:

```bash
browserfi
```

Or build everything directly:

```bash
browserfi build
```

Re-running is safe: existing bundles are skipped, icons are still re-applied,
and changed bundles are re-signed. Pass `--force` to rebuild generated `.app`
bundles from scratch while preserving profile data:

```bash
browserfi build --force
```

The interactive UI shows a compact table with installed/missing status and a
detail panel for the selected bundle. Run `browserfi` with no command, or use
`browserfi tui`, to open it. Use arrow keys to select a row, then:

- `enter`/`e`: edit config values inline
- `a`: add new app
- `b`: build selected app
- `d`: delete app
- `w`: write AeroSpace rules
- `q`: quit

Deleting an app removes its generated `.app`, profile data, and config row
after confirmation.

The browser field is selected from supported browsers that are installed on the
machine. In the edit form, use `↑/↓` to move between fields and `enter` to open
browser/workspace selectors. Press `s` to save. New apps get a filesystem-safe
`key` generated from the display name; existing apps keep their current key when
renamed. The icon field accepts a `.svg`, `.png`, or `.icns` path or URL; leave
it blank to use the `icons/<key>.png|icns` convention. The icon color pickers
set `iconColor` and `iconBackgroundColor`, which customize SVG icons during
build. If AeroSpace config is found, Browserfi shows workspace fields and lets
you choose from existing AeroSpace workspace names. If AeroSpace is not found,
workspace fields and AeroSpace actions are hidden.

List configured bundles as a table:

```bash
browserfi list
```

Machine-readable and path-only output are also available:

```bash
browserfi list --wide
browserfi list --json
browserfi list --paths
```

Print AeroSpace rules:

```bash
browserfi aerospace
```

Write those rules into a managed block in your AeroSpace config:

```bash
browserfi aerospace --write
```

Create a starter config:

```bash
browserfi init
```

## Config

browserfi uses TOML because it is comfortable to edit by hand: comments are
allowed, values are not indentation-sensitive, and repeated `[[bundles]]`
sections read cleanly.

Config lookup order:

1. `./.browserfi.toml`
2. `./browserfi.toml`
3. `$XDG_CONFIG_HOME/browserfi/browserfi.toml`, or `~/.config/browserfi/browserfi.toml`
4. `~/.browserfi.toml`

```toml
installDir = "/Applications"
profilesDir = "~/ChromiumProfiles"
iconsDir = "./icons"

[[bundles]]
browser = "chromium"
key = "user-console-monorepo"
displayName = "User Console Monorepo"
workspace = "6_User_Console"
```

Each bundle supports:

- `browser`: one of the supported adapters; defaults to `chromium`
- `key`: stable identifier used for profiles and icons
- `id`: optional stable app identity; defaults to `key`
- `displayName`: Finder, Dock, and menu bar name; also used for the `.app` filename
- `icon`: optional `.svg`, `.png`, or `.icns` path or URL for this app
- `iconColor`: optional SVG tint color, as a 6-digit hex value like `#34CDD7`
- `iconBackgroundColor`: optional SVG background color, as a 6-digit hex value like `#111111`
- `workspace`: optional AeroSpace workspace for printed rules
- `sourceApp`: optional override for the source `.app`
- `installDir`, `profilesDir`, `iconsDir`: optional per-bundle path overrides
- `bundleIdPrefix`, `executableName`: advanced overrides

Keys and ids may contain only letters, numbers, dots, underscores, and hyphens.
Display names must not be empty or contain `/`.

Generated apps are written as `<displayName>.app`. Browserfi marks generated
bundles in `Info.plist` with ownership metadata. If a target app name already
exists, Browserfi only overwrites it when it is managed by the same config and
same bundle id. Apps from other Browserfi configs, or third-party apps such as
Google Chrome, are rejected until the existing app is deleted manually.

## Custom Icons

Set `icon` on a bundle to use a specific SVG, PNG, or ICNS file. Local paths and
`http(s)` URLs are supported:

```toml
[[bundles]]
browser = "chromium"
key = "user-console-monorepo"
displayName = "User Console Monorepo"
icon = "./icons/console.icns"
```

```toml
[[bundles]]
browser = "chromium"
key = "docs"
displayName = "Docs"
icon = "https://example.com/icon.svg"
iconColor = "#34CDD7"
iconBackgroundColor = "#111111"
```

If `icon` is not set, Browserfi looks for a square PNG, ideally `1024x1024`,
or a pre-built `.icns` in `icons/`, named after the bundle key:

```text
icons/<key>.png
icons/<key>.icns
```

`browserfi build` picks icons up by explicit path, URL, or convention. It
downloads URL icons during build, converts SVG and PNG files to ICNS, replaces
`Contents/Resources/app.icns`, deletes `CFBundleIconName` from `Info.plist`,
re-signs ad-hoc, and refreshes Launch Services.

SVG icons are normalized onto a `1024x1024` canvas before conversion. Browserfi
preserves the SVG `viewBox`, insets the artwork slightly so it does not touch
the macOS icon edges, optionally tints non-`none` fills and strokes with
`iconColor`, and optionally paints `iconBackgroundColor` behind the artwork.
PNG and ICNS icons are used as supplied.

The legacy helper [build-icon.sh](build-icon.sh) can still build a simple
macOS-style PNG from an SVG:

```bash
./build-icon.sh <key> <svg-url-or-path>
```

## AeroSpace

Each generated bundle is detectable by app id:

```toml
[[on-window-detected]]
if.app-id = "com.adrian.chromium-<id>"
run = "move-node-to-workspace <workspace>"
```

`browserfi aerospace` prints rules for every bundle with a `workspace` value.
`browserfi aerospace --write` updates a managed block in your AeroSpace config:

```toml
# BEGIN browserfi
[[on-window-detected]]
if.app-id = "com.adrian.chromium-user-console-monorepo"
run = "move-node-to-workspace 6_User_Console"
# END browserfi
```

By default, browserfi writes to whichever AeroSpace config exists:

1. `~/.aerospace.toml`
2. `$XDG_CONFIG_HOME/aerospace/aerospace.toml`, or `~/.config/aerospace/aerospace.toml`

If both exist, pass `--aerospace-config <path>` explicitly. Add `--reload` to run
`aerospace reload-config` after writing.

## Project Layout

```text
src/                    TypeScript CLI source
.browserfi.toml         Local bundle config
browserfi.example.toml  Starter config for browserfi init
icons/                  Per-bundle icon files
make-bundles.sh         Legacy Bash implementation
build-icon.sh           Legacy SVG-to-PNG icon helper
```

## Caveats

- Bundles are re-signed ad-hoc, so first launch may require System Settings ->
  Privacy & Security -> Open Anyway.
- Browser auto-updaters usually update the original app only. Re-run
  `browserfi build --force` after updating the source browser.
- Firefox support uses `-profile <dir> -no-remote`; Chromium-family browsers use
  `--user-data-dir=<dir>`.
