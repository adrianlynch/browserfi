#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, cpSync, renameSync, writeFileSync, chmodSync, utimesSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { runTui } from "./tui.js";

export type BrowserName = "chromium" | "chrome" | "chrome-canary" | "brave" | "edge" | "firefox";

export type BundleConfig = {
  id?: string;
  browser?: BrowserName;
  key: string;
  displayName?: string;
  workspace?: string;
  icon?: string;
  sourceApp?: string;
  installDir?: string;
  profilesDir?: string;
  iconsDir?: string;
  bundleIdPrefix?: string;
  appNamePrefix?: string;
  executableName?: string;
};

export type Config = {
  installDir?: string;
  profilesDir?: string;
  iconsDir?: string;
  bundles: BundleConfig[];
};

export type LoadedConfig = {
  path: string;
  config: Config;
  baseDir: string;
};

export type BrowserDefinition = {
  sourceApp: string;
  executableName: string;
  bundleIdPrefix: string;
  appNamePrefix: string;
  profileArgs: (profileDir: string) => string[];
};

export type ResolvedBundle = {
  id: string;
  configPath: string;
  browser: BrowserName;
  key: string;
  displayName: string;
  workspace?: string;
  icon?: string;
  iconPath?: string;
  sourceApp: string;
  appName: string;
  appPath: string;
  bundleId: string;
  profileDir: string;
  executableName: string;
  profileArgs: string[];
  iconsDir: string;
};

export type BuildProgress = {
  step: string;
  current: number;
  total: number;
};

type ListFormat = "table" | "wide" | "json" | "paths";
type BundleOperationOptions = { quiet?: boolean; onProgress?: (progress: BuildProgress) => void };

const DEFAULT_CONFIG = ".browserfi.toml";
const KEY_PATTERN = /^[A-Za-z0-9._-]+$/;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const AEROSPACE_BEGIN = "# BEGIN browserfi";
const AEROSPACE_END = "# END browserfi";
const BROWSERFI_MANAGED = "BrowserfiManaged";
const BROWSERFI_ID = "BrowserfiId";
const BROWSERFI_KEY = "BrowserfiKey";
const BROWSERFI_CONFIG_PATH = "BrowserfiConfigPath";
const BROWSERFI_ICON_PATH = "BrowserfiIconPath";

export const BROWSERS: Record<BrowserName, BrowserDefinition> = {
  chromium: {
    sourceApp: "/Applications/Chromium.app",
    executableName: "Chromium",
    bundleIdPrefix: "com.adrian.chromium",
    appNamePrefix: "chromium",
    profileArgs: (profileDir) => [`--user-data-dir=${profileDir}`],
  },
  chrome: {
    sourceApp: "/Applications/Google Chrome.app",
    executableName: "Google Chrome",
    bundleIdPrefix: "com.adrian.chrome",
    appNamePrefix: "chrome",
    profileArgs: (profileDir) => [`--user-data-dir=${profileDir}`],
  },
  "chrome-canary": {
    sourceApp: "/Applications/Google Chrome Canary.app",
    executableName: "Google Chrome Canary",
    bundleIdPrefix: "com.adrian.chrome-canary",
    appNamePrefix: "chrome-canary",
    profileArgs: (profileDir) => [`--user-data-dir=${profileDir}`],
  },
  brave: {
    sourceApp: "/Applications/Brave Browser.app",
    executableName: "Brave Browser",
    bundleIdPrefix: "com.adrian.brave",
    appNamePrefix: "brave",
    profileArgs: (profileDir) => [`--user-data-dir=${profileDir}`],
  },
  edge: {
    sourceApp: "/Applications/Microsoft Edge.app",
    executableName: "Microsoft Edge",
    bundleIdPrefix: "com.adrian.edge",
    appNamePrefix: "edge",
    profileArgs: (profileDir) => [`--user-data-dir=${profileDir}`],
  },
  firefox: {
    sourceApp: "/Applications/Firefox.app",
    executableName: "firefox",
    bundleIdPrefix: "com.adrian.firefox",
    appNamePrefix: "firefox",
    profileArgs: (profileDir) => ["-profile", profileDir, "-no-remote"],
  },
};

