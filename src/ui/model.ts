import { loadConfig } from "../core/config.ts";
import { ingest } from "../core/ingest.ts";
import { sessionCalls, sessionMetrics, totals, totalsBy } from "../core/metrics.ts";
import type { CallRow, GroupTotals, SessionMetrics, Totals } from "../core/metrics.ts";
import { evaluateGlobal, loadQuota, publishAll } from "../core/publish.ts";
import type { AgentResult } from "../core/publish.ts";
import type { CopilotQuota } from "../core/quota/copilot.ts";
import { openRuntime, publishContext } from "../core/runtime.ts";
import type { Runtime } from "../core/runtime.ts";
import type { Harness, Level } from "../core/types.ts";
import { ping } from "../herdr/client.ts";
import { log } from "../util/log.ts";
import { DAY, HOUR, startOfLocalDay, startOfLocalMonth, startOfUtcMonth } from "../util/time.ts";
import { buildAnatomy, buildBurnup } from "./chartsdata.ts";
import type { Anatomy, Burnup } from "./chartsdata.ts";

export type PeriodId = "today" | "7d" | "30d" | "month" | "billing" | "all";
export const PERIODS: PeriodId[] = ["today", "7d", "30d", "billing", "month", "all"];
export const PERIOD_LABEL: Record<PeriodId, string> = {
  today: "today",
  "7d": "last 7 days",
  "30d": "last 30 days",
  month: "this month",
  billing: "Copilot billing month",
  all: "all time",
};

export type GroupBy = "harness" | "model" | "cwd" | "billing";
export const GROUPS: GroupBy[] = ["harness", "model", "cwd", "billing"];

export function periodSince(p: PeriodId, now = Date.now()): number {
  switch (p) {
    case "today":
      return startOfLocalDay(now);
    case "7d":
      return startOfLocalDay(now) - 6 * DAY;
    case "30d":
      return startOfLocalDay(now) - 29 * DAY;
    case "month":
      return startOfLocalMonth(now);
    case "billing":
      return startOfUtcMonth(now);
    case "all":
      return 0;
  }
}

export interface AlertRow {
  rule_id: string;
  scope: string;
  level: string;
  value: number | null;
  since: number | null;
}

export interface LogRow {
  ts: number;
  rule_id: string;
  level: string;
  message: string;
  notified: number;
}

export interface Model {
  at: number;
  herdrOk: boolean;
  agents: AgentResult[];
  workspaceLabels: Map<string, string>;
  quota: CopilotQuota | null;
  quotaLevel: Level;
  today: Totals;
  todayCopilot: Totals;
  billingCopilot: Totals;
  period: PeriodId;
  periodTotals: Totals;
  groupBy: GroupBy;
  groups: GroupTotals[];
  byHarness: GroupTotals[];
  byModel: GroupTotals[];
  activity: number[];
  activityBucketMs: number;
  daily: Array<{ day: string; work: number; credits: number; usd: number }>;
  /** Copilot spend across the billing month (Summary chart). */
  burnup: Burnup | null;
  /** Spend split into input / cache write / cache read / output (Summary). */
  anatomy: Anatomy[];
  alerts: AlertRow[];
  alertLog: LogRow[];
  snoozedUntil: number | null;
  ingestMs: number;
  error: string | null;
}

export interface SessionDetail {
  harness: Harness;
  sessionId: string;
  metrics: SessionMetrics | null;
  calls: CallRow[];
}

export class DataSource {
  readonly rt: Runtime;
  constructor() {
    this.rt = openRuntime();
  }

  close(): void {
    this.rt.close();
  }

  reloadConfig(): void {
    this.rt.config = loadConfig();
  }

