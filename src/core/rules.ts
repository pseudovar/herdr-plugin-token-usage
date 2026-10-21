import type { Config, MetricId, Rule } from "./config.ts";
import { METRICS } from "./config.ts";
import type { Ledger } from "./ledger.ts";
import type { SessionMetrics, Totals } from "./metrics.ts";
import type { CopilotQuota } from "./quota/copilot.ts";
import { quotaPeriodKey } from "./quota/copilot.ts";
import { maxLevel } from "./types.ts";
import type { Level } from "./types.ts";
import { fmtPace, fmtTokens, fmtUsd } from "../util/format.ts";
import { money } from "./display.ts";
import type { MoneyUnit } from "./display.ts";
import { localDayKey, MINUTE } from "../util/time.ts";

/** How long an `every` milestone keeps its level after firing. */
const EVERY_HOLD_MS = 15 * MINUTE;

export interface EvalContext {
  now: number;
  quota: CopilotQuota | null;
  today: Totals | null;
  session: SessionMetrics | null;
  /** Human labels used in toast text. */
  labels: { agent?: string; where?: string };
}

export interface Firing {
  rule: Rule;
  scope: string;
  value: number;
  level: Level;
  title: string;
  body: string;
  notify: boolean;
}

export interface EvalResult {
  level: Level;
  active: Array<{ rule: Rule; value: number }>;
  firings: Firing[];
}

interface StateRow {
  active: number;
  level: string | null;
  value: number | null;
  mark: number | null;
  since: number | null;
  last_notified: number | null;
}

export function metricValue(metric: MetricId, ctx: EvalContext): number | null {
  const s = ctx.session;
  const q = ctx.quota;
  switch (metric) {
    case "session.tokens":
      return s ? s.workTokens : null;
    case "session.credits":
      return s && s.credits > 0 ? s.credits : null;
    case "session.cost_usd":
      return s ? s.costUsd : null;
    case "session.context_pct":
      return s?.contextPct ?? null;
    case "session.cache_hit_pct":
      return s?.cacheHitPct ?? null;
    case "session.credits_5m":
      return s ? s.credits5m : null;
    case "session.cost_usd_5m":
      return s ? s.costUsd5m : null;
    case "session.tokens_5m":
      return s ? s.tokens5m : null;
    case "session.tps_p50":
      return s?.tpsP50 ?? null;
    case "session.calls":
      return s ? s.calls : null;
    case "today.tokens":
      return ctx.today ? ctx.today.workTokens : null;
    case "today.credits":
      return ctx.today ? ctx.today.credits : null;
    case "today.cost_usd":
      return ctx.today ? ctx.today.costUsd : null;
    case "quota.copilot.used_pct":
      return q?.usedPct ?? null;
    case "quota.copilot.pace":
      return q?.pace ?? null;
    case "quota.copilot.projected_pct":
      return q?.projectedPct ?? null;
    case "quota.copilot.days_left":
      return q ? q.daysLeft : null;
  }
}

/** Scope key: rule state (and `steps`/`every` marks) is tracked per scope. */
export function scopeFor(rule: Rule, ctx: EvalContext): string | null {
  if (rule.metric.startsWith("session.")) {
    return ctx.session ? `session:${ctx.session.harness}:${ctx.session.sessionId}` : null;
  }
  if (rule.metric.startsWith("quota.copilot.")) return ctx.quota ? `copilot:${quotaPeriodKey(ctx.quota)}` : null;
  if (rule.metric.startsWith("today.")) return `today:${localDayKey(ctx.now)}`;
  return null;
}

export function isSnoozed(ledger: Ledger, now = Date.now()): boolean {
  const until = Number(ledger.getMeta("snooze_until") ?? 0);
  return until > now;
}

/**
 * Evaluate rules for one kind of scope ("session" rules for a pane's session,
 * "global" rules for quota/today). Alerts are edge-triggered: a toast is sent
 * when a rule becomes active (or crosses a new step / multiple), never on
 * every refresh. Threshold rules clear with 5% hysteresis.
 */