function main(): void {
  try {
    const args = process.argv.slice(2);
    const command = args[0] && !args[0].startsWith("-") ? args.shift() : undefined;

    if (!command) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        printHelp();
        process.exit(1);
      }
      void runTui({
        configPath: parseConfigPath(args),
        loadConfig,
        resolveBundles,
        bundleNeedsBuild,
        buildBundle,
        createOrUpdateBundle,
        removeBundle,
        writeConfig,
        aerospace,
      }).catch((error: unknown) => {
        console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      });
      return;
    }

    switch (command) {
      case "build":
        build(parseBuildArgs(args));
        break;
      case "list":
        list(parseListArgs(args));
        break;
      case "aerospace":
        aerospace(parseAerospaceArgs(args));
        break;
      case "tui":
        void runTui({
          configPath: parseConfigPath(args),
          loadConfig,
          resolveBundles,
          bundleNeedsBuild,
          buildBundle,
          createOrUpdateBundle,
          removeBundle,
          writeConfig,
          aerospace,
        }).catch((error: unknown) => {
          console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
          process.exit(1);
        });
        break;
      case "init":
        init(args);
        break;
      case "help":
      case "--help":
      case "-h":
        printHelp();
        break;
      case "version":
      case "--version":
      case "-v":
        printVersion();
        break;
      default:
        throw new Error(`unknown command: ${command}`);
    }
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

function parseBuildArgs(args: string[]): { configPath?: string; force: boolean } {
  let configPath: string | undefined;
  let force = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--force" || arg === "-f") {
      force = true;
    } else if (arg === "--config" || arg === "-c") {
      configPath = requireValue(args, index, arg);
      index += 1;
    } else {
      throw new Error(`unknown build argument: ${arg}`);
    }
  }

  return { configPath, force };
}

function parseConfigPath(args: string[]): string | undefined {
  let configPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--config" || arg === "-c") {
      configPath = requireValue(args, index, arg);
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return configPath;
}

function parseListArgs(args: string[]): { configPath?: string; format: ListFormat } {
  let configPath: string | undefined;
  let format: ListFormat = "table";

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--config" || arg === "-c") {
      configPath = requireValue(args, index, arg);
      index += 1;
    } else if (arg === "--json") {
      format = "json";
    } else if (arg === "--wide") {
      format = "wide";
    } else if (arg === "--paths") {
      format = "paths";
    } else {
      throw new Error(`unknown list argument: ${arg}`);
    }
  }

  return { configPath, format };
}

function parseAerospaceArgs(args: string[]): { configPath?: string; aerospaceConfigPath?: string; write: boolean; reload: boolean } {
  let configPath: string | undefined;
  let aerospaceConfigPath: string | undefined;
  let write = false;
  let reload = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--config" || arg === "-c") {
      configPath = requireValue(args, index, arg);
      index += 1;
    } else if (arg === "--aerospace-config") {
      aerospaceConfigPath = requireValue(args, index, arg);
      index += 1;
    } else if (arg === "--write" || arg === "-w") {
      write = true;
    } else if (arg === "--reload") {
      reload = true;
      write = true;
    } else {
      throw new Error(`unknown aerospace argument: ${arg}`);
    }
  }

  return { configPath, aerospaceConfigPath, write, reload };
}

function build(options: { configPath?: string; force: boolean }): void {
  requireMacos();
  const loaded = loadConfig(options.configPath);
  const bundles = resolveBundles(loaded.config, loaded.baseDir, loaded.path);
  const aerospaceSnippets: Array<{ bundleId: string; workspace: string }> = [];
  let iconsChanged = false;

  for (const bundle of bundles) {
    console.log(`==> ${bundle.appName}`);
    let changed = false;

    changed = createOrUpdateBundle(bundle, options.force);

    if (applyIcon(bundle)) {
      console.log(`    applied icon from ${relativePath(effectiveIconPath(bundle) ?? join(bundle.iconsDir, `${bundle.key}.*`))}`);
      iconsChanged = true;
      changed = true;
    }

    if (changed) {
      console.log("    stripping quarantine + extended attrs");
      run("xattr", ["-cr", bundle.appPath]);
      console.log("    re-signing ad-hoc");
      run("codesign", ["--force", "--deep", "--sign", "-", bundle.appPath]);
      touch(bundle.appPath);
      refreshLaunchServices(bundle.appPath);
    }

    mkdirSync(bundle.profileDir, { recursive: true });
    console.log(`    profile at ${bundle.profileDir}`);

    if (bundle.workspace) aerospaceSnippets.push({ bundleId: bundle.bundleId, workspace: bundle.workspace });
  }

  printAerospaceSnippets(aerospaceSnippets);

  if (iconsChanged) {
    console.log("Icons updated. Refreshing Dock and Finder so the new icons appear...");
    run("killall", ["Dock"], { ignoreFailure: true });
    run("killall", ["Finder"], { ignoreFailure: true });
  }
}

