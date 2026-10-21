/**
 * Display system for herdr's text-only surfaces (sidebar rows, tab bar).
 *
 * One grammar everywhere: `<level glyph> <money> <visual>`. Agents, spaces
 * and the tab bar use the same unit and (by default) the same scope, today,
 * so the numbers add up: agents ⊂ space ⊂ tab bar.
 */
import type { CopilotQuota } from "./quota/copilot.ts";
import { LEVEL_GLYPH } from "./types.ts";
import type { Billing, Level } from "./types.ts";
import { fmtCredits, fmtPace, fmtPct, fmtTokens, fmtUsd, sortKey } from "../util/format.ts";

export type DisplayStyle = "text" | "visual" | "spark" | "rich";
export const DISPLAY_STYLES: DisplayStyle[] = ["rich", "visual", "text", "spark"];
export type MoneyUnit = "usd" | "credits";
export type AgentScope = "today" | "session";

export interface DisplayConfig {
  style: DisplayStyle;
  money: MoneyUnit;
  agentScope: AgentScope;
}

export const DEFAULT_DISPLAY: DisplayConfig = { style: "rich", money: "usd", agentScope: "today" };

export const STYLE_HINT: Record<DisplayStyle, string> = {
  text: "money and context %",
  visual: "money, context gauge, activity sparkline",
  spark: "money, per-call cost sparkline",
  rich: "visual plus a detail line: speed, burn, share",
};

/** Money in the configured unit. Copilot spend is credits; 1 credit = $0.01. */
export function money(unit: MoneyUnit, usd: number, copilotCredits = 0): string {
  if (unit === "credits" && copilotCredits > 0) {
    const other = usd - copilotCredits / 100;
    return other >= 0.005 ? `${fmtCredits(copilotCredits)}+${fmtUsd(other)}` : fmtCredits(copilotCredits);
  }
  return fmtUsd(usd);
}

const SPARK = "▁▂▃▄▅▆▇█";

/** Zero-anchored sparkline for text-only surfaces (no colour available). */
export function textSpark(values: number[]): string {
  const max = Math.max(0, ...values);
  if (max <= 0) return "▁".repeat(values.length);
  return values
    .map((v) => (v <= 0 ? "▁" : SPARK[Math.min(7, Math.max(0, Math.ceil((v / max) * 8) - 1))]))
    .join("");
}

/**
 * `██▍░░░` gauge with eighth-cell precision; any usage shows at least a sliver.
 * Block elements are drawn by terminals themselves at exactly one cell.
 * Geometric shapes like ▰▱ come from fallback fonts (Menlo, in Ghostty) and
 * can spill into the next cell, swallowing the space after the gauge.
 */
export function textGauge(pct: number, cells = 6): string {
  const exact = Math.max(0, Math.min(cells, (pct / 100) * cells));
  let out = "";
  for (let i = 0; i < cells; i++) {
    const fill = exact - i;
    const eighths = fill > 0 && fill < 1 ? Math.max(1, Math.round(fill * 8)) : 0;
    out += fill >= 1 || eighths === 8 ? "█" : eighths > 0 ? EIGHTHS[eighths] : "░";
  }
  return out;
}

const EIGHTHS = " ▏▎▍▌▋▊▉";

/** Eighth-block bar for the tab bar: `▕███▋░░┃░░▏` with an optional marker. */
export function textBar(pct: number, cells: number, markerPct: number | null = null): string {
  const exact = Math.max(0, Math.min(cells, (pct / 100) * cells));
  const marker = markerPct == null ? -1 : Math.max(0, Math.min(cells - 1, Math.round((markerPct / 100) * cells)));
  const eighths = " ▏▎▍▌▋▊▉";
  let out = "";
  for (let i = 0; i < cells; i++) {
    if (i === marker) {
      out += "┃";
      continue;
    }
    const fill = exact - i;
    if (fill >= 1) out += "█";
    else if (fill > 0) out += eighths[Math.max(1, Math.round(fill * 8))] ?? "▌";
    else out += "░";
  }
  return `▕${out}▏`;
}

