import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { claudeAdapter } from "../src/adapters/claude.ts";
import { count, tempDir, testContext, writeLines } from "./helpers.ts";

const SESSION = "11111111-2222-3333-4444-555555555555";

function assistant(id: string, requestId: string, output: number, extra: Record<string, unknown> = {}) {
  return {
    type: "assistant",
    sessionId: SESSION,
    cwd: "/work/proj",
    timestamp: "2026-10-01T01:00:00.000Z",
    requestId,
    message: {
      id,
      model: "claude-opus-4-8",
      usage: {
        input_tokens: 10,
        output_tokens: output,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 200,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 200 },
        output_tokens_details: { thinking_tokens: 5 },
      },
    },
    ...extra,
  };
}

describe("claude adapter", () => {
  let root: string;
  before(() => {
    root = tempDir();
    process.env.CLAUDE_CONFIG_DIR = root;
    const proj = join(root, "projects", "-work-proj");
    writeLines(join(proj, `${SESSION}.jsonl`), [
      { type: "user", sessionId: SESSION, cwd: "/work/proj", timestamp: "2026-10-01T00:59:00.000Z" },
      { type: "ai-title", aiTitle: "Fix the parser", sessionId: SESSION },
      // one response streamed as three lines: early lines carry placeholder output
      assistant("msg_A", "req_A", 1),
      assistant("msg_A", "req_A", 1),
      assistant("msg_A", "req_A", 420),
      assistant("msg_B", "req_B", 50),
      // /btw replay: same message id, new request id → must not double count
      assistant("msg_B", "req_B2", 50),
      { type: "assistant", sessionId: SESSION, timestamp: "2026-10-01T01:01:00.000Z", message: { id: "x", model: "<synthetic>", usage: { input_tokens: 0, output_tokens: 0 } } },
    ]);
    writeLines(join(proj, SESSION, "subagents", "agent-abc.jsonl"), [
      assistant("msg_SUB", "req_S", 30, { isSidechain: true, agentId: "abc" }),
    ]);
    // ClaudeBar probe sessions are ignored by default
    writeLines(join(root, "projects", "-Users-x-Library-Application-Support-ClaudeBar-Probe", "p.jsonl"), [
      assistant("msg_PROBE", "req_P", 9),
    ]);
  });

  it("dedupes streaming lines keeping the max output, skips synthetic and probes", () => {
    const ctx = testContext();
    const res = claudeAdapter.ingest(ctx);
    assert.equal(res.errors, 0);
    assert.equal(count(ctx), 3, "msg_A, msg_B and the subagent call");
    const a = ctx.ledger.get<{ output: number; reasoning: number; cost_usd: number; cache_write_1h: number }>(
      "SELECT output, reasoning, cost_usd, cache_write_1h FROM request WHERE id = 'claude:msg_A'",
    );
    assert.equal(a?.output, 420);
    assert.equal(a?.reasoning, 5);
    assert.equal(a?.cache_write_1h, 200);
    // 10×5 + 420×25 + 1000×0.5 + 200 (1h) × 2×5 = 13,050 per 1M
    assert.ok(Math.abs((a?.cost_usd ?? 0) - 0.01305) < 1e-9);
    assert.equal(count(ctx, "model = '<synthetic>'"), 0);
    assert.equal(count(ctx, "id LIKE '%PROBE%'"), 0);
  });

  it("rolls subagent calls up to the parent session and records the title", () => {
    const ctx = testContext();
    claudeAdapter.ingest(ctx);
    const sub = ctx.ledger.get<{ root_session_id: string; is_subagent: number }>(
      "SELECT root_session_id, is_subagent FROM request WHERE id = 'claude:msg_SUB'",
    );
    assert.equal(sub?.root_session_id, SESSION);
    assert.equal(sub?.is_subagent, 1);
    const s = ctx.ledger.get<{ title: string; cwd: string }>("SELECT title, cwd FROM session WHERE id = ?", SESSION);
    assert.equal(s?.title, "Fix the parser");
    assert.equal(s?.cwd, "/work/proj");
  });

  it("is incremental: appended lines are picked up, unchanged files skipped", () => {
    const ctx = testContext();
    claudeAdapter.ingest(ctx);
    const again = claudeAdapter.ingest(ctx);
    assert.equal(again.files, 0);
    const file = join(root, "projects", "-work-proj", `${SESSION}.jsonl`);
    appendFileSync(file, JSON.stringify(assistant("msg_C", "req_C", 77)) + "\n");
    const third = claudeAdapter.ingest(ctx);
    assert.equal(third.files, 1);
    assert.equal(count(ctx), 4);
  });
});