function list(options: { configPath?: string; format: ListFormat }): void {
  const loaded = loadConfig(options.configPath);
  const bundles = resolveBundles(loaded.config, loaded.baseDir, loaded.path);

  if (options.format === "json") {
    console.log(JSON.stringify(bundles.map(toListItem), null, 2));
  } else if (options.format === "paths") {
    console.log(bundles.map((bundle) => bundle.appPath).join("\n"));
  } else if (options.format === "wide") {
    printWideTable(bundles);
  } else {
    printTable(bundles);
  }
}

function aerospace(options: { configPath?: string; aerospaceConfigPath?: string; write: boolean; reload: boolean }): void {
  const loaded = loadConfig(options.configPath);
  const bundles = resolveBundles(loaded.config, loaded.baseDir, loaded.path);
  const rules = aerospaceRules(bundles);

  if (!options.write) {
    process.stdout.write(rules);
    return;
  }

  const aerospaceConfigPath = findAerospaceConfigPath(options.aerospaceConfigPath);
  const current = existsSync(aerospaceConfigPath) ? readFileSync(aerospaceConfigPath, "utf8") : "";
  const next = replaceManagedBlock(current, rules);
  writeFileSync(aerospaceConfigPath, next);
  console.log(`updated ${aerospaceConfigPath}`);

  if (options.reload) {
    run("aerospace", ["reload-config"]);
  }
}

function toListItem(bundle: ResolvedBundle): Record<string, string | undefined> {
  return {
    id: bundle.id,
    key: bundle.key,
    browser: bundle.browser,
    displayName: bundle.displayName,
    icon: bundle.icon,
    iconPath: bundle.iconPath,
    appPath: bundle.appPath,
    profileDir: bundle.profileDir,
    bundleId: bundle.bundleId,
    workspace: bundle.workspace,
  };
}

function printTable(bundles: ResolvedBundle[]): void {
  const rows = bundles.map((bundle) => [
    bundle.key,
    bundle.browser,
    bundle.displayName,
    bundle.workspace ?? "",
    bundle.appName,
  ]);
  const headers = ["Key", "Browser", "Name", "Workspace", "App"];
  printRows(headers, rows);
}

function printWideTable(bundles: ResolvedBundle[]): void {
  const rows = bundles.map((bundle) => [
    bundle.id,
    bundle.key,
    bundle.browser,
    bundle.displayName,
    bundle.icon ?? "",
    bundle.workspace ?? "",
    bundle.bundleId,
    bundle.appPath,
    bundle.profileDir,
  ]);
  const headers = ["ID", "Key", "Browser", "Name", "Icon", "Workspace", "Bundle ID", "App Path", "Profile Path"];
  printRows(headers, rows);
}

function printRows(headers: string[], rows: string[][]): void {
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => row[index].length)));
  const formatRow = (row: string[]) => row.map((cell, index) => cell.padEnd(widths[index])).join("  ").trimEnd();

  console.log(formatRow(headers));
  console.log(formatRow(widths.map((width) => "-".repeat(width))));
  for (const row of rows) {
    console.log(formatRow(row));
  }
}

function init(args: string[]): void {
  const configPath = parseConfigPath(args) ?? DEFAULT_CONFIG;
  const dest = resolvePath(configPath, process.cwd());
  if (existsSync(dest)) {
    throw new Error(`${dest} already exists`);
  }
  const examplePath = resolve(SCRIPT_DIR, "../browserfi.example.toml");
  if (dest.endsWith(".json")) {
    writeFileSync(dest, `${JSON.stringify(EXAMPLE_CONFIG, null, 2)}\n`);
  } else {
    cpSync(examplePath, dest);
  }
  console.log(`wrote ${dest}`);
}

