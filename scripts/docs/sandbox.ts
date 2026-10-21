/**
 * A sealed, reproducible environment for the docs renders. Import it before
 * anything else: it fixes the clock and timezone, and points HOME, the plugin's
 * state and config dirs, harness caches and the herdr socket at a throwaway
 * directory, so no real usage data can end up in a screenshot.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Wednesday 21 Oct 2026, 15:42 UTC: two thirds through a Copilot billing month. */
export const NOW = Date.UTC(2026, 9, 21, 15, 42, 0);
export const DEMO_HOME = "/Users/demo";
export const SANDBOX = mkdtempSync(join(tmpdir(), "tu-docs-"));

process.env.TZ = "UTC";
process.env.HOME = DEMO_HOME;
for (const dir of ["state", "config", "xdg-cache", "xdg-data", "xdg-config", "xdg-state"]) mkdirSync(join(SANDBOX, dir), { recursive: true });
process.env.HERDR_PLUGIN_STATE_DIR = join(SANDBOX, "state");
process.env.HERDR_PLUGIN_CONFIG_DIR = join(SANDBOX, "config");
process.env.HERDR_SOCKET_PATH = join(SANDBOX, "herdr.sock");
process.env.HERDR_CONFIG_PATH = join(SANDBOX, "herdr-config.toml");
process.env.XDG_CACHE_HOME = join(SANDBOX, "xdg-cache");
process.env.XDG_DATA_HOME = join(SANDBOX, "xdg-data");
process.env.XDG_CONFIG_HOME = join(SANDBOX, "xdg-config");
process.env.XDG_STATE_HOME = join(SANDBOX, "xdg-state");
delete process.env.NO_COLOR;
// The Rules view reads toast delivery from herdr's config.toml.
writeFileSync(process.env.HERDR_CONFIG_PATH, '[ui.toast]\ndelivery = "herdr"\n');

const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(NOW);
    else super(...(args as [number]));
  }
  static now(): number {
    return NOW;
  }
}
globalThis.Date = FixedDate as DateConstructor;