  async build(period: PeriodId, groupBy: GroupBy, activityBuckets: number, opts: { dryRun?: boolean } = {}): Promise<Model> {
    const { ledger, config, pricing } = this.rt;
    const now = Date.now();
    let error: string | null = null;
    const summary = ingest(ledger, pricing, config, { freshMs: 1500, waitMs: 0 });
    const herdrOk = await ping(800);
    let agents: AgentResult[] = [];
    let quota: CopilotQuota | null = null;
    let quotaLevel: Level = "normal";
    let labels = new Map<string, string>();
    try {
      quota = loadQuota(ledger, config, true, 3000);
      const pc = publishContext(this.rt, quota);
      pc.dryRun = opts.dryRun;
      if (herdrOk) {
        const res = await publishAll(pc);
        agents = res.results;
        quotaLevel = res.quotaLevel;
        labels = pc.workspaceLabels;
      } else {
        quotaLevel = evaluateGlobal(pc);
      }
    } catch (err) {
      error = (err as Error).message;
      log.warn(`dashboard refresh: ${error}`);
    }
    const since = periodSince(period, now);
    const todaySince = startOfLocalDay(now);
    const bucketMs = Math.max(5 * 60_000, Math.round((6 * HOUR) / Math.max(1, activityBuckets)));
    const activitySince = now - bucketMs * activityBuckets;
    const activity = new Array<number>(activityBuckets).fill(0);
    for (const r of ledger.all<{ b: number; v: number }>(
      `SELECT CAST((ts - ?) / ? AS INTEGER) AS b, SUM(input + cache_write + output) AS v
       FROM request WHERE ts >= ? GROUP BY b`,
      activitySince,
      bucketMs,
      activitySince,
    )) {
      if (r.b >= 0 && r.b < activityBuckets) activity[r.b] = r.v;
    }
    const daily = ledger.all<{ day: string; work: number; credits: number; usd: number }>(
      `SELECT strftime('%Y-%m-%d', ts / 1000, 'unixepoch', 'localtime') AS day,
              SUM(input + cache_write + output) AS work,
              COALESCE(SUM(credits), 0) AS credits,
              COALESCE(SUM(CASE WHEN billing <> 'copilot' THEN cost_usd ELSE 0 END), 0) AS usd
       FROM request WHERE ts >= ? GROUP BY day ORDER BY day`,
      startOfLocalDay(now) - 29 * DAY,
    );
    const snooze = Number(ledger.getMeta("snooze_until") ?? 0);
    return {
      at: now,
      herdrOk,
      agents,
      workspaceLabels: labels,
      quota,
      quotaLevel,
      today: totals(ledger, { since: todaySince }),
      todayCopilot: totals(ledger, { since: todaySince, billing: "copilot" }),
      billingCopilot: totals(ledger, { since: startOfUtcMonth(now), billing: "copilot" }),
      period,
      periodTotals: totals(ledger, { since }),
      groupBy,
      groups: totalsBy(ledger, groupBy, { since }, 200),
      byHarness: totalsBy(ledger, "harness", { since }),
      byModel: totalsBy(ledger, "model", { since }, 12),
      activity,
      activityBucketMs: bucketMs,
      burnup: buildBurnup(ledger, quota, now),
      anatomy: buildAnatomy(ledger, pricing, agents, now),
      daily,
      alerts: ledger.all<AlertRow>(
        "SELECT rule_id, scope, level, value, since FROM alert_state WHERE active = 1 ORDER BY since DESC LIMIT 50",
      ),
      alertLog: ledger.all<LogRow>(
        "SELECT ts, rule_id, level, message, notified FROM alert_log ORDER BY ts DESC LIMIT 50",
      ),
      snoozedUntil: snooze > now ? snooze : null,
      ingestMs: summary.ms,
      error,
    };
  }

  session(harness: Harness, sessionId: string): SessionDetail {
    return {
      harness,
      sessionId,
      metrics: sessionMetrics(this.rt.ledger, harness, sessionId),
      calls: sessionCalls(this.rt.ledger, harness, sessionId, 400),
    };
  }

  recentSessions(limit = 30): Array<{ harness: Harness; id: string; title: string | null; cwd: string | null; last: number; credits: number; usd: number; work: number }> {
    return this.rt.ledger.all(
      `SELECT r.harness AS harness, r.root_session_id AS id, s.title AS title, s.cwd AS cwd, MAX(r.ts) AS last,
              COALESCE(SUM(r.credits), 0) AS credits,
              COALESCE(SUM(r.cost_usd), 0) AS usd,
              SUM(r.input + r.cache_write + r.output) AS work
       FROM request r LEFT JOIN session s ON s.harness = r.harness AND s.id = r.root_session_id
       GROUP BY r.harness, r.root_session_id ORDER BY last DESC LIMIT ${limit}`,
    );
  }
}
