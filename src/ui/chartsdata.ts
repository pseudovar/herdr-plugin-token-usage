import { basename } from "node:path";
import { harnessOf } from "../core/binding.ts";
import type { Config } from "../core/config.ts";
import type { Ledger } from "../core/ledger.ts";
import type { Pricing, Rates } from "../core/pricing.ts";
import { normalizeModel } from "../core/pricing.ts";
import type { CopilotQuota } from "../core/quota/copilot.ts";
import type { Harness, Level } from "../core/types.ts";
import { DAY, startOfLocalDay, startOfLocalWeek, startOfUtcMonth } from "../util/time.ts";
import type { BoxStats } from "./charts.ts";
import type { AgentResult } from "../core/publish.ts";

export interface Burnup {
  days: number;
  nowX: number;
  local: Array<[number, number]>;
  history: Array<[number, number]>;
  allowance: number;
  used: number;
  projected: number | null;
  periodStart: number;
  /** Alerts fired this billing month, x in days since the period start. */
  alerts: Array<{ x: number; level: Level }>;
}

export interface Anatomy {
  label: string;
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

export type DailySpend = Array<{ label: string; parts: Record<Harness, number> }>;
export interface Calendar {
  weeks: Array<Array<{ day: string; v: number } | null>>;
  months: Array<[number, string]>;
}
export interface ContextSeries {
  title: string;
  limit: number | null;
  points: number[];
}
export type Strips = Array<{ label: string; values: number[]; burn: number; level: Level; harness: Harness }>;
export type Speed = Array<{ model: string; n: number; stats: BoxStats }>;

/** The Charts view's tabs; each one only queries the data it shows. */
export const CHART_TABS = ["live", "spend", "models", "patterns"] as const;
export type ChartTab = (typeof CHART_TABS)[number];

export type ChartsData =
  | { tab: "live"; advisor: AdvisorRow[]; context: ContextSeries | null; strips: Strips }
  | { tab: "spend"; tree: TreeData; daily: DailySpend }
  | { tab: "models"; whatIf: WhatIf | null; speed: Speed }
  | {
      tab: "patterns";
      calendar: Calendar;
      hours: number[][];
      /** Alerts over the last 7 days, oldest first. */
      alerts: Array<{ ts: number; ruleId: string; level: Level }>;
      ruleTitles: Map<string, string>;
    };

/** What the Charts view needs from the runtime. */
export interface ChartsSource {
  ledger: Ledger;
  pricing: Pricing;
  config: Config;
}

// ─── Compaction advisor ─────────────────────────────────────────────────────

/** Tokens a compaction summary adds back to the prompt (rough; varies by harness). */
export const SUMMARY_TOKENS = 8_000;

export interface AdvisorInput {
  /** Current prompt size (input + cache read + cache write of the last main call). */
  prompt: number;
  /** What a fresh session starts at (smallest of its first three prompts). */
  baseline: number;
  limit: number | null;
  callsPerHour: number;
  /** Average prompt growth per call since the last compaction. */
  growthPerCall: number;
  rates: Rates | null;
}

export interface Advice {
  carryPerCall: number;
  compactPerCall: number;
  freshPerCall: number;
  savingsPerCall: number;
  carryPerHour: number | null;
  savingsPerHour: number | null;
  /** One-off cost of compacting: read everything once, write a summary, re-cache the prefix. */
  compactCost: number;
  breakEvenCalls: number | null;
  callsToLimit: number | null;
  contextPct: number | null;
  verdict: "compact now" | "compact soon" | "keep going";
}

export interface AdvisorRow {
  label: string;
  harness: Harness;
  level: Level;
  input: AdvisorInput;
  advice: Advice;
}

/**
 * Every call re-reads the whole prompt from cache, so a long context costs
 * `prompt × cache-read rate` per call. Compacting shrinks that to roughly the
 * starting prompt plus a summary, for a one-off cost.
 */
export function advise(i: AdvisorInput): Advice {
  const r = i.rates;
  const cr = r ? (r.cacheRead || r.input) / 1e6 : 0;
  const cw = r ? (r.cacheWrite || r.input) / 1e6 : 0;
  const out = r ? r.output / 1e6 : 0;
  const compacted = Math.min(i.prompt, i.baseline + SUMMARY_TOKENS);
  const carryPerCall = i.prompt * cr;
  const compactPerCall = compacted * cr;
  const savingsPerCall = Math.max(0, carryPerCall - compactPerCall);
  const perHour = (v: number) => (i.callsPerHour > 0 ? v * i.callsPerHour : null);
  const savingsPerHour = perHour(savingsPerCall);
  const compactCost = i.prompt * cr + SUMMARY_TOKENS * out + compacted * cw;
  const contextPct = i.limit ? (i.prompt / i.limit) * 100 : null;
  // Idle sessions are judged on what the next 20 calls would cost.
  const pressure = savingsPerHour ?? savingsPerCall * 20;
  return {
    carryPerCall,
    compactPerCall,
    freshPerCall: i.baseline * cr,
    savingsPerCall,
    carryPerHour: perHour(carryPerCall),
    savingsPerHour,
    compactCost,
    breakEvenCalls: savingsPerCall > 0 ? Math.ceil(compactCost / savingsPerCall) : null,
    callsToLimit: i.limit && i.growthPerCall > 0 ? Math.max(0, Math.floor((0.92 * i.limit - i.prompt) / i.growthPerCall)) : null,
    contextPct,
    verdict: (contextPct ?? 0) >= 80 || pressure >= 2 ? "compact now" : pressure >= 0.5 ? "compact soon" : "keep going",
  };
}

function advisorRows(src: ChartsSource, agents: AgentResult[], labels: Map<string, string>, now: number): AdvisorRow[] {
  const rows: AdvisorRow[] = [];
  for (const a of agents) {
    const harness = harnessOf(a.agent.agent);
    if (!harness || !a.binding?.sessionId) continue;
    const calls = src.ledger.all<{ ts: number; p: number; model: string; provider: string | null; billing: string }>(
      `SELECT ts, input + cache_read + cache_write AS p, model, provider, billing FROM request
       WHERE harness = ? AND root_session_id = ? AND is_subagent = 0 ORDER BY ts`,
      harness,
      a.binding.sessionId,
    );
    if (calls.length === 0) continue;
    const last = calls[calls.length - 1];
    const firsts = calls.slice(0, 3).map((c) => c.p).filter((p) => p > 0);
    // Measure growth only since the last compaction (a drop of more than 30%).
    let since = 0;
    for (let k = 1; k < calls.length; k++) if (calls[k].p < calls[k - 1].p * 0.7) since = k;
    const recent = calls.slice(Math.max(since, calls.length - 11));
    const input: AdvisorInput = {
      prompt: last.p,
      baseline: firsts.length ? Math.min(...firsts) : last.p,
      limit: a.metrics?.contextLimit ?? null,
      callsPerHour: calls.filter((c) => c.ts >= now - 3_600_000).length,
      growthPerCall: recent.length > 1 ? Math.max(0, (recent[recent.length - 1].p - recent[0].p) / (recent.length - 1)) : 0,
      rates: src.pricing.ratesUsd(last.billing, last.provider, last.model),
    };
    const ws = labels.get(a.agent.workspace_id) ?? a.agent.workspace_id;
    rows.push({ label: `${a.agent.agent.padEnd(9)}${ws}`, harness, level: a.level, input, advice: advise(input) });
  }
  return rows;
}

// ─── Model what-if ──────────────────────────────────────────────────────────

export interface WhatIf {
  label: string;
  tokens: { input: number; cacheWrite: number; cacheRead: number; output: number };
  actual: number;
  rows: Array<{ model: string; usd: number; used: boolean }>;
}

/** The period's tokens re-priced at each model's rate (Copilot card first, then catalogs). */
export function buildWhatIf(src: ChartsSource, since: number, label: string): WhatIf | null {
  const t = src.ledger.get<{ i: number; cw: number; cr: number; o: number; usd: number }>(
    `SELECT COALESCE(SUM(input), 0) AS i, COALESCE(SUM(cache_write), 0) AS cw, COALESCE(SUM(cache_read), 0) AS cr,
            COALESCE(SUM(output), 0) AS o, COALESCE(SUM(cost_usd), 0) AS usd
     FROM request WHERE ts >= ? AND billing <> 'local'`,
    since,
  );
  if (!t || t.usd <= 0) return null;
  const used = new Map<string, string>();
  for (const r of src.ledger.all<{ model: string }>("SELECT DISTINCT model FROM request WHERE ts >= ? AND billing <> 'local'", since)) {
    used.set(normalizeModel(r.model), r.model.replace(/-\d{8}$/, ""));
  }
  // Card keys are normalised (claude-opus-5-5); show the spelling you used (claude-opus-5.5).
  const names = new Map<string, string>(used);
  for (const m of src.pricing.copilotCardModels()) if (!names.has(normalizeModel(m))) names.set(normalizeModel(m), m);
  const rows: WhatIf["rows"] = [];
  for (const [key, model] of names) {
    const r = src.pricing.ratesUsd("copilot", "github-copilot", model) ?? src.pricing.ratesUsd("api", null, model);
    if (!r || !(r.input > 0) || !(r.output > 0)) continue;
    const usd = (t.i * r.input + t.cw * (r.cacheWrite || r.input) + t.cr * (r.cacheRead || r.input) + t.o * r.output) / 1e6;
    rows.push({ model, usd, used: used.has(key) });
  }
  rows.sort((a, b) => a.usd - b.usd);
  return { label, tokens: { input: t.i, cacheWrite: t.cw, cacheRead: t.cr, output: t.o }, actual: t.usd, rows: rows.slice(0, 12) };
}

// ─── Treemap: project → session → model ─────────────────────────────────────

export interface TreeData {
  label: string;
  total: number;
  groups: Array<{ key: string; usd: number; sessions: Array<{ title: string; usd: number; model: string; models: number }> }>;
}

export function buildTree(ledger: Ledger, since: number, label: string): TreeData {
  const projects = new Map<string, Map<string, { title: string; models: Map<string, number> }>>();
  for (const r of ledger.all<{ cwd: string | null; harness: string; sid: string; model: string; usd: number; title: string | null; first: number }>(
    `SELECT r.cwd AS cwd, r.harness AS harness, r.root_session_id AS sid, r.model AS model,
            SUM(r.cost_usd) AS usd, MAX(s.title) AS title, MIN(r.ts) AS first
     FROM request r LEFT JOIN session s ON s.harness = r.harness AND s.id = r.root_session_id
     WHERE r.ts >= ? AND r.cost_usd > 0
     GROUP BY r.cwd, r.harness, r.root_session_id, r.model`,
    since,
  )) {
    const key = r.cwd ? basename(r.cwd) : "(unknown)";
    const sessions = projects.get(key) ?? new Map();
    projects.set(key, sessions);
    const id = `${r.harness}:${r.sid}`;
    // Untitled sessions are named by harness and start time, which says more than an id.
    const started = new Date(r.first).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
    const s = sessions.get(id) ?? { title: r.title?.trim() || `${r.harness} · ${started}`, models: new Map<string, number>() };
    s.models.set(r.model, (s.models.get(r.model) ?? 0) + r.usd);
    sessions.set(id, s);
  }
  const groups: TreeData["groups"] = [...projects.entries()].map(([key, sessions]) => {
    const list = [...sessions.values()].map((s) => {
      const models = [...s.models.entries()].sort((a, b) => b[1] - a[1]);
      return { title: s.title, usd: models.reduce((sum, [, v]) => sum + v, 0), model: models[0][0], models: models.length };
    });
    list.sort((a, b) => b.usd - a.usd);
    return { key, usd: list.reduce((sum, s) => sum + s.usd, 0), sessions: list };
  });
  groups.sort((a, b) => b.usd - a.usd);
  return { label, total: groups.reduce((s, g) => s + g.usd, 0), groups };
}

const DAY_KEY = "strftime('%Y-%m-%d', ts / 1000, 'unixepoch', 'localtime')";

function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function pct(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

/** Copilot spend over the billing month (UTC, as GitHub bills it), in USD. */
export function buildBurnup(ledger: Ledger, q: CopilotQuota | null, now = Date.now()): Burnup | null {
  if (!q || !q.entitlement) return null;
  const days = Math.round((q.resetAt - q.periodStart) / DAY);
  const nowX = (now - q.periodStart) / DAY;
  const perDay = new Array<number>(days).fill(0);
  for (const r of ledger.all<{ d: number; v: number }>(
    `SELECT CAST((ts - ?) / 86400000 AS INTEGER) AS d, SUM(cost_usd) AS v FROM request
     WHERE billing = 'copilot' AND ts >= ? AND ts < ? GROUP BY d`,
    q.periodStart,
    q.periodStart,
    q.resetAt,
  )) {
    if (r.d >= 0 && r.d < days) perDay[r.d] = r.v ?? 0;
  }
  const local: Array<[number, number]> = [[0, 0]];
  let cum = 0;
  for (let d = 0; d < Math.min(days, Math.ceil(nowX)); d++) {
    cum += perDay[d];
    local.push([Math.min(d + 1, nowX), cum]);
  }
  const history = ledger
    .all<{ ts: number; used: number }>("SELECT ts, used FROM quota_history WHERE provider = 'copilot' AND ts >= ? ORDER BY ts", q.periodStart)
    .map((r) => [(r.ts - q.periodStart) / DAY, r.used / 100] as [number, number]);
  return {
    days,
    nowX,
    local,
    history,
    allowance: q.entitlement / 100,
    used: (q.used ?? 0) / 100,
    projected: q.projectedPct != null ? (q.projectedPct / 100) * (q.entitlement / 100) : null,
    periodStart: q.periodStart,
    alerts: ledger
      .all<{ ts: number; level: Level }>("SELECT ts, level FROM alert_log WHERE ts >= ? ORDER BY ts", q.periodStart)
      .map((r) => ({ x: (r.ts - q.periodStart) / DAY, level: r.level })),
  };
}

/** What the money is spent on: input / cache write / cache read / output, in USD. */
export function buildAnatomy(ledger: Ledger, pricing: Pricing, agents: AgentResult[], now = Date.now()): Anatomy[] {
  const today0 = startOfLocalDay(now);
  const anatomyFor = (label: string, where: string, ...params: Array<string | number>): Anatomy => {
    const out: Anatomy = { label, input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
    for (const r of ledger.all<{ billing: string; provider: string | null; model: string; i: number; cw: number; cr: number; o: number }>(
      `SELECT billing, provider, model, SUM(input) AS i, SUM(cache_write) AS cw, SUM(cache_read) AS cr, SUM(output) AS o
       FROM request WHERE ${where} GROUP BY billing, provider, model`,
      ...params,
    )) {
      const rates = pricing.ratesUsd(r.billing, r.provider, r.model);
      if (!rates) continue;
      out.input += (r.i * rates.input) / 1e6;
      out.cacheWrite += (r.cw * rates.cacheWrite) / 1e6;
      out.cacheRead += (r.cr * rates.cacheRead) / 1e6;
      out.output += (r.o * rates.output) / 1e6;
    }
    return out;
  };
  const out = [anatomyFor("today", "ts >= ?", today0), anatomyFor("last 30 days", "ts >= ?", today0 - 29 * DAY)];
  const busiest = [...agents]
    .filter((a) => a.metrics && a.binding?.sessionId)
    .sort((a, b) => (b.metrics?.costUsd ?? 0) - (a.metrics?.costUsd ?? 0))[0];
  if (busiest?.metrics && busiest.binding?.sessionId) {
    out.push(anatomyFor(`${busiest.agent.agent} session`, "harness = ? AND root_session_id = ?", busiest.metrics.harness, busiest.binding.sessionId));
  }
  return out;
}

/** Data for one Charts tab (only computed while the Charts view shows it). */
export function buildChartsData(
  src: ChartsSource,
  tab: ChartTab,
  agents: AgentResult[],
  labels: Map<string, string>,
  quota: CopilotQuota | null,
  now = Date.now(),
): ChartsData {
  const { ledger } = src;
  const today0 = startOfLocalDay(now);
  switch (tab) {
    case "live":
      return { tab, advisor: advisorRows(src, agents, labels, now), context: contextGrowth(ledger, agents, labels), strips: liveStrips(ledger, agents, labels, now) };
    case "spend":
      return { tab, tree: buildTree(ledger, today0 - 29 * DAY, "last 30 days"), daily: dailySpend(ledger, today0) };
    case "models":
      return {
        tab,
        whatIf: buildWhatIf(src, quota?.periodStart ?? startOfUtcMonth(now), quota ? "this billing month" : "this month"),
        speed: speedByModel(ledger, today0),
      };
    case "patterns":
      return {
        tab,
        calendar: calendar(ledger, now),
        hours: weekdayHours(ledger, today0),
        alerts: ledger
          .all<{ ts: number; rule_id: string; level: Level }>("SELECT ts, rule_id, level FROM alert_log WHERE ts >= ? ORDER BY ts", now - 7 * DAY)
          .map((r) => ({ ts: r.ts, ruleId: r.rule_id, level: r.level })),
        ruleTitles: new Map(src.config.rules.map((r) => [r.id, r.title])),
      };
  }
}

/** Daily spend by harness, last 21 days. */
function dailySpend(ledger: Ledger, today0: number): DailySpend {
  const firstDay = today0 - 20 * DAY;
  const byDay = new Map<string, Record<Harness, number>>();
  for (const r of ledger.all<{ day: string; harness: Harness; v: number }>(
    `SELECT ${DAY_KEY} AS day, harness, SUM(cost_usd) AS v FROM request WHERE ts >= ? GROUP BY day, harness`,
    firstDay,
  )) {
    const rec = byDay.get(r.day) ?? { pi: 0, opencode: 0, copilot: 0, claude: 0 };
    rec[r.harness] = r.v ?? 0;
    byDay.set(r.day, rec);
  }
  const daily: DailySpend = [];
  for (let i = 0; i < 21; i++) {
    const d = new Date(firstDay);
    d.setDate(d.getDate() + i);
    daily.push({ label: String(d.getDate()).padStart(2, " "), parts: byDay.get(dayKey(d.getTime())) ?? { pi: 0, opencode: 0, copilot: 0, claude: 0 } });
  }
  return daily;
}

/** Calendar heatmap, 20 weeks (Monday-start columns). */
function calendar(ledger: Ledger, now: number): Calendar {
  const weeksN = 20;
  const calStart = startOfLocalWeek(now) - (weeksN - 1) * 7 * DAY;
  const spend = new Map<string, number>();
  for (const r of ledger.all<{ day: string; v: number }>(`SELECT ${DAY_KEY} AS day, SUM(cost_usd) AS v FROM request WHERE ts >= ? GROUP BY day`, calStart)) {
    spend.set(r.day, r.v ?? 0);
  }
  const weeks: Calendar["weeks"] = [];
  const months: Calendar["months"] = [];
  let lastMonth = -1;
  for (let w = 0; w < weeksN; w++) {
    const col: Array<{ day: string; v: number } | null> = [];
    for (let dow = 0; dow < 7; dow++) {
      const d = new Date(calStart);
      d.setDate(d.getDate() + w * 7 + dow);
      if (d.getTime() > now) {
        col.push(null);
        continue;
      }
      const key = dayKey(d.getTime());
      col.push({ day: key, v: spend.get(key) ?? 0 });
      if (dow === 0 && d.getMonth() !== lastMonth) {
        months.push([w, d.toLocaleDateString("en-AU", { month: "short" })]);
        lastMonth = d.getMonth();
      }
    }
    weeks.push(col);
  }
  return { weeks, months };
}

/** Spend by weekday (Monday first) × hour, last 30 days. */
function weekdayHours(ledger: Ledger, today0: number): number[][] {
  const hours = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  for (const r of ledger.all<{ dow: string; hr: string; v: number }>(
    `SELECT strftime('%w', ts / 1000, 'unixepoch', 'localtime') AS dow,
            strftime('%H', ts / 1000, 'unixepoch', 'localtime') AS hr, SUM(cost_usd) AS v
     FROM request WHERE ts >= ? GROUP BY dow, hr`,
    today0 - 29 * DAY,
  )) {
    hours[(Number(r.dow) + 6) % 7][Number(r.hr)] = r.v ?? 0;
  }
  return hours;
}

/** Prompt size per call of the fullest live session. */
function contextGrowth(ledger: Ledger, agents: AgentResult[], labels: Map<string, string>): ContextSeries | null {
  const fullest = [...agents]
    .filter((a) => a.metrics?.contextTokens != null && a.binding?.sessionId)
    .sort((a, b) => (b.metrics?.contextPct ?? 0) - (a.metrics?.contextPct ?? 0))[0];
  if (!fullest?.metrics || !fullest.binding?.sessionId) return null;
  const points = ledger
    .all<{ p: number }>(
      `SELECT input + cache_read + cache_write AS p FROM request
       WHERE harness = ? AND root_session_id = ? AND is_subagent = 0 ORDER BY ts`,
      fullest.metrics.harness,
      fullest.binding.sessionId,
    )
    .map((r) => r.p);
  const ws = labels.get(fullest.agent.workspace_id) ?? fullest.agent.workspace_id;
  return { title: `${ws} · ${fullest.agent.agent}${fullest.metrics.title ? ` · ${fullest.metrics.title}` : ""}`, limit: fullest.metrics.contextLimit, points };
}

/** Live agent strips: spend per 2 minutes, last hour. */
function liveStrips(ledger: Ledger, agents: AgentResult[], labels: Map<string, string>, now: number): Strips {
  const base = now - 60 * 60_000;
  const strips: Strips = [];
  for (const a of agents) {
    const harness = harnessOf(a.agent.agent);
    if (!harness || !a.binding?.sessionId) continue;
    const values = new Array<number>(30).fill(0);
    for (const r of ledger.all<{ b: number; v: number }>(
      `SELECT CAST((ts - ?) / 120000 AS INTEGER) AS b, SUM(cost_usd) AS v FROM request
       WHERE harness = ? AND root_session_id = ? AND ts >= ? GROUP BY b`,
      base,
      harness,
      a.binding.sessionId,
      base,
    )) {
      if (r.b >= 0 && r.b < 30) values[r.b] = r.v ?? 0;
    }
    const ws = labels.get(a.agent.workspace_id) ?? a.agent.workspace_id;
    strips.push({ label: `${a.agent.agent.padEnd(9)}${ws}`, values, burn: a.metrics?.costUsd5m ?? 0, level: a.level, harness });
  }
  return strips;
}

/** Output speed by model, last 7 days. */
function speedByModel(ledger: Ledger, today0: number): Speed {
  const perModel = new Map<string, number[]>();
  for (const r of ledger.all<{ model: string; output: number; duration_ms: number | null; ttft_ms: number | null; itl_ms: number | null }>(
    `SELECT model, output, duration_ms, ttft_ms, itl_ms FROM request
     WHERE ts >= ? AND (itl_ms > 0 OR (duration_ms > 500 AND output > 20))`,
    today0 - 6 * DAY,
  )) {
    let tps: number | null = null;
    if (r.itl_ms && r.itl_ms > 0) tps = 1000 / r.itl_ms;
    else if (r.duration_ms) {
      const gen = r.ttft_ms && r.ttft_ms < r.duration_ms ? r.duration_ms - r.ttft_ms : r.duration_ms;
      tps = r.output / (gen / 1000);
    }
    if (tps == null || !Number.isFinite(tps) || tps > 2000) continue;
    const list = perModel.get(r.model) ?? [];
    list.push(tps);
    perModel.set(r.model, list);
  }
  return [...perModel.entries()]
    .filter(([, v]) => v.length >= 5)
    .map(([m, v]) => {
      const s = [...v].sort((a, b) => a - b);
      return { model: m, n: s.length, stats: { p10: pct(s, 10), p25: pct(s, 25), p50: pct(s, 50), p75: pct(s, 75), p90: pct(s, 90) } };
    })
    .sort((a, b) => b.stats.p50 - a.stats.p50)
    .slice(0, 8);
}
