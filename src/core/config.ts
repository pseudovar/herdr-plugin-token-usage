import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PLUGIN_ID, configDir } from "../env.ts";
import { parseJsonc } from "../util/jsonc.ts";
import { DEFAULT_DISPLAY, DISPLAY_STYLES } from "./display.ts";
import type { DisplayConfig } from "./display.ts";
import type { Billing, Harness, Level } from "./types.ts";

export type MetricId =
  | "session.tokens"
  | "session.credits"
  | "session.cost_usd"
  | "session.context_pct"
  | "session.cache_hit_pct"
  | "session.credits_5m"
  | "session.cost_usd_5m"
  | "session.tokens_5m"
  | "session.tps_p50"
  | "session.calls"
  | "today.tokens"
  | "today.credits"
  | "today.cost_usd"
  | "quota.copilot.used_pct"
  | "quota.copilot.pace"
  | "quota.copilot.projected_pct"
  | "quota.copilot.days_left";

export const METRICS: Record<MetricId, { label: string; unit: string; step: number; scope: "session" | "global" }> = {
  "session.tokens": { label: "Session work tokens", unit: "tok", step: 100_000, scope: "session" },
  "session.credits": { label: "Session Copilot credits", unit: "cr", step: 50, scope: "session" },
  "session.cost_usd": { label: "Session cost (USD)", unit: "$", step: 0.5, scope: "session" },
  "session.context_pct": { label: "Context window used", unit: "%", step: 1, scope: "session" },
  "session.cache_hit_pct": { label: "Cache hit rate (last 10 calls)", unit: "%", step: 5, scope: "session" },
  "session.credits_5m": { label: "Credits burned in 5 min", unit: "cr", step: 10, scope: "session" },
  "session.cost_usd_5m": { label: "USD burned in 5 min", unit: "$", step: 0.25, scope: "session" },
  "session.tokens_5m": { label: "Work tokens in 5 min", unit: "tok", step: 25_000, scope: "session" },
  "session.tps_p50": { label: "Output speed p50", unit: "tok/s", step: 5, scope: "session" },
  "session.calls": { label: "Model calls in session", unit: "calls", step: 10, scope: "session" },
  "today.tokens": { label: "Today's work tokens", unit: "tok", step: 1_000_000, scope: "global" },
  "today.credits": { label: "Today's Copilot credits", unit: "cr", step: 100, scope: "global" },
  "today.cost_usd": { label: "Today's cost (USD)", unit: "$", step: 1, scope: "global" },
  "quota.copilot.used_pct": { label: "Copilot monthly credits used", unit: "%", step: 5, scope: "global" },
  "quota.copilot.pace": { label: "Copilot pace (used ÷ elapsed)", unit: "×", step: 0.05, scope: "global" },
  "quota.copilot.projected_pct": { label: "Copilot projected month-end", unit: "%", step: 5, scope: "global" },
  "quota.copilot.days_left": { label: "Days until Copilot reset", unit: "d", step: 1, scope: "global" },
};

export interface Rule {
  id: string;
  title: string;
  enabled: boolean;
  notify: boolean;
  metric: MetricId;
  op: ">=" | "<=";
  /** Fire when the value crosses this threshold. */
  value?: number;
  /** Fire once at each step crossed (e.g. 75, 90 % of quota). */
  steps?: number[];
  /** Fire at every multiple (e.g. every 500 credits in one session). */
  every?: number;
  level: Exclude<Level, "normal">;
  /** Session rules: only after this many calls in the session. */
  minCalls?: number;
  /** Quota rules: only when the period has at most this many days left. */
  maxDaysLeft?: number;
  /** Quota rules: only after this % of the billing period has elapsed (avoids day-1 noise). */
  minElapsedPct?: number;
  /** Session rules: only for sessions billed this way. */
  billing?: Billing;
}

