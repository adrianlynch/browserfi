import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, render, useApp, useInput, useWindowSize } from "ink";
import TextInput from "ink-text-input";
import { parse as parseToml } from "smol-toml";
import type { BuildProgress, BundleConfig, Config, LoadedConfig, ResolvedBundle } from "./cli.js";

const browserNames = ["chromium", "chrome", "chrome-canary", "brave", "edge", "firefox"];
const spinnerFrames = ["*", "+", "-", "+"];
const iconColors = [
  "",
  "#EF4444",
  "#F97316",
  "#F59E0B",
  "#EAB308",
  "#22C55E",
  "#14B8A6",
  "#06B6D4",
  "#3B82F6",
  "#6366F1",
  "#8B5CF6",
  "#EC4899",
  "#34CDD7",
  "#FFB000",
  "#FF5C8A",
  "#7C5CFF",
  "#2ECC71",
  "#64748B",
  "#CBD5E1",
  "#F8FAFC",
  "#FFFFFF",
  "#111111",
];
const REDRAW_INTERVAL_MS = 2000;
const SELECTED_ROW_BACKGROUND_LIGHT = "#FFEAF3";
const SELECTED_ROW_BACKGROUND_DARK = "#5A2438";
const TABLE_PADDING_X = 2;
const EDIT_PADDING_X = 2;
const EDIT_LABEL_WIDTH = 22;
const LABEL_COLOR = "#777777";
const ICON_PLACEHOLDER = "- url to svg, png or jpg -";
const COLOR_PICKER_LABEL_WIDTH = 12;
const COLOR_PREVIEW_SIZE = 3;
const COLOR_PREVIEW_WIDTH = COLOR_PREVIEW_SIZE * 2;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_VERSION = readPackageVersion();

type TuiOptions = {
  configPath?: string;
  loadConfig: (configPath?: string) => LoadedConfig;
  resolveBundles: (config: Config, baseDir: string, configPath?: string) => ResolvedBundle[];
  bundleNeedsBuild: (bundle: ResolvedBundle) => boolean;
  buildBundle: (bundle: ResolvedBundle, force: boolean, options?: { quiet?: boolean; onProgress?: (progress: BuildProgress) => void }) => Promise<boolean>;
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
      picker?: "browser" | "workspace" | "iconColor" | "iconBackgroundColor";
    }
  | { type: "confirm"; message: string; run: () => string };

type EditValues = {
  browser: string;
  key: string;
  displayName: string;
  icon: string;
  iconColor: string;
  iconBackgroundColor: string;
  iconInset: boolean;
  workspace: string;
};

type EditField = { key: keyof EditValues; label: string };

type TuiTheme = {
  isDark: boolean;
  selectedRowBackground: string;
  detailValueColor: string;
};

const baseFields: EditField[] = [
  { key: "browser", label: "browser" },
  { key: "displayName", label: "display name" },
  { key: "icon", label: "icon" },
  { key: "iconColor", label: "icon color" },
  { key: "iconBackgroundColor", label: "icon background" },
  { key: "iconInset", label: "indent icon" },
];

export function runTui(options: TuiOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    let clear: () => void = () => undefined;
    if (process.stdout.isTTY) {
      process.stdout.write("\u001b[2J\u001b[3J\u001b[H");
    }
    const instance = render(<BrowserfiTui options={options} onDone={resolve} onError={reject} onRefresh={() => clear()} />);
    clear = instance.clear;
    instance.waitUntilExit().then(() => resolve(), reject);
  });
}

