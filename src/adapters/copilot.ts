import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { harnessPaths } from "../env.ts";
import type { Rates } from "../core/pricing.ts";
import { normalizeModel } from "../core/pricing.ts";
import type { UsageRecord } from "../core/types.ts";
import { parseJson, readTailLines } from "../util/fs.ts";
import { emptyResult, n, nOrNull } from "./adapter.ts";
import type { Adapter, AdapterContext, AdapterResult } from "./adapter.ts";

interface UsageRow {
  id: number;
  session_id: string;
  turn_index: number | null;
  agent_id: string | null;
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  reasoning_tokens: number | null;
  total_nano_aiu: number | null;
  request_multiplier: number | null;
  duration_ms: number | null;
  time_to_first_token_ms: number | null;
  inter_token_latency_ms: number | null;
  initiator: string | null;
  created_at: string;
  cwd: string | null;
  summary: string | null;
}

interface TokenDetail {
  batchSize?: number;
  costPerBatch?: number;
  tokenType?: string;
}

const BATCH_LIMIT = 50_000;

/**
 * GitHub Copilot CLI. `~/.copilot/session-store.db` keeps one normalized row
 * per API call in `assistant_usage_events`, including exact AI-credit cost
 * (`total_nano_aiu`, 1e9 nano-AIU = 1 credit = $0.01), TTFT and inter-token
 * latency. `input_tokens` includes cache reads and writes, so uncached input =
 * input − cache_read − cache_write. `request_multiplier` is the legacy
 * premium-request multiplier, not USD.
 */
export const copilotAdapter: Adapter = {
  harness: "copilot",

  detect() {
    return existsSync(join(harnessPaths.copilotHome(), "session-store.db"));
  },

  ingest(ctx: AdapterContext): AdapterResult {
    const home = harnessPaths.copilotHome();
    const path = join(home, "session-store.db");
    if (!existsSync(path)) return emptyResult("copilot", "no session-store.db");
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(path, { readOnly: true });
      db.exec("PRAGMA busy_timeout = 2000");
    } catch (err) {
      return emptyResult("copilot", `open failed: ${(err as Error).message}`);
    }
    const result = emptyResult("copilot");
    try {
      const hasTable = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'assistant_usage_events'")
        .get();
      if (!hasTable) return emptyResult("copilot", "no assistant_usage_events table");
      const cursorKey = "copilot:db";
      const cursor = ctx.ledger.getCursor<{ id: number }>(cursorKey) ?? { id: 0 };
      const maxRow = db.prepare("SELECT MAX(id) AS id FROM assistant_usage_events").get() as { id: number | null };
      let since = cursor.id;
      if (maxRow.id != null && maxRow.id < since) since = 0; // store was recreated
      const rows = db
        .prepare(
          `SELECT e.id, e.session_id, e.turn_index, e.agent_id, e.model, e.input_tokens, e.output_tokens,
                  e.cache_read_tokens, e.cache_write_tokens, e.reasoning_tokens, e.total_nano_aiu,
                  e.request_multiplier, e.duration_ms, e.time_to_first_token_ms, e.inter_token_latency_ms,
                  e.initiator, e.created_at, s.cwd, s.summary
           FROM assistant_usage_events e LEFT JOIN sessions s ON s.id = e.session_id
           WHERE e.id > :since ORDER BY e.id LIMIT ${BATCH_LIMIT}`,
        )
        .all({ since }) as unknown as UsageRow[];
      if (rows.length === 0) return result;

      updateRateCard(ctx, db);
      const sessionsTouched = new Map<string, { cwd: string | null; title: string | null; first: number; last: number }>();
      for (const row of rows) {
        const ts = Date.parse(row.created_at);
        if (!Number.isFinite(ts)) continue;
        const s = sessionsTouched.get(row.session_id);
        if (s) {
          s.first = Math.min(s.first, ts);
          s.last = Math.max(s.last, ts);
        } else {
          sessionsTouched.set(row.session_id, { cwd: row.cwd, title: row.summary, first: ts, last: ts });
        }
      }
      for (const sessionId of sessionsTouched.keys()) learnContextLimits(ctx, home, sessionId);

      const records: UsageRecord[] = [];
      let maxId = since;
      for (const row of rows) {
        maxId = Math.max(maxId, row.id);
        const ts = Date.parse(row.created_at);
        if (!Number.isFinite(ts)) {
          result.errors++;
          continue;
        }
        const cacheRead = n(row.cache_read_tokens);
        const cacheWrite = n(row.cache_write_tokens);
        const t = {
          input: Math.max(0, n(row.input_tokens) - cacheRead - cacheWrite),
          output: n(row.output_tokens),
          cacheRead,
          cacheWrite,
          cacheWrite1h: 0,
        };
        const nano = nOrNull(row.total_nano_aiu);
        const credits = nano != null ? nano / 1e9 : ctx.pricing.credits(row.model, t);
        records.push({
          id: `copilot:${row.session_id}:${row.id}`,
          harness: "copilot",
          sessionId: row.session_id,
          rootSessionId: row.session_id,
          ts,
          cwd: row.cwd,
          provider: "github-copilot",
          model: row.model,
          billing: "copilot",
          ...t,
          reasoning: n(row.reasoning_tokens),
          costUsd: credits != null ? credits / 100 : null,
          credits,
          creditsExact: nano != null,
          premiumMultiplier: nOrNull(row.request_multiplier),
          initiator: row.initiator,
          durationMs: nOrNull(row.duration_ms),
          ttftMs: nOrNull(row.time_to_first_token_ms),
          itlMs: nOrNull(row.inter_token_latency_ms),
          contextLimit: ctx.ledger.getModelLimit("copilot", row.model) ?? ctx.pricing.contextLimit("github-copilot", row.model),
          isSubagent: row.agent_id != null || row.initiator === "sub-agent",
        });
      }
      for (const [id, s] of sessionsTouched) {
        ctx.ledger.upsertSession({
          harness: "copilot",
          id,
          rootId: id,
          parentId: null,
          cwd: s.cwd,
          title: s.title,
          path: join(home, "session-state", id),
          firstTs: s.first,
          lastTs: s.last,
        });
        result.sessions++;
      }
      result.records = ctx.ledger.upsertRequests(records, "replace");
      ctx.ledger.setCursor(cursorKey, { id: maxId });
      return result;
    } catch (err) {
      return { ...result, errors: result.errors + 1, note: (err as Error).message };
    } finally {
      db.close();
    }
  },
};

