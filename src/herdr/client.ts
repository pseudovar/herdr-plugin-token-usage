import { createConnection } from "node:net";
import { PLUGIN_ID, SOURCE, herdrSocketPath } from "../env.ts";
import { sleepSync } from "../util/time.ts";

export class HerdrError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

let seq = 0;

/**
 * One request/response over herdr's newline-delimited JSON socket. Talking
 * to the socket directly avoids spawning a `herdr` CLI process per call,
 * which matters for hooks that report several token patches.
 */
export function call<T = Record<string, unknown>>(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 3000,
): Promise<T> {
  const path = herdrSocketPath();
  const id = `tu-${process.pid}-${++seq}`;
  return new Promise<T>((resolve, reject) => {
    const sock = createConnection(path);
    let buf = "";
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new HerdrError("timeout", `${method} timed out`))), timeoutMs);
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(JSON.stringify({ id, method, params }) + "\n"));
    sock.on("data", (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      finish(() => {
        try {
          const msg = JSON.parse(line) as { result?: T; error?: { code: string; message: string } };
          if (msg.error) reject(new HerdrError(msg.error.code, msg.error.message));
          else resolve(msg.result as T);
        } catch (err) {
          reject(new HerdrError("protocol", (err as Error).message));
        }
      });
    });
    sock.on("error", (err) => finish(() => reject(new HerdrError("connect", err.message))));
    sock.on("close", () => finish(() => reject(new HerdrError("closed", `${method}: connection closed`))));
  });
}

export interface AgentSession {
  source: string;
  agent: string;
  kind: "id" | "path" | string;
  value: string;
}

export interface AgentInfo {
  agent: string;
  agent_status: "idle" | "working" | "blocked" | "done" | "unknown";
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
  cwd?: string;
  foreground_cwd?: string;
  focused?: boolean;
  name?: string;
  terminal_title?: string;
  terminal_title_stripped?: string;
  agent_session?: AgentSession;
  tokens?: Record<string, string> | null;
}

export interface WorkspaceInfo {
  workspace_id: string;
  label: string;
  focused?: boolean;
  tokens?: Record<string, string> | null;
}

export interface PaneInfo {
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
  agent?: string | null;
  label?: string | null;
  cwd?: string;
  tokens?: Record<string, string> | null;
}

export async function listAgents(): Promise<AgentInfo[]> {
  const res = await call<{ agents?: AgentInfo[] }>("agent.list");
  return res.agents ?? [];
}

export async function listWorkspaces(): Promise<WorkspaceInfo[]> {
  const res = await call<{ workspaces?: WorkspaceInfo[] }>("workspace.list");
  return res.workspaces ?? [];
}

export async function listPanes(): Promise<PaneInfo[]> {
  const res = await call<{ panes?: PaneInfo[] }>("pane.list");
  return res.panes ?? [];
}

export async function getPane(paneId: string): Promise<PaneInfo | null> {
  try {
    const res = await call<{ pane?: PaneInfo }>("pane.get", { pane_id: paneId });
    return res.pane ?? null;
  } catch (err) {
    if (err instanceof HerdrError && err.code === "not_found") return null;
    throw err;
  }
}

/** Patch pane tokens: a string sets a key, null clears it (≤ 16 keys per report). */
export async function reportPaneTokens(paneId: string, tokens: Record<string, string | null>): Promise<void> {
  const entries = Object.entries(tokens);
  for (let i = 0; i < entries.length; i += 16) {
    await call("pane.report_metadata", {
      pane_id: paneId,
      source: SOURCE,
      tokens: Object.fromEntries(entries.slice(i, i + 16)),
    });
  }
}

export async function reportWorkspaceTokens(workspaceId: string, tokens: Record<string, string | null>): Promise<void> {
  const entries = Object.entries(tokens);
  for (let i = 0; i < entries.length; i += 16) {
    await call("workspace.report_metadata", {
      workspace_id: workspaceId,
      source: SOURCE,
      tokens: Object.fromEntries(entries.slice(i, i + 16)),
    });
  }
}

export type NotifySound = "none" | "done" | "request";

/** herdr allows one shown toast per second server-wide; retry once when rate limited. */
export async function notify(title: string, body: string, sound: NotifySound): Promise<string> {
  const params = { title: title.slice(0, 80), body: body.slice(0, 240), sound };
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await call<{ shown?: boolean; reason?: string }>("notification.show", params);
    if (res.reason !== "rate_limited") return res.reason ?? (res.shown ? "shown" : "unknown");
    sleepSync(1100);
  }
  return "rate_limited";
}

export type Placement = "popup" | "split" | "tab" | "overlay" | "zoomed";

/** Popup sizes are outer cells (border included) or a percentage of the pane area, e.g. "88%". */
export type PopupSize = number | string;

export async function openPluginPane(
  entrypoint: string,
  placement: Placement,
  opts: { width?: PopupSize; height?: PopupSize; targetPaneId?: string; workspaceId?: string } = {},
): Promise<Record<string, unknown>> {
  const params: Record<string, unknown> = { plugin_id: PLUGIN_ID, entrypoint, placement, focus: true };
  if (opts.width) params.width = opts.width;
  if (opts.height) params.height = opts.height;
  if (opts.targetPaneId) params.target_pane_id = opts.targetPaneId;
  if (opts.workspaceId) params.workspace_id = opts.workspaceId;
  return call("plugin.pane.open", params);
}

/**
 * Size of the area a tab's panes (and popups) are laid out in: the window
 * minus herdr's sidebar and tab bar. Defaults to the focused pane's tab.
 */
export async function paneArea(paneId?: string): Promise<{ width: number; height: number } | null> {
  const res = await call<{ layout?: { area?: { width?: number; height?: number } } }>("pane.layout", paneId ? { pane_id: paneId } : {}, 1500);
  const area = res.layout?.area;
  return area?.width && area.height ? { width: area.width, height: area.height } : null;
}

export async function focusPluginPane(paneId: string): Promise<void> {
  await call("plugin.pane.focus", { pane_id: paneId });
}

export async function ping(timeoutMs = 1000): Promise<boolean> {
  try {
    await call("ping", {}, timeoutMs);
    return true;
  } catch {
    return false;
  }
}