/** `claude-opus-5.5` → `opus-5.5`, `gpt-6.1-sol` stays. */
export function shortModel(model: string | null): string | null {
  if (!model) return null;
  return model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

/**
 * Detail rows sit indented under herdr's sidebar (26 columns by default), so
 * they're capped at 24 characters. Parts keep their order; the
 * least important ones (highest rank) are dropped until the row fits.
 */
export const DETAIL_MAX = 24;

export function detailLine(parts: Array<[string | null, number]>, max = DETAIL_MAX): string | null {
  let keep = parts.filter((p): p is [string, number] => p[0] != null);
  const text = () => keep.map(([s]) => s).join(" · ");
  while (keep.length > 1 && text().length > max) {
    const worst = Math.max(...keep.map(([, rank]) => rank));
    keep = keep.filter(([, rank]) => rank !== worst);
  }
  return keep.length ? text() : null;
}

// ─── Agent rows ─────────────────────────────────────────────────────────────

export interface AgentView {
  level: Level;
  billing: Billing;
  /** Money for the configured scope (USD; Copilot credits / 100). */
  usd: number;
  credits: number;
  sessionUsd: number;
  sessionCredits: number;
  workTokens: number;
  contextPct: number | null;
  contextTokens: number | null;
  model: string | null;
  tps: number | null;
  burn5mUsd: number;
  /** Per-call cost, oldest → newest (spark style). */
  recentCalls: number[];
}

/** Every agent token this plugin owns (all cleared together when an agent leaves). */
export const AGENT_TOKEN_KEYS = [
  "tu",
  "tu_sub",
  "tu_more",
  // stable building blocks for hand-made rows
  "tu_money",
  "tu_tok",
  "tu_ctx",
  "tu_ctx_bar",
  "tu_tps",
  "tu_ctx_num",
  "tu_cost",
  "tu_cost_num",
  "tu_level",
  "tu_sort",
] as const;

export type TokenMap = Record<string, string | null>;

function ctxText(v: AgentView): string | null {
  if (v.contextPct != null) return `${Math.round(v.contextPct)}%`;
  if (v.contextTokens != null) return fmtTokens(v.contextTokens);
  return null;
}

export function agentTokens(v: AgentView | null, d: DisplayConfig): TokenMap {
  const out: TokenMap = Object.fromEntries(AGENT_TOKEN_KEYS.map((k) => [k, null]));
  if (!v) return out;
  const glyph = LEVEL_GLYPH[v.level];
  const m = money(d.money, v.usd, v.credits);
  const ctx = ctxText(v);
  const gauge = v.contextPct != null ? textGauge(v.contextPct) : null;
  const model = shortModel(v.model);
  switch (d.style) {
    case "text":
      out.tu = `${glyph} ${m}${ctx ? ` · ctx ${ctx}` : ""}`;
      break;
    case "visual":
      out.tu = `${glyph} ${m}${gauge ? ` ${gauge} ${ctx}` : ctx ? ` · ctx ${ctx}` : ""}`;
      break;
    case "spark": {
      const spark = v.recentCalls.length ? ` ${textSpark(v.recentCalls)}` : "";
      out.tu = `${glyph} ${m}${spark}${ctx ? ` ${ctx}` : ""}`;
      break;
    }
    case "rich":
      out.tu = `${glyph} ${m}${gauge ? ` ${gauge} ${ctx}` : ctx ? ` · ctx ${ctx}` : ""}`;
      out.tu_more = detailLine([
        [v.burn5mUsd >= 0.01 ? `${money(d.money, v.burn5mUsd, v.billing === "copilot" ? v.burn5mUsd * 100 : 0)}/5m` : null, 0],
        [v.tps != null ? `${Math.round(v.tps)} t/s` : null, 1],
        [`${fmtTokens(v.workTokens)} tok`, 2],
      ]);
      break;
  }
  out.tu_sub = model;
  out.tu_money = m;
  out.tu_tok = fmtTokens(v.workTokens);
  out.tu_ctx = ctx ? `ctx ${ctx}` : null;
  out.tu_ctx_bar = gauge;
  out.tu_ctx_num = v.contextPct != null ? String(Math.round(v.contextPct)) : null;
  out.tu_tps = v.tps != null ? `${Math.round(v.tps)} t/s` : null;
  out.tu_cost = money(d.money, v.sessionUsd, v.sessionCredits);
  out.tu_cost_num = v.sessionUsd.toFixed(2);
  out.tu_level = v.level;
  out.tu_sort = sortKey(v.sessionUsd * 1e6);
  return out;
}

// ─── Space rows ─────────────────────────────────────────────────────────────

export interface SpaceView {
  level: Level;
  usd: number;
  credits: number;
  workTokens: number;
  /** Share of today's total spend, 0–100. */
  sharePct: number | null;
  /** Spend per hour, last 8 hours, oldest → newest. */
  hourly: number[];
  agents: number;
}

export const SPACE_TOKEN_KEYS = ["tu_ws", "tu_ws_more", "tu_ws_cost", "tu_ws_tok", "tu_ws_spark"] as const;

export function spaceTokens(v: SpaceView | null, d: DisplayConfig): TokenMap {
  const out: TokenMap = Object.fromEntries(SPACE_TOKEN_KEYS.map((k) => [k, null]));
  if (!v) return out;
  const glyph = LEVEL_GLYPH[v.level];
  const m = money(d.money, v.usd, v.credits);
  const spark = v.hourly.some((x) => x > 0) ? textSpark(v.hourly) : null;
  switch (d.style) {
    case "text":
      out.tu_ws = `${glyph} ${m} today`;
      break;
    case "visual":
    case "spark":
      out.tu_ws = `${glyph} ${m}${spark ? ` ${spark}` : " today"}`;
      break;
    case "rich":
      out.tu_ws = `${glyph} ${m}${spark ? ` ${spark}` : " today"}`;
      out.tu_ws_more = detailLine([
        [v.sharePct != null ? `${v.sharePct > 0 && v.sharePct < 1 ? "<1%" : fmtPct(v.sharePct)} of today` : null, 0],
        [`${fmtTokens(v.workTokens)} tok`, 1],
        [v.agents > 1 ? `${v.agents} agents` : null, 2],
      ]);
      break;
  }
  out.tu_ws_cost = m;
  out.tu_ws_tok = fmtTokens(v.workTokens);
  out.tu_ws_spark = spark;
  return out;
}

// ─── Tab bar ────────────────────────────────────────────────────────────────

export interface TabView {
  quota: CopilotQuota | null;
  quotaLevel: Level;
  todayUsd: number;
  todayCredits: number;
  workTokens: number;
  /** Daily spend, last 7 days, oldest → newest. */
  daily: number[];
  burn5mUsd: number;
  snoozed: boolean;
}

function quotaMoney(q: CopilotQuota, unit: MoneyUnit): { used: string; total: string } {
  if (unit === "credits") return { used: fmtCredits(q.used ?? 0), total: fmtCredits(q.entitlement ?? 0) };
  return { used: fmtUsd((q.used ?? 0) / 100), total: fmtUsd((q.entitlement ?? 0) / 100) };
}

/** The one line herdr shows in the tab bar (≤ 80 chars, no colour). */
export function tabBarText(v: TabView, d: DisplayConfig): string {
  const q = v.quota;
  const parts: string[] = [];
  const today = money(d.money, v.todayUsd, v.todayCredits);
  const glyph = LEVEL_GLYPH[v.quotaLevel];
  if (q && q.usedPct != null) {
    const pct = `${Math.round(q.usedPct)}%`;
    const pace = q.pace != null ? fmtPace(q.pace) : "";
    switch (d.style) {
      case "text":
        parts.push(`Copilot ${glyph} ${pct}${pace ? ` · ${pace}` : ""}`);
        break;
      case "visual":
        parts.push(`Copilot ${textBar(q.usedPct, 10, q.elapsedPct)} ${pct}${pace ? ` ${pace}` : ""}`);
        break;
      case "spark":
        parts.push(`Copilot ${glyph} ${pct}${pace ? ` · ${pace}` : ""}`);
        break;
      case "rich": {
        const qm = quotaMoney(q, d.money);
        parts.push(`Copilot ${glyph} ${qm.used}/${qm.total}${pace ? ` · ${pace}` : ""} · ${Math.ceil(q.daysLeft)}d left`);
        break;
      }
    }
  } else if (q?.unlimited && q.used != null) {
    parts.push(`Copilot ${money(d.money, q.used / 100, q.used)} used`);
  }
  let todayPart = `today ${today}`;
  if (d.style === "spark" && v.daily.some((x) => x > 0)) todayPart += ` ${textSpark(v.daily)}`;
  if (d.style === "rich" && v.burn5mUsd >= 0.01) todayPart += ` · ${fmtUsd(v.burn5mUsd)}/5m`;
  if (d.style === "text" && v.workTokens > 0) todayPart += ` · ${fmtTokens(v.workTokens)} tok`;
  parts.push(todayPart);
  if (v.snoozed) parts.push("alerts snoozed");
  const text = parts.join(" │ ");
  return text.length > 80 ? text.slice(0, 79) + "…" : text;
}