/**
 * Copilot CLI records the exact credit price of every call. Keep the latest
 * observed per-model rate card (credits per 1M tokens) so Pi and OpenCode
 * calls routed through the `github-copilot` provider can be priced exactly.
 */
function updateRateCard(ctx: AdapterContext, db: DatabaseSync): void {
  const rows = db
    .prepare(
      `SELECT model, token_details_json FROM assistant_usage_events
       WHERE id IN (SELECT MAX(id) FROM assistant_usage_events
                    WHERE token_details_json IS NOT NULL GROUP BY model)`,
    )
    .all() as Array<{ model: string; token_details_json: string }>;
  const existing = ctx.ledger.getMeta("copilot_rate_card");
  const card: Record<string, Rates> = existing ? (parseJson<Record<string, Rates>>(existing) ?? {}) : {};
  for (const row of rows) {
    const details = parseJson<TokenDetail[]>(row.token_details_json);
    if (!Array.isArray(details)) continue;
    const rate = (type: string) => {
      const d = details.find((x) => x.tokenType === type);
      if (!d || !d.batchSize || d.costPerBatch == null) return null;
      return (d.costPerBatch / d.batchSize) * 1e6 / 1e9;
    };
    const input = rate("input");
    const output = rate("output");
    if (input == null || output == null) continue;
    card[normalizeModel(row.model)] = {
      input,
      output,
      cacheRead: rate("cache_read") ?? input,
      cacheWrite: rate("cache_write") ?? input,
    };
  }
  ctx.ledger.setMeta("copilot_rate_card", JSON.stringify(card));
}

/** Learn each model's prompt limit (`maxPromptTokens`) from the session's event log tail. */
function learnContextLimits(ctx: AdapterContext, home: string, sessionId: string): void {
  const lines = readTailLines(join(home, "session-state", sessionId, "events.jsonl"), 512 * 1024);
  const seen = new Set<string>();
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"session.usage_record"')) continue;
    const ev = parseJson<{ data?: { usage?: { model?: string; maxPromptTokens?: number } } }>(line);
    const usage = ev?.data?.usage;
    if (!usage?.model || !usage.maxPromptTokens || seen.has(usage.model)) continue;
    seen.add(usage.model);
    ctx.ledger.setModelLimit("copilot", usage.model, usage.maxPromptTokens);
  }
}