export function evaluate(
  ledger: Ledger,
  config: Config,
  kind: "session" | "global",
  ctx: EvalContext,
  persist = true,
): EvalResult {
  const levels: Level[] = [];
  const active: Array<{ rule: Rule; value: number }> = [];
  const firings: Firing[] = [];
  const snoozed = isSnoozed(ledger, ctx.now);
  for (const rule of config.rules) {
    if (!rule.enabled) continue;
    const meta = METRICS[rule.metric];
    if (!meta || meta.scope !== kind) continue;
    if (kind === "session" && rule.billing && ctx.session?.billing !== rule.billing) continue;
    const scope = scopeFor(rule, ctx);
    if (!scope) continue;
    const value = metricValue(rule.metric, ctx);
    const prev = ledger.get<StateRow>(
      "SELECT active, level, value, mark, since, last_notified FROM alert_state WHERE rule_id = ? AND scope = ?",
      rule.id,
      scope,
    );
    const guardsOk = value != null && guards(rule, ctx);
    let isActive = false;
    let fire = false;
    let mark = prev?.mark ?? null;
    let since: number | null = prev?.active ? (prev.since ?? ctx.now) : null;
    if (guardsOk && value != null) {
      const cond = (x: number) => (rule.op === ">=" ? value >= x : value <= x);
      if (rule.steps && rule.steps.length) {
        const crossed = rule.steps.filter(cond);
        if (crossed.length) {
          isActive = true;
          const cur = rule.op === ">=" ? Math.max(...crossed) : Math.min(...crossed);
          const newer = mark == null || (rule.op === ">=" ? cur > mark : cur < mark);
          if (newer) {
            fire = true;
            mark = cur;
          }
        }
      } else if (rule.every && rule.every > 0) {
        // Repeating milestones are events, not standing conditions: they mark
        // the level only for a short hold after each new multiple, so a long
        // session is not flagged forever.
        const k = Math.floor(value / rule.every);
        if (k > (mark ?? 0) && k >= 1) {
          fire = true;
          mark = k;
          since = ctx.now;
        }
        isActive = since != null && ctx.now - since < EVERY_HOLD_MS;
        if (!isActive) since = null;
      } else if (rule.value != null) {
        isActive = cond(rule.value);
        if (!isActive && prev?.active) {
          const band = Math.abs(rule.value) * 0.05;
          isActive = rule.op === ">=" ? value >= rule.value - band : value <= rule.value + band;
        }
        fire = isActive && !prev?.active;
      }
    }
    if (isActive && since == null) since = ctx.now;
    if (!isActive) since = null;
    if (isActive && value != null) {
      levels.push(rule.level);
      active.push({ rule, value });
    }
    let notified = prev?.last_notified ?? null;
    if (fire && value != null) {
      const cooldownOk =
        rule.value == null || !prev?.last_notified || ctx.now - prev.last_notified >= config.notify.cooldownMinutes * MINUTE;
      const shouldNotify = rule.notify && config.notify.enabled && !snoozed && cooldownOk;
      const msg = describe(rule, value, mark, ctx, config.display.money);
      firings.push({ rule, scope, value, level: rule.level, title: msg.title, body: msg.body, notify: shouldNotify });
      if (shouldNotify) notified = ctx.now;
      if (persist) {
        ledger.run(
          "INSERT INTO alert_log (ts, rule_id, scope, level, value, message, notified) VALUES (?, ?, ?, ?, ?, ?, ?)",
          ctx.now,
          rule.id,
          scope,
          rule.level,
          value,
          `${msg.title} — ${msg.body}`,
          shouldNotify ? 1 : 0,
        );
      }
    }
    if (persist && (prev || isActive || fire)) {
      ledger.run(
        `INSERT INTO alert_state (rule_id, scope, active, level, value, mark, since, last_notified)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(rule_id, scope) DO UPDATE SET active = excluded.active, level = excluded.level,
           value = excluded.value, mark = excluded.mark, since = excluded.since, last_notified = excluded.last_notified`,
        rule.id,
        scope,
        isActive ? 1 : 0,
        isActive ? rule.level : null,
        value,
        mark,
        since,
        notified,
      );
    }
  }
  return { level: levels.length ? maxLevel(levels) : "normal", active, firings };
}

function guards(rule: Rule, ctx: EvalContext): boolean {
  if (rule.minCalls != null && (ctx.session?.calls ?? 0) < rule.minCalls) return false;
  if (rule.maxDaysLeft != null && (!ctx.quota || ctx.quota.daysLeft > rule.maxDaysLeft)) return false;
  if (rule.minElapsedPct != null && (!ctx.quota || ctx.quota.elapsedPct < rule.minElapsedPct)) return false;
  return true;
}

