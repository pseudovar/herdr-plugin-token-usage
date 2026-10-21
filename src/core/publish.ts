import type { Config } from "./config.ts";
import { allBindings, deleteBinding, getBinding, harnessOf, resolveSession, saveBinding } from "./binding.ts";
import type { Binding } from "./binding.ts";
import type { Ledger } from "./ledger.ts";
import { sessionCalls, sessionMetrics, totals } from "./metrics.ts";
import type { SessionMetrics } from "./metrics.ts";
import type { Pricing } from "./pricing.ts";
import type { CopilotQuota } from "./quota/copilot.ts";
import { getCopilotQuota } from "./quota/copilot.ts";
import { coalesce, evaluate, isSnoozed } from "./rules.ts";
import type { Firing } from "./rules.ts";
import { diffTokens } from "./surfaces.ts";
import { AGENT_TOKEN_KEYS, SPACE_TOKEN_KEYS, agentTokens, spaceTokens } from "./display.ts";
import type { AgentView, SpaceView, TabView, TokenMap } from "./display.ts";
import type { Level } from "./types.ts";
import { HARNESS_LABEL, maxLevel } from "./types.ts";
import { listAgents, listWorkspaces, notify, reportPaneTokens, reportWorkspaceTokens } from "../herdr/client.ts";
import type { AgentInfo, WorkspaceInfo } from "../herdr/client.ts";
import { log } from "../util/log.ts";
import { MINUTE, startOfLocalDay } from "../util/time.ts";

export interface PublishContext {
  ledger: Ledger;
  pricing: Pricing;
  config: Config;
  now: number;
  quota: CopilotQuota | null;
  workspaceLabels: Map<string, string>;
  /** Collected toasts, sent once at the end (herdr allows one toast per second). */
  firings: Firing[];
  /** Compute everything but report nothing to herdr and persist no alert state. */
  dryRun?: boolean;
}

export function loadQuota(ledger: Ledger, config: Config, allowFetch: boolean, timeoutMs = 4000): CopilotQuota | null {
  if (!config.copilot.quota) return null;
  try {
    return getCopilotQuota(ledger, {
      allowFetch,
      maxAgeMs: Math.max(1, config.copilot.refreshMinutes) * MINUTE,
      timeoutMs,
    });
  } catch (err) {
    log.error("copilot quota", err);
    return null;
  }
}

export interface AgentResult {
  agent: AgentInfo;
  binding: Binding | null;
  metrics: SessionMetrics | null;
  level: Level;
  /** What the sidebar shows for this pane (null = nothing to show yet). */
  view: AgentView | null;
  patch: TokenMap;
}

function contextOverride(config: Config) {
  const entries = Object.entries(config.contextLimits);
  if (entries.length === 0) return undefined;
  const map = new Map(entries.map(([k, v]) => [k.toLowerCase().replace(/\./g, "-"), v]));
  return (model: string) => map.get(model.toLowerCase().replace(/\./g, "-")) ?? null;
}

/** Sessions currently owned by other live panes (so heuristics never double-bind). */
export function claimedSessions(ledger: Ledger, agents: AgentInfo[], exceptTerminal: string): Set<string> {
  const live = new Set(agents.map((a) => a.terminal_id));
  const out = new Set<string>();
  for (const b of allBindings(ledger)) {
    if (b.terminalId !== exceptTerminal && live.has(b.terminalId) && b.sessionId) out.add(b.sessionId);
  }
  return out;
}

/**
 * Bind one agent pane to its session, compute its metrics and rule level,
 * and report changed sidebar tokens. Never throws (hooks must not fail).
 */
