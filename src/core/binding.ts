import { sessionIdFromName } from "../adapters/pi.ts";
import type { AgentInfo } from "../herdr/client.ts";
import type { Ledger } from "./ledger.ts";
import type { Harness } from "./types.ts";

export interface Binding {
  terminalId: string;
  paneId: string;
  workspaceId: string | null;
  agent: string | null;
  harness: Harness | null;
  sessionId: string | null;
  method: "exact" | "heuristic" | null;
  boundAt: number | null;
  agentSeenAt: number | null;
  lastStatus: string | null;
  statusAt: number | null;
}

interface BindingRow {
  terminal_id: string;
  pane_id: string;
  workspace_id: string | null;
  agent: string | null;
  harness: string | null;
  session_id: string | null;
  method: string | null;
  bound_at: number | null;
  agent_seen_at: number | null;
  last_status: string | null;
  status_at: number | null;
}

export function harnessOf(agent: string | null | undefined): Harness | null {
  switch (agent) {
    case "pi":
    case "opencode":
    case "claude":
    case "copilot":
      return agent;
    default:
      return null;
  }
}

function fromRow(r: BindingRow): Binding {
  return {
    terminalId: r.terminal_id,
    paneId: r.pane_id,
    workspaceId: r.workspace_id,
    agent: r.agent,
    harness: harnessOf(r.harness),
    sessionId: r.session_id,
    method: r.method === "exact" || r.method === "heuristic" ? r.method : null,
    boundAt: r.bound_at,
    agentSeenAt: r.agent_seen_at,
    lastStatus: r.last_status,
    statusAt: r.status_at,
  };
}

export function getBinding(ledger: Ledger, terminalId: string): Binding | null {
  const row = ledger.get<BindingRow>("SELECT * FROM binding WHERE terminal_id = ?", terminalId);
  return row ? fromRow(row) : null;
}

export function getBindingByPane(ledger: Ledger, paneId: string): Binding | null {
  const row = ledger.get<BindingRow>("SELECT * FROM binding WHERE pane_id = ? ORDER BY bound_at DESC", paneId);
  return row ? fromRow(row) : null;
}

export function allBindings(ledger: Ledger): Binding[] {
  return ledger.all<BindingRow>("SELECT * FROM binding").map(fromRow);
}

export function saveBinding(ledger: Ledger, b: Binding, now = Date.now()): void {
  ledger.run(
    `INSERT INTO binding (terminal_id, pane_id, workspace_id, agent, harness, session_id, method, bound_at,
                          agent_seen_at, last_status, status_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(terminal_id) DO UPDATE SET
       pane_id = excluded.pane_id, workspace_id = excluded.workspace_id, agent = excluded.agent,
       harness = excluded.harness, session_id = excluded.session_id, method = excluded.method,
       bound_at = excluded.bound_at, agent_seen_at = excluded.agent_seen_at,
       last_status = excluded.last_status, status_at = excluded.status_at`,
    b.terminalId,
    b.paneId,
    b.workspaceId,
    b.agent,
    b.harness,
    b.sessionId,
    b.method,
    b.boundAt,
    b.agentSeenAt,
    b.lastStatus,
    b.statusAt,
  );
  if (b.harness && b.sessionId) {
    ledger.run(
      `INSERT INTO binding_history (terminal_id, workspace_id, harness, session_id, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(terminal_id, harness, session_id) DO UPDATE SET
         last_seen = excluded.last_seen, workspace_id = excluded.workspace_id`,
      b.terminalId,
      b.workspaceId,
      b.harness,
      b.sessionId,
      now,
      now,
    );
  }
}

export function deleteBinding(ledger: Ledger, terminalId: string): void {
  ledger.run("DELETE FROM binding WHERE terminal_id = ?", terminalId);
}

export interface Resolution {
  sessionId: string;
  method: "exact" | "heuristic";
  /** Pi reports a session file path that may not be ingested yet. */
  path?: string;
}

interface Candidate {
  id: string;
  title: string | null;
  first_ts: number | null;
  last_ts: number | null;
}

