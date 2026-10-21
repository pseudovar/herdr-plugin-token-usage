import type { Ledger } from "./ledger.ts";
import { HARNESSES } from "./types.ts";
import type { Billing, Harness } from "./types.ts";

export interface Totals {
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  /** input + cache_write + output: the tokens a turn actually adds. */
  workTokens: number;
  /** work + cache reads: everything the model processed. */
  processedTokens: number;
  costUsd: number;
  credits: number;
  creditsExact: number;
}

export interface SessionMetrics extends Totals {
  harness: Harness;
  sessionId: string;
  title: string | null;
  cwd: string | null;
  model: string | null;
  provider: string | null;
  billing: Billing;
  firstTs: number | null;
  lastTs: number | null;
  contextTokens: number | null;
  contextLimit: number | null;
  contextPct: number | null;
  cacheHitPct: number | null;
  credits5m: number;
  costUsd5m: number;
  tokens5m: number;
  tpsP50: number | null;
  ttftP50: number | null;
  subagentCredits: number;
  subagentCostUsd: number;
}

const TOTALS_SQL = `
  COUNT(*) AS calls,
  COALESCE(SUM(input), 0) AS input,
  COALESCE(SUM(output), 0) AS output,
  COALESCE(SUM(cache_read), 0) AS cacheRead,
  COALESCE(SUM(cache_write), 0) AS cacheWrite,
  COALESCE(SUM(reasoning), 0) AS reasoning,
  COALESCE(SUM(cost_usd), 0) AS costUsd,
  COALESCE(SUM(credits), 0) AS credits,
  COALESCE(SUM(CASE WHEN credits_exact = 1 THEN credits ELSE 0 END), 0) AS creditsExact`;

type RawTotals = Omit<Totals, "workTokens" | "processedTokens">;

function finish(t: RawTotals): Totals {
  const workTokens = t.input + t.cacheWrite + t.output;
  return { ...t, workTokens, processedTokens: workTokens + t.cacheRead };
}

export function emptyTotals(): Totals {
  return finish({ calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0, credits: 0, creditsExact: 0 });
}

export interface TotalsFilter {
  since: number;
  until?: number;
  harness?: Harness;
  billing?: Billing;
  model?: string;
}

function where(f: TotalsFilter): { sql: string; params: Array<string | number> } {
  const clauses = ["ts >= ?"];
  const params: Array<string | number> = [f.since];
  if (f.until != null) {
    clauses.push("ts < ?");
    params.push(f.until);
  }
  if (f.harness) {
    clauses.push("harness = ?");
    params.push(f.harness);
  }
  if (f.billing) {
    clauses.push("billing = ?");
    params.push(f.billing);
  }
  if (f.model) {
    clauses.push("model = ?");
    params.push(f.model);
  }
  return { sql: clauses.join(" AND "), params };
}

export function totals(ledger: Ledger, f: TotalsFilter): Totals {
  const w = where(f);
  const row = ledger.get<RawTotals>(`SELECT ${TOTALS_SQL} FROM request WHERE ${w.sql}`, ...w.params);
  return row ? finish(row) : emptyTotals();
}

export interface GroupTotals extends Totals {
  key: string;
}

export function totalsBy(
  ledger: Ledger,
  column: "harness" | "model" | "billing" | "cwd",
  f: TotalsFilter,
  limit = 50,
): GroupTotals[] {
  const w = where(f);
  const rows = ledger.all<RawTotals & { key: string | null }>(
    `SELECT ${column} AS key, ${TOTALS_SQL} FROM request WHERE ${w.sql}
     GROUP BY ${column} ORDER BY SUM(COALESCE(credits, 0)) / 100.0 + SUM(COALESCE(cost_usd, 0)) DESC LIMIT ${limit}`,
    ...w.params,
  );
  return rows.map((r) => ({ ...finish(r), key: r.key ?? "(unknown)" }));
}

export function totalsByHarness(ledger: Ledger, f: TotalsFilter): Record<Harness, Totals> {
  const out = Object.fromEntries(HARNESSES.map((h) => [h, emptyTotals()])) as Record<Harness, Totals>;
  for (const g of totalsBy(ledger, "harness", f)) {
    if ((HARNESSES as readonly string[]).includes(g.key)) out[g.key as Harness] = g;
  }
  return out;
}

/** Bucketed work tokens (or credits) for sparklines. */
export function series(
  ledger: Ledger,
  since: number,
  bucketMs: number,
  buckets: number,
  field: "work" | "credits" | "cost" = "work",
  extra?: { harness?: Harness; sessionId?: string },
): number[] {
  const expr =
    field === "work"
      ? "SUM(input + cache_write + output)"
      : field === "credits"
        ? "SUM(COALESCE(credits, 0))"
        : "SUM(COALESCE(cost_usd, 0))";
  const clauses = ["ts >= ?"];
  const params: Array<string | number> = [since];
  if (extra?.harness) {
    clauses.push("harness = ?");
    params.push(extra.harness);
  }
  if (extra?.sessionId) {
    clauses.push("root_session_id = ?");
    params.push(extra.sessionId);
  }
  const rows = ledger.all<{ b: number; v: number }>(
    `SELECT CAST((ts - ?) / ? AS INTEGER) AS b, ${expr} AS v FROM request
     WHERE ${clauses.join(" AND ")} GROUP BY b`,
    since,
    bucketMs,
    ...params,
  );
  const out = new Array<number>(buckets).fill(0);
  for (const r of rows) if (r.b >= 0 && r.b < buckets) out[r.b] = r.v;
  return out;
}

