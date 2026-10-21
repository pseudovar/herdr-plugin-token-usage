import { spawnSync } from "node:child_process";
import type { Ledger } from "../ledger.ts";
import { DAY, MINUTE, startOfUtcMonth } from "../../util/time.ts";

export interface CopilotQuota {
  ok: boolean;
  fetchedAt: number;
  error: string | null;
  plan: string | null;
  /** True for AI-credit billing (since 2026-06); false for legacy premium requests. */
  tokenBased: boolean;
  unit: "credits" | "requests";
  unlimited: boolean;
  entitlement: number | null;
  remaining: number | null;
  used: number | null;
  usedPct: number | null;
  overagePermitted: boolean;
  periodStart: number;
  resetAt: number;
  elapsedPct: number;
  /** usedPct ÷ elapsedPct: 1.0 = on budget, < 1 under, > 1 over. */
  pace: number | null;
  /** Straight-line projection of month-end usage, % of entitlement. */
  projectedPct: number | null;
  daysLeft: number;
}

interface Snapshot {
  entitlement?: number | string;
  remaining?: number;
  quota_remaining?: number;
  percent_remaining?: number;
  unlimited?: boolean;
  overage_permitted?: boolean;
  credits_used?: number;
  quota_reset_at?: number;
  token_based_billing?: boolean;
}

interface UserResponse {
  copilot_plan?: string;
  token_based_billing?: boolean;
  quota_reset_date?: string;
  quota_reset_date_utc?: string;
  quota_snapshots?: Record<string, Snapshot>;
}

/** Interpret `GET /copilot_internal/user` the way VS Code's `parseQuotas()` does. */
export function parseCopilotUser(json: UserResponse, now = Date.now()): CopilotQuota {
  const snap = json.quota_snapshots?.premium_interactions;
  const tokenBased = Boolean(json.token_based_billing ?? snap?.token_based_billing);
  let resetAt = NaN;
  if (snap?.quota_reset_at && snap.quota_reset_at > 0) resetAt = snap.quota_reset_at * 1000;
  if (!Number.isFinite(resetAt) && json.quota_reset_date_utc) resetAt = Date.parse(json.quota_reset_date_utc);
  if (!Number.isFinite(resetAt) && json.quota_reset_date) resetAt = Date.parse(json.quota_reset_date + "T00:00:00Z");
  if (!Number.isFinite(resetAt)) resetAt = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() + 1, 1);
  const periodStart = startOfUtcMonth(resetAt - DAY);
  const span = Math.max(1, resetAt - periodStart);
  const elapsedPct = Math.min(100, Math.max(0, ((now - periodStart) / span) * 100));
  const daysLeft = Math.max(0, (resetAt - now) / DAY);

  const base: CopilotQuota = {
    ok: true,
    fetchedAt: now,
    error: null,
    plan: json.copilot_plan ?? null,
    tokenBased,
    unit: tokenBased ? "credits" : "requests",
    unlimited: false,
    entitlement: null,
    remaining: null,
    used: null,
    usedPct: null,
    overagePermitted: Boolean(snap?.overage_permitted),
    periodStart,
    resetAt,
    elapsedPct,
    pace: null,
    projectedPct: null,
    daysLeft,
  };
  if (!snap) return { ...base, ok: false, error: "no premium_interactions snapshot" };

  if (snap.unlimited) {
    return { ...base, unlimited: true, used: typeof snap.credits_used === "number" ? snap.credits_used : null };
  }
  const entitlement = Number(snap.entitlement);
  if (!Number.isFinite(entitlement) || entitlement <= 0) {
    return { ...base, ok: false, error: "no entitlement (placeholder snapshot)" };
  }
  const remaining = typeof snap.quota_remaining === "number" ? snap.quota_remaining : Number(snap.remaining ?? NaN);
  const usedPct =
    typeof snap.percent_remaining === "number"
      ? 100 - snap.percent_remaining
      : Number.isFinite(remaining)
        ? ((entitlement - remaining) / entitlement) * 100
        : null;
  const used = Number.isFinite(remaining) ? entitlement - remaining : usedPct != null ? (usedPct / 100) * entitlement : null;
  const pace = usedPct != null && elapsedPct >= 0.5 ? usedPct / elapsedPct : null;
  const projectedPct = usedPct != null && elapsedPct >= 0.5 ? usedPct / (elapsedPct / 100) : null;
  return {
    ...base,
    entitlement,
    remaining: Number.isFinite(remaining) ? remaining : null,
    used,
    usedPct,
    pace,
    projectedPct,
  };
}

