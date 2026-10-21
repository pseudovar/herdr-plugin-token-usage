import assert from "node:assert/strict";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { piAdapter } from "../src/adapters/pi.ts";
import { count, tempDir, testContext, writeLines } from "./helpers.ts";

function msg(id: string, ts: number, usage: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date(ts).toISOString(),
    message: {
      role: "assistant",
      provider: "github-copilot",
      model: "claude-opus-5.5",
      usage,
      timestamp: ts,
      responseId: `resp_${id}`,
      durationMs: 2000,
      ...extra,
    },
  };
}

const usage = {
  input: 2,
  output: 100,
  cacheRead: 1000,
  cacheWrite: 50,
  reasoning: 10,
  totalTokens: 1152,
  cost: { total: 0.00585 },
};

describe("pi adapter", () => {
  let dir: string;
  before(() => {
    const root = tempDir();
    process.env.PI_CODING_AGENT_DIR = root;
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
    dir = join(root, "sessions", "--work-proj--");
    const t0 = Date.parse("2026-10-02T00:00:00Z");
    writeLines(join(dir, "2026-10-02T00-00-00-000Z_aaaa-1111.jsonl"), [
      { type: "session", version: 3, id: "aaaa-1111", timestamp: "2026-10-02T00:00:00.000Z", cwd: "/work/proj" },
      { type: "session_info", id: "i1", parentId: null, timestamp: "2026-10-02T00:00:01.000Z", name: "Refactor auth" },
      msg("e1", t0 + 1000, usage),
      msg("e2", t0 + 5000, usage),
      { type: "usage", id: "u1", timestamp: "2026-10-02T00:00:09.000Z", kind: "cache_warm", provider: "github-copilot", model: "claude-opus-5.5", usage: { input: 0, output: 1, cacheRead: 500, cacheWrite: 0, cost: { total: 0.0001 } } },
    ]);
    // /fork copies entries verbatim into a new file: must not double count
    writeLines(join(dir, "2026-10-02T01-00-00-000Z_bbbb-2222.jsonl"), [
      { type: "session", version: 3, id: "bbbb-2222", timestamp: "2026-10-02T01:00:00.000Z", cwd: "/work/proj", parentSession: "x" },
      msg("e1", t0 + 1000, usage),
      msg("e3", t0 + 9000, usage),
    ]);
  });

  it("counts assistant and usage entries, dedupes fork copies", () => {
    const ctx = testContext();
    const res = piAdapter.ingest(ctx);
    assert.equal(res.errors, 0);
    assert.equal(count(ctx), 4, "e1, e2, u1 (parent) + e3 (fork)");
    const e1 = ctx.ledger.get<{ session_id: string }>("SELECT session_id FROM request WHERE id LIKE 'pi:e1:%'");
    assert.equal(e1?.session_id, "aaaa-1111", "fork copy keeps the parent's attribution");
  });

  it("prices Copilot calls in credits and keeps $ = credits / 100", () => {
    const ctx = testContext();
    piAdapter.ingest(ctx);
    const r = ctx.ledger.get<{ billing: string; credits: number; cost_usd: number; duration_ms: number }>(
      "SELECT billing, credits, cost_usd, duration_ms FROM request WHERE id LIKE 'pi:e2:%'",
    );
    assert.equal(r?.billing, "copilot");
    // (2×4 + 100×20 + 1000×0.2 + 50×5) / 1e6 × 100 = 0.2458 credits
    assert.ok(Math.abs((r?.credits ?? 0) - 0.2458) < 1e-9);
    assert.ok(Math.abs((r?.cost_usd ?? 0) - 0.002458) < 1e-12);
    assert.equal(r?.duration_ms, 2000);
  });

  it("records the session title and cwd", () => {
    const ctx = testContext();
    piAdapter.ingest(ctx);
    const s = ctx.ledger.get<{ title: string; cwd: string }>("SELECT title, cwd FROM session WHERE id = 'aaaa-1111'");
    assert.equal(s?.title, "Refactor auth");
    assert.equal(s?.cwd, "/work/proj");
  });
});
