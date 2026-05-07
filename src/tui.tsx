import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import React, { useMemo, useState } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import { parse as parseToml } from "smol-toml";
import type { BundleConfig, Config, LoadedConfig, ResolvedBundle } from "./cli.js";

const browserNames = ["chromium", "chrome", "chrome-canary", "brave", "edge", "firefox"];
const keyPattern = /^[A-Za-z0-9._-]+$/;

type TuiOptions = {
  configPath?: string;
  loadConfig: (configPath?: string) => LoadedConfig;
  resolveBundles: (config: Config, baseDir: string) => ResolvedBundle[];
  createOrUpdateBundle: (bundle: ResolvedBundle, force: boolean, options?: { quiet?: boolean }) => boolean;
  removeBundle: (bundle: ResolvedBundle, deleteProfile: boolean, options?: { quiet?: boolean }) => void;
  writeConfig: (configPath: string, config: Config) => void;
  aerospace: (options: { configPath?: string; aerospaceConfigPath?: string; write: boolean; reload: boolean }) => void;
};

type AerospaceInfo = {
  configPath?: string;
  workspaces: string[];
};

type Mode =
  | { type: "table" }
  | {
      type: "edit";
      originalKey?: string;
      initialValues: EditValues;
      values: EditValues;
      field: number;
      fields: EditField[];
      browserOptions: string[];
      workspaceOptions: string[];
      picker?: "browser" | "workspace";
    }
  | { type: "confirm"; message: string; run: () => string };

type EditValues = {
  browser: string;
  key: string;
  displayName: string;
  workspace: string;
};

type EditField = { key: keyof EditValues; label: string };

const baseFields: EditField[] = [
  { key: "browser", label: "Browser" },
  { key: "key", label: "Key" },
  { key: "displayName", label: "Display name" },
];

export function runTui(options: TuiOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const instance = render(<BrowserfiTui options={options} onDone={resolve} onError={reject} />);
    instance.waitUntilExit().then(() => resolve(), reject);
  });
}

