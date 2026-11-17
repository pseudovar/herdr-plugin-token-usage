import { takeUnreportedFailures } from "../core/ingest.ts";
import type { Runtime } from "../core/runtime.ts";
import { HARNESS_LABEL } from "../core/types.ts";
import { log } from "../util/log.ts";
import { restoreIfWiped } from "./herdrconfig.ts";

/**
 * The plugin's own health, as notes for the next toast: herdr config entries
 * put back after a rewrite, and harnesses whose usage has stopped being readable.
 */
export async function selfCheck(rt: Runtime): Promise<Array<{ title: string; body: string }>> {
  const notes: Array<{ title: string; body: string }> = [];
  try {
    const restored = await restoreIfWiped(rt.ledger, rt.config.setup.autoRestore);
    if (restored) notes.push(restored);
  } catch (err) {
    log.error("self-check: herdr config", err);
  }
  for (const f of takeUnreportedFailures(rt.ledger)) {
    notes.push({ title: `Token usage can't read ${HARNESS_LABEL[f.harness]} usage`, body: `${f.message.slice(0, 100)} · tu doctor has details` });
  }
  return notes;
}