export async function publishAgent(
  pc: PublishContext,
  agent: AgentInfo,
  agents: AgentInfo[],
  opts: { evaluateRules?: boolean } = {},
): Promise<AgentResult> {
  const { ledger, config, now } = pc;
  const harness = harnessOf(agent.agent);
  let prev = getBinding(ledger, agent.terminal_id);
  const result: AgentResult = { agent, binding: null, metrics: null, level: "normal", view: null, patch: {} };
  try {
    if (prev && prev.agent !== agent.agent) {
      await clearPaneTokens(agent.pane_id, agent.tokens);
      deleteBinding(ledger, agent.terminal_id);
      prev = null;
    }
    if (!harness) {
      if (prev) deleteBinding(ledger, agent.terminal_id);
      return result;
    }
    const resolution = resolveSession(ledger, agent, harness, prev, claimedSessions(ledger, agents, agent.terminal_id));
    const binding: Binding = {
      terminalId: agent.terminal_id,
      paneId: agent.pane_id,
      workspaceId: agent.workspace_id,
      agent: agent.agent,
      harness,
      sessionId: resolution?.sessionId ?? null,
      method: resolution?.method ?? null,
      boundAt: resolution && resolution.sessionId === prev?.sessionId ? (prev?.boundAt ?? now) : now,
      agentSeenAt: prev?.agentSeenAt ?? null,
      lastStatus: agent.agent_status,
      statusAt: prev?.lastStatus === agent.agent_status ? (prev?.statusAt ?? now) : now,
    };
    saveBinding(ledger, binding, now);
    result.binding = binding;
    const metrics = binding.sessionId
      ? sessionMetrics(ledger, harness, binding.sessionId, now, contextOverride(config))
      : null;
    result.metrics = metrics;
    if (metrics && opts.evaluateRules !== false) {
      const wsLabel = pc.workspaceLabels.get(agent.workspace_id) ?? agent.workspace_id;
      const shortWs = wsLabel.length > 22 ? wsLabel.slice(0, 21) + "…" : wsLabel;
      const evaluation = ledger.transaction(() =>
        evaluate(
          ledger,
          config,
          "session",
          {
            now,
            quota: pc.quota,
            today: null,
            session: metrics,
            labels: { agent: `${shortWs} · ${HARNESS_LABEL[harness]}`, where: metrics.title ?? undefined },
          },
          !pc.dryRun,
        ),
      );
      result.level = evaluation.level;
      pc.firings.push(...evaluation.firings);
    } else if (metrics) {
      result.level = currentLevel(ledger, `session:${harness}:${metrics.sessionId}`);
    }
    result.view = agentView(pc, agent, harness, binding, metrics, result.level);
    const patch = diffTokens(agent.tokens, agentTokens(result.view, config.display));
    result.patch = patch;
    if (Object.keys(patch).length && !pc.dryRun) await reportPaneTokens(agent.pane_id, patch);
  } catch (err) {
    log.error(`publishAgent ${agent.pane_id}`, err);
  }
  return result;
}

/** Today's spend for the sessions seen in one pane or one workspace (via binding history). */
export function scopedToday(
  ledger: Ledger,
  column: "terminal_id" | "workspace_id",
  id: string,
  now: number,
): { calls: number; usd: number; credits: number; work: number } {
  const since = startOfLocalDay(now);
  const row = ledger.get<{ calls: number; usd: number; credits: number; work: number }>(
    `SELECT COUNT(*) AS calls, COALESCE(SUM(cost_usd), 0) AS usd, COALESCE(SUM(credits), 0) AS credits,
            COALESCE(SUM(input + cache_write + output), 0) AS work
     FROM request
     WHERE ts >= ? AND (harness, root_session_id) IN
       (SELECT DISTINCT harness, session_id FROM binding_history WHERE ${column} = ? AND last_seen >= ?)`,
    since,
    id,
    since,
  );
  return row ?? { calls: 0, usd: 0, credits: 0, work: 0 };
}

/** Spend per hour for a pane or workspace, last `hours` hours, oldest → newest. */
export function scopedHourly(
  ledger: Ledger,
  column: "terminal_id" | "workspace_id",
  id: string,
  now: number,
  hours = 8,
): number[] {
  const base = now - hours * 3_600_000;
  const out = new Array<number>(hours).fill(0);
  for (const r of ledger.all<{ b: number; v: number }>(
    `SELECT CAST((ts - ?) / 3600000 AS INTEGER) AS b, SUM(cost_usd) AS v FROM request
     WHERE ts >= ? AND (harness, root_session_id) IN
       (SELECT DISTINCT harness, session_id FROM binding_history WHERE ${column} = ? AND last_seen >= ?)
     GROUP BY b`,
    base,
    base,
    id,
    base,
  )) {
    if (r.b >= 0 && r.b < hours) out[r.b] = r.v ?? 0;
  }
  return out;
}