function BrowserfiTui({ options, onDone, onError }: { options: TuiOptions; onDone: () => void; onError: (error: unknown) => void }) {
  const { exit } = useApp();
  const [loaded, setLoaded] = useState(() => options.loadConfig(options.configPath));
  const [selected, setSelected] = useState(0);
  const [mode, setMode] = useState<Mode>({ type: "table" });
  const [message, setMessage] = useState("");
  const [aerospaceInfo] = useState(loadAerospaceInfo);

  const bundles = useMemo(() => options.resolveBundles(loaded.config, loaded.baseDir), [loaded, options]);
  const selectedBundle = bundles[Math.min(selected, Math.max(0, bundles.length - 1))];
  const fields = editFields(aerospaceInfo);
  const browserOptions = installedBrowsers(loaded.config.bundles);
  const needsBuild = mode.type === "table" && selectedBundle ? !existsSync(selectedBundle.appPath) : false;
  const needsSave = mode.type === "edit" && editNeedsSave(mode);

  const reload = () => setLoaded(options.loadConfig(loaded.path));
  const done = () => {
    exit();
    onDone();
  };
  const handleError = (error: unknown) => {
    setMessage(error instanceof Error ? error.message : String(error));
    onError(error);
  };

  useInput((input, key) => {
    try {
      if (mode.type === "confirm") {
        if (input.toLowerCase() === "y") {
          setMessage(mode.run());
          reload();
          setMode({ type: "table" });
        } else if (input.toLowerCase() === "n" || key.escape) {
          setMode({ type: "table" });
        }
        return;
      }

      if (mode.type === "edit") {
        if (key.escape) {
          setMode(mode.picker ? { ...mode, picker: undefined } : { type: "table" });
        } else if (mode.picker === "browser" && (key.upArrow || key.downArrow || input === "j" || input === "k")) {
          const direction = key.upArrow || input === "k" ? -1 : 1;
          setMode({ ...mode, values: { ...mode.values, browser: nextOption(mode.browserOptions, mode.values.browser, direction) } });
        } else if (mode.picker === "workspace" && (key.upArrow || key.downArrow || input === "j" || input === "k")) {
          const direction = key.upArrow || input === "k" ? -1 : 1;
          setMode({ ...mode, values: { ...mode.values, workspace: nextOption(aerospaceInfo.workspaces, mode.values.workspace, direction) } });
        } else if (mode.picker && key.return) {
          setMode({ ...mode, picker: undefined });
        } else if (key.upArrow || input === "k") {
          setMode({ ...mode, field: Math.max(0, mode.field - 1), picker: undefined });
        } else if (key.downArrow || input === "j") {
          setMode({ ...mode, field: Math.min(mode.fields.length - 1, mode.field + 1), picker: undefined });
        } else if (key.return && mode.fields[mode.field]?.key === "browser") {
          setMode({ ...mode, picker: "browser" });
        } else if (key.return && mode.fields[mode.field]?.key === "workspace") {
          setMode({ ...mode, picker: "workspace" });
        } else if (input === "s") {
          saveEdit(options, loaded, mode.originalKey, mode.values, mode.workspaceOptions);
          setMessage(`updated ${loaded.path}`);
          reload();
          setMode({ type: "table" });
        }
        return;
      }

      if (input === "q") {
        done();
      } else if (key.upArrow || input === "k") {
        setSelected((value: number) => Math.max(0, value - 1));
      } else if (key.downArrow || input === "j") {
        setSelected((value: number) => Math.min(bundles.length - 1, value + 1));
      } else if ((input === "e" || key.return) && selectedBundle) {
        const values = editValues(selectedBundle, aerospaceInfo);
        setMode({ type: "edit", originalKey: selectedBundle.key, initialValues: values, values, field: 0, fields, browserOptions: browserOptionsForEdit(browserOptions, selectedBundle.browser), workspaceOptions: aerospaceInfo.workspaces });
      } else if (input === "a") {
        const values = newAppValues(loaded.config, aerospaceInfo, browserOptions);
        setMode({ type: "edit", initialValues: values, values, field: 0, fields, browserOptions, workspaceOptions: aerospaceInfo.workspaces });
      } else if (input === "b" && selectedBundle) {
        options.createOrUpdateBundle(selectedBundle, true, { quiet: true });
        setMessage(`built ${selectedBundle.key}`);
        reload();
      } else if (input === "d" && selectedBundle) {
        setMode(confirmDeleteApp(options, loaded, selectedBundle));
      } else if (input === "w" && aerospaceInfo.configPath) {
        options.aerospace({ configPath: loaded.path, write: true, reload: false });
        setMessage("updated AeroSpace config");
      }
    } catch (error) {
      handleError(error);
    }
  });

  return (
    <Box flexDirection="column">
      <Header configPath={loaded.path} />
      {mode.type === "edit" ? (
        <EditForm mode={mode} setMode={setMode} />
      ) : (
        <Table bundles={bundles} selected={selected} showWorkspace={Boolean(aerospaceInfo.configPath)} />
      )}
      {mode.type === "confirm" && <Text color="yellow">{mode.message} y/n</Text>}
      {message && <Text color="cyan">{message}</Text>}
      <Footer mode={mode.type} hasAerospace={Boolean(aerospaceInfo.configPath)} needsSave={needsSave} needsBuild={needsBuild} />
    </Box>
  );
}

function Header({ configPath }: { configPath: string }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text bold color="magenta">Browserfi</Text>
        <Text> - create and manage custom bundled browsers</Text>
      </Text>
      <Text color="gray">Config: {configPath}</Text>
    </Box>
  );
}