/** Recompute time-dependent fields for a cached snapshot. */
function refreshDerived(q: CopilotQuota, now: number): CopilotQuota {
  const span = Math.max(1, q.resetAt - q.periodStart);
  const elapsedPct = Math.min(100, Math.max(0, ((now - q.periodStart) / span) * 100));
  const pace = q.usedPct != null && elapsedPct >= 0.5 ? q.usedPct / elapsedPct : null;
  const projectedPct = q.usedPct != null && elapsedPct >= 0.5 ? q.usedPct / (elapsedPct / 100) : null;
  return { ...q, elapsedPct, pace, projectedPct, daysLeft: Math.max(0, (q.resetAt - now) / DAY) };
}

export interface QuotaOptions {
  /** Allow a network fetch when the cache is stale. */
  allowFetch: boolean;
  maxAgeMs: number;
  timeoutMs: number;
}

interface QuotaRow {
  fetched_at: number;
  ok: number;
  payload: string | null;
  error: string | null;
  failures: number;
}

/**
 * Account-wide Copilot quota, fetched with the user's existing `gh` login
 * (`gh api /copilot_internal/user`), so the plugin never handles tokens.
 * Cached in the ledger; at most one fetch per `maxAgeMs`, with exponential
 * backoff after failures (internal endpoint: be polite).
 */
export function getCopilotQuota(ledger: Ledger, opts: QuotaOptions): CopilotQuota | null {
  const now = Date.now();
  const row = ledger.get<QuotaRow>("SELECT fetched_at, ok, payload, error, failures FROM quota WHERE provider = 'copilot'");
  let cached: CopilotQuota | null = null;
  if (row?.payload) {
    try {
      cached = refreshDerived(JSON.parse(row.payload) as CopilotQuota, now);
    } catch {
      cached = null;
    }
  }
  const age = row ? now - row.fetched_at : Infinity;
  const backoff = row && row.failures > 0 ? Math.min(60 * MINUTE, opts.maxAgeMs * 2 ** row.failures) : opts.maxAgeMs;
  if (!opts.allowFetch || age < backoff) return cached;

  const fetched = fetchCopilotUser(opts.timeoutMs);
  if (fetched.ok && fetched.json) {
    const quota = parseCopilotUser(fetched.json, now);
    ledger.run(
      `INSERT INTO quota (provider, fetched_at, ok, payload, error, failures) VALUES ('copilot', ?, 1, ?, NULL, 0)
       ON CONFLICT(provider) DO UPDATE SET fetched_at = excluded.fetched_at, ok = 1, payload = excluded.payload, error = NULL, failures = 0`,
      now,
      JSON.stringify(quota),
    );
    // Account-wide history for the burn-up chart (one row per fetch, ≤ every 5 min).
    if (quota.used != null) {
      ledger.run(
        "INSERT OR IGNORE INTO quota_history (provider, ts, used, entitlement, used_pct) VALUES ('copilot', ?, ?, ?, ?)",
        now,
        quota.used,
        quota.entitlement,
        quota.usedPct,
      );
    }
    return quota;
  }
  ledger.run(
    `INSERT INTO quota (provider, fetched_at, ok, payload, error, failures) VALUES ('copilot', ?, 0, ?, ?, 1)
     ON CONFLICT(provider) DO UPDATE SET fetched_at = excluded.fetched_at, ok = 0, error = excluded.error,
       failures = MIN(quota.failures + 1, 6)`,
    now,
    cached ? JSON.stringify(cached) : null,
    fetched.error ?? "unknown error",
  );
  return cached ? { ...cached, ok: false, error: fetched.error ?? "fetch failed" } : null;
}

function fetchCopilotUser(timeoutMs: number): { ok: boolean; json?: UserResponse; error?: string } {
  const gh = process.env.TU_GH_BIN || "gh";
  const res = spawnSync(gh, ["api", "/copilot_internal/user", "-H", "X-GitHub-Api-Version: 2025-04-01"], {
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" },
  });
  if (res.error) {
    const code = (res.error as NodeJS.ErrnoException).code;
    return { ok: false, error: code === "ENOENT" ? "gh CLI not installed" : res.error.message };
  }
  if (res.status !== 0) {
    const msg = (res.stderr || res.stdout || "").trim().split("\n")[0] || `gh exited ${res.status}`;
    return { ok: false, error: msg.includes("auth login") ? "gh not logged in (run: gh auth login)" : msg };
  }
  try {
    return { ok: true, json: JSON.parse(res.stdout) as UserResponse };
  } catch {
    return { ok: false, error: "unparseable response" };
  }
}

export function quotaPeriodKey(q: CopilotQuota): string {
  return new Date(q.resetAt).toISOString().slice(0, 10);
}