function BrowserfiTui({ options, onDone, onError, onRefresh }: { options: TuiOptions; onDone: () => void; onError: (error: unknown) => void; onRefresh: () => void }) {
  const { exit } = useApp();
  const [loaded, setLoaded] = useState(() => options.loadConfig(options.configPath));
  const [selected, setSelected] = useState(0);
  const [mode, setMode] = useState<Mode>({ type: "table" });
  const [message, setMessage] = useState("");
  const [buildProgress, setBuildProgress] = useState<(BuildProgress & { name: string }) | undefined>();
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const [redrawToken, setRedrawToken] = useState(0);
  const [aerospaceInfo] = useState(loadAerospaceInfo);

  const bundles = useMemo(() => options.resolveBundles(loaded.config, loaded.baseDir, loaded.path), [loaded, options]);
  const selectedBundle = bundles[Math.min(selected, Math.max(0, bundles.length - 1))];
  const fields = editFields(aerospaceInfo);
  const browserOptions = installedBrowsers(loaded.config.bundles);
  const needsBuild = mode.type === "table" && selectedBundle ? options.bundleNeedsBuild(selectedBundle) : false;
  const needsSave = mode.type === "edit" && editNeedsSave(mode);
  const theme = currentTuiTheme();

  const reload = () => setLoaded(options.loadConfig(loaded.path));
  const done = () => {
    exit();
    onDone();
  };
  const handleError = (error: unknown) => {
    setMessage(error instanceof Error ? error.message : String(error));
    onError(error);
  };

  useEffect(() => {
    if (!buildProgress) return undefined;
    const timer = setInterval(() => setSpinnerFrame((frame) => (frame + 1) % spinnerFrames.length), 120);
    return () => clearInterval(timer);
  }, [buildProgress]);

  useEffect(() => {
    if (buildProgress) return undefined;
    const timer = setInterval(() => setRedrawToken((value) => value + 1), REDRAW_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [buildProgress]);

  useInput((input, key) => {
    try {
      if (isRefreshInput(input, key)) {
        onRefresh();
        setRedrawToken((value) => value + 1);
        return;
      }

      if (buildProgress) return;

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
        } else if (mode.picker === "iconColor" && (key.upArrow || key.downArrow || input === "j" || input === "k")) {
          const direction = key.upArrow || input === "k" ? -1 : 1;
          setMode({ ...mode, values: { ...mode.values, iconColor: nextOption(iconColors, mode.values.iconColor, direction) } });
        } else if (mode.picker === "iconBackgroundColor" && (key.upArrow || key.downArrow || input === "j" || input === "k")) {
          const direction = key.upArrow || input === "k" ? -1 : 1;
          setMode({ ...mode, values: { ...mode.values, iconBackgroundColor: nextOption(iconColors, mode.values.iconBackgroundColor, direction) } });
        } else if (mode.picker && key.return) {
          setMode({ ...mode, picker: undefined });
        } else if ((key.return || input === " ") && mode.fields[mode.field]?.key === "iconInset") {
          setMode({ ...mode, values: { ...mode.values, iconInset: !mode.values.iconInset } });
        } else if (key.upArrow || input === "k") {
          setMode({ ...mode, field: Math.max(0, mode.field - 1), picker: undefined });
        } else if (key.downArrow || input === "j") {
          setMode({ ...mode, field: Math.min(mode.fields.length - 1, mode.field + 1), picker: undefined });
        } else if (key.return && mode.fields[mode.field]?.key === "browser") {
          setMode({ ...mode, picker: "browser" });
        } else if (key.return && mode.fields[mode.field]?.key === "workspace") {
          setMode({ ...mode, picker: "workspace" });
        } else if (key.return && mode.fields[mode.field]?.key === "iconColor") {
          setMode({ ...mode, picker: "iconColor" });
        } else if (key.return && mode.fields[mode.field]?.key === "iconBackgroundColor") {
          setMode({ ...mode, picker: "iconBackgroundColor" });
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
        const values = newAppValues(aerospaceInfo, browserOptions);
        setMode({ type: "edit", initialValues: values, values, field: 0, fields, browserOptions, workspaceOptions: aerospaceInfo.workspaces });
      } else if (input === "b" && selectedBundle) {
        const bundle = selectedBundle;
        setBuildProgress({ name: bundle.displayName, step: "Preparing", current: 0, total: 7 });
        setMessage("");
        setTimeout(() => {
          try {
            void options
              .buildBundle(bundle, true, { quiet: true, onProgress: (progress) => setBuildProgress({ name: bundle.displayName, ...progress }) })
              .then(() => {
                setMessage(`✓ Built ${bundle.key}`);
                reload();
              }, handleError)
              .finally(() => setBuildProgress(undefined));
          } catch (error) {
            handleError(error);
            setBuildProgress(undefined);
          }
        }, 0);
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
    <Box key={redrawToken} flexDirection="column">
      <Header configPath={loaded.path} redrawToken={redrawToken} />
      {mode.type === "edit" ? (
        <EditForm mode={mode} setMode={setMode} theme={theme} />
      ) : (
        <Table bundles={bundles} selected={selected} showWorkspace={Boolean(aerospaceInfo.configPath)} bundleNeedsBuild={options.bundleNeedsBuild} theme={theme} />
      )}
      {mode.type === "confirm" && <Text color="yellow">{mode.message} y/n</Text>}
      <Footer
        mode={mode.type}
        hasAerospace={Boolean(aerospaceInfo.configPath)}
        needsSave={needsSave}
        needsBuild={needsBuild}
        buildProgress={buildProgress}
        spinner={spinnerFrames[(spinnerFrame + (buildProgress?.current ?? 0)) % spinnerFrames.length]}
        notice={message}
      />
    </Box>
  );
}

function isRefreshInput(input: string, key: { ctrl?: boolean; name?: string; raw?: string }): boolean {
  return (key.ctrl && (input === "k" || input === "l" || key.name === "k" || key.name === "l")) || input === "\u000b" || input === "\u000c" || key.raw === "\u000b" || key.raw === "\u000c";
}

function currentTuiTheme(): TuiTheme {
  const isDark = isDarkTerminal();
  return {
    isDark,
    selectedRowBackground: isDark ? SELECTED_ROW_BACKGROUND_DARK : SELECTED_ROW_BACKGROUND_LIGHT,
    detailValueColor: isDark ? "#FFFFFF" : "#000000",
  };
}

function isDarkTerminal(): boolean {
  if (process.env.BROWSERFI_THEME === "dark") return true;
  if (process.env.BROWSERFI_THEME === "light") return false;

  const colorFgBg = process.env.COLORFGBG;
  const background = colorFgBg?.split(";").at(-1);
  if (background && /^\d+$/.test(background)) {
    return Number(background) < 8;
  }

  if (process.env.TERM_PROGRAM?.toLowerCase() === "ghostty" && ghosttyThemeFollowsSystem()) {
    return isMacosDarkMode();
  }

  return false;
}

function ghosttyThemeFollowsSystem(): boolean {
  try {
    const config = readFileSync(join(homedir(), ".config/ghostty/config"), "utf8");
    return /^theme\s*=\s*.*\blight:.*\bdark:/im.test(config);
  } catch {
    return false;
  }
}

function isMacosDarkMode(): boolean {
  try {
    return execFileSync("defaults", ["read", "-g", "AppleInterfaceStyle"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() === "Dark";
  } catch {
    return false;
  }
}

function Header({ configPath, redrawToken }: { configPath: string; redrawToken: number }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text bold color="magenta">Browserfi</Text>
        <Text color={LABEL_COLOR}> v{PACKAGE_VERSION}</Text>
      </Text>
      <Text>create and manage custom bundled browsers</Text>
      <Text>
        <Text color={LABEL_COLOR}>config:</Text>
        <Text color="gray"> {configPath}{redrawToken % 2 === 0 ? "" : " "}</Text>
      </Text>
    </Box>
  );
}

function readPackageVersion(): string {
  try {
    const packagePath = resolve(SCRIPT_DIR, "../package.json");
    const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function Table({ bundles, selected, showWorkspace, bundleNeedsBuild, theme }: { bundles: ResolvedBundle[]; selected: number; showWorkspace: boolean; bundleNeedsBuild: (bundle: ResolvedBundle) => boolean; theme: TuiTheme }) {
  const { columns } = useWindowSize();
  const widths = tableWidths(columns || 100, showWorkspace);
  const selectedBundle = bundles[selected];
  return (
    <Box flexDirection="column">
      <Text color="gray">{tableBorder("top", widths)}</Text>
      <Text color="gray">{tableRow(showWorkspace ? ["Status", "  Name", "Browser", "Workspace"] : ["Status", "  Name", "Browser"], widths)}</Text>
      <Text color="gray">{tableRow(showWorkspace ? ["", "", "", ""] : ["", "", ""], widths)}</Text>
      {bundles.map((bundle, index) => {
        const active = index === selected;
        const status = bundleNeedsBuild(bundle) ? "build" : "ok";
        return (
          <TableBundleRow key={bundle.key} bundle={bundle} active={active} status={status} showWorkspace={showWorkspace} widths={widths} theme={theme} />
        );
      })}
      <Text color="gray">{tableRow(showWorkspace ? ["", "", "", ""] : ["", "", ""], widths)}</Text>
      <Text color="gray">{tableBorder("bottom", widths)}</Text>
      {bundles.length === 0 && <Text color="yellow">No bundles configured.</Text>}
      {selectedBundle && (
        <Box flexDirection="column" marginTop={1}>
          <DetailLine label="name" value={selectedBundle.displayName} theme={theme} />
          <DetailLine label="profile" value={selectedBundle.profileDir} theme={theme} />
          <DetailLine label="icon" value={selectedBundle.icon ?? "icons/<key>.png|icns"} theme={theme} />
          <DetailLine label="icon color" value={selectedBundle.iconColor ?? "-"} colorValue={selectedBundle.iconColor} theme={theme} />
          <DetailLine label="icon background" value={selectedBundle.iconBackgroundColor ?? "-"} colorValue={selectedBundle.iconBackgroundColor} theme={theme} />
          <DetailLine label="indent icon" value={selectedBundle.iconInset ? "yes" : "no"} theme={theme} />
          {showWorkspace && <DetailLine label="workspace" value={selectedBundle.workspace ?? "-"} theme={theme} />}
        </Box>
      )}
    </Box>
  );
}

function DetailLine({ label, value, colorValue, theme }: { label: string; value: string; colorValue?: string; theme: TuiTheme }) {
  return (
    <Text>
      <Text color={LABEL_COLOR}>{label}:</Text>
      {" "}
      {colorValue && (
        <>
          <ColorDot color={colorValue} theme={theme} />
          {" "}
        </>
      )}
      <Text color={theme.detailValueColor}>{value}</Text>
    </Text>
  );
}

function TableBundleRow({ bundle, active, status, showWorkspace, widths, theme }: { bundle: ResolvedBundle; active: boolean; status: "ok" | "build"; showWorkspace: boolean; widths: number[]; theme: TuiTheme }) {
  const statusLabel = status === "ok" ? "✓ ok" : "build";
  const rowBackground = active ? theme.selectedRowBackground : undefined;
  return (
    <Text>
      <Text color="gray">│{" ".repeat(TABLE_PADDING_X)}</Text>
      <Text backgroundColor={rowBackground} color={status === "ok" ? "green" : "yellow"}>{fit(statusLabel, widths[0]).padEnd(widths[0])}</Text>
      <Text backgroundColor={rowBackground}>  </Text>
      <ColorDot color={bundle.iconBackgroundColor} backgroundColor={rowBackground} blankWhenEmpty theme={theme} />
      <Text backgroundColor={rowBackground}> {fit(bundle.displayName, widths[1] - 2).padEnd(widths[1] - 2)}</Text>
      <Text backgroundColor={rowBackground}>  {fit(bundle.browser, widths[2]).padEnd(widths[2])}</Text>
      {showWorkspace && <Text backgroundColor={rowBackground}>  {fit(bundle.workspace ?? "", widths[3]).padEnd(widths[3])}</Text>}
      <Text color="gray">{" ".repeat(TABLE_PADDING_X)}│</Text>
    </Text>
  );
}

function EditForm({ mode, setMode, theme }: { mode: Extract<Mode, { type: "edit" }>; setMode: (mode: Mode) => void; theme: TuiTheme }) {
  const { columns } = useWindowSize();
  const field = mode.fields[mode.field];
  const valueWidth = Math.max(12, (columns || 80) - 2 - (EDIT_PADDING_X * 2) - EDIT_LABEL_WIDTH);
  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor="gray" flexDirection="column" paddingX={EDIT_PADDING_X} paddingBottom={1}>
        <Text bold>{mode.originalKey ? `Edit ${mode.originalKey}` : "Add new app"}</Text>
        <Text> </Text>
        {mode.fields.map((item, index) => (
          <Box key={item.key}>
            <Box width={EDIT_LABEL_WIDTH}>
              <Text color={LABEL_COLOR}>{item.label}:</Text>
            </Box>
            {index === mode.field && item.key !== "workspace" && item.key !== "browser" && item.key !== "iconColor" && item.key !== "iconBackgroundColor" && item.key !== "iconInset" ? (
              <TextInput
                value={String(mode.values[item.key])}
                onChange={(value) => setMode({ ...mode, values: { ...mode.values, [field.key]: value } })}
              />
            ) : index === mode.field && item.key === "browser" ? (
              <Text color="cyan">{mode.values.browser || "-"} {mode.picker === "browser" ? "" : "(enter to choose)"}</Text>
            ) : index === mode.field && item.key === "workspace" ? (
              <Text color="cyan">{mode.values.workspace || "-"} {mode.picker === "workspace" ? "" : "(enter to choose)"}</Text>
            ) : index === mode.field && item.key === "iconColor" ? (
              <ColorValue value={mode.values.iconColor} active suffix={mode.picker === "iconColor" ? "" : " (enter to choose)"} theme={theme} />
            ) : index === mode.field && item.key === "iconBackgroundColor" ? (
              <ColorValue value={mode.values.iconBackgroundColor} active suffix={mode.picker === "iconBackgroundColor" ? "" : " (enter to choose)"} theme={theme} />
            ) : item.key === "iconColor" || item.key === "iconBackgroundColor" ? (
              <ColorValue value={mode.values[item.key]} theme={theme} />
            ) : item.key === "iconInset" ? (
              <Text color={index === mode.field ? "cyan" : undefined}>{mode.values.iconInset ? "[x]" : "[ ]"}</Text>
            ) : item.key === "icon" && !mode.values.icon ? (
              <Text color="gray">{fit(ICON_PLACEHOLDER, valueWidth)}</Text>
            ) : (
              <Text>{fit(String(mode.values[item.key]) || "-", valueWidth)}</Text>
            )}
          </Box>
        ))}
      </Box>
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
      {mode.picker === "iconColor" && (
        <ColorPicker colors={iconColors} selectedColor={mode.values.iconColor} theme={theme} />
      )}
      {mode.picker === "iconBackgroundColor" && (
        <ColorPicker colors={iconColors} selectedColor={mode.values.iconBackgroundColor} theme={theme} />
      )}
    </Box>
  );
}

function ColorValue({ value, active = false, suffix = "", theme }: { value: string; active?: boolean; suffix?: string; theme: TuiTheme }) {
  return (
    <Text>
      <ColorDot color={value} theme={theme} />
      <Text color={active ? "cyan" : undefined}> {value || "default"}{suffix}</Text>
    </Text>
  );
}

function ColorPicker({ colors, selectedColor, theme }: { colors: string[]; selectedColor: string; theme: TuiTheme }) {
  const selectedIndex = Math.max(0, colors.indexOf(selectedColor));
  const maxStart = Math.max(0, colors.length - COLOR_PREVIEW_SIZE);
  const previewStart = Math.min(Math.max(0, selectedIndex - 1), maxStart);
  return (
    <Box flexDirection="row" marginTop={1}>
      <Box flexDirection="column">
        {colors.map((color) => (
          <PickerColor key={color || "default"} color={color} selected={color === selectedColor} theme={theme} />
        ))}
      </Box>
      <Box flexDirection="column" marginLeft={1}>
        {colors.map((color, index) => (
          <ColorPreviewRow
            key={color || "default"}
            color={selectedColor}
            showPreview={index >= previewStart && index < previewStart + COLOR_PREVIEW_SIZE}
            showArrow={index === selectedIndex}
            theme={theme}
          />
        ))}
      </Box>
    </Box>
  );
}

function PickerColor({ color, selected, theme }: { color: string; selected: boolean; theme: TuiTheme }) {
  const label = color || "default";
  return (
    <Text>
      <Text color={selected ? "cyan" : "gray"}>{selected ? "› " : "  "}</Text>
      <ColorDot color={color} theme={theme} />
      <Text color={selected ? "cyan" : undefined}> {label.padEnd(COLOR_PICKER_LABEL_WIDTH)}</Text>
    </Text>
  );
}

function ColorPreviewRow({ color, showPreview, showArrow, theme }: { color: string; showPreview: boolean; showArrow: boolean; theme: TuiTheme }) {
  const previewColor = color || (theme.isDark ? "#FFFFFF" : "#000000");
  return (
    <Text>
      <Text color={showArrow ? previewColor : "gray"}>{showArrow ? "◀" : " "}</Text>
      {showPreview ? <ColorBlock color={color} theme={theme} /> : <Text>{" ".repeat(COLOR_PREVIEW_WIDTH)}</Text>}
    </Text>
  );
}

function ColorBlock({ color, theme }: { color: string; theme: TuiTheme }) {
  return <Text color={color || (theme.isDark ? "#FFFFFF" : "#000000")}>{"█".repeat(COLOR_PREVIEW_WIDTH)}</Text>;
}

function ColorDot({ color, backgroundColor, blankWhenEmpty = false, theme }: { color?: string; backgroundColor?: string; blankWhenEmpty?: boolean; theme: TuiTheme }) {
  if (!color) {
    return <Text backgroundColor={backgroundColor} color="gray">{blankWhenEmpty ? " " : "●"}</Text>;
  }
  const normalized = color.toLowerCase();
  const isWhite = normalized === "#fff" || normalized === "#ffffff" || normalized === "white";
  const isBlack = normalized === "#000" || normalized === "#000000" || normalized === "#111111" || normalized === "black";
  if ((!theme.isDark && isWhite) || (theme.isDark && isBlack)) {
    return <Text backgroundColor={backgroundColor} color={theme.isDark ? "white" : "black"}>○</Text>;
  }
  return <Text backgroundColor={backgroundColor} color={color}>●</Text>;
}

function Footer({ mode, hasAerospace, needsSave, needsBuild, buildProgress, spinner, notice }: { mode: Mode["type"]; hasAerospace?: boolean; needsSave?: boolean; needsBuild?: boolean; buildProgress?: BuildProgress & { name: string }; spinner: string; notice?: string }) {
  const { columns } = useWindowSize();
  const rule = "─".repeat(Math.max(20, columns || 80));
  if (mode === "edit") {
    return (
      <Box flexDirection="column" marginTop={1}>
        {needsSave ? <Text bold color="green">Unsaved changes (s) to save</Text> : <Text> </Text>}
        <Text color="gray">{rule}</Text>
        <Text color="gray">
          {hasAerospace ? "↑/↓ move fields • enter choose options • " : "↑/↓ move fields • enter choose browser/color • "}
          <Text bold={needsSave} color={needsSave ? "green" : "gray"}>s save</Text>
          {" • esc cancel"}
        </Text>
      </Box>
    );
  }
  if (mode === "confirm") {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text> </Text>
        <Text color="gray">{rule}</Text>
        <Text color="gray">y confirm • n/esc cancel</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" marginTop={1}>
      {buildProgress ? (
        <BuildProgress progress={buildProgress} spinner={spinner} />
      ) : needsBuild ? (
        <Text bold color="#FFA500">Some apps need to be built (b) to build</Text>
      ) : (
        <Text bold={Boolean(notice)} color={notice ? "green" : undefined}>{notice || " "}</Text>
      )}
      <Text color="gray">{rule}</Text>
      <Text color="gray">
        {"↑/↓ select • a add app • enter/e edit • "}
        <Text bold={needsBuild || Boolean(buildProgress)} color={needsBuild || buildProgress ? "#FFA500" : "gray"}>{buildProgress ? "building" : "b build"}</Text>
        {hasAerospace ? " • d delete app • w aerospace • q quit" : " • d delete app • q quit"}
      </Text>
    </Box>
  );
}

function BuildProgress({ progress, spinner }: { progress: BuildProgress & { name: string }; spinner: string }) {
  const width = 16;
  const filled = Math.max(0, Math.min(width, Math.round((progress.current / progress.total) * width)));
  const bar = `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
  return (
    <Text bold color="#FFA500">
      {spinner} Building {progress.name} [{bar}] {progress.current}/{progress.total} {progress.step}
    </Text>
  );
}

function tableRow(values: string[], widths: number[]): string {
  const padding = " ".repeat(TABLE_PADDING_X);
  return `│${padding}${values.map((value, index) => fit(value, widths[index]).padEnd(widths[index])).join("  ")}${padding}│`;
}

function tableBorder(position: "top" | "bottom", widths: number[]): string {
  const chars = {
    top: ["╭", "╮"],
    bottom: ["╰", "╯"],
  }[position];
  return `${chars[0]}${"─".repeat(tableContentWidth(widths) + (TABLE_PADDING_X * 2))}${chars[1]}`;
}

function tableWidths(columns: number, showWorkspace: boolean): number[] {
  const usableColumns = Math.max(40, columns - 2);
  const base = showWorkspace ? [6, 28, 8, 18] : [6, 40, 8];
  const tableOverhead = 4 + (2 * (base.length - 1));
  let remaining = Math.max(0, usableColumns - tableOverhead - sum(base));
  const flexible = showWorkspace ? [1, 3] : [1];
  while (remaining > 0) {
    for (const index of flexible) {
      if (remaining === 0) break;
      base[index] += 1;
      remaining -= 1;
    }
  }
  return base;
}

function tableContentWidth(widths: number[]): number {
  return sum(widths) + (2 * (widths.length - 1));
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
  return aerospaceInfo.configPath ? [...baseFields, { key: "workspace", label: "aerospace workspace" }] : baseFields;
}

function editValues(bundle: ResolvedBundle, aerospaceInfo: AerospaceInfo): EditValues {
  return {
    browser: bundle.browser,
    key: bundle.key,
    displayName: bundle.displayName,
    icon: bundle.icon ?? "",
    iconColor: bundle.iconColor ?? "",
    iconBackgroundColor: bundle.iconBackgroundColor ?? "",
    iconInset: bundle.iconInset,
    workspace: bundle.workspace ?? aerospaceInfo.workspaces[0] ?? "",
  };
}

function newAppValues(aerospaceInfo: AerospaceInfo, browserOptions: string[]): EditValues {
  return {
    browser: browserOptions[0] ?? "chromium",
    key: "",
    displayName: "New App",
    icon: "",
    iconColor: "",
    iconBackgroundColor: "",
    iconInset: true,
    workspace: aerospaceInfo.workspaces[0] ?? "",
  };
}

function saveEdit(options: TuiOptions, loaded: LoadedConfig, originalKey: string | undefined, values: EditValues, workspaceOptions: string[]): void {
  if (!browserNames.includes(values.browser)) throw new Error(`unsupported browser: ${values.browser}`);
  if (workspaceOptions.length > 0 && !workspaceOptions.includes(values.workspace)) throw new Error(`unknown AeroSpace workspace: ${values.workspace}`);
  const displayName = values.displayName.trim();
  if (!displayName) throw new Error("Display name must not be empty.");
  const key = originalKey ?? uniqueKeyFromDisplayName(displayName, loaded.config);
  const duplicate = loaded.config.bundles.some((bundle) => bundle.key === key && bundle.key !== originalKey);
  if (duplicate) throw new Error(`bundle already exists: ${key}`);

  const next: BundleConfig = {
    browser: values.browser as BundleConfig["browser"],
    key,
    displayName,
    icon: values.icon.trim() || undefined,
    iconColor: values.iconColor || undefined,
    iconBackgroundColor: values.iconBackgroundColor || undefined,
    iconInset: values.iconInset ? undefined : false,
    workspace: values.workspace || undefined,
  };

  if (originalKey) {
    const index = loaded.config.bundles.findIndex((bundle) => bundle.key === originalKey);
    if (index === -1) throw new Error(`bundle not found: ${originalKey}`);
    next.id = loaded.config.bundles[index].id ?? originalKey;
    loaded.config.bundles[index] = { ...loaded.config.bundles[index], ...next };
  } else {
    next.id = key;
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

function uniqueKeyFromDisplayName(displayName: string, config: Config): string {
  const base = keyFromDisplayName(displayName);
  let key = base;
  let count = 2;
  while (config.bundles.some((bundle) => bundle.key === key)) {
    key = `${base}-${count}`;
    count += 1;
  }
  return key;
}

function keyFromDisplayName(displayName: string): string {
  const key = displayName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .replace(/-{2,}/g, "-");
  return key || "app";
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
