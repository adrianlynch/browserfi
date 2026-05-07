import { existsSync } from "node:fs";
import React, { useMemo, useState } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import type { BundleConfig, Config, LoadedConfig, ResolvedBundle } from "./cli.js";

const browserNames = ["chromium", "chrome", "chrome-canary", "brave", "edge", "firefox"];
const keyPattern = /^[A-Za-z0-9._-]+$/;

type TuiOptions = {
  configPath?: string;
  loadConfig: (configPath?: string) => LoadedConfig;
  resolveBundles: (config: Config, baseDir: string) => ResolvedBundle[];
  createOrUpdateBundle: (bundle: ResolvedBundle, force: boolean) => boolean;
  removeBundle: (bundle: ResolvedBundle, deleteProfile: boolean) => void;
  writeConfig: (configPath: string, config: Config) => void;
  aerospace: (options: { configPath?: string; aerospaceConfigPath?: string; write: boolean; reload: boolean }) => void;
};

type Mode =
  | { type: "table" }
  | { type: "edit"; key: string; values: EditValues; field: number }
  | { type: "confirm"; message: string; run: () => string };

type EditValues = {
  browser: string;
  key: string;
  displayName: string;
  workspace: string;
};

const fields: Array<{ key: keyof EditValues; label: string }> = [
  { key: "browser", label: "Browser" },
  { key: "key", label: "Key" },
  { key: "displayName", label: "Display name" },
  { key: "workspace", label: "AeroSpace workspace" },
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

  const bundles = useMemo(() => options.resolveBundles(loaded.config, loaded.baseDir), [loaded, options]);
  const selectedBundle = bundles[Math.min(selected, Math.max(0, bundles.length - 1))];

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
          setMode({ type: "table" });
        } else if (key.tab || key.return) {
          if (mode.field === fields.length - 1) {
            saveEdit(options, loaded, mode.key, mode.values);
            setMessage(`updated ${loaded.path}`);
            reload();
            setMode({ type: "table" });
          } else {
            setMode({ ...mode, field: mode.field + 1 });
          }
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
        setMode({ type: "edit", key: selectedBundle.key, values: editValues(selectedBundle), field: 0 });
      } else if (input === "b" && selectedBundle) {
        options.createOrUpdateBundle(selectedBundle, false);
        setMessage(`built ${selectedBundle.key}`);
        reload();
      } else if (input === "f" && selectedBundle) {
        options.createOrUpdateBundle(selectedBundle, true);
        setMessage(`rebuilt ${selectedBundle.key}`);
        reload();
      } else if (input === "d" && selectedBundle) {
        setMode(confirmDelete(options, loaded, selectedBundle, false));
      } else if (input === "D" && selectedBundle) {
        setMode(confirmDelete(options, loaded, selectedBundle, true));
      } else if (input === "x" && selectedBundle) {
        setMode(confirmRemoveConfig(options, loaded, selectedBundle.key));
      } else if (input === "B") {
        for (const bundle of bundles) options.createOrUpdateBundle(bundle, false);
        setMessage("built all bundles");
        reload();
      } else if (input === "w") {
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
        <Table bundles={bundles} selected={selected} />
      )}
      {mode.type === "confirm" && <Text color="yellow">{mode.message} y/n</Text>}
      {message && <Text color="cyan">{message}</Text>}
      <Footer mode={mode.type} />
    </Box>
  );
}

function Header({ configPath }: { configPath: string }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text bold>browserfi</Text>
        <Text color="gray">  {configPath}</Text>
      </Box>
      <Text color="gray">Manage per-context browser apps. Select a row, then use the shortcuts below.</Text>
    </Box>
  );
}

function Table({ bundles, selected }: { bundles: ResolvedBundle[]; selected: number }) {
  const { stdout } = useStdout();
  const widths = tableWidths(stdout.columns ?? 100);
  const selectedBundle = bundles[selected];
  return (
    <Box flexDirection="column">
      <Text color="gray">{row(["Stat", "Key", "Browser", "Workspace"], widths)}</Text>
      {bundles.map((bundle, index) => {
        const active = index === selected;
        const status = existsSync(bundle.appPath) ? "ok" : "miss";
        return (
          <Text key={bundle.key} inverse={active} color={status === "miss" ? "yellow" : undefined}>
            {row([status, bundle.key, bundle.browser, bundle.workspace ?? ""], widths)}
          </Text>
        );
      })}
      {bundles.length === 0 && <Text color="yellow">No bundles configured.</Text>}
      {selectedBundle && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray">Name: {selectedBundle.displayName}</Text>
          <Text color="gray">App: {selectedBundle.appName}</Text>
          <Text color="gray">Workspace: {selectedBundle.workspace ?? "-"}</Text>
          <Text color="gray">Profile: {selectedBundle.profileDir}</Text>
        </Box>
      )}
    </Box>
  );
}

