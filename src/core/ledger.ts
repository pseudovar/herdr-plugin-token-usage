import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import { stateDir } from "../env.ts";
import type { SessionInfo, UsageRecord } from "./types.ts";

const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS request (
  id TEXT PRIMARY KEY,
  harness TEXT NOT NULL,
  session_id TEXT NOT NULL,
  root_session_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  cwd TEXT,
  provider TEXT,
  model TEXT NOT NULL,
  billing TEXT NOT NULL,
  input INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  cache_write_1h INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  reasoning INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  credits REAL,
  credits_exact INTEGER NOT NULL DEFAULT 0,
  premium_mult REAL,
  initiator TEXT,
  duration_ms INTEGER,
  ttft_ms INTEGER,
  itl_ms REAL,
  context_limit INTEGER,
  is_subagent INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS request_ts ON request(ts);
CREATE INDEX IF NOT EXISTS request_root ON request(harness, root_session_id, ts);

CREATE TABLE IF NOT EXISTS session (
  harness TEXT NOT NULL,
  id TEXT NOT NULL,
  root_id TEXT NOT NULL,
  parent_id TEXT,
  cwd TEXT,
  title TEXT,
  path TEXT,
  first_ts INTEGER,
  last_ts INTEGER,
  PRIMARY KEY (harness, id)
);
CREATE INDEX IF NOT EXISTS session_cwd ON session(harness, cwd, last_ts);

CREATE TABLE IF NOT EXISTS cursor (
  source TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS binding (
  terminal_id TEXT PRIMARY KEY,
  pane_id TEXT NOT NULL,
  workspace_id TEXT,
  agent TEXT,
  harness TEXT,
  session_id TEXT,
  method TEXT,
  bound_at INTEGER,
  agent_seen_at INTEGER,
  last_status TEXT,
  status_at INTEGER,
  reported TEXT
);

CREATE TABLE IF NOT EXISTS binding_history (
  terminal_id TEXT NOT NULL,
  workspace_id TEXT,
  harness TEXT NOT NULL,
  session_id TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (terminal_id, harness, session_id)
);

CREATE TABLE IF NOT EXISTS workspace_report (
  workspace_id TEXT PRIMARY KEY,
  reported TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS alert_state (
  rule_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  active INTEGER NOT NULL,
  level TEXT,
  value REAL,
  mark REAL,
  since INTEGER,
  last_notified INTEGER,
  PRIMARY KEY (rule_id, scope)
);

CREATE TABLE IF NOT EXISTS alert_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  rule_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  level TEXT NOT NULL,
  value REAL,
  message TEXT NOT NULL,
  notified INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS alert_log_ts ON alert_log(ts);

CREATE TABLE IF NOT EXISTS quota (
  provider TEXT PRIMARY KEY,
  fetched_at INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  payload TEXT,
  error TEXT,
  failures INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS model_limit (
  harness TEXT NOT NULL,
  model TEXT NOT NULL,
  context_limit INTEGER NOT NULL,
  PRIMARY KEY (harness, model)
);

CREATE TABLE IF NOT EXISTS quota_history (
  provider TEXT NOT NULL,
  ts INTEGER NOT NULL,
  used REAL,
  entitlement REAL,
  used_pct REAL,
  PRIMARY KEY (provider, ts)
);
`;

const COLUMNS = [
  "id",
  "harness",
  "session_id",
  "root_session_id",
  "ts",
  "cwd",
  "provider",
  "model",
  "billing",
  "input",
  "cache_read",
  "cache_write",
  "cache_write_1h",
  "output",
  "reasoning",
  "cost_usd",
  "credits",
  "credits_exact",
  "premium_mult",
  "initiator",
  "duration_ms",
  "ttft_ms",
  "itl_ms",
  "context_limit",
  "is_subagent",
] as const;

/**
 * How a re-seen dedupe key is merged:
 * - `ignore`: first writer wins (fork copies keep the original session's attribution).
 * - `replace`: latest row wins (rows that are filled in after streaming).
 * - `max-output`: keep the larger output count (Claude Code writes placeholder
 *   output counts on early streaming lines; the last line carries the real one).
 */
export type UpsertMode = "ignore" | "replace" | "max-output";

function conflictClause(mode: UpsertMode): string {
  switch (mode) {
    case "ignore":
      return "ON CONFLICT(id) DO NOTHING";
    case "replace":
      return `ON CONFLICT(id) DO UPDATE SET ${COLUMNS.filter((c) => c !== "id")
        .map((c) => `${c} = excluded.${c}`)
        .join(", ")}`;
    case "max-output":
      return `ON CONFLICT(id) DO UPDATE SET
        cost_usd = CASE WHEN excluded.output > request.output THEN excluded.cost_usd ELSE request.cost_usd END,
        credits = CASE WHEN excluded.output > request.output THEN excluded.credits ELSE request.credits END,
        reasoning = MAX(request.reasoning, excluded.reasoning),
        output = MAX(request.output, excluded.output)`;
  }
}

export class Ledger {
  readonly db: DatabaseSync;
  private readonly upserts = new Map<UpsertMode, ReturnType<DatabaseSync["prepare"]>>();

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 5000");
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.migrate();
  }

  static open(): Ledger {
    return new Ledger(join(stateDir(), "ledger.db"));
  }

  static path(): string {
    return join(stateDir(), "ledger.db");
  }

  private migrate(): void {
    // Every statement is CREATE … IF NOT EXISTS, so running it each open is
    // cheap and lets new tables appear on upgrade.
    this.db.exec(SCHEMA);
    const row = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    // Additive columns introduced after a table was first created.
    this.ensureColumn("binding", "agent_seen_at", "INTEGER");
    // v2: titles are stored on one line (Copilot CLI summaries can hold a multi-line prompt).
    if (row.user_version < 2) {
      const update = this.db.prepare("UPDATE session SET title = ? WHERE harness = ? AND id = ?");
      const broken = this.db.prepare("SELECT harness, id, title FROM session WHERE title GLOB ?").all("*[\t\n\r]*") as Array<{ harness: string; id: string; title: string }>;
      for (const s of broken) update.run(oneLine(s.title), s.harness, s.id);
    }
    if (row.user_version < SCHEMA_VERSION) this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  private ensureColumn(table: string, column: string, type: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (cols.length && !cols.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ignore
      }
      throw err;
    }
  }

  upsertRequests(records: UsageRecord[], mode: UpsertMode): number {
    if (records.length === 0) return 0;
    let stmt = this.upserts.get(mode);
    if (!stmt) {
      const placeholders = COLUMNS.map((c) => `:${c}`).join(", ");
      stmt = this.db.prepare(
        `INSERT INTO request (${COLUMNS.join(", ")}) VALUES (${placeholders}) ${conflictClause(mode)}`,
      );
      this.upserts.set(mode, stmt);
    }
    let changed = 0;
    for (const r of records) {
      const res = stmt.run({
        id: r.id,
        harness: r.harness,
        session_id: r.sessionId,
        root_session_id: r.rootSessionId,
        ts: Math.round(r.ts),
        cwd: r.cwd,
        provider: r.provider,
        model: r.model,
        billing: r.billing,
        input: int(r.input),
        cache_read: int(r.cacheRead),
        cache_write: int(r.cacheWrite),
        cache_write_1h: int(r.cacheWrite1h),
        output: int(r.output),
        reasoning: int(r.reasoning),
        cost_usd: num(r.costUsd),
        credits: num(r.credits),
        credits_exact: r.creditsExact ? 1 : 0,
        premium_mult: num(r.premiumMultiplier),
        initiator: r.initiator,
        duration_ms: r.durationMs == null ? null : Math.round(r.durationMs),
        ttft_ms: r.ttftMs == null ? null : Math.round(r.ttftMs),
        itl_ms: num(r.itlMs),
        context_limit: r.contextLimit == null ? null : Math.round(r.contextLimit),
        is_subagent: r.isSubagent ? 1 : 0,
      });
      changed += Number(res.changes);
    }
    return changed;
  }

  upsertSession(s: SessionInfo): void {
    this.db
      .prepare(
        `INSERT INTO session (harness, id, root_id, parent_id, cwd, title, path, first_ts, last_ts)
         VALUES (:harness, :id, :root_id, :parent_id, :cwd, :title, :path, :first_ts, :last_ts)
         ON CONFLICT(harness, id) DO UPDATE SET
           root_id = excluded.root_id,
           parent_id = COALESCE(excluded.parent_id, session.parent_id),
           cwd = COALESCE(excluded.cwd, session.cwd),
           title = COALESCE(excluded.title, session.title),
           path = COALESCE(excluded.path, session.path),
           first_ts = CASE
             WHEN session.first_ts IS NULL THEN excluded.first_ts
             WHEN excluded.first_ts IS NULL THEN session.first_ts
             ELSE MIN(session.first_ts, excluded.first_ts) END,
           last_ts = CASE
             WHEN session.last_ts IS NULL THEN excluded.last_ts
             WHEN excluded.last_ts IS NULL THEN session.last_ts
             ELSE MAX(session.last_ts, excluded.last_ts) END`,
      )
      .run({
        harness: s.harness,
        id: s.id,
        root_id: s.rootId,
        parent_id: s.parentId,
        cwd: s.cwd,
        title: oneLine(s.title),
        path: s.path,
        first_ts: s.firstTs,
        last_ts: s.lastTs,
      });
  }

  getCursor<T>(source: string): T | null {
    const row = this.db.prepare("SELECT value FROM cursor WHERE source = ?").get(source) as
      | { value: string }
      | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return null;
    }
  }

  setCursor(source: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO cursor (source, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(source) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(source, JSON.stringify(value), Date.now());
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  deleteMeta(key: string): void {
    this.db.prepare("DELETE FROM meta WHERE key = ?").run(key);
  }

  setModelLimit(harness: string, model: string, limit: number): void {
    this.db
      .prepare(
        `INSERT INTO model_limit (harness, model, context_limit) VALUES (?, ?, ?)
         ON CONFLICT(harness, model) DO UPDATE SET context_limit = excluded.context_limit`,
      )
      .run(harness, model, Math.round(limit));
  }

  getModelLimit(harness: string, model: string): number | null {
    const row = this.db
      .prepare("SELECT context_limit FROM model_limit WHERE harness = ? AND model = ?")
      .get(harness, model) as { context_limit: number } | undefined;
    return row ? row.context_limit : null;
  }

  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  run(sql: string, ...params: SQLInputValue[]): void {
    this.db.prepare(sql).run(...params);
  }
}

function int(n: number | null | undefined): number {
  return n == null || !Number.isFinite(n) ? 0 : Math.max(0, Math.round(n));
}

function num(n: number | null | undefined): number | null {
  return n == null || !Number.isFinite(n) ? null : n;
}

/** Collapse whitespace runs (line breaks, tabs) so a title fits on one line. */
function oneLine(s: string | null): string | null {
  return s?.replace(/\s+/g, " ").trim() || null;
}