function readConfig(configPath: string): Config {
  if (!existsSync(configPath)) {
    throw new Error(`config not found at ${configPath}`);
  }
  const raw = readFileSync(configPath, "utf8");
  const config = configPath.endsWith(".json") ? JSON.parse(raw) as Config : parseToml(raw) as unknown as Config;
  if (!Array.isArray(config.bundles)) {
    throw new Error("config must contain a bundles array");
  }
  return config;
}

export function loadConfig(configPathArg?: string): LoadedConfig {
  const configPath = findConfigPath(configPathArg);
  return {
    path: configPath,
    config: readConfig(configPath),
    baseDir: dirname(configPath),
  };
}

export function writeConfig(configPath: string, config: Config): void {
  if (configPath.endsWith(".json")) {
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  } else {
    writeFileSync(configPath, stringifyToml(config));
  }
}

function findConfigPath(configPath?: string): string {
  if (configPath) {
    return resolvePath(configPath, process.cwd());
  }

  const candidates = configCandidates();
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found) {
    return found;
  }

  throw new Error(`config not found. Looked in: ${candidates.join(", ")}`);
}

function configCandidates(): string[] {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME ? resolvePath(process.env.XDG_CONFIG_HOME, process.cwd()) : join(homedir(), ".config");
  return [
    resolve(process.cwd(), ".browserfi.toml"),
    resolve(process.cwd(), "browserfi.toml"),
    join(xdgConfigHome, "browserfi/browserfi.toml"),
    join(homedir(), ".browserfi.toml"),
  ];
}

export function resolveBundles(config: Config, baseDir: string, configPath = ""): ResolvedBundle[] {
  return config.bundles.map((entry) => resolveBundle(config, entry, baseDir, configPath));
}

function resolveBundle(config: Config, entry: BundleConfig, baseDir: string, configPath: string): ResolvedBundle {
  const browserName = entry.browser ?? "chromium";
  const browser = BROWSERS[browserName];
  if (!browser) {
    throw new Error(`unsupported browser: ${browserName}`);
  }
  if (!entry.key || !KEY_PATTERN.test(entry.key)) {
    throw new Error(`invalid bundle key "${entry.key}". Use only letters, numbers, dots, underscores, and hyphens.`);
  }
  const id = entry.id ?? entry.key;
  if (!KEY_PATTERN.test(id)) {
    throw new Error(`invalid bundle id "${id}". Use only letters, numbers, dots, underscores, and hyphens.`);
  }

  const installDir = resolvePath(entry.installDir ?? config.installDir ?? "/Applications", baseDir);
  const profilesDir = resolvePath(entry.profilesDir ?? config.profilesDir ?? "~/BrowserProfiles", baseDir);
  const iconsDir = resolvePath(entry.iconsDir ?? config.iconsDir ?? "./icons", baseDir);
  const sourceApp = resolvePath(entry.sourceApp ?? browser.sourceApp, baseDir);
  const bundleIdPrefix = entry.bundleIdPrefix ?? browser.bundleIdPrefix;
  const executableName = entry.executableName ?? browser.executableName;
  const displayName = entry.displayName ?? `${titleCase(browserName)} ${entry.key}`;
  const appName = appNameFromDisplayName(displayName);
  const profileDir = join(profilesDir, entry.key);
  const iconPath = entry.icon ? resolvePath(entry.icon, baseDir) : undefined;

  if (!existsSync(sourceApp)) {
    throw new Error(`source app not found at ${sourceApp}`);
  }
  if (iconPath && !existsSync(iconPath)) {
    throw new Error(`icon not found at ${iconPath}`);
  }

  return {
    id,
    configPath,
    browser: browserName,
    key: entry.key,
    displayName,
    workspace: entry.workspace,
    icon: entry.icon,
    iconPath,
    sourceApp,
    appName,
    appPath: join(installDir, `${appName}.app`),
    bundleId: `${bundleIdPrefix}-${id}`,
    profileDir,
    executableName,
    profileArgs: browser.profileArgs(profileDir),
    iconsDir,
  };
}