function agentView(
  pc: PublishContext,
  agent: AgentInfo,
  harness: NonNullable<ReturnType<typeof harnessOf>>,
  binding: Binding,
  metrics: SessionMetrics | null,
  level: Level,
): AgentView | null {
  const today = scopedToday(pc.ledger, "terminal_id", agent.terminal_id, pc.now);
  if ((!metrics || metrics.calls === 0) && today.calls === 0) return null;
  const sessionScope = pc.config.display.agentScope === "session" && metrics != null;
  const recent =
    metrics && binding.sessionId
      ? sessionCalls(pc.ledger, harness, binding.sessionId, 8)
          .reverse()
          .map((c) => c.cost_usd ?? 0)
      : [];
  return {
    level,
    billing: metrics?.billing ?? "api",
    usd: sessionScope ? metrics.costUsd : today.usd,
    credits: sessionScope ? metrics.credits : today.credits,
    sessionUsd: metrics?.costUsd ?? 0,
    sessionCredits: metrics?.credits ?? 0,
    workTokens: sessionScope ? metrics.workTokens : today.work,
    contextPct: metrics?.contextPct ?? null,
    contextTokens: metrics?.contextTokens ?? null,
    model: metrics?.model ?? null,
    tps: metrics?.tpsP50 ?? null,
    burn5mUsd: metrics?.costUsd5m ?? 0,
    recentCalls: recent,
  };
}

/** Tab-bar view: Copilot quota plus today's spend across everything. */
export function tabView(ledger: Ledger, quota: CopilotQuota | null, quotaLevel: Level, now: number): TabView {
  const since = startOfLocalDay(now);
  const today = totals(ledger, { since });
  const daily = new Array<number>(7).fill(0);
  const firstDay = since - 6 * 86_400_000;
  for (const r of ledger.all<{ day: string; v: number }>(
    `SELECT strftime('%Y-%m-%d', ts / 1000, 'unixepoch', 'localtime') AS day, SUM(cost_usd) AS v
     FROM request WHERE ts >= ? GROUP BY day`,
    firstDay,
  )) {
    const idx = Math.round((Date.parse(r.day + "T00:00:00") - firstDay) / 86_400_000);
    if (idx >= 0 && idx < 7) daily[idx] = r.v ?? 0;
  }
  const burn = ledger.get<{ v: number }>("SELECT COALESCE(SUM(cost_usd), 0) AS v FROM request WHERE ts >= ?", now - 5 * 60_000);
  return {
    quota,
    quotaLevel,
    todayUsd: today.costUsd,
    todayCredits: today.credits,
    workTokens: today.workTokens,
    daily,
    burn5mUsd: burn?.v ?? 0,
    snoozed: isSnoozed(ledger, now),
  };
}

/** Highest active level recorded for a scope (used when rules are not re-evaluated). */
export function currentLevel(ledger: Ledger, scope: string): Level {
  const rows = ledger.all<{ level: string }>(
    "SELECT level FROM alert_state WHERE scope = ? AND active = 1 AND level IS NOT NULL",
    scope,
  );
  const order: Record<string, number> = { low: 0, high: 2, critical: 3 };
  let best: Level = "normal";
  let low = false;
  for (const r of rows) {
    if (r.level === "low") low = true;
    else if ((order[r.level] ?? 1) > (order[best] ?? 1)) best = r.level as Level;
  }
  return best === "normal" && low ? "low" : best;
}

export async function clearPaneTokens(paneId: string, current: Record<string, string> | null | undefined): Promise<void> {
  const patch: TokenMap = {};
  for (const key of AGENT_TOKEN_KEYS) if (current?.[key] != null) patch[key] = null;
  if (Object.keys(patch).length) {
    try {
      await reportPaneTokens(paneId, patch);
    } catch (err) {
      log.warn(`clear tokens ${paneId}: ${(err as Error).message}`);
    }
  }
}

/** Clear every token this plugin owns on a pane (current values unknown). */
export async function clearAllPaneTokens(paneId: string): Promise<void> {
  try {
    await reportPaneTokens(paneId, Object.fromEntries(AGENT_TOKEN_KEYS.map((k) => [k, null])));
  } catch (err) {
    log.warn(`clear tokens ${paneId}: ${(err as Error).message}`);
  }
}

export function buildSpaceView(
  ledger: Ledger,
  workspaceId: string,
  level: Level,
  agents: AgentInfo[],
  todayTotalUsd: number,
  now: number,
): SpaceView | null {
  const t = scopedToday(ledger, "workspace_id", workspaceId, now);
  if (t.calls === 0) return null;
  return {
    level,
    usd: t.usd,
    credits: t.credits,
    workTokens: t.work,
    sharePct: todayTotalUsd > 0 ? (t.usd / todayTotalUsd) * 100 : null,
    hourly: scopedHourly(ledger, "workspace_id", workspaceId, now),
    agents: agents.filter((a) => a.workspace_id === workspaceId && harnessOf(a.agent)).length,
  };
}