export interface Config {
  harnesses: Record<Harness, boolean>;
  claude: { ignore: string[] };
  copilot: {
    quota: boolean;
    refreshMinutes: number;
  };
  contextLimits: Record<string, number>;
  notify: {
    enabled: boolean;
    cooldownMinutes: number;
    sound: "none" | "done" | "request";
  };
  statusline: { refreshPanes: boolean; showTokens: boolean };
  /** How sidebar rows and the tab bar look (cycle live from the dashboard Lab view). */
  display: DisplayConfig;
  rules: Rule[];
}

export const DEFAULT_RULES: Rule[] = [
  {
    id: "copilot-pace-high",
    title: "Copilot on track to exceed monthly credits",
    enabled: true,
    notify: true,
    metric: "quota.copilot.pace",
    op: ">=",
    value: 1.1,
    level: "high",
    minElapsedPct: 10,
  },
  {
    id: "copilot-pace-critical",
    title: "Copilot burning credits far too fast",
    enabled: true,
    notify: true,
    metric: "quota.copilot.pace",
    op: ">=",
    value: 1.5,
    level: "critical",
    minElapsedPct: 10,
  },
  {
    id: "copilot-used",
    title: "Copilot monthly credits used",
    enabled: true,
    notify: true,
    metric: "quota.copilot.used_pct",
    op: ">=",
    steps: [75, 90],
    level: "high",
  },
  {
    id: "copilot-exhausted",
    title: "Copilot monthly credits exhausted",
    enabled: true,
    notify: true,
    metric: "quota.copilot.used_pct",
    op: ">=",
    value: 100,
    level: "critical",
  },
  {
    id: "context-high",
    title: "Context window filling up",
    enabled: true,
    notify: true,
    metric: "session.context_pct",
    op: ">=",
    value: 80,
    level: "high",
  },
  {
    id: "context-critical",
    title: "Context window nearly full",
    enabled: true,
    notify: true,
    metric: "session.context_pct",
    op: ">=",
    value: 92,
    level: "critical",
  },
  {
    id: "session-credits",
    title: "Expensive session (credits)",
    enabled: true,
    notify: true,
    metric: "session.credits",
    op: ">=",
    every: 500,
    level: "high",
    billing: "copilot",
  },
  {
    id: "session-cost",
    title: "Expensive session (USD)",
    enabled: true,
    notify: true,
    metric: "session.cost_usd",
    op: ">=",
    every: 5,
    level: "high",
    billing: "claude",
  },
  {
    id: "burn-credits",
    title: "Credit burn spike",
    enabled: true,
    notify: true,
    metric: "session.credits_5m",
    op: ">=",
    value: 150,
    level: "high",
    billing: "copilot",
  },
  {
    id: "burn-cost",
    title: "Spend burn spike",
    enabled: true,
    notify: true,
    metric: "session.cost_usd_5m",
    op: ">=",
    value: 1.5,
    level: "high",
    billing: "claude",
  },
  {
    id: "cache-poor",
    title: "Poor prompt-cache hit rate",
    enabled: true,
    notify: true,
    metric: "session.cache_hit_pct",
    op: "<=",
    value: 50,
    level: "high",
    minCalls: 5,
  },
  {
    id: "copilot-under-using",
    title: "Copilot credits to spare before reset",
    enabled: true,
    notify: true,
    metric: "quota.copilot.pace",
    op: "<=",
    value: 0.5,
    level: "low",
    maxDaysLeft: 10,
  },
  {
    id: "copilot-pace-low",
    title: "Copilot well under budget",
    enabled: true,
    notify: false,
    metric: "quota.copilot.pace",
    op: "<=",
    value: 0.5,
    level: "low",
    minElapsedPct: 10,
  },
];

export function defaultConfig(): Config {
  return {
    harnesses: { pi: true, opencode: true, copilot: true, claude: true },
    claude: { ignore: ["**/*ClaudeBar-Probe*/**", "**/*ClaudeBar-Probe*"] },
    copilot: { quota: true, refreshMinutes: 5 },
    contextLimits: {},
    notify: { enabled: true, cooldownMinutes: 60, sound: "request" },
    statusline: { refreshPanes: true, showTokens: true },
    display: { ...DEFAULT_DISPLAY },
    rules: structuredClone(DEFAULT_RULES),
  };
}