function configureBundle(bundle: ResolvedBundle, options: BundleOperationOptions = {}): void {
  log(options, "    setting bundle id and display name");
  const plist = join(bundle.appPath, "Contents/Info.plist");
  plistSetString(plist, "CFBundleIdentifier", bundle.bundleId);
  plistSetString(plist, "CFBundleName", bundle.displayName);
  plistSetString(plist, "CFBundleDisplayName", bundle.displayName);
  plistSetString(plist, BROWSERFI_MANAGED, "true");
  plistSetString(plist, BROWSERFI_ID, bundle.id);
  plistSetString(plist, BROWSERFI_KEY, bundle.key);
  plistSetString(plist, BROWSERFI_CONFIG_PATH, bundle.configPath);
  plistSetString(plist, BROWSERFI_ICON_PATH, effectiveIconPath(bundle) ?? "");
  plistBuddy(["Delete", ":CFBundleIconName"], plist, { ignoreFailure: true });

  const executableDir = join(bundle.appPath, "Contents/MacOS");
  const executablePath = join(executableDir, bundle.executableName);
  const realExecutablePath = `${executablePath}-real`;
  if (!existsSync(realExecutablePath)) {
    renameSync(executablePath, realExecutablePath);
  }
  writeFileSync(executablePath, wrapperScript(bundle), { mode: 0o755 });
  chmodSync(executablePath, 0o755);
}

export function createOrUpdateBundle(bundle: ResolvedBundle, force: boolean, options: BundleOperationOptions = {}): boolean {
  let changed = false;
  assertCanUseAppPath(bundle);
  removePreviousManagedApps(bundle, options);

  if (existsSync(bundle.appPath) && (force || bundleNeedsBuild(bundle))) {
    log(options, "    removing existing bundle");
    rmSync(bundle.appPath, { recursive: true, force: true });
  }

  if (!existsSync(bundle.appPath)) {
    log(options, `    copying ${bundle.sourceApp} -> ${bundle.appPath}`);
    copyAppBundle(bundle.sourceApp, bundle.appPath);
    configureBundle(bundle, options);
    changed = true;
  } else {
    log(options, "    bundle exists (use --force to rebuild)");
  }

  return changed;
}

export async function buildBundle(bundle: ResolvedBundle, force: boolean, options: BundleOperationOptions = {}): Promise<boolean> {
  const total = 7;
  let changed = false;

  await reportProgress(options, "Preparing", 1, total);
  assertCanUseAppPath(bundle);
  removePreviousManagedApps(bundle, options);

  if (existsSync(bundle.appPath) && (force || bundleNeedsBuild(bundle))) {
    log(options, "    removing existing bundle");
    rmSync(bundle.appPath, { recursive: true, force: true });
  }

  await reportProgress(options, "Copying app", 2, total);
  if (!existsSync(bundle.appPath)) {
    log(options, `    copying ${bundle.sourceApp} -> ${bundle.appPath}`);
    copyAppBundle(bundle.sourceApp, bundle.appPath);
    changed = true;
  } else {
    log(options, "    bundle exists (use --force to rebuild)");
  }

  await reportProgress(options, "Configuring bundle", 3, total);
  if (changed || bundleNeedsBuild(bundle)) {
    configureBundle(bundle, options);
    changed = true;
  }

  await reportProgress(options, "Applying icon", 4, total);
  if (applyIcon(bundle)) {
    log(options, `    applied icon from ${relativePath(effectiveIconPath(bundle) ?? join(bundle.iconsDir, `${bundle.key}.*`))}`);
    changed = true;
  }

  await reportProgress(options, "Updating attributes", 5, total);
  if (changed) {
    run("xattr", ["-cr", bundle.appPath]);
  }

  await reportProgress(options, "Signing", 6, total);
  if (changed) {
    run("codesign", ["--force", "--deep", "--sign", "-", bundle.appPath]);
    touch(bundle.appPath);
    refreshLaunchServices(bundle.appPath);
  }

  await reportProgress(options, "Creating profile", 7, total);
  mkdirSync(bundle.profileDir, { recursive: true });
  log(options, `    profile at ${bundle.profileDir}`);

  return changed;
}

async function reportProgress(options: BundleOperationOptions, step: string, current: number, total: number): Promise<void> {
  options.onProgress?.({ step, current, total });
  await new Promise((resolve) => setTimeout(resolve, 0));
}

