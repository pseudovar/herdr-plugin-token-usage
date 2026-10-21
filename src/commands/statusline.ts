import { tabBarText } from "../core/display.ts";
import { ingest } from "../core/ingest.ts";
import { evaluateGlobal, flushNotifications, loadQuota, publishAll, tabView } from "../core/publish.ts";
import { openRuntime, publishContext } from "../core/runtime.ts";
import type { Level } from "../core/types.ts";
import { log } from "../util/log.ts";

/**
 * `ui.tab_bar_right` command entry. herdr runs it on an interval (no overlap,
 * SIGKILL on timeout) and shows the last stdout line, so it doubles as the
 * plugin's supervised periodic tick: cheap incremental ingest, refresh the
 * sidebar for working panes mid-turn, evaluate quota rules, print one line.
 */
export async function run(args: string[]): Promise<number> {
  const rt = openRuntime();
  try {
    ingest(rt.ledger, rt.pricing, rt.config, { freshMs: 3000, waitMs: 0 });
    const quota = loadQuota(rt.ledger, rt.config, true, 1500);
    const pc = publishContext(rt, quota);
    let quotaLevel: Level = "normal";
    const inHerdr = Boolean(process.env.HERDR_SOCKET_PATH) && !args.includes("--no-publish");
    if (inHerdr && rt.config.statusline.refreshPanes) {
      try {
        quotaLevel = (await publishAll(pc)).quotaLevel;
      } catch (err) {
        log.warn(`status-line publish: ${(err as Error).message}`);
        quotaLevel = evaluateGlobal(pc);
        await flushNotifications(pc);
      }
    } else {
      pc.dryRun = !inHerdr;
      quotaLevel = evaluateGlobal(pc);
      if (inHerdr) await flushNotifications(pc);
    }
    process.stdout.write(tabBarText(tabView(rt.ledger, quota, quotaLevel, Date.now()), rt.config.display) + "\n");
    return 0;
  } catch (err) {
    log.error("status-line", err);
    return 1;
  } finally {
    rt.close();
  }
}
