import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultConfig } from "../src/core/config.ts";
import type { Rule } from "../src/core/config.ts";
import { Ledger } from "../src/core/ledger.ts";
import type { SessionMetrics } from "../src/core/metrics.ts";
import { parseCopilotUser } from "../src/core/quota/copilot.ts";
import { coalesce, evaluate } from "../src/core/rules.ts";
import type { EvalContext } from "../src/core/rules.ts";

function session(over: Partial<SessionMetrics> = {}): SessionMetrics {
  return {
    calls: 10,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    workTokens: 0,
    processedTokens: 0,
    costUsd: 0,
    credits: 0,
    creditsExact: 0,
    harness: "pi",
    sessionId: "S1",
    title: null,
    cwd: null,
    model: "m",
    provider: "github-copilot",
    billing: "copilot",
    firstTs: 0,
    lastTs: 0,
    contextTokens: 0,
    contextLimit: 100,
    contextPct: 0,
    cacheHitPct: 95,
    credits5m: 0,
    costUsd5m: 0,
    tokens5m: 0,
    tpsP50: null,
    ttftP50: null,
    subagentCredits: 0,
    subagentCostUsd: 0,
    ...over,
  };
}

function ctx(now: number, s: SessionMetrics | null, quota: EvalContext["quota"] = null): EvalContext {
  return { now, quota, today: null, session: s, labels: { agent: "w1 Pi" } };
}

function config(rules: Rule[]) {
  const c = defaultConfig();
  c.rules = rules;
  return c;
}

const ctxRule: Rule = {
  id: "ctx",
  title: "Context",
  enabled: true,
  notify: true,
  metric: "session.context_pct",
  op: ">=",
  value: 80,
  level: "high",
};

describe("rules engine", () => {
  it("fires a threshold once on the rising edge and clears with hysteresis", () => {
    const ledger = new Ledger(":memory:");
    const c = config([ctxRule]);
    const t0 = Date.parse("2026-10-10T00:00:00Z");
    let r = evaluate(ledger, c, "session", ctx(t0, session({ contextPct: 50 })));
    assert.equal(r.firings.length, 0);
    assert.equal(r.level, "normal");
    r = evaluate(ledger, c, "session", ctx(t0 + 1, session({ contextPct: 85 })));
    assert.equal(r.firings.length, 1);
    assert.equal(r.firings[0].notify, true);
    assert.equal(r.level, "high");
    r = evaluate(ledger, c, "session", ctx(t0 + 2, session({ contextPct: 90 })));
    assert.equal(r.firings.length, 0, "still active: no repeat");
    r = evaluate(ledger, c, "session", ctx(t0 + 3, session({ contextPct: 78 })));
    assert.equal(r.level, "high", "within the 5% hysteresis band");
    r = evaluate(ledger, c, "session", ctx(t0 + 4, session({ contextPct: 60 })));
    assert.equal(r.level, "normal");
    r = evaluate(ledger, c, "session", ctx(t0 + 5, session({ contextPct: 85 })));
    assert.equal(r.firings.length, 1);
    assert.equal(r.firings[0].notify, false, "re-activation inside the cooldown does not toast");
  });

  it("fires each step once per scope", () => {
    const ledger = new Ledger(":memory:");
    const rule: Rule = { id: "q", title: "Quota", enabled: true, notify: true, metric: "quota.copilot.used_pct", op: ">=", steps: [75, 90], level: "high" };
    const c = config([rule]);
    const now = Date.parse("2026-10-20T00:00:00Z");
    const quota = (usedPct: number) => ({
      ...parseCopilotUser({ token_based_billing: true, quota_reset_date_utc: "2026-11-01T00:00:00.000Z", quota_snapshots: { premium_interactions: { entitlement: 1000, quota_remaining: 1000 - usedPct * 10, percent_remaining: 100 - usedPct } } }, now),
    });
    assert.equal(evaluate(ledger, c, "global", ctx(now, null, quota(70))).firings.length, 0);
    assert.equal(evaluate(ledger, c, "global", ctx(now, null, quota(76))).firings.length, 1);
    assert.equal(evaluate(ledger, c, "global", ctx(now, null, quota(80))).firings.length, 0);
    assert.equal(evaluate(ledger, c, "global", ctx(now, null, quota(95))).firings.length, 1);
    assert.equal(evaluate(ledger, c, "global", ctx(now, null, quota(96))).firings.length, 0);
  });

  it("fires `every` milestones and holds their level only briefly", () => {
    const ledger = new Ledger(":memory:");
    const rule: Rule = { id: "e", title: "Expensive", enabled: true, notify: true, metric: "session.credits", op: ">=", every: 500, level: "high", billing: "copilot" };
    const c = config([rule]);
    const t0 = Date.parse("2026-10-10T00:00:00Z");
    let r = evaluate(ledger, c, "session", ctx(t0, session({ credits: 520 })));
    assert.equal(r.firings.length, 1);
    assert.match(r.firings[0].title, /session passed \$5\.00/, "milestones read in dollars (500 credits = $5)");
    assert.equal(r.level, "high");
    r = evaluate(ledger, c, "session", ctx(t0 + 60_000, session({ credits: 700 })));
    assert.equal(r.firings.length, 0);
    assert.equal(r.level, "high", "still within the hold");
    r = evaluate(ledger, c, "session", ctx(t0 + 20 * 60_000, session({ credits: 900 })));
    assert.equal(r.level, "normal", "hold expired: not a standing alarm");
    r = evaluate(ledger, c, "session", ctx(t0 + 21 * 60_000, session({ credits: 1010 })));
    assert.equal(r.firings.length, 1);
    assert.match(r.firings[0].title, /\$10\.00/);
  });

  it("respects billing filters, guards and snooze", () => {
    const ledger = new Ledger(":memory:");
    const rule: Rule = { ...ctxRule, id: "cache", metric: "session.cache_hit_pct", op: "<=", value: 50, minCalls: 5, billing: "claude" };
    const c = config([rule]);
    const now = Date.now();
    assert.equal(evaluate(ledger, c, "session", ctx(now, session({ cacheHitPct: 10 }))).firings.length, 0, "billing filter");
    assert.equal(evaluate(ledger, c, "session", ctx(now, session({ billing: "claude", calls: 3, cacheHitPct: 10 }))).firings.length, 0, "minCalls guard");
    ledger.setMeta("snooze_until", String(now + 60_000));
    const r = evaluate(ledger, c, "session", ctx(now + 1, session({ billing: "claude", calls: 9, cacheHitPct: 10 })));
    assert.equal(r.firings.length, 1);
    assert.equal(r.firings[0].notify, false, "snoozed: logged but no toast");
  });

  it("coalesces several alerts into one toast", () => {
    const f = (title: string) => ({ rule: ctxRule, scope: "s", value: 1, level: "high" as const, title, body: "b", notify: true });
    assert.equal(coalesce([]), null);
    assert.deepEqual(coalesce([f("A")]), { title: "A", body: "b" });
    assert.deepEqual(coalesce([f("A"), f("B")]), { title: "2 usage alerts", body: "A · B" });
  });

  it("default rules are valid and cover the agreed alert categories", () => {
    const ids = defaultConfig().rules.map((r) => r.id);
    for (const id of ["copilot-pace-high", "copilot-used", "context-high", "session-credits", "burn-credits", "cache-poor", "copilot-under-using"]) {
      assert.ok(ids.includes(id), id);
    }
  });
});
