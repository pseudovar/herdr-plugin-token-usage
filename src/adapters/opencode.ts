import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { harnessPaths } from "../env.ts";
import type { UsageRecord } from "../core/types.ts";
import { parseJson } from "../util/fs.ts";
import { billingFor, emptyResult, n, nOrNull } from "./adapter.ts";
import type { Adapter, AdapterContext, AdapterResult } from "./adapter.ts";

interface SessionRow {
  id: string;
  parent_id: string | null;
  directory: string | null;
  title: string | null;
  time_created: number;
  time_updated: number;
}

interface MessageRow {
  id: string;
  session_id: string;
  time_created: number;
  time_updated: number;
  data: string;
}

interface AssistantData {
  agent?: string;
  model?: { id?: string; providerID?: string };
  // v1.2 message shape
  modelID?: string;
  providerID?: string;
  role?: string;
  path?: { cwd?: string };
  cost?: number;
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
  time?: { created?: number; streamed?: number; completed?: number };
}

const SAFETY_WINDOW_MS = 5_000;

/**
 * OpenCode. v2 (2.x) stores one `session_message` row per LLM step in
 * opencode.db; v1.2 used `message` rows with the same JSON shape. Rows are
 * inserted at step start without `tokens` and completed later, so we poll by
 * `time_updated` and upsert. `tokens.output` excludes reasoning, so billed
 * output = output + reasoning. Fork copies keep the parent's `time_created`
 * and are skipped. Child (subagent) sessions roll up via `parent_id`.
 */
export const opencodeAdapter: Adapter = {
  harness: "opencode",

  detect() {
    return existsSync(harnessPaths.opencodeDb());
  },

  ingest(ctx: AdapterContext): AdapterResult {
    const path = harnessPaths.opencodeDb();
    if (!existsSync(path)) return emptyResult("opencode", "no opencode.db");
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(path, { readOnly: true });
      db.exec("PRAGMA busy_timeout = 2000");
    } catch (err) {
      return emptyResult("opencode", `open failed: ${(err as Error).message}`);
    }
    try {
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name),
      );
      if (tables.has("session_v2") && tables.has("session_message")) return ingestV2(ctx, db);
      if (tables.has("session") && tables.has("message")) return ingestV1(ctx, db);
      return emptyResult("opencode", "unrecognized schema");
    } finally {
      db.close();
    }
  },
};

function ingestV2(ctx: AdapterContext, db: DatabaseSync): AdapterResult {
  const result = emptyResult("opencode");
  const cursorKey = "opencode:v2";
  const cursor = ctx.ledger.getCursor<{ wm: number }>(cursorKey) ?? { wm: 0 };

  const sessions = db
    .prepare(
      `SELECT id, parent_id, directory, title, time_created, time_updated, fork_session_id
       FROM session_v2`,
    )
    .all() as unknown as Array<SessionRow & { fork_session_id: string | null }>;
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const rootOf = makeRootResolver((id) => byId.get(id)?.parent_id ?? null);

  for (const s of sessions) {
    if (s.time_updated < cursor.wm - SAFETY_WINDOW_MS) continue;
    ctx.ledger.upsertSession({
      harness: "opencode",
      id: s.id,
      rootId: rootOf(s.id),
      parentId: s.parent_id,
      cwd: s.directory,
      title: s.title,
      path: null,
      firstTs: s.time_created,
      lastTs: s.time_updated,
    });
    result.sessions++;
  }

  const rows = db
    .prepare(
      `SELECT m.id, m.session_id, m.time_created, m.time_updated, m.data
       FROM session_message m JOIN session_v2 s ON s.id = m.session_id
       WHERE m.type IN ('assistant', 'compaction')
         AND m.time_updated > :wm
         AND (s.fork_session_id IS NULL OR m.time_created >= s.time_created)
       ORDER BY m.time_updated`,
    )
    .all({ wm: cursor.wm - SAFETY_WINDOW_MS }) as unknown as MessageRow[];

  let wm = cursor.wm;
  const records: UsageRecord[] = [];
  for (const row of rows) {
    wm = Math.max(wm, row.time_updated);
    const data = parseJson<AssistantData>(row.data);
    if (!data) {
      result.errors++;
      continue;
    }
    const session = byId.get(row.session_id);
    const rec = toRecord(ctx, row.id, row.session_id, rootOf(row.session_id), session?.directory ?? null, row.time_created, data);
    if (rec) records.push(rec);
  }
  result.records = ctx.ledger.upsertRequests(records, "replace");
  ctx.ledger.setCursor(cursorKey, { wm });
  return result;
}

