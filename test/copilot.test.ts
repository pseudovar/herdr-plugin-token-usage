import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { before, describe, it } from "node:test";
import { copilotAdapter } from "../src/adapters/copilot.ts";
import { count, tempDir, testContext, writeLines } from "./helpers.ts";

describe("copilot cli adapter", () => {
  before(() => {
    const home = tempDir();
    process.env.COPILOT_HOME = home;
    const db = new DatabaseSync(join(home, "session-store.db"));
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, summary TEXT);
      CREATE TABLE assistant_usage_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, turn_index INTEGER,
        agent_id TEXT, parent_tool_call_id TEXT, model TEXT, copilot_usage_model TEXT, input_tokens INTEGER,
        output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER,
        total_nano_aiu INTEGER, request_multiplier REAL, duration_ms INTEGER, time_to_first_token_ms INTEGER,
        output_ttft_ms REAL, inter_token_latency_ms INTEGER, initiator TEXT, api_endpoint TEXT,
        reasoning_effort TEXT, finish_reason TEXT, content_filter_triggered INTEGER, token_details_json TEXT,
        created_at TEXT);
    `);
    db.prepare("INSERT INTO sessions VALUES ('s1', '/work/cli', 'Add tests')").run();
    const details = JSON.stringify([
      { batchSize: 1000000, costPerBatch: 400000000000, tokenCount: 4, tokenType: "input", model: "claude-opus-5.5" },
      { batchSize: 1000000, costPerBatch: 20000000000, tokenCount: 1000, tokenType: "cache_read", model: "claude-opus-5.5" },
      { batchSize: 1000000, costPerBatch: 500000000000, tokenCount: 50, tokenType: "cache_write", model: "claude-opus-5.5" },
      { batchSize: 1000000, costPerBatch: 2000000000000, tokenCount: 100, tokenType: "output", model: "claude-opus-5.5" },
    ]);
    const ins = db.prepare(`INSERT INTO assistant_usage_events (session_id, model, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, reasoning_tokens, total_nano_aiu, request_multiplier, duration_ms,
      time_to_first_token_ms, inter_token_latency_ms, initiator, token_details_json, created_at)
      VALUES ('s1', 'claude-opus-5.5', ?, 100, 1000, 50, 10, ?, 15.0, 3000, 1200, 12, ?, ?, ?)`);
    // input_tokens includes cache reads and writes: uncached = 1054 − 1000 − 50 = 4
    ins.run(1054, 225800000, "user", details, "2026-10-03T00:00:00.000Z");
    ins.run(1054, 225800000, "agent", details, "2026-10-03T00:00:05.000Z");
    db.close();
    writeLines(join(home, "session-state", "s1", "events.jsonl"), [
      { type: "session.usage_record", data: { usage: { model: "claude-opus-5.5", maxPromptTokens: 200000 } } },
    ]);
  });

  it("normalizes input, uses exact credits and learns context limits", () => {
    const ctx = testContext();
    const res = copilotAdapter.ingest(ctx);
    assert.equal(res.errors, 0);
    assert.equal(count(ctx), 2);
    const r = ctx.ledger.get<{
      input: number;
      credits: number;
      credits_exact: number;
      cost_usd: number;
      premium_mult: number;
      ttft_ms: number;
      context_limit: number;
      cwd: string;
    }>("SELECT input, credits, credits_exact, cost_usd, premium_mult, ttft_ms, context_limit, cwd FROM request ORDER BY ts LIMIT 1");
    assert.equal(r?.input, 4);
    assert.ok(Math.abs((r?.credits ?? 0) - 0.2258) < 1e-12);
    assert.equal(r?.credits_exact, 1);
    assert.ok(Math.abs((r?.cost_usd ?? 0) - 0.002258) < 1e-12);
    assert.equal(r?.premium_mult, 15);
    assert.equal(r?.ttft_ms, 1200);
    assert.equal(r?.context_limit, 200000);
    assert.equal(r?.cwd, "/work/cli");
  });

  it("stores the observed credit rate card for pricing other harnesses", () => {
    const ctx = testContext();
    copilotAdapter.ingest(ctx);
    const card = JSON.parse(ctx.ledger.getMeta("copilot_rate_card") ?? "{}");
    assert.deepEqual(card["claude-opus-5-5"], { input: 400, output: 2000, cacheRead: 20, cacheWrite: 500 });
  });

  it("only reads new rows on the next run", () => {
    const ctx = testContext();
    copilotAdapter.ingest(ctx);
    assert.equal(copilotAdapter.ingest(ctx).records, 0);
  });
});
