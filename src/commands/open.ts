import { openRuntime } from "../core/runtime.ts";
import { focusPluginPane, HerdrError, listPanes, openPluginPane, paneArea } from "../herdr/client.ts";
import type { Placement } from "../herdr/client.ts";
import { popupWidth } from "../ui/frame.ts";
import { log } from "../util/log.ts";

interface DashboardRef {
  paneId: string;
  terminalId: string | null;
}

function findPane(result: unknown): { pane_id?: string; terminal_id?: string } | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  for (const key of ["pane", "plugin_pane"]) {
    const v = r[key] as Record<string, unknown> | undefined;
    if (v && typeof v === "object") {
      if (typeof v.pane_id === "string") return v as { pane_id: string; terminal_id?: string };
      const inner = findPane(v);
      if (inner) return inner;
    }
  }
  return null;
}

/**
 * Open the dashboard. Popups are session singletons and never persist, so
 * they are the default. Split/tab dashboards are normal panes: herdr does not
 * dedupe plugin panes, so focus an existing one instead of opening another.
 */
export async function run(args: string[]): Promise<number> {
  const placement = (args[0] ?? "popup") as Placement;
  if (!["popup", "split", "tab", "zoomed", "overlay"].includes(placement)) {
    process.stderr.write("usage: open [popup|split|tab]\n");
    return 2;
  }
  if (placement === "popup") {
    // 92% of the pane area, clamped to the dashboard's width so wide windows get no empty margins.
    const area = await paneArea(process.env.HERDR_PANE_ID).catch((err: Error) => {
      log.warn(`popup size: ${err.message}`);
      return null;
    });
    try {
      await openPluginPane("dashboard", "popup", { width: popupWidth(area?.width ?? null), height: "88%" });
      return 0;
    } catch (err) {
      if (err instanceof HerdrError && err.code === "ui_busy") {
        process.stderr.write("herdr is showing another dialog; close it and try again\n");
        return 1;
      }
      throw err;
    }
  }
  const rt = openRuntime();
  try {
    const raw = rt.ledger.getMeta("dashboard_pane");
    const existing = raw ? (JSON.parse(raw) as DashboardRef) : null;
    if (existing) {
      const panes = await listPanes();
      const live = panes.find(
        (p) => (existing.terminalId && p.terminal_id === existing.terminalId) || p.pane_id === existing.paneId,
      );
      if (live) {
        try {
          await focusPluginPane(live.pane_id);
          return 0;
        } catch (err) {
          log.warn(`focus dashboard ${live.pane_id}: ${(err as Error).message}`);
        }
      }
    }
    const opts =
      placement === "tab"
        ? { workspaceId: process.env.HERDR_WORKSPACE_ID }
        : { targetPaneId: process.env.HERDR_PANE_ID };
    const result = await openPluginPane("dashboard-split", placement, opts);
    const pane = findPane(result);
    if (pane?.pane_id) {
      rt.ledger.setMeta(
        "dashboard_pane",
        JSON.stringify({ paneId: pane.pane_id, terminalId: pane.terminal_id ?? null } satisfies DashboardRef),
      );
    }
    return 0;
  } finally {
    rt.close();
  }
}