function ingestV1(ctx: AdapterContext, db: DatabaseSync): AdapterResult {
  const result = emptyResult("opencode", "v1 schema");
  const cursorKey = "opencode:v1";
  const cursor = ctx.ledger.getCursor<{ wm: number }>(cursorKey) ?? { wm: 0 };
  const sessions = db
    .prepare("SELECT id, parent_id, directory, title, time_created, time_updated FROM session")
    .all() as unknown as SessionRow[];
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const rootOf = makeRootResolver((id) => byId.get(id)?.parent_id ?? null);
  for (const s of sessions) {
    if (s.time_updated < cursor.wm - SAFETY_WINDOW_MS) continue;
    ctx.ledger.upsertSession({
      harness: "opencode",
      id: s.id,
      rootId: rootOf(s.id),
      parentId: s.parent_id,
      cwd: s.directory,
      title: s.title,
      path: null,
      firstTs: s.time_created,
      lastTs: s.time_updated,
    });
    result.sessions++;
  }
  const rows = db
    .prepare(
      `SELECT id, session_id, time_created, time_updated, data FROM message
       WHERE time_updated > :wm ORDER BY time_updated`,
    )
    .all({ wm: cursor.wm - SAFETY_WINDOW_MS }) as unknown as MessageRow[];
  let wm = cursor.wm;
  const records: UsageRecord[] = [];
  for (const row of rows) {
    wm = Math.max(wm, row.time_updated);
    const data = parseJson<AssistantData>(row.data);
    if (!data || data.role !== "assistant") continue;
    const cwd = data.path?.cwd ?? byId.get(row.session_id)?.directory ?? null;
    const rec = toRecord(ctx, row.id, row.session_id, rootOf(row.session_id), cwd, row.time_created, data);
    if (rec) records.push(rec);
  }
  result.records = ctx.ledger.upsertRequests(records, "replace");
  ctx.ledger.setCursor(cursorKey, { wm });
  return result;
}

function toRecord(
  ctx: AdapterContext,
  id: string,
  sessionId: string,
  rootId: string,
  cwd: string | null,
  createdFallback: number,
  data: AssistantData,
): UsageRecord | null {
  const tokens = data.tokens;
  if (!tokens) return null;
  const provider = data.model?.providerID ?? data.providerID ?? null;
  const model = data.model?.id ?? data.modelID ?? null;
  if (!model) return null;
  const reasoning = n(tokens.reasoning);
  const t = {
    input: n(tokens.input),
    output: n(tokens.output) + reasoning,
    cacheRead: n(tokens.cache?.read),
    cacheWrite: n(tokens.cache?.write),
    cacheWrite1h: 0,
  };
  if (t.input + t.output + t.cacheRead + t.cacheWrite === 0) return null;
  const billing = billingFor("opencode", provider, model);
  const costUsd = nOrNull(data.cost);
  const created = n(data.time?.created) || createdFallback;
  const streamed = nOrNull(data.time?.streamed);
  // OpenCode's own estimate omits cache writes and reasoning for Copilot models;
  // Copilot bills both, so credits come from the Copilot rate card and $ = credits / 100.
  const credits = billing === "copilot" ? (ctx.pricing.credits(model, t) ?? (costUsd != null ? costUsd * 100 : null)) : null;
  return {
    id: `opencode:${id}`,
    harness: "opencode",
    sessionId,
    rootSessionId: rootId,
    ts: created,
    cwd,
    provider,
    model,
    billing,
    ...t,
    reasoning,
    costUsd:
      billing === "copilot" && credits != null
        ? credits / 100
        : billing === "local"
          ? (costUsd ?? 0)
          : (costUsd ?? ctx.pricing.usd(provider, model, t)),
    credits,
    creditsExact: false,
    premiumMultiplier: null,
    initiator: data.agent ?? null,
    durationMs: streamed && created && streamed > created ? streamed - created : null,
    ttftMs: null,
    itlMs: null,
    contextLimit: ctx.pricing.contextLimit(provider, model),
    isSubagent: rootId !== sessionId,
  };
}

function makeRootResolver(parentOf: (id: string) => string | null): (id: string) => string {
  const cache = new Map<string, string>();
  return (id: string) => {
    const hit = cache.get(id);
    if (hit) return hit;
    let cur = id;
    const seen = new Set<string>();
    while (true) {
      const parent = parentOf(cur);
      if (!parent || seen.has(parent)) break;
      seen.add(cur);
      cur = parent;
    }
    cache.set(id, cur);
    return cur;
  };
}
