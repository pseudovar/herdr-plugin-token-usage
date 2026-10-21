import { existsSync } from "node:fs";
import { basename } from "node:path";
import { harnessPaths } from "../env.ts";
import type { SessionInfo, UsageRecord } from "../core/types.ts";
import { parseJson, readNewLines, safeStat, walkFiles } from "../util/fs.ts";
import type { FileCursor } from "../util/fs.ts";
import { billingFor, emptyResult, n, nOrNull } from "./adapter.ts";
import type { Adapter, AdapterContext, AdapterResult, IngestScope } from "./adapter.ts";

interface PiCursor extends FileCursor {
  sessionId: string | null;
  cwd: string | null;
  title: string | null;
  lastProvider: string | null;
  lastModel: string | null;
}

interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
  reasoning?: number;
  cost?: { total?: number };
}

interface PiEntry {
  type?: string;
  id?: string;
  timestamp?: string;
  // session header
  cwd?: string;
  parentSession?: string;
  // session_info
  name?: string;
  // model_change
  provider?: string;
  modelId?: string;
  model?: string;
  // usage / compaction / branch_summary
  usage?: PiUsage;
  message?: {
    role?: string;
    provider?: string;
    model?: string;
    usage?: PiUsage;
    timestamp?: number;
    responseId?: string;
    durationMs?: number;
  };
}

/**
 * Pi coding agent: append-only JSONL session trees under
 * ~/.pi/agent/sessions/--<cwd>--/<ISO>_<uuid>.jsonl.
 *
 * Every usage-bearing entry is counted (assistant messages, cache-warm `usage`
 * entries, compaction/branch summaries, nested tool-result calls), including
 * abandoned branches: those requests were billed. `/fork` copies entries
 * verbatim into a new file, so the dedupe key omits the session id and the
 * first file ingested (the parent, by filename order) keeps attribution.
 */
export const piAdapter: Adapter = {
  harness: "pi",

  detect() {
    return existsSync(harnessPaths.piSessions());
  },

  ingest(ctx: AdapterContext, scope?: IngestScope): AdapterResult {
    const root = harnessPaths.piSessions();
    if (!existsSync(root)) return emptyResult("pi", "no sessions dir");
    const files = (scope?.paths ?? walkFiles(root, (name) => name.endsWith(".jsonl"), () => false, 2)).sort((a, b) =>
      basename(a).localeCompare(basename(b)),
    );
    const result = emptyResult("pi");
    for (const file of files) {
      const key = `pi:${file}`;
      const prev = ctx.ledger.getCursor<PiCursor>(key);
      const st = safeStat(file);
      if (!st) continue;
      if (prev && prev.ino === st.ino && prev.size === st.size && prev.mtimeMs === st.mtimeMs) continue;
      const tail = readNewLines(file, prev);
      if (!tail) continue;
      result.files++;
      const state: PiCursor = {
        ...tail.cursor,
        sessionId: tail.reset ? null : (prev?.sessionId ?? null),
        cwd: tail.reset ? null : (prev?.cwd ?? null),
        title: tail.reset ? null : (prev?.title ?? null),
        lastProvider: tail.reset ? null : (prev?.lastProvider ?? null),
        lastModel: tail.reset ? null : (prev?.lastModel ?? null),
      };
      const records: UsageRecord[] = [];
      let firstTs: number | null = null;
      let lastTs: number | null = null;
      for (const line of tail.lines) {
        const entry = parseJson<PiEntry>(line);
        if (!entry) {
          result.errors++;
          continue;
        }
        const entryTs = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
        if (Number.isFinite(entryTs)) {
          firstTs = firstTs == null ? entryTs : Math.min(firstTs, entryTs);
          lastTs = lastTs == null ? entryTs : Math.max(lastTs, entryTs);
        }
        switch (entry.type) {
          case "session":
            state.sessionId = entry.id ?? state.sessionId;
            state.cwd = entry.cwd ?? state.cwd;
            continue;
          case "session_info":
            if (entry.name) state.title = entry.name;
            continue;
          case "model_change":
            state.lastProvider = entry.provider ?? state.lastProvider;
            state.lastModel = entry.modelId ?? entry.model ?? state.lastModel;
            continue;
        }
        const sessionId = state.sessionId ?? sessionIdFromName(file);
        const msg = entry.message;
        let usage: PiUsage | undefined;
        let provider: string | null = state.lastProvider;
        let model: string | null = state.lastModel;
        let tsMs = entryTs;
        let responseId = "";
        let durationMs: number | null = null;
        let kind = entry.type ?? "entry";
        if (entry.type === "message" && msg?.usage && (msg.role === "assistant" || msg.role === "toolResult")) {
          usage = msg.usage;
          provider = msg.provider ?? provider;
          model = msg.model ?? model;
          if (typeof msg.timestamp === "number") tsMs = msg.timestamp;
          responseId = msg.responseId ?? "";
          durationMs = msg.role === "assistant" ? nOrNull(msg.durationMs) : null;
          kind = msg.role;
          if (msg.role === "assistant") {
            state.lastProvider = provider;
            state.lastModel = model;
          }
        } else if ((entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
          usage = entry.usage;
          provider = entry.provider ?? provider;
          model = entry.model ?? model;
        }
        if (!usage || !model || !Number.isFinite(tsMs)) continue;
        const t = {
          input: n(usage.input),
          output: n(usage.output),
          cacheRead: n(usage.cacheRead),
          cacheWrite: n(usage.cacheWrite),
          cacheWrite1h: n(usage.cacheWrite1h),
        };
        if (t.input + t.output + t.cacheRead + t.cacheWrite === 0) continue;
        const billing = billingFor("pi", provider, model);
        const costUsd = nOrNull(usage.cost?.total);
        let credits: number | null = null;
        if (billing === "copilot") credits = ctx.pricing.credits(model, t) ?? (costUsd != null ? costUsd * 100 : null);
        const recordCost =
          billing === "copilot" && credits != null
            ? credits / 100
            : billing === "local"
              ? (costUsd ?? 0)
              : (costUsd ?? ctx.pricing.usd(provider, model, t));
        records.push({
          id: `pi:${entry.id ?? kind}:${tsMs}:${responseId}`,
          harness: "pi",
          sessionId,
          rootSessionId: sessionId,
          ts: tsMs,
          cwd: state.cwd,
          provider,
          model,
          billing,
          ...t,
          reasoning: n(usage.reasoning),
          costUsd: recordCost,
          credits,
          creditsExact: false,
          premiumMultiplier: null,
          initiator: kind === "assistant" ? null : kind,
          durationMs,
          ttftMs: null,
          itlMs: null,
          contextLimit: ctx.pricing.contextLimit(provider, model),
          isSubagent: false,
        });
      }
      const sessionId = state.sessionId ?? sessionIdFromName(file);
      const session: SessionInfo = {
        harness: "pi",
        id: sessionId,
        rootId: sessionId,
        parentId: null,
        cwd: state.cwd,
        title: state.title,
        path: file,
        firstTs,
        lastTs: Math.max(lastTs ?? 0, st.mtimeMs) || null,
      };
      ctx.ledger.upsertSession(session);
      result.records += ctx.ledger.upsertRequests(records, "ignore");
      result.sessions++;
      ctx.ledger.setCursor(key, state);
    }
    return result;
  },
};

/** `2026-10-19T01-03-45-623Z_01a151af-….jsonl` → `01a151af-…` */
export function sessionIdFromName(file: string): string {
  const name = basename(file, ".jsonl");
  const idx = name.indexOf("_");
  return idx >= 0 ? name.slice(idx + 1) : name;
}