function EditForm({ mode, setMode }: { mode: Extract<Mode, { type: "edit" }>; setMode: (mode: Mode) => void }) {
  const field = fields[mode.field];
  return (
    <Box flexDirection="column">
      <Text bold>Edit {mode.key}</Text>
      {fields.map((item, index) => (
        <Box key={item.key}>
          <Box width={22}>
            <Text color={index === mode.field ? "cyan" : undefined}>{item.label}</Text>
          </Box>
          {index === mode.field ? (
            <TextInput
              value={mode.values[item.key]}
              onChange={(value) => setMode({ ...mode, values: { ...mode.values, [field.key]: value } })}
            />
          ) : (
            <Text>{mode.values[item.key] || "-"}</Text>
          )}
        </Box>
      ))}
    </Box>
  );
}

function Footer({ mode }: { mode: Mode["type"] }) {
  if (mode === "edit") {
    return <Text color="gray">tab/enter next field • esc cancel • save on final field</Text>;
  }
  if (mode === "confirm") {
    return <Text color="gray">y confirm • n/esc cancel</Text>;
  }
  return <Text color="gray">↑/↓ select • enter/e edit • b build • f rebuild • d delete • D delete+profile • x remove config • B build all • w aerospace • q quit</Text>;
}

function row(values: string[], widths: number[]): string {
  return values.map((value, index) => fit(value, widths[index]).padEnd(widths[index])).join("  ").trimEnd();
}

function tableWidths(columns: number): number[] {
  const fixed = 4 + 2 + 28 + 2 + 8 + 2;
  const workspace = Math.max(26, columns - fixed);
  return [4, 28, 8, workspace];
}

function fit(value: string, width: number): string {
  return value.length <= width ? value : `${value.slice(0, Math.max(0, width - 1))}…`;
}

function editValues(bundle: ResolvedBundle): EditValues {
  return {
    browser: bundle.browser,
    key: bundle.key,
    displayName: bundle.displayName,
    workspace: bundle.workspace ?? "",
  };
}

function saveEdit(options: TuiOptions, loaded: LoadedConfig, originalKey: string, values: EditValues): void {
  const entry = loaded.config.bundles.find((bundle) => bundle.key === originalKey);
  if (!entry) throw new Error(`bundle not found: ${originalKey}`);

  const keyValidation = validateKey(values.key);
  if (keyValidation !== true) throw new Error(keyValidation);
  if (!browserNames.includes(values.browser)) throw new Error(`unsupported browser: ${values.browser}`);

  entry.browser = values.browser as BundleConfig["browser"];
  entry.key = values.key;
  entry.displayName = values.displayName || undefined;
  entry.workspace = values.workspace || undefined;
  options.writeConfig(loaded.path, loaded.config);
}

function validateKey(value: string): true | string {
  return keyPattern.test(value) ? true : "Use only letters, numbers, dots, underscores, and hyphens.";
}

function confirmDelete(options: TuiOptions, loaded: LoadedConfig, bundle: ResolvedBundle, deleteProfile: boolean): Mode {
  const target = deleteProfile ? "app, profile, and config row" : "app and config row";
  return {
    type: "confirm",
    message: `Delete ${target} for ${bundle.key}?`,
    run: () => {
      options.removeBundle(bundle, deleteProfile);
      removeConfigEntry(options, loaded, bundle.key);
      return `removed ${bundle.key}`;
    },
  };
}

function confirmRemoveConfig(options: TuiOptions, loaded: LoadedConfig, key: string): Mode {
  return {
    type: "confirm",
    message: `Remove ${key} from config only?`,
    run: () => {
      removeConfigEntry(options, loaded, key);
      return `removed ${key} from config`;
    },
  };
}

function removeConfigEntry(options: TuiOptions, loaded: LoadedConfig, key: string): void {
  const before = loaded.config.bundles.length;
  loaded.config.bundles = loaded.config.bundles.filter((bundle) => bundle.key !== key);
  if (loaded.config.bundles.length === before) throw new Error(`bundle not found in config: ${key}`);
  options.writeConfig(loaded.path, loaded.config);
}