export function bundleNeedsBuild(bundle: ResolvedBundle): boolean {
  if (!existsSync(bundle.appPath)) return true;

  const plist = join(bundle.appPath, "Contents/Info.plist");
  if (plistReadString(plist, BROWSERFI_MANAGED) !== "true") return true;
  if (plistReadString(plist, BROWSERFI_ID) !== bundle.id) return true;
  if (plistReadString(plist, BROWSERFI_CONFIG_PATH) !== bundle.configPath) return true;
  if (plistReadString(plist, BROWSERFI_ICON_PATH) !== (effectiveIconPath(bundle) ?? "")) return true;
  if (plistReadString(plist, "CFBundleIdentifier") !== bundle.bundleId) return true;
  if (plistReadString(plist, "CFBundleName") !== bundle.displayName) return true;
  if (plistReadString(plist, "CFBundleDisplayName") !== bundle.displayName) return true;

  const executablePath = join(bundle.appPath, "Contents/MacOS", bundle.executableName);
  const realExecutablePath = `${executablePath}-real`;
  if (!existsSync(realExecutablePath)) return true;

  try {
    return readFileSync(executablePath, "utf8") !== wrapperScript(bundle);
  } catch {
    return true;
  }
}

function assertCanUseAppPath(bundle: ResolvedBundle): void {
  if (!existsSync(bundle.appPath)) return;
  const owner = readBrowserfiOwner(bundle.appPath);
  if (!owner) {
    throw new Error(`App already exists and is not managed by Browserfi: ${bundle.appPath}`);
  }
  if (owner.configPath !== bundle.configPath || owner.id !== bundle.id) {
    throw new Error(`Browserfi app already exists, delete the existing app first: ${bundle.appPath}`);
  }
}

function removePreviousManagedApps(bundle: ResolvedBundle, options: BundleOperationOptions): void {
  for (const appPath of findManagedApps(bundle)) {
    if (appPath === bundle.appPath) continue;
    log(options, `    removing previous bundle ${appPath}`);
    rmSync(appPath, { recursive: true, force: true });
  }
}

function copyAppBundle(sourceApp: string, appPath: string): void {
  run("/bin/cp", ["-R", sourceApp, appPath]);
}

export function removeBundle(bundle: ResolvedBundle, deleteProfile: boolean, options: BundleOperationOptions = {}): void {
  const appPaths = new Set([bundle.appPath, ...findManagedApps(bundle)]);
  let removedApp = false;
  for (const appPath of appPaths) {
    if (!existsSync(appPath)) continue;
    rmSync(appPath, { recursive: true, force: true });
    log(options, `removed ${appPath}`);
    removedApp = true;
  }
  if (!removedApp) {
    log(options, `app not found at ${bundle.appPath}`);
  }

  if (deleteProfile) {
    if (existsSync(bundle.profileDir)) {
      rmSync(bundle.profileDir, { recursive: true, force: true });
      log(options, `removed ${bundle.profileDir}`);
    } else {
      log(options, `profile not found at ${bundle.profileDir}`);
    }
  }
}

function log(options: BundleOperationOptions, message: string): void {
  if (!options.quiet) console.log(message);
}

type BrowserfiOwner = {
  id?: string;
  configPath?: string;
};

function readBrowserfiOwner(appPath: string): BrowserfiOwner | undefined {
  const plist = join(appPath, "Contents/Info.plist");
  if (plistReadString(plist, BROWSERFI_MANAGED) !== "true") return undefined;
  return {
    id: plistReadString(plist, BROWSERFI_ID),
    configPath: plistReadString(plist, BROWSERFI_CONFIG_PATH),
  };
}

function findManagedApps(bundle: ResolvedBundle): string[] {
  const installDir = dirname(bundle.appPath);
  if (!existsSync(installDir)) return [];
  return readdirSync(installDir)
    .filter((name) => name.endsWith(".app"))
    .map((name) => join(installDir, name))
    .filter((appPath) => {
      const owner = readBrowserfiOwner(appPath);
      return owner?.id === bundle.id && owner.configPath === bundle.configPath;
    });
}

function wrapperScript(bundle: ResolvedBundle): string {
  const args = bundle.profileArgs.map(shellQuote).join(" ");
  return `#!/bin/bash\nexec "$(dirname "$0")/${bundle.executableName}-real" ${args} "$@"\n`;
}