function Table({ bundles, selected, showWorkspace }: { bundles: ResolvedBundle[]; selected: number; showWorkspace: boolean }) {
  const { stdout } = useStdout();
  const widths = tableWidths(stdout.columns ?? 100, showWorkspace);
  const selectedBundle = bundles[selected];
  return (
    <Box flexDirection="column">
      <Text color="gray">{tableBorder("top", widths)}</Text>
      <Text color="gray">{tableRow(showWorkspace ? ["Status", "Name", "Key", "Browser", "Workspace"] : ["Status", "Name", "Key", "Browser"], widths)}</Text>
      <Text color="gray">{tableBorder("middle", widths)}</Text>
      {bundles.map((bundle, index) => {
        const active = index === selected;
        const status = existsSync(bundle.appPath) ? "ok" : "build";
        return (
          <Text key={bundle.key} inverse={active} color={status === "build" ? "yellow" : undefined}>
            {tableRow(showWorkspace ? [status, bundle.displayName, bundle.key, bundle.browser, bundle.workspace ?? ""] : [status, bundle.displayName, bundle.key, bundle.browser], widths)}
          </Text>
        );
      })}
      <Text color="gray">{tableBorder("bottom", widths)}</Text>
      {bundles.length === 0 && <Text color="yellow">No bundles configured.</Text>}
      {selectedBundle && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray">Name: {selectedBundle.displayName}</Text>
          <Text color="gray">App: {selectedBundle.appName}</Text>
          {showWorkspace && <Text color="gray">Workspace: {selectedBundle.workspace ?? "-"}</Text>}
          <Text color="gray">Profile: {selectedBundle.profileDir}</Text>
        </Box>
      )}
    </Box>
  );
}

