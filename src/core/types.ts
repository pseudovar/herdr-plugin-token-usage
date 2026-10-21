/** Harnesses with a usage adapter. Names match herdr's canonical agent ids. */
export type Harness = "pi" | "opencode" | "copilot" | "claude";

export const HARNESSES: readonly Harness[] = ["pi", "opencode", "copilot", "claude"];

export const HARNESS_LABEL: Record<Harness, string> = {
  pi: "Pi",
  opencode: "OpenCode",
  copilot: "Copilot CLI",
  claude: "Claude Code",
};

/**
 * Who pays for a call, which decides the headline unit:
 * copilot → AI credits against the monthly quota, claude/api → dollars,
 * local → tokens only.
 */
export type Billing = "copilot" | "claude" | "api" | "local";

/** One model call, normalized across harnesses. */
export interface UsageRecord {
  /** Harness-specific dedupe key, globally unique. */
  id: string;
  harness: Harness;
  sessionId: string;
  /** Root of the session tree (subagents and child sessions roll up here). */
  rootSessionId: string;
  /** Epoch milliseconds (request start where the harness records it). */
  ts: number;
  cwd: string | null;
  provider: string | null;
  model: string;
  billing: Billing;
  /** Uncached prompt tokens only. */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  /** Subset of cacheWrite written with a 1h TTL (Anthropic). */
  cacheWrite1h: number;
  /** All billed output, including reasoning. */
  output: number;
  /** Informational subset of output. */
  reasoning: number;
  costUsd: number | null;
  credits: number | null;
  creditsExact: boolean;
  premiumMultiplier: number | null;
  initiator: string | null;
  durationMs: number | null;
  ttftMs: number | null;
  itlMs: number | null;
  contextLimit: number | null;
  isSubagent: boolean;
}

export interface SessionInfo {
  harness: Harness;
  id: string;
  rootId: string;
  parentId: string | null;
  cwd: string | null;
  title: string | null;
  path: string | null;
  firstTs: number | null;
  lastTs: number | null;
}

export type Level = "low" | "normal" | "high" | "critical";

export const LEVEL_ORDER: Record<Level, number> = { low: 0, normal: 1, high: 2, critical: 3 };

export const LEVEL_GLYPH: Record<Level, string> = { low: "▽", normal: "●", high: "▲", critical: "■" };

export function maxLevel(levels: Iterable<Level>): Level {
  let best: Level = "normal";
  let sawLow = false;
  for (const level of levels) {
    if (level === "low") {
      sawLow = true;
      continue;
    }
    if (LEVEL_ORDER[level] > LEVEL_ORDER[best]) best = level;
  }
  return best === "normal" && sawLow ? "low" : best;
}

export function workTokens(r: { input: number; cacheWrite: number; output: number }): number {
  return r.input + r.cacheWrite + r.output;
}

export function promptTokens(r: { input: number; cacheRead: number; cacheWrite: number }): number {
  return r.input + r.cacheRead + r.cacheWrite;
}
