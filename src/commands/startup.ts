import { ingest } from "../core/ingest.ts";
import { loadQuota, publishAll } from "../core/publish.ts";
import { openRuntime, publishContext } from "../core/runtime.ts";
import { log } from "../util/log.ts";
import { writeShims } from "./shims.ts";

/**
 * Startup hook: herdr does not persist pane/workspace tokens across a server
 * restart, so re-ingest, re-bind and re-publish everything, refresh the
 * Copilot quota and rewrite the tab-bar shim. One-shot; exits when done.
 */
export async function run(_args: string[]): Promise<number> {
  const started = Date.now();
  try {
    writeShims();
  } catch (err) {
    log.error("startup: write shims", err);
  }
  const rt = openRuntime();
  try {
    const summary = ingest(rt.ledger, rt.pricing, rt.config, { waitMs: 20_000 });
    const quota = loadQuota(rt.ledger, rt.config, true, 5000);
    const pc = publishContext(rt, quota);
    const res = await publishAll(pc, { prune: true });
    log.info(
      `startup: ingest ${summary.ms} ms (${summary.results.map((r) => `${r.harness}+${r.records}`).join(" ")}), ` +
        `${res.agents.length} agents, ${Date.now() - started} ms total`,
    );
  } catch (err) {
    log.error("startup", err);
  } finally {
    rt.close();
  }
  return 0;
}