function applyIcon(bundle: ResolvedBundle): boolean {
  const iconPath = effectiveIconPath(bundle);
  if (!iconPath) return false;

  const dest = join(bundle.appPath, "Contents/Resources/app.icns");

  const lowerIconPath = iconPath.toLowerCase();

  if (lowerIconPath.endsWith(".icns")) {
    cpSync(iconPath, dest);
    return true;
  }

  if (lowerIconPath.endsWith(".png")) {
    pngToIcns(iconPath, dest);
    return true;
  }

  throw new Error(`unsupported icon type: ${iconPath}. Use .png or .icns.`);
}

function effectiveIconPath(bundle: ResolvedBundle): string | undefined {
  if (bundle.iconPath) return bundle.iconPath;

  const icns = join(bundle.iconsDir, `${bundle.key}.icns`);
  if (existsSync(icns)) return icns;

  const png = join(bundle.iconsDir, `${bundle.key}.png`);
  if (existsSync(png)) return png;

  return undefined;
}

function pngToIcns(src: string, dest: string): void {
  const work = mkdtempSync(join(tmpdir(), "browserfi-"));
  const iconset = join(work, "icon.iconset");
  mkdirSync(iconset);

  try {
    const sizes: Array<[number, string]> = [
      [16, "icon_16x16.png"],
      [32, "icon_16x16@2x.png"],
      [32, "icon_32x32.png"],
      [64, "icon_32x32@2x.png"],
      [128, "icon_128x128.png"],
      [256, "icon_128x128@2x.png"],
      [256, "icon_256x256.png"],
      [512, "icon_256x256@2x.png"],
      [512, "icon_512x512.png"],
      [1024, "icon_512x512@2x.png"],
    ];

    for (const [size, filename] of sizes) {
      run("sips", ["-z", String(size), String(size), src, "--out", join(iconset, filename)], { quiet: true });
    }

    run("iconutil", ["-c", "icns", iconset, "-o", dest]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function plistBuddy(command: string[], plist: string, options: { ignoreFailure?: boolean; quiet?: boolean } = {}): void {
  run("/usr/libexec/PlistBuddy", ["-c", command.join(" "), plist], options);
}

function plistSetString(plist: string, key: string, value: string): void {
  const quotedValue = plistQuote(value);
  try {
    plistBuddy(["Set", `:${key}`, quotedValue], plist, { quiet: true });
  } catch {
    plistBuddy(["Add", `:${key}`, "string", quotedValue], plist);
  }
}

function plistReadString(plist: string, key: string): string | undefined {
  try {
    return execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

function plistQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function refreshLaunchServices(appPath: string): void {
  const lsregister = "/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister";
  run(lsregister, ["-u", appPath], { ignoreFailure: true, quiet: true });
  run(lsregister, ["-f", appPath], { ignoreFailure: true, quiet: true });
}

function printAerospaceSnippets(snippets: Array<{ bundleId: string; workspace: string }>): void {
  if (snippets.length === 0) {
    return;
  }

  console.log("");
  console.log("AeroSpace rules (paste into ~/.aerospace.toml):");
  console.log("");
  process.stdout.write(formatAerospaceRules(snippets));
}

function aerospaceRules(bundles: ResolvedBundle[]): string {
  return formatAerospaceRules(
    bundles
      .filter((bundle): bundle is ResolvedBundle & { workspace: string } => Boolean(bundle.workspace))
      .map((bundle) => ({ bundleId: bundle.bundleId, workspace: bundle.workspace })),
  );
}

function formatAerospaceRules(snippets: Array<{ bundleId: string; workspace: string }>): string {
  return snippets
    .map((snippet) => [
      "[[on-window-detected]]",
      `if.app-id = ${tomlString(snippet.bundleId)}`,
      `run = ${tomlString(`move-node-to-workspace ${snippet.workspace}`)}`,
      "",
    ].join("\n"))
    .join("\n");
}

function findAerospaceConfigPath(configPath?: string): string {
  if (configPath) return resolvePath(configPath, process.cwd());

  const candidates = aerospaceConfigCandidates();
  const existing = candidates.filter((candidate) => existsSync(candidate));
  if (existing.length > 1) {
    throw new Error(`multiple AeroSpace configs found. Pass --aerospace-config explicitly: ${existing.join(", ")}`);
  }
  if (existing.length === 1) {
    return existing[0];
  }
  return candidates[0];
}

function aerospaceConfigCandidates(): string[] {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME ? resolvePath(process.env.XDG_CONFIG_HOME, process.cwd()) : join(homedir(), ".config");
  return [
    join(homedir(), ".aerospace.toml"),
    join(xdgConfigHome, "aerospace/aerospace.toml"),
  ];
}

function replaceManagedBlock(content: string, rules: string): string {
  const block = `${AEROSPACE_BEGIN}\n${rules.trimEnd()}\n${AEROSPACE_END}`;
  const pattern = new RegExp(`${escapeRegExp(AEROSPACE_BEGIN)}[\\s\\S]*?${escapeRegExp(AEROSPACE_END)}`);

  if (pattern.test(content)) {
    return ensureTrailingNewline(content.replace(pattern, block));
  }

  const separator = content.trim().length > 0 ? "\n\n" : "";
  return ensureTrailingNewline(`${content.trimEnd()}${separator}${block}`);
}

function run(command: string, args: string[], options: { ignoreFailure?: boolean; quiet?: boolean } = {}): void {
  try {
    execFileSync(command, args, { stdio: options.quiet ? "ignore" : "inherit" });
  } catch (error) {
    if (!options.ignoreFailure) {
      throw error;
    }
  }
}

function resolvePath(value: string, baseDir: string): string {
  const expanded = value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
  return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
}

function relativePath(value: string): string {
  const cwd = process.cwd();
  return value.startsWith(cwd) ? value.slice(cwd.length + 1) : value;
}

function shellQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$").replaceAll("`", "\\`")}"`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function validateKey(value: string): true | string {
  return KEY_PATTERN.test(value) ? true : "Use only letters, numbers, dots, underscores, and hyphens.";
}

function titleCase(value: string): string {
  return value
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function appNameFromDisplayName(displayName: string): string {
  const appName = displayName.trim();
  if (!appName) {
    throw new Error("displayName must not be empty");
  }
  if (appName.includes("/")) {
    throw new Error("displayName must not contain /");
  }
  return appName.endsWith(".app") ? appName.slice(0, -4) : appName;
}

function touch(path: string): void {
  const now = new Date();
  utimesSync(path, now, now);
}

function requireMacos(): void {
  if (process.platform !== "darwin") {
    throw new Error("browserfi only supports macOS");
  }
}

function printHelp(): void {
  console.log(`browserfi

Usage:
  browserfi
  browserfi tui [--config .browserfi.toml]
  browserfi build [--force] [--config .browserfi.toml]
  browserfi list [--wide|--json|--paths] [--config .browserfi.toml]
  browserfi aerospace [--write] [--reload] [--config .browserfi.toml]
  browserfi init [--config .browserfi.toml]
  browserfi help

Commands:
  tui     Open the interactive terminal UI.
  build   Create or update browser app bundles.
  list    Print resolved bundle paths, ids, and profiles.
  aerospace Print or write AeroSpace on-window-detected rules.
  init    Write an example config.

Config lookup:
  ./.browserfi.toml
  ./browserfi.toml
  ~/.config/browserfi/browserfi.toml
  ~/.browserfi.toml

Supported browsers:
  ${Object.keys(BROWSERS).join(", ")}
`);
}

function printVersion(): void {
  const packagePath = resolve(SCRIPT_DIR, "../package.json");
  const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: string };
  console.log(pkg.version ?? "0.0.0");
}

const EXAMPLE_CONFIG: Config = {
  installDir: "/Applications",
  profilesDir: "~/BrowserProfiles",
  iconsDir: "./icons",
  bundles: [
    {
      browser: "chromium",
      key: "my-project",
      displayName: "My Project",
      workspace: "4_Project",
    },
    {
      browser: "chrome",
      key: "work",
      displayName: "Chrome Work",
      workspace: "5_Work",
    },
    {
      browser: "firefox",
      key: "docs",
      displayName: "Firefox Docs",
      workspace: "6_Docs",
    },
  ],
};

main();