export async function publishWorkspaces(
  pc: PublishContext,
  workspaces: WorkspaceInfo[],
  levels: Map<string, Level>,
  agents: AgentInfo[] = [],
): Promise<void> {
  const todayTotal = totals(pc.ledger, { since: startOfLocalDay(pc.now) }).costUsd;
  for (const ws of workspaces) {
    try {
      const view = buildSpaceView(pc.ledger, ws.workspace_id, levels.get(ws.workspace_id) ?? "normal", agents, todayTotal, pc.now);
      const patch = diffTokens(ws.tokens, spaceTokens(view, pc.config.display));
      if (Object.keys(patch).length && !pc.dryRun) await reportWorkspaceTokens(ws.workspace_id, patch);
    } catch (err) {
      log.error(`publish workspace ${ws.workspace_id}`, err);
    }
  }
}

export function clearWorkspacePatch(ws: WorkspaceInfo): TokenMap {
  const patch: TokenMap = {};
  for (const key of SPACE_TOKEN_KEYS) if (ws.tokens?.[key] != null) patch[key] = null;
  return patch;
}

/** Global rules (Copilot quota, today's totals). Returns the quota scope level. */
export function evaluateGlobal(pc: PublishContext): Level {
  const today = totals(pc.ledger, { since: startOfLocalDay(pc.now) });
  // Serialized: hooks, the tab-bar tick and the dashboard may evaluate at once.
  const res = pc.ledger.transaction(() =>
    evaluate(
      pc.ledger,
      pc.config,
      "global",
      {
        now: pc.now,
        quota: pc.quota,
        today,
        session: null,
        labels: {},
      },
      !pc.dryRun,
    ),
  );
  pc.firings.push(...res.firings);
  return res.level;
}

/** Send collected alerts as one toast (respecting snooze and the notify switch). */
export async function flushNotifications(pc: PublishContext): Promise<void> {
  if (pc.dryRun || !pc.config.notify.enabled || isSnoozed(pc.ledger, pc.now)) return;
  const toast = coalesce(pc.firings);
  if (!toast) return;
  try {
    const reason = await notify(toast.title, toast.body, pc.config.notify.sound);
    log.info(`toast (${reason}): ${toast.title} — ${toast.body}`);
  } catch (err) {
    log.error("notify", err);
  }
}

export function workspaceLabelMap(workspaces: WorkspaceInfo[]): Map<string, string> {
  return new Map(workspaces.map((w) => [w.workspace_id, w.label || w.workspace_id]));
}

/** Highest session level per workspace, for the Space sidebar token glyph. */
export function workspaceLevels(ledger: Ledger, agents: AgentInfo[]): Map<string, Level> {
  const byWs = new Map<string, Level[]>();
  for (const a of agents) {
    const b = getBinding(ledger, a.terminal_id);
    if (!b?.harness || !b.sessionId) continue;
    const list = byWs.get(a.workspace_id) ?? [];
    list.push(currentLevel(ledger, `session:${b.harness}:${b.sessionId}`));
    byWs.set(a.workspace_id, list);
  }
  return new Map([...byWs].map(([ws, levels]) => [ws, maxLevel(levels)]));
}

export interface PublishAllResult {
  agents: AgentInfo[];
  workspaces: WorkspaceInfo[];
  results: AgentResult[];
  quota: CopilotQuota | null;
  quotaLevel: Level;
}

/**
 * Bind and publish every live agent, update workspace tokens, evaluate
 * global rules and send any alerts. Used by startup, refresh, the tab-bar
 * tick and the dashboard.
 */
export async function publishAll(
  pc: PublishContext,
  opts: { prune?: boolean } = {},
): Promise<PublishAllResult> {
  const [agents, workspaces] = await Promise.all([listAgents(), listWorkspaces()]);
  pc.workspaceLabels = workspaceLabelMap(workspaces);
  const results: AgentResult[] = [];
  for (const agent of agents) results.push(await publishAgent(pc, agent, agents));
  if (opts.prune) {
    const live = new Set(agents.map((a) => a.terminal_id));
    for (const b of allBindings(pc.ledger)) if (!live.has(b.terminalId)) deleteBinding(pc.ledger, b.terminalId);
  }
  await publishWorkspaces(pc, workspaces, workspaceLevels(pc.ledger, agents), agents);
  const quotaLevel = evaluateGlobal(pc);
  await flushNotifications(pc);
  return { agents, workspaces, results, quota: pc.quota, quotaLevel };
}