function describe(rule: Rule, v: number, mark: number | null, ctx: EvalContext, unit: MoneyUnit): { title: string; body: string } {
  /** Copilot credits in the display unit (1 credit = $0.01). */
  const cr = (credits: number) => money(unit, credits / 100, credits);
  const agent = ctx.labels.agent ?? "agent";
  const where = ctx.labels.where ? `${ctx.labels.where} · ` : "";
  const s = ctx.session;
  const q = ctx.quota;
  const resetDate = q ? new Date(q.resetAt).toLocaleDateString("en-AU", { day: "numeric", month: "short" }) : "";
  switch (rule.metric) {
    case "session.context_pct":
      return {
        title: `${agent}: context ${Math.round(v)}% full`,
        body: `${where}${s?.model ?? ""} · consider /compact or a fresh session`,
      };
    case "session.credits":
      return {
        title: `${agent}: session passed ${cr((mark ?? 1) * (rule.every ?? v))}`,
        body: `${where}${fmtTokens(s?.workTokens ?? 0)} work tokens · ${s?.model ?? ""}`,
      };
    case "session.cost_usd":
      return {
        title: `${agent}: session passed ${fmtUsd((mark ?? 1) * (rule.every ?? v))}`,
        body: `${where}${fmtTokens(s?.workTokens ?? 0)} work tokens · ${s?.model ?? ""}`,
      };
    case "session.credits_5m":
      return { title: `${agent}: ${cr(v)} in 5 min`, body: `${where}burn spike · ${s?.model ?? ""}` };
    case "session.cost_usd_5m":
      return { title: `${agent}: ${fmtUsd(v)} in 5 min`, body: `${where}burn spike · ${s?.model ?? ""}` };
    case "session.tokens_5m":
      return { title: `${agent}: ${fmtTokens(v)} tokens in 5 min`, body: `${where}burn spike` };
    case "session.cache_hit_pct":
      return {
        title: `${agent}: cache hit only ${Math.round(v)}%`,
        body: `${where}context is being re-uploaded; look for cache breaks`,
      };
    case "session.tps_p50":
      return { title: `${agent}: ${Math.round(v)} tok/s`, body: `${where}${rule.title}` };
    case "session.tokens":
      return { title: `${agent}: ${fmtTokens(v)} work tokens`, body: `${where}${rule.title}` };
    case "session.calls":
      return { title: `${agent}: ${Math.round(v)} calls`, body: `${where}${rule.title}` };
    case "quota.copilot.used_pct":
      return {
        title: `Copilot credits ${Math.round(v)}% used`,
        body: q
          ? `${cr(q.used ?? 0)} of ${cr(q.entitlement ?? 0)} · resets ${resetDate} (${Math.ceil(q.daysLeft)}d)`
          : rule.title,
      };
    case "quota.copilot.pace":
      if (rule.op === ">=") {
        return {
          title: `Copilot pace ${fmtPace(v)}: over budget`,
          body: q ? `on track for ${Math.round(q.projectedPct ?? 0)}% of monthly credits by ${resetDate}` : rule.title,
        };
      }
      return {
        title: q ? `Copilot: ${Math.round(100 - (q.usedPct ?? 0))}% of credits left` : rule.title,
        body: q ? `pace ${fmtPace(v)} · ${Math.ceil(q.daysLeft)} days to reset · room to use more` : rule.title,
      };
    case "quota.copilot.projected_pct":
      return { title: `Copilot projected ${Math.round(v)}% by reset`, body: rule.title };
    case "quota.copilot.days_left":
      return { title: `Copilot resets in ${Math.ceil(v)} days`, body: rule.title };
    case "today.tokens":
      return { title: `Today: ${fmtTokens(v)} work tokens`, body: rule.title };
    case "today.credits":
      return { title: `Today: ${cr(v)}`, body: rule.title };
    case "today.cost_usd":
      return { title: `Today: ${fmtUsd(v)}`, body: rule.title };
  }
}

/** Merge several firings into a single toast (herdr shows one per second). */
export function coalesce(firings: Firing[]): { title: string; body: string } | null {
  const toSend = firings.filter((f) => f.notify);
  if (toSend.length === 0) return null;
  if (toSend.length === 1) return { title: toSend[0].title, body: toSend[0].body };
  return {
    title: `${toSend.length} usage alerts`,
    body: toSend.map((f) => f.title).join(" · "),
  };
}
