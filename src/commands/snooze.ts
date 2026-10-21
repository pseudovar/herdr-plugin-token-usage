import { isSnoozed } from "../core/rules.ts";
import { openRuntime } from "../core/runtime.ts";
import { notify } from "../herdr/client.ts";
import { fmtClock } from "../util/format.ts";
import { MINUTE } from "../util/time.ts";

/** Mute alert toasts: `snooze [toggle|on|off|<minutes>]` (default toggle, 60 min). */
export async function run(args: string[]): Promise<number> {
  const rt = openRuntime();
  try {
    const arg = args[0] ?? "toggle";
    const now = Date.now();
    let until = 0;
    if (arg === "off") until = 0;
    else if (arg === "on") until = now + 60 * MINUTE;
    else if (arg === "toggle") until = isSnoozed(rt.ledger, now) ? 0 : now + 60 * MINUTE;
    else if (/^\d+$/.test(arg)) until = now + Number(arg) * MINUTE;
    else {
      process.stderr.write("usage: snooze [toggle|on|off|<minutes>]\n");
      return 2;
    }
    if (until) rt.ledger.setMeta("snooze_until", String(until));
    else rt.ledger.deleteMeta("snooze_until");
    const msg = until ? `Usage alerts snoozed until ${fmtClock(until)}` : "Usage alerts resumed";
    process.stdout.write(msg + "\n");
    if (process.env.HERDR_SOCKET_PATH) {
      try {
        await notify(msg, until ? "Toasts are muted; sidebar colours still update." : "", "none");
      } catch {
        // best effort
      }
    }
    return 0;
  } finally {
    rt.close();
  }
}
