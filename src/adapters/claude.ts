import { existsSync } from "node:fs";
import { basename, dirname, sep } from "node:path";
import { harnessPaths } from "../env.ts";
import type { UsageRecord } from "../core/types.ts";
import { globToRegExp, parseJson, readNewLines, safeStat, walkFiles } from "../util/fs.ts";
import type { FileCursor } from "../util/fs.ts";
import { billingFor, emptyResult, n } from "./adapter.ts";
import type { Adapter, AdapterContext, AdapterResult, IngestScope } from "./adapter.ts";

interface ClaudeCursor extends FileCursor {
  sessionId: string | null;
  cwd: string | null;
  title: string | null;
}

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
  output_tokens_details?: { thinking_tokens?: number } | null;
  inference_geo?: string | null;
  iterations?: Array<{
    type?: string;
    model?: string;
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  }> | null;
}

interface ClaudeLine {
  type?: string;
  sessionId?: string;
  cwd?: string;
  timestamp?: string;
  requestId?: string;
  isSidechain?: boolean;
  aiTitle?: string;
  customTitle?: string;
  message?: { id?: string; model?: string; usage?: ClaudeUsage };
}

/**
 * Claude Code transcripts under ~/.claude/projects/<project>/<sessionId>.jsonl
 * plus subagent files in <sessionId>/subagents/agent-*.jsonl (53% of calls on
 * this machine). One API response is written as several lines that share
 * `message.id`; early lines carry a placeholder `output_tokens`, so the
 * ledger keeps the maximum. Anthropic `msg_…` ids are globally unique, which
 * also collapses `/btw` replays and fork copies. `<synthetic>` lines are local
 * notices with no usage.
 */
export const claudeAdapter: Adapter = {
  harness: "claude",

  detect() {
    return existsSync(harnessPaths.claudeProjects());
  },

  ingest(ctx: AdapterContext, scope?: IngestScope): AdapterResult {
    const root = harnessPaths.claudeProjects();
    if (!existsSync(root)) return emptyResult("claude", "no projects dir");
    const ignore = ctx.config.claude.ignore.map(globToRegExp);
    const ignored = (path: string) => {
      const rel = path.slice(root.length + 1).split(sep).join("/");
      return ignore.some((re) => re.test(rel) || re.test(rel + "/"));
    };
    const files = (scope?.paths ?? walkFiles(root, (name) => name.endsWith(".jsonl"), ignored, 3)).filter(
      (f) => !ignored(f),
    );
    const result = emptyResult("claude");
    const stats = files
      .map((file) => ({ file, st: safeStat(file) }))
      .filter((x): x is { file: string; st: NonNullable<ReturnType<typeof safeStat>> } => x.st != null)
      .sort((a, b) => a.st.mtimeMs - b.st.mtimeMs);
    for (const { file, st } of stats) {
      const key = `claude:${file}`;
      const prev = ctx.ledger.getCursor<ClaudeCursor>(key);
      if (prev && prev.ino === st.ino && prev.size === st.size && prev.mtimeMs === st.mtimeMs) continue;
      const tail = readNewLines(file, prev);
      if (!tail) continue;
      result.files++;
      const isSubagentFile = basename(dirname(file)) === "subagents";
      const state: ClaudeCursor = {
        ...tail.cursor,
        sessionId: tail.reset ? null : (prev?.sessionId ?? null),
        cwd: tail.reset ? null : (prev?.cwd ?? null),
        title: tail.reset ? null : (prev?.title ?? null),
      };
      const records: UsageRecord[] = [];
      let firstTs: number | null = null;
      let lastTs: number | null = null;
      for (const line of tail.lines) {
        // Cheap pre-filter: transcript lines are large and most are not usage.
        const isAssistant = line.includes('"type":"assistant"');
        const isTitle = !isAssistant && (line.includes('"type":"ai-title"') || line.includes('"type":"custom-title"'));
        if (!isAssistant && !isTitle && state.sessionId && state.cwd) continue;
        const entry = parseJson<ClaudeLine>(line);
        if (!entry) {
          result.errors++;
          continue;
        }
        if (entry.sessionId && !state.sessionId) state.sessionId = entry.sessionId;
        if (entry.cwd) state.cwd = entry.cwd;
        if (entry.type === "ai-title" && entry.aiTitle) state.title = entry.aiTitle;
        if (entry.type === "custom-title" && entry.customTitle) state.title = entry.customTitle;
        if (entry.type !== "assistant") continue;
        const msg = entry.message;
        const usage = msg?.usage;
        if (!msg || !usage || !msg.model || msg.model === "<synthetic>") continue;
        const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
        if (!Number.isFinite(ts)) continue;
        firstTs = firstTs == null ? ts : Math.min(firstTs, ts);
        lastTs = lastTs == null ? ts : Math.max(lastTs, ts);
        const sessionId = entry.sessionId ?? state.sessionId ?? basename(file, ".jsonl");
        const baseId = msg.id?.startsWith("msg_")
          ? `claude:${msg.id}`
          : `claude:${sessionId}:${msg.id ?? ""}:${entry.requestId ?? entry.timestamp}`;
        const geo = usage.inference_geo === "us" ? 1.1 : 1;
        const push = (id: string, model: string, u: ClaudeUsage, reasoning: number) => {
          const t = {
            input: n(u.input_tokens),
            output: n(u.output_tokens),
            cacheRead: n(u.cache_read_input_tokens),
            cacheWrite: n(u.cache_creation_input_tokens),
            cacheWrite1h: n(u.cache_creation?.ephemeral_1h_input_tokens),
          };
          if (t.input + t.output + t.cacheRead + t.cacheWrite === 0) return;
          const usd = ctx.pricing.usd("anthropic", model, t);
          records.push({
            id,
            harness: "claude",
            sessionId,
            rootSessionId: sessionId,
            ts,
            cwd: entry.cwd ?? state.cwd,
            provider: "anthropic",
            model,
            billing: billingFor("claude", "anthropic", model),
            ...t,
            reasoning,
            costUsd: usd == null ? null : usd * geo,
            credits: null,
            creditsExact: false,
            premiumMultiplier: null,
            initiator: entry.isSidechain || isSubagentFile ? "subagent" : null,
            durationMs: null,
            ttftMs: null,
            itlMs: null,
            contextLimit: ctx.pricing.contextLimit("anthropic", model),
            isSubagent: entry.isSidechain === true || isSubagentFile,
          });
        };
        push(baseId, msg.model, usage, n(usage.output_tokens_details?.thinking_tokens));
        usage.iterations?.forEach((it, i) => {
          if (it.type === "advisor_message" && it.model) push(`${baseId}:advisor:${i}`, it.model, it, 0);
        });
      }
      result.records += ctx.ledger.upsertRequests(records, "max-output");
      const sessionId = state.sessionId ?? (isSubagentFile ? basename(dirname(dirname(file))) : basename(file, ".jsonl"));
      if (!isSubagentFile) {
        ctx.ledger.upsertSession({
          harness: "claude",
          id: sessionId,
          rootId: sessionId,
          parentId: null,
          cwd: state.cwd,
          title: state.title,
          path: file,
          firstTs,
          lastTs: Math.max(lastTs ?? 0, st.mtimeMs) || null,
        });
        result.sessions++;
      }
      ctx.ledger.setCursor(key, state);
    }
    return result;
  },
};
