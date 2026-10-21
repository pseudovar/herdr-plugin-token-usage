import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCopilotUser } from "../src/core/quota/copilot.ts";

const NOW = Date.parse("2026-10-19T01:16:15.948Z");

describe("copilot quota parsing", () => {
  it("parses a token-based Business seat with a budget (shape verified live)", () => {
    const q = parseCopilotUser(
      {
        copilot_plan: "business",
        token_based_billing: true,
        quota_reset_date: "2026-11-01",
        quota_reset_date_utc: "2026-11-01T00:00:00.000Z",
        quota_snapshots: {
          chat: { unlimited: true, entitlement: 0 },
          premium_interactions: {
            entitlement: 60000,
            remaining: 51378,
            quota_remaining: 51378.6,
            percent_remaining: 85.6,
            unlimited: false,
            overage_permitted: true,
            quota_reset_at: 0,
          },
        },
      },
      NOW,
    );
    assert.equal(q.ok, true);
    assert.equal(q.unit, "credits");
    assert.equal(q.entitlement, 60000);
    assert.ok(Math.abs((q.usedPct ?? 0) - 14.4) < 1e-9);
    assert.ok(Math.abs((q.used ?? 0) - 8621.4) < 1e-6);
    assert.equal(q.resetAt, Date.parse("2026-11-01T00:00:00.000Z"));
    assert.equal(q.periodStart, Date.parse("2026-10-01T00:00:00.000Z"));
    assert.ok(q.elapsedPct > 58 && q.elapsedPct < 59);
    assert.ok((q.pace ?? 0) > 0.24 && (q.pace ?? 0) < 0.25);
    assert.ok(q.daysLeft > 12.9 && q.daysLeft < 13);
  });

  it("accepts entitlement as a string", () => {
    const q = parseCopilotUser(
      { token_based_billing: true, quota_snapshots: { premium_interactions: { entitlement: "1500", quota_remaining: 750, percent_remaining: 50 } } },
      NOW,
    );
    assert.equal(q.entitlement, 1500);
    assert.equal(q.used, 750);
  });

  it("handles pooled unlimited seats via credits_used", () => {
    const q = parseCopilotUser(
      { token_based_billing: true, quota_snapshots: { premium_interactions: { unlimited: true, entitlement: 0, credits_used: 31 } } },
      NOW,
    );
    assert.equal(q.unlimited, true);
    assert.equal(q.used, 31);
    assert.equal(q.usedPct, null);
  });

  it("treats a zero entitlement as a placeholder", () => {
    const q = parseCopilotUser({ quota_snapshots: { premium_interactions: { unlimited: false, entitlement: 0 } } }, NOW);
    assert.equal(q.ok, false);
  });

  it("reports overage as more than 100% used", () => {
    const q = parseCopilotUser(
      { token_based_billing: false, quota_snapshots: { premium_interactions: { entitlement: 300, quota_remaining: -30, percent_remaining: -10 } } },
      NOW,
    );
    assert.equal(q.unit, "requests");
    assert.equal(q.usedPct, 110);
  });
});