/** herdr pane titles carry the session title for some harnesses (`OC | <title>`). */
export function titleHint(agent: AgentInfo): string | null {
  const raw = (agent.terminal_title_stripped || agent.terminal_title || "").trim();
  if (!raw) return null;
  let t = raw;
  if (agent.agent === "opencode") t = t.replace(/^OC\s*\|\s*/, "");
  else if (agent.agent === "pi") return null; // "π - <cwd basename>": not a session title
  t = t.replace(/[…\s.]+$/, "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
  return t.length >= 6 ? t : null;
}

export function normalizeCwd(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  return cwd.length > 1 ? cwd.replace(/\/+$/, "") : cwd;
}

/**
 * Find the native session running in an agent pane.
 * 1. Exact: the session reference reported by herdr's agent integration.
 * 2. Heuristic: sessions of that harness in the pane's cwd, scored by title
 *    match, recency and stickiness, excluding sessions other live panes own.
 */
export function resolveSession(
  ledger: Ledger,
  agent: AgentInfo,
  harness: Harness,
  prev: Binding | null,
  claimedByOthers: Set<string>,
): Resolution | null {
  const ref = agent.agent_session;
  if (ref?.value) {
    if (ref.kind === "path") {
      const row = ledger.get<{ id: string }>("SELECT id FROM session WHERE harness = ? AND path = ?", harness, ref.value);
      return { sessionId: row?.id ?? sessionIdFromName(ref.value), method: "exact", path: ref.value };
    }
    if (harness === "opencode") {
      const row = ledger.get<{ root_id: string }>(
        "SELECT root_id FROM session WHERE harness = 'opencode' AND id = ?",
        ref.value,
      );
      return { sessionId: row?.root_id ?? ref.value, method: "exact" };
    }
    return { sessionId: ref.value, method: "exact" };
  }

  const cwd = normalizeCwd(agent.foreground_cwd || agent.cwd);
  if (!cwd) return null;
  const candidates = ledger
    .all<Candidate>(
      `SELECT id, title, first_ts, last_ts FROM session
       WHERE harness = ? AND (cwd = ? OR cwd = ?) AND parent_id IS NULL
       ORDER BY last_ts DESC LIMIT 25`,
      harness,
      cwd,
      cwd + "/",
    )
    .filter((c) => !claimedByOthers.has(c.id));
  const minTs = prev?.agentSeenAt && prev.agent === agent.agent ? prev.agentSeenAt - 2 * 60_000 : null;
  const live = minTs ? candidates.filter((c) => (c.last_ts ?? 0) >= minTs) : candidates;
  if (live.length === 0) {
    // A freshly started agent whose session has not written anything yet.
    if (minTs && prev?.sessionId && candidates.some((c) => c.id === prev.sessionId)) {
      return { sessionId: prev.sessionId, method: "heuristic" };
    }
    return null;
  }
  const hint = titleHint(agent);
  const prevSession = prev?.sessionId ? live.find((c) => c.id === prev.sessionId) : undefined;
  // The session this pane was bound to before the current one. If it has written since the
  // current one started, the current one was a side run in the same directory (a subagent or a
  // parallel job the agent started), or the old session was resumed: the pane is on it again.
  const former = prevSession
    ? ledger.get<{ session_id: string }>(
        `SELECT session_id FROM binding_history WHERE terminal_id = ? AND harness = ? AND session_id <> ?
         ORDER BY last_seen DESC LIMIT 1`,
        agent.terminal_id,
        harness,
        prevSession.id,
      )?.session_id
    : undefined;
  let best: Candidate | null = null;
  let bestScore = -Infinity;
  live.forEach((c, rank) => {
    let score = 20 - Math.min(rank, 20);
    if (hint && c.title) {
      const title = c.title.toLowerCase();
      const h = hint.toLowerCase();
      if (title.startsWith(h) || h.startsWith(title)) score += 100;
    }
    if (prevSession && c.id === prevSession.id) score += 10;
    if (prevSession && c.id !== prevSession.id && (c.first_ts ?? 0) > (prevSession.last_ts ?? 0)) score += 15;
    if (prevSession && c.id === former && (c.last_ts ?? 0) > (prevSession.first_ts ?? 0)) score += 25;
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  });
  const chosen = best as Candidate | null;
  return chosen ? { sessionId: chosen.id, method: "heuristic" } : null;
}
