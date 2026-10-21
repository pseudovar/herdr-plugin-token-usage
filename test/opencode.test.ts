import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { before, describe, it } from "node:test";
import { opencodeAdapter } from "../src/adapters/opencode.ts";
import { count, tempDir, testContext } from "./helpers.ts";

describe("opencode adapter (v2 schema)", () => {
  before(() => {
    const dir = tempDir();
    const path = join(dir, "opencode.db");
    process.env.OPENCODE_DB = path;
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, fork_session_id TEXT,
        directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
        time_created INTEGER, time_updated INTEGER, data TEXT);
    `);
    const ins = db.prepare("INSERT INTO session_v2 VALUES (?, 'p', ?, ?, '/work/oc', ?, ?, ?)");
    ins.run("ses_root", null, null, "Main task", 1000, 9000);
    ins.run("ses_child", "ses_root", null, "Subagent", 2000, 9000);
    ins.run("ses_fork", null, "ses_root", "Fork", 5000, 9000);
    const msg = db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)");
    const data = (tokens: unknown, cost = 0.01) =>
      JSON.stringify({
        agent: "build",
        model: { id: "claude-opus-5.5", providerID: "github-copilot" },
        cost,
        tokens,
        time: { created: 3000, streamed: 5000, completed: 5100 },
      });
    const t = { input: 2, output: 100, reasoning: 40, cache: { read: 1000, write: 50 } };
    msg.run("msg_1", "ses_root", "assistant", 1, 3000, 3100, data(t));
    msg.run("msg_2", "ses_child", "assistant", 1, 3500, 3600, data(t));
    msg.run("msg_inflight", "ses_root", "assistant", 2, 4000, 4000, JSON.stringify({ model: { id: "claude-opus-5.5", providerID: "github-copilot" }, time: { created: 4000 } }));
    // fork copy keeps the parent's time_created (before the fork session existed)
    msg.run("msg_1_copy", "ses_fork", "assistant", 1, 3000, 5000, data(t));
    msg.run("msg_user", "ses_root", "user", 0, 2900, 2900, JSON.stringify({ text: "hi" }));
    db.close();
  });

  it("ingests completed steps, skips in-flight rows and fork copies", () => {
    const ctx = testContext();
    const res = opencodeAdapter.ingest(ctx);
    assert.equal(res.errors, 0);
    assert.equal(count(ctx), 2);
    assert.equal(count(ctx, "id = 'opencode:msg_1_copy'"), 0);
  });

  it("counts reasoning as billed output and rolls children up to the root", () => {
    const ctx = testContext();
    opencodeAdapter.ingest(ctx);
    const r = ctx.ledger.get<{ output: number; reasoning: number; duration_ms: number; credits: number }>(
      "SELECT output, reasoning, duration_ms, credits FROM request WHERE id = 'opencode:msg_1'",
    );
    assert.equal(r?.output, 140);
    assert.equal(r?.reasoning, 40);
    assert.equal(r?.duration_ms, 2000);
    // (2×4 + 140×20 + 1000×0.2 + 50×5)/1e6 × 100
    assert.ok(Math.abs((r?.credits ?? 0) - 0.3258) < 1e-9);
    const child = ctx.ledger.get<{ root_session_id: string; is_subagent: number }>(
      "SELECT root_session_id, is_subagent FROM request WHERE id = 'opencode:msg_2'",
    );
    assert.equal(child?.root_session_id, "ses_root");
    assert.equal(child?.is_subagent, 1);
  });

  it("uses a time_updated watermark", () => {
    const ctx = testContext();
    opencodeAdapter.ingest(ctx);
    const again = opencodeAdapter.ingest(ctx);
    assert.equal(again.records, 2, "rows inside the safety window are re-upserted idempotently");
    assert.equal(count(ctx), 2);
  });
});