export function configPath(): string {
  return join(configDir(), "config.jsonc");
}

let cached: { mtime: number; config: Config } | null = null;

export function loadConfig(): Config {
  const path = configPath();
  if (!existsSync(path)) {
    const config = defaultConfig();
    try {
      saveConfig(config);
    } catch {
      // read-only config dir: run with defaults
    }
    return config;
  }
  try {
    const text = readFileSync(path, "utf8");
    const user = parseJsonc<Partial<Config>>(text);
    return mergeConfig(defaultConfig(), user);
  } catch {
    return defaultConfig();
  }
}

/** Merge user config over defaults. Rules are taken as a whole list when present. */
export function mergeConfig(base: Config, user: Partial<Config>): Config {
  const out: Config = structuredClone(base);
  if (user.harnesses) out.harnesses = { ...out.harnesses, ...user.harnesses };
  if (user.claude) out.claude = { ...out.claude, ...user.claude };
  if (user.copilot) out.copilot = { ...out.copilot, ...user.copilot };
  if (user.contextLimits) out.contextLimits = { ...user.contextLimits };
  if (user.notify) out.notify = { ...out.notify, ...user.notify };
  if (user.statusline) out.statusline = { ...out.statusline, ...user.statusline };
  if (user.display) {
    const d = { ...out.display, ...user.display };
    if (!DISPLAY_STYLES.includes(d.style)) d.style = DEFAULT_DISPLAY.style;
    if (d.money !== "usd" && d.money !== "credits") d.money = DEFAULT_DISPLAY.money;
    if (d.agentScope !== "today" && d.agentScope !== "session") d.agentScope = DEFAULT_DISPLAY.agentScope;
    out.display = d;
  }
  if (Array.isArray(user.rules)) out.rules = user.rules.filter(isValidRule);
  return out;
}

export function isValidRule(r: unknown): r is Rule {
  if (!r || typeof r !== "object") return false;
  const rule = r as Rule;
  return (
    typeof rule.id === "string" &&
    typeof rule.metric === "string" &&
    rule.metric in METRICS &&
    (rule.op === ">=" || rule.op === "<=") &&
    (typeof rule.value === "number" || Array.isArray(rule.steps) || typeof rule.every === "number") &&
    (rule.level === "low" || rule.level === "high" || rule.level === "critical")
  );
}

const HEADER = `// Token Usage (${PLUGIN_ID}) configuration.
//
// Edit by hand or from the dashboard's Rules view (prefix+u, then 5).
// The dashboard rewrites this file when you change a rule, so comments
// other than this header are not preserved.
//
// Rule fields:
//   metric       what to watch (see README for the full list)
//   op           ">=" or "<="
//   value        fire when the value crosses this threshold
//   steps        fire once at each step (e.g. [75, 90])
//   every        fire at every multiple (e.g. every 500 credits)
//   level        "low" (under-using), "high" or "critical"
//   notify       send a herdr toast (needs [ui.toast] delivery = "herdr")
//   billing      "copilot" | "claude" | "api" | "local": limit session rules to one billing kind
//   minCalls / maxDaysLeft / minElapsedPct: guards against noisy alerts
//
// display.style: "visual" | "text" | "spark" | "rich" (sidebar rows and tab bar)
// display.money: "usd" | "credits" (Copilot AI credits; 1 credit = $0.01)
// display.agentScope: "today" | "session" (what the agent row's money covers)
`;

export function saveConfig(config: Config): void {
  const path = configPath();
  mkdirSync(configDir(), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, HEADER + JSON.stringify(config, null, 2) + "\n");
  renameSync(tmp, path);
  cached = null;
}

export function loadConfigCached(): Config {
  let mtime = 0;
  try {
    mtime = statSync(configPath()).mtimeMs;
  } catch {
    mtime = 0;
  }
  if (cached && cached.mtime === mtime) return cached.config;
  const config = loadConfig();
  cached = { mtime, config };
  return config;
}
