import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PLUGIN_ID, herdrConfigPath } from "../env.ts";
import { statusShimPath } from "./shims.ts";

export interface ConfigCheck {
  id: "toast" | "tabbar" | "agents" | "spaces" | "keys";
  label: string;
  /** `outdated`: rows written by an earlier version of this plugin (safe to replace). */
  state: "ok" | "missing" | "conflict" | "outdated";
  detail: string;
}

interface Table {
  name: string;
  array: boolean;
  start: number; // header line index
  end: number; // exclusive
}

const HEADER_RE = /^\s*(\[\[?)\s*([A-Za-z0-9_.\-"' ]+?)\s*\]\]?\s*(#.*)?$/;

export function parseTables(lines: string[]): Table[] {
  const tables: Table[] = [];
  lines.forEach((line, i) => {
    const m = HEADER_RE.exec(line);
    if (!m) return;
    if (tables.length) tables[tables.length - 1].end = i;
    tables.push({ name: m[2].replace(/["'\s]/g, ""), array: m[1] === "[[", start: i, end: lines.length });
  });
  return tables;
}

function findKey(lines: string[], table: Table | undefined, key: string): number {
  if (!table) return -1;
  const re = new RegExp(`^\\s*${key.replace(/\./g, "\\.")}\\s*=`);
  for (let i = table.start + 1; i < table.end; i++) if (re.test(lines[i])) return i;
  return -1;
}

/** Extent of a (possibly multi-line) value starting at `line`: bracket depth outside strings. */
function valueExtent(lines: string[], line: number): number {
  let depth = 0;
  let inStr: string | null = null;
  for (let i = line; i < lines.length; i++) {
    const text = i === line ? lines[i].slice(lines[i].indexOf("=") + 1) : lines[i];
    for (let j = 0; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (c === "\\" && inStr === '"') j++;
        else if (c === inStr) inStr = null;
        continue;
      }
      if (c === "#") break;
      if (c === '"' || c === "'") inStr = c;
      else if (c === "[" || c === "{") depth++;
      else if (c === "]" || c === "}") depth--;
    }
    if (depth <= 0) return i;
  }
  return line;
}

const LEVEL_RULES =
  'rules = [{ starts_with = "■", fg = "#f38ba8", bold = true }, { starts_with = "▲", fg = "#f9e2af" }, { starts_with = "▽", fg = "#a6e3a1" }]';

export const SNIPPETS = {
  toast: `[ui.toast]\ndelivery = "herdr"`,
  tabbar: () =>
    `tab_bar_right = [\n  { type = "command", command = "${statusShimPath()}", interval_seconds = 5, timeout_seconds = 4 },\n]`,
  agents: `[ui.sidebar.agents]
rows = [
  ["state_icon", "machine", "workspace", "tab"],
  ["agent", { token = "$tu_sub", dim = true }],
  [{ token = "$tu", ${LEVEL_RULES} }],
  [{ token = "$tu_more", dim = true }],
]`,
  spaces: `[ui.sidebar.spaces]
rows = [
  ["state_icon", "workspace"],
  ["branch", "git_status"],
  [{ token = "$tu_ws", ${LEVEL_RULES} }],
  [{ token = "$tu_ws_more", dim = true }],
]`,
  keys: `[[keys.command]]
key = "prefix+u"
type = "plugin_action"
command = "${PLUGIN_ID}.open"
description = "token usage dashboard"

[[keys.command]]
key = "prefix+shift+u"
type = "plugin_action"
command = "${PLUGIN_ID}.snooze"
description = "snooze usage alerts (1h)"`,
};

export function readHerdrConfig(): string {
  const path = herdrConfigPath();
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

export function checkConfig(text: string): ConfigCheck[] {
  const lines = text.split("\n");
  const tables = parseTables(lines);
  const table = (name: string) => tables.find((t) => t.name === name && !t.array);
  const checks: ConfigCheck[] = [];

  const toast = table("ui.toast");
  const deliveryLine = findKey(lines, toast, "delivery");
  const delivery = deliveryLine >= 0 ? /=\s*"([^"]*)"/.exec(lines[deliveryLine])?.[1] : undefined;
  checks.push({
    id: "toast",
    label: "Toast delivery (alerts)",
    state: delivery && delivery !== "off" ? "ok" : "missing",
    detail: delivery ? `delivery = "${delivery}"` : 'not set (herdr default "off": alerts are silent)',
  });

  const ui = table("ui");
  const tabLine = findKey(lines, ui, "tab_bar_right");
  const tabText = tabLine >= 0 ? lines.slice(tabLine, valueExtent(lines, tabLine) + 1).join("\n") : "";
  checks.push({
    id: "tabbar",
    label: "Tab bar summary",
    state: tabLine < 0 ? "missing" : tabText.includes("tu-status") ? "ok" : "conflict",
    detail: tabLine < 0 ? "ui.tab_bar_right not set" : tabText.includes("tu-status") ? "tu-status entry present" : "ui.tab_bar_right exists without the tu-status entry",
  });

  const agents = table("ui.sidebar.agents");
  const rowsLine = findKey(lines, agents, "rows");
  const rowsText = rowsLine >= 0 ? lines.slice(rowsLine, valueExtent(lines, rowsLine) + 1).join("\n") : "";
  // v1 of this plugin wrote `$tu_ctx` on the agent row and `$tu` below it.
  const agentsV1 = rowsText.includes('"$tu_ctx"') && rowsText.includes('"$tu"') && !rowsText.includes("$tu_more");
  checks.push({
    id: "agents",
    label: "Agent sidebar rows",
    state: rowsLine < 0 ? "missing" : rowsText.includes("$tu_more") ? "ok" : agentsV1 ? "outdated" : rowsText.includes('"$tu"') ? "ok" : "conflict",
    detail:
      rowsLine < 0
        ? "default rows (no $tu)"
        : rowsText.includes("$tu_more")
          ? "$tu rows present"
          : agentsV1
            ? "v1 layout from an earlier version (upgrade adds the detail row)"
            : rowsText.includes('"$tu"')
              ? "custom rows with $tu"
              : "custom rows without $tu",
  });

  const spaces = table("ui.sidebar.spaces");
  const spaceRows = findKey(lines, spaces, "rows");
  const spaceText = spaceRows >= 0 ? lines.slice(spaceRows, valueExtent(lines, spaceRows) + 1).join("\n") : "";
  const spacesV1 = spaceText.includes('token = "$tu_ws", dim = true') && !spaceText.includes("$tu_ws_more");
  checks.push({
    id: "spaces",
    label: "Space sidebar rows",
    state: spaceRows < 0 ? "missing" : spaceText.includes("$tu_ws_more") ? "ok" : spacesV1 ? "outdated" : spaceText.includes("$tu_ws") ? "ok" : "conflict",
    detail:
      spaceRows < 0
        ? "default rows (no $tu_ws)"
        : spaceText.includes("$tu_ws_more")
          ? "$tu_ws rows present"
          : spacesV1
            ? "v1 layout from an earlier version (upgrade matches the agent rows)"
            : spaceText.includes("$tu_ws")
              ? "custom rows with $tu_ws"
              : "custom rows without $tu_ws",
  });

  const hasOpen = text.includes(`"${PLUGIN_ID}.open"`);
  const prefixUTaken = /key\s*=\s*"prefix\+u"/.test(text) && !hasOpen;
  checks.push({
    id: "keys",
    label: "Keybinding (prefix+u)",
    state: hasOpen ? "ok" : prefixUTaken ? "conflict" : "missing",
    detail: hasOpen ? "bound" : prefixUTaken ? "prefix+u is already bound to something else" : "not bound",
  });
  return checks;
}

/**
 * Apply missing sections. Never overwrites user choices, except turning toast
 * delivery from "off" to "herdr" (the plugin's alerts need it). Returns the
 * new text and a description of each change.
 */
export function applyConfig(text: string): { text: string; changes: string[]; manual: string[] } {
  let lines = text.length ? text.replace(/\n+$/, "").split("\n") : [];
  const changes: string[] = [];
  const manual: string[] = [];
  const appendBlock = (block: string) => {
    if (lines.length && lines[lines.length - 1].trim() !== "") lines.push("");
    lines.push(...block.split("\n"));
  };
  const insertAfterHeader = (table: Table, block: string) => {
    lines = [...lines.slice(0, table.start + 1), ...block.split("\n"), ...lines.slice(table.start + 1)];
  };

  for (const check of checkConfig(lines.join("\n"))) {
    const tables = parseTables(lines);
    const table = (name: string) => tables.find((t) => t.name === name && !t.array);
    if (check.state === "ok") continue;
    switch (check.id) {
      case "toast": {
        const toast = table("ui.toast");
        const line = findKey(lines, toast, "delivery");
        if (toast && line >= 0) {
          lines[line] = 'delivery = "herdr"';
          changes.push('ui.toast.delivery: "off" → "herdr"');
        } else if (toast) {
          insertAfterHeader(toast, 'delivery = "herdr"');
          changes.push('ui.toast.delivery = "herdr"');
        } else {
          appendBlock(SNIPPETS.toast);
          changes.push('added [ui.toast] delivery = "herdr"');
        }
        break;
      }
      case "tabbar": {
        if (check.state === "conflict") {
          manual.push(`Add this entry to your existing ui.tab_bar_right array:\n  { type = "command", command = "${statusShimPath()}", interval_seconds = 5, timeout_seconds = 4 },`);
          break;
        }
        const ui = table("ui");
        if (ui) insertAfterHeader(ui, SNIPPETS.tabbar());
        else appendBlock(`[ui]\n${SNIPPETS.tabbar()}`);
        changes.push("added ui.tab_bar_right tu-status entry");
        break;
      }
      case "agents":
      case "spaces": {
        const snippet = check.id === "agents" ? SNIPPETS.agents : SNIPPETS.spaces;
        const name = check.id === "agents" ? "ui.sidebar.agents" : "ui.sidebar.spaces";
        if (check.state === "conflict") {
          manual.push(`Your ${check.label.toLowerCase()} are customised; add a row with ${check.id === "agents" ? "$tu" : "$tu_ws"}, e.g.:\n${snippet}`);
          break;
        }
        const existing = table(name);
        const body = snippet.split("\n").slice(1).join("\n");
        if (check.state === "outdated" && existing) {
          // Replace only the rows value this plugin wrote previously.
          const start = findKey(lines, existing, "rows");
          const end = valueExtent(lines, start);
          lines = [...lines.slice(0, start), ...body.split("\n"), ...lines.slice(end + 1)];
          changes.push(`upgraded ${name} rows to the v2 layout`);
          break;
        }
        if (existing) insertAfterHeader(existing, body);
        else appendBlock(snippet);
        changes.push(`added ${name} rows with ${check.id === "agents" ? "$tu" : "$tu_ws"}`);
        break;
      }
      case "keys": {
        if (check.state === "conflict") {
          manual.push(`prefix+u is taken; bind the dashboard yourself, e.g.:\n${SNIPPETS.keys.replace(/prefix\+u/, "prefix+alt+u")}`);
          break;
        }
        appendBlock(SNIPPETS.keys);
        changes.push("bound prefix+u (dashboard) and prefix+shift+u (snooze)");
        break;
      }
    }
  }
  return { text: lines.join("\n") + "\n", changes, manual };
}

export function writeHerdrConfig(text: string): string {
  const path = herdrConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  let backup = "";
  if (existsSync(path)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    backup = `${path}.bak-${stamp}`;
    copyFileSync(path, backup);
  }
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
  return backup;
}

export function simpleDiff(before: string, after: string): string {
  const a = before.replace(/\n+$/, "").split("\n");
  const b = after.replace(/\n+$/, "").split("\n");
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    // find next sync point
    const nextInB = i < a.length ? b.indexOf(a[i], j) : -1;
    if (nextInB >= 0) {
      while (j < nextInB) out.push(`+ ${b[j++]}`);
    } else if (i < a.length) {
      out.push(`- ${a[i++]}`);
    } else {
      out.push(`+ ${b[j++]}`);
    }
  }
  return out.join("\n");
}