function EditForm({ mode, setMode }: { mode: Extract<Mode, { type: "edit" }>; setMode: (mode: Mode) => void }) {
  const field = mode.fields[mode.field];
  return (
    <Box flexDirection="column">
      <Text bold>{mode.originalKey ? `Edit ${mode.originalKey}` : "Add new app"}</Text>
      {mode.fields.map((item, index) => (
        <Box key={item.key}>
          <Box width={22}>
            <Text color={index === mode.field ? "cyan" : undefined}>{item.label}</Text>
          </Box>
          {index === mode.field && item.key !== "workspace" && item.key !== "browser" ? (
            <TextInput
              value={mode.values[item.key]}
              onChange={(value) => setMode({ ...mode, values: { ...mode.values, [field.key]: value } })}
            />
          ) : index === mode.field && item.key === "browser" ? (
            <Text color="cyan">{mode.values.browser || "-"} {mode.picker === "browser" ? "" : "(enter to choose)"}</Text>
          ) : index === mode.field && item.key === "workspace" ? (
            <Text color="cyan">{mode.values.workspace || "-"} {mode.picker === "workspace" ? "" : "(enter to choose)"}</Text>
          ) : (
            <Text>{mode.values[item.key] || "-"}</Text>
          )}
        </Box>
      ))}
      {mode.picker === "workspace" && (
        <Box flexDirection="column" marginTop={1}>
          {mode.workspaceOptions.map((workspace) => (
            <Text key={workspace} color={workspace === mode.values.workspace ? "cyan" : "gray"}>
              {workspace === mode.values.workspace ? "› " : "  "}
              {workspace}
            </Text>
          ))}
        </Box>
      )}
      {mode.picker === "browser" && (
        <Box flexDirection="column" marginTop={1}>
          {mode.browserOptions.map((browser) => (
            <Text key={browser} color={browser === mode.values.browser ? "cyan" : "gray"}>
              {browser === mode.values.browser ? "› " : "  "}
              {browser}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}

function Footer({ mode, hasAerospace, needsSave, needsBuild }: { mode: Mode["type"]; hasAerospace?: boolean; needsSave?: boolean; needsBuild?: boolean }) {
  const { stdout } = useStdout();
  const rule = "─".repeat(Math.max(20, stdout.columns ?? 80));
  if (mode === "edit") {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color="gray">{rule}</Text>
        <Text color="gray">
          {hasAerospace ? "↑/↓ move fields • enter choose browser/workspace • " : "↑/↓ move fields • enter choose browser • "}
          <Text bold={needsSave} color={needsSave ? "green" : "gray"}>s save</Text>
          {" • esc cancel"}
        </Text>
      </Box>
    );
  }
  if (mode === "confirm") {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color="gray">{rule}</Text>
        <Text color="gray">y confirm • n/esc cancel</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="gray">{rule}</Text>
      <Text color="gray">
        {"↑/↓ select • a add app • enter/e edit • "}
        <Text bold={needsBuild} color={needsBuild ? "#FFA500" : "gray"}>b build</Text>
        {hasAerospace ? " • d delete app • w aerospace • q quit" : " • d delete app • q quit"}
      </Text>
    </Box>
  );
}

function tableRow(values: string[], widths: number[]): string {
  return `│ ${values.map((value, index) => fit(value, widths[index]).padEnd(widths[index])).join(" │ ")} │`;
}

function tableBorder(position: "top" | "middle" | "bottom", widths: number[]): string {
  const chars = {
    top: ["┌", "┬", "┐"],
    middle: ["├", "┼", "┤"],
    bottom: ["└", "┴", "┘"],
  }[position];
  return `${chars[0]}${widths.map((width) => "─".repeat(width + 2)).join(chars[1])}${chars[2]}`;
}

function tableWidths(columns: number, showWorkspace: boolean): number[] {
  const usableColumns = Math.max(40, columns - 2);
  const base = showWorkspace ? [6, 16, 18, 8, 12] : [6, 22, 26, 8];
  const tableOverhead = 3 * base.length + 1;
  let remaining = Math.max(0, usableColumns - tableOverhead - sum(base));
  const flexible = showWorkspace ? [1, 2, 4] : [1, 2];
  while (remaining > 0) {
    for (const index of flexible) {
      if (remaining === 0) break;
      base[index] += 1;
      remaining -= 1;
    }
  }
  return base;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function editNeedsSave(mode: Extract<Mode, { type: "edit" }>): boolean {
  if (!mode.originalKey) return true;
  return mode.fields.some((field) => mode.values[field.key] !== mode.initialValues[field.key]);
}

function fit(value: string, width: number): string {
  return value.length <= width ? value : `${value.slice(0, Math.max(0, width - 1))}…`;
}

function editFields(aerospaceInfo: AerospaceInfo): EditField[] {
  return aerospaceInfo.configPath ? [...baseFields, { key: "workspace", label: "AeroSpace workspace" }] : baseFields;
}

function editValues(bundle: ResolvedBundle, aerospaceInfo: AerospaceInfo): EditValues {
  return {
    browser: bundle.browser,
    key: bundle.key,
    displayName: bundle.displayName,
    workspace: bundle.workspace ?? aerospaceInfo.workspaces[0] ?? "",
  };
}

function newAppValues(config: Config, aerospaceInfo: AerospaceInfo, browserOptions: string[]): EditValues {
  const base = "new-app";
  let key = base;
  let count = 2;
  while (config.bundles.some((bundle) => bundle.key === key)) {
    key = `${base}-${count}`;
    count += 1;
  }
  return {
    browser: browserOptions[0] ?? "chromium",
    key,
    displayName: "New App",
    workspace: aerospaceInfo.workspaces[0] ?? "",
  };
}

function saveEdit(options: TuiOptions, loaded: LoadedConfig, originalKey: string | undefined, values: EditValues, workspaceOptions: string[]): void {
  const keyValidation = validateKey(values.key);
  if (keyValidation !== true) throw new Error(keyValidation);
  if (!browserNames.includes(values.browser)) throw new Error(`unsupported browser: ${values.browser}`);
  if (workspaceOptions.length > 0 && !workspaceOptions.includes(values.workspace)) throw new Error(`unknown AeroSpace workspace: ${values.workspace}`);
  const duplicate = loaded.config.bundles.some((bundle) => bundle.key === values.key && bundle.key !== originalKey);
  if (duplicate) throw new Error(`bundle already exists: ${values.key}`);

  const next: BundleConfig = {
    browser: values.browser as BundleConfig["browser"],
    key: values.key,
    displayName: values.displayName || undefined,
    workspace: values.workspace || undefined,
  };

  if (originalKey) {
    const index = loaded.config.bundles.findIndex((bundle) => bundle.key === originalKey);
    if (index === -1) throw new Error(`bundle not found: ${originalKey}`);
    loaded.config.bundles[index] = { ...loaded.config.bundles[index], ...next };
  } else {
    loaded.config.bundles.push(next);
  }

  options.writeConfig(loaded.path, loaded.config);
}

function installedBrowsers(entries: BundleConfig[]): string[] {
  const configured = new Map<string, string | undefined>(entries.map((entry) => [entry.browser ?? "chromium", entry.sourceApp]));
  return browserNames.filter((browser) => existsSync(configured.get(browser) ?? defaultSourceApp(browser)));
}

function browserOptionsForEdit(options: string[], current: string): string[] {
  return options.includes(current) ? options : [current, ...options];
}

function defaultSourceApp(browser: string): string {
  return {
    chromium: "/Applications/Chromium.app",
    chrome: "/Applications/Google Chrome.app",
    "chrome-canary": "/Applications/Google Chrome Canary.app",
    brave: "/Applications/Brave Browser.app",
    edge: "/Applications/Microsoft Edge.app",
    firefox: "/Applications/Firefox.app",
  }[browser] ?? "";
}

function validateKey(value: string): true | string {
  return keyPattern.test(value) ? true : "Use only letters, numbers, dots, underscores, and hyphens.";
}

function confirmDeleteApp(options: TuiOptions, loaded: LoadedConfig, bundle: ResolvedBundle): Mode {
  return {
    type: "confirm",
    message: `Delete ${bundle.key}? This removes the app, profile data, and config row.`,
    run: () => {
      options.removeBundle(bundle, true, { quiet: true });
      removeConfigEntry(options, loaded, bundle.key);
      return `removed ${bundle.key}`;
    },
  };
}

function removeConfigEntry(options: TuiOptions, loaded: LoadedConfig, key: string): void {
  const before = loaded.config.bundles.length;
  loaded.config.bundles = loaded.config.bundles.filter((bundle) => bundle.key !== key);
  if (loaded.config.bundles.length === before) throw new Error(`bundle not found in config: ${key}`);
  options.writeConfig(loaded.path, loaded.config);
}

function loadAerospaceInfo(): AerospaceInfo {
  const configPath = aerospaceConfigCandidates().find((candidate) => existsSync(candidate));
  if (!configPath) return { workspaces: [] };

  const raw = readFileSync(configPath, "utf8");
  const parsed = parseToml(raw) as Record<string, unknown>;
  const workspaces = new Set<string>();
  const persistent = parsed["persistent-workspaces"];
  if (Array.isArray(persistent)) {
    for (const workspace of persistent) {
      if (typeof workspace === "string") workspaces.add(workspace);
    }
  }

  const monitorAssignments = parsed["workspace-to-monitor-force-assignment"];
  if (monitorAssignments && typeof monitorAssignments === "object" && !Array.isArray(monitorAssignments)) {
    for (const workspace of Object.keys(monitorAssignments)) workspaces.add(workspace);
  }

  for (const match of raw.matchAll(/\b(?:workspace|move-node-to-workspace)\s+(?:--wrap-around\s+)?([A-Za-z0-9_.:-]+)/g)) {
    const workspace = match[1];
    if (workspace !== "prev" && workspace !== "next") workspaces.add(workspace);
  }

  return { configPath, workspaces: [...workspaces].sort(workspaceSort) };
}

function aerospaceConfigCandidates(): string[] {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return [
    join(homedir(), ".aerospace.toml"),
    join(xdgConfigHome, "aerospace/aerospace.toml"),
  ];
}

function nextOption(options: string[], current: string, direction: number): string {
  if (options.length === 0) return "";
  const index = Math.max(0, options.indexOf(current));
  return options[(index + direction + options.length) % options.length];
}

function workspaceSort(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}
