import { deleteBinding, getBinding, getBindingByPane, harnessOf, saveBinding } from "../core/binding.ts";
import { ingest } from "../core/ingest.ts";
import {
  clearAllPaneTokens,
  evaluateGlobal,
  flushNotifications,
  loadQuota,
  publishAgent,
  publishWorkspaces,
  workspaceLabelMap,
  workspaceLevels,
} from "../core/publish.ts";
import { openRuntime, publishContext } from "../core/runtime.ts";
import type { Runtime } from "../core/runtime.ts";
import { listAgents, listWorkspaces } from "../herdr/client.ts";
import type { AgentInfo } from "../herdr/client.ts";
import { parseJson } from "../util/fs.ts";
import { log } from "../util/log.ts";

interface EventData {
  pane_id?: string;
  workspace_id?: string;
  agent?: string;
  agent_status?: string;
  released?: boolean;
  previous_pane_id?: string;
  pane?: { pane_id?: string; terminal_id?: string; workspace_id?: string };
}

/**
 * Event hook entrypoint. herdr runs hooks concurrently with no timeout and a
 * shared limit of 32 in-flight plugin commands, so this stays short: touch
 * only the event's pane, never spawn background children, never throw.
 */
export async function run(_args: string[]): Promise<number> {
  const event = process.env.HERDR_PLUGIN_EVENT ?? "";
  const payload = parseJson<{ data?: EventData }>(process.env.HERDR_PLUGIN_EVENT_JSON ?? "") ?? {};
  const data = payload.data ?? {};
  const started = Date.now();
  let rt: Runtime;
  try {
    rt = openRuntime();
  } catch (err) {
    log.error("hook: open runtime", err);
    return 0;
  }
  try {
    switch (event) {
      case "pane.agent_status_changed":
      case "pane.agent_detected":
        if (data.pane_id) await onAgentEvent(rt, event, data);
        break;
      case "pane.exited":
      case "pane.closed":
        if (data.pane_id) await onPaneGone(rt, event, data.pane_id);
        break;
      case "pane.moved":
        onPaneMoved(rt, data);
        break;
      default:
        log.debug(`hook: ignoring ${event}`);
    }
  } catch (err) {
    log.error(`hook ${event}`, err);
  } finally {
    rt.close();
    log.debug(`hook ${event} ${data.pane_id ?? ""} took ${Date.now() - started} ms`);
  }
  return 0;
}

async function onAgentEvent(rt: Runtime, event: string, data: EventData): Promise<void> {
  const paneId = data.pane_id as string;
  const [agents, workspaces] = await Promise.all([listAgents(), listWorkspaces()]);
  const agent = agents.find((a) => a.pane_id === paneId);
  if (!agent || data.released) {
    // The agent left this pane. herdr keeps pane tokens on the terminal and
    // would show them for the next agent, so clear ours.
    const prev = getBindingByPane(rt.ledger, paneId);
    if (prev) {
      await clearAllPaneTokens(paneId);
      deleteBinding(rt.ledger, prev.terminalId);
    }
    return;
  }

  if (event === "pane.agent_detected") {
    const prev = getBinding(rt.ledger, agent.terminal_id);
    if (prev && prev.agent !== agent.agent) {
      await clearAllPaneTokens(paneId);
      deleteBinding(rt.ledger, prev.terminalId);
    }
    markAgentSeen(rt, agent);
  }

  const harness = harnessOf(agent.agent);
  if (harness) ingest(rt.ledger, rt.pricing, rt.config, { harnesses: [harness], freshMs: 800, waitMs: 2500 });

  const quota = loadQuota(rt.ledger, rt.config, true, 3000);
  const pc = publishContext(rt, quota, workspaceLabelMap(workspaces));
  await publishAgent(pc, agent, agents);
  await publishWorkspaces(
    pc,
    workspaces.filter((w) => w.workspace_id === agent.workspace_id),
    workspaceLevels(rt.ledger, agents),
    agents,
  );
  evaluateGlobal(pc);
  await flushNotifications(pc);
}

/** Record when a new agent appeared: its session must be at least this recent. */
function markAgentSeen(rt: Runtime, agent: AgentInfo): void {
  const prev = getBinding(rt.ledger, agent.terminal_id);
  if (prev && prev.agent === agent.agent && prev.agentSeenAt) return;
  const now = Date.now();
  saveBinding(rt.ledger, {
    terminalId: agent.terminal_id,
    paneId: agent.pane_id,
    workspaceId: agent.workspace_id,
    agent: agent.agent,
    harness: harnessOf(agent.agent),
    sessionId: null,
    method: null,
    boundAt: now,
    agentSeenAt: now,
    lastStatus: agent.agent_status,
    statusAt: now,
  });
}

async function onPaneGone(rt: Runtime, event: string, paneId: string): Promise<void> {
  const prev = getBindingByPane(rt.ledger, paneId);
  if (!prev) return;
  // pane.exited: the process ended but the pane may remain, so drop our tokens.
  if (event === "pane.exited") await clearAllPaneTokens(paneId);
  deleteBinding(rt.ledger, prev.terminalId);
}

function onPaneMoved(rt: Runtime, data: EventData): void {
  const terminalId = data.pane?.terminal_id;
  const newPaneId = data.pane?.pane_id;
  if (!terminalId || !newPaneId) return;
  const prev = getBinding(rt.ledger, terminalId);
  if (!prev) return;
  saveBinding(rt.ledger, { ...prev, paneId: newPaneId, workspaceId: data.pane?.workspace_id ?? prev.workspaceId });
}