interface CallRow {
  ts: number;
  model: string;
  provider: string | null;
  billing: Billing;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  reasoning: number;
  cost_usd: number | null;
  credits: number | null;
  duration_ms: number | null;
  ttft_ms: number | null;
  itl_ms: number | null;
  context_limit: number | null;
  is_subagent: number;
  initiator: string | null;
}

export function sessionCalls(ledger: Ledger, harness: Harness, rootSessionId: string, limit = 500): CallRow[] {
  return ledger.all<CallRow>(
    `SELECT ts, model, provider, billing, input, output, cache_read, cache_write, reasoning, cost_usd, credits,
            duration_ms, ttft_ms, itl_ms, context_limit, is_subagent, initiator
     FROM request WHERE harness = ? AND root_session_id = ? ORDER BY ts DESC LIMIT ${limit}`,
    harness,
    rootSessionId,
  );
}

export type { CallRow };

export function sessionMetrics(
  ledger: Ledger,
  harness: Harness,
  rootSessionId: string,
  now = Date.now(),
  contextOverride?: (model: string) => number | null,
): SessionMetrics | null {
  const agg = ledger.get<RawTotals & { firstTs: number | null; lastTs: number | null; subCredits: number; subCost: number }>(
    `SELECT ${TOTALS_SQL}, MIN(ts) AS firstTs, MAX(ts) AS lastTs,
            COALESCE(SUM(CASE WHEN is_subagent = 1 THEN credits ELSE 0 END), 0) AS subCredits,
            COALESCE(SUM(CASE WHEN is_subagent = 1 THEN cost_usd ELSE 0 END), 0) AS subCost
     FROM request WHERE harness = ? AND root_session_id = ?`,
    harness,
    rootSessionId,
  );
  const session = ledger.get<{ title: string | null; cwd: string | null; first_ts: number | null; last_ts: number | null }>(
    "SELECT title, cwd, first_ts, last_ts FROM session WHERE harness = ? AND id = ?",
    harness,
    rootSessionId,
  );
  if (!agg && !session) return null;
  const base = finish(
    agg ?? { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0, credits: 0, creditsExact: 0 },
  );
  const recent = ledger.all<CallRow>(
    `SELECT ts, model, provider, billing, input, output, cache_read, cache_write, reasoning, cost_usd, credits,
            duration_ms, ttft_ms, itl_ms, context_limit, is_subagent, initiator
     FROM request WHERE harness = ? AND root_session_id = ? ORDER BY ts DESC LIMIT 40`,
    harness,
    rootSessionId,
  );
  const main = recent.filter((r) => r.is_subagent === 0);
  const last = main[0] ?? recent[0];
  const contextTokens = last ? last.input + last.cache_read + last.cache_write : null;
  let contextLimit = last ? (contextOverride?.(last.model) ?? last.context_limit) : null;
  if (contextLimit != null && contextTokens != null && contextTokens > contextLimit * 1.02) contextLimit = null;
  const contextPct = contextTokens != null && contextLimit ? (contextTokens / contextLimit) * 100 : null;

  const window = main.slice(0, 10);
  const prompt = window.reduce((s, r) => s + r.input + r.cache_read + r.cache_write, 0);
  const read = window.reduce((s, r) => s + r.cache_read, 0);
  const cacheHitPct = window.length >= 2 && prompt > 0 ? (read / prompt) * 100 : null;

  const since5m = now - 5 * 60_000;
  const inWindow = recent.filter((r) => r.ts >= since5m);
  const credits5m = inWindow.reduce((s, r) => s + (r.credits ?? 0), 0);
  const costUsd5m = inWindow.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
  const tokens5m = inWindow.reduce((s, r) => s + r.input + r.cache_write + r.output, 0);

  const speeds: number[] = [];
  const ttfts: number[] = [];
  for (const r of recent.slice(0, 20)) {
    if (r.itl_ms && r.itl_ms > 0) speeds.push(1000 / r.itl_ms);
    else if (r.duration_ms && r.duration_ms > 500 && r.output > 20) {
      const gen = r.ttft_ms && r.ttft_ms < r.duration_ms ? r.duration_ms - r.ttft_ms : r.duration_ms;
      speeds.push(r.output / (gen / 1000));
    }
    if (r.ttft_ms && r.ttft_ms > 0) ttfts.push(r.ttft_ms);
  }

  return {
    ...base,
    harness,
    sessionId: rootSessionId,
    title: session?.title ?? null,
    cwd: session?.cwd ?? null,
    model: last?.model ?? null,
    provider: last?.provider ?? null,
    billing: dominantBilling(recent) ?? "api",
    firstTs: agg?.firstTs ?? session?.first_ts ?? null,
    lastTs: agg?.lastTs ?? session?.last_ts ?? null,
    contextTokens,
    contextLimit,
    contextPct,
    cacheHitPct,
    credits5m,
    costUsd5m,
    tokens5m,
    tpsP50: median(speeds),
    ttftP50: median(ttfts),
    subagentCredits: agg?.subCredits ?? 0,
    subagentCostUsd: agg?.subCost ?? 0,
  };
}

function dominantBilling(rows: CallRow[]): Billing | null {
  const counts = new Map<Billing, number>();
  for (const r of rows) counts.set(r.billing, (counts.get(r.billing) ?? 0) + 1);
  let best: Billing | null = null;
  let max = 0;
  for (const [b, c] of counts) {
    if (c > max) {
      best = b;
      max = c;
    }
  }
  return best;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}
