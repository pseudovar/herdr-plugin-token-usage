import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { HOME, PLUGIN_ID, herdrBin, herdrConfigPath, harnessPaths } from "../env.ts";
import { call, notify } from "../herdr/client.ts";
import { applyConfig, checkConfig, readHerdrConfig, simpleDiff, writeHerdrConfig } from "./herdrconfig.ts";
import { writeShims } from "./shims.ts";

const INTEGRATIONS: Array<{ name: string; present: () => boolean }> = [
  { name: "pi", present: () => existsSync(join(HOME, ".pi", "agent")) },
  { name: "opencode", present: () => existsSync(join(HOME, ".config", "opencode")) },
  { name: "claude", present: () => existsSync(join(HOME, ".claude")) },
  { name: "copilot", present: () => existsSync(harnessPaths.copilotHome()) },
];

function herdr(args: string[]): { ok: boolean; out: string } {
  const res = spawnSync(herdrBin(), args, { encoding: "utf8", timeout: 20_000 });
  return { ok: res.status === 0, out: `${res.stdout ?? ""}${res.stderr ?? ""}`.trim() };
}

export function integrationStatus(): Map<string, string> {
  const res = herdr(["integration", "status"]);
  const map = new Map<string, string>();
  for (const line of res.out.split("\n")) {
    const m = /^([a-z-]+)(?: \(experimental\))?:\s*(.+)$/.exec(line.trim());
    if (m) map.set(m[1], m[2]);
  }
  return map;
}

const MARK = { ok: "✓", missing: "·", conflict: "!", outdated: "↑" } as const;

/** `herdr integration status` reports "current (v9)", "outdated (v8)" or "not installed (…)". */
function isInstalled(status: string): boolean {
  return status !== "" && status !== "unknown" && !status.startsWith("not installed");
}

export async function run(args: string[]): Promise<number> {
  const apply = args.includes("--apply");
  const yes = args.includes("--yes");
  const doIntegrations = args.includes("--integrations");
  const out: string[] = [];
  const shims = writeShims();

  out.push(`Token Usage (${PLUGIN_ID}) setup`);
  out.push("");
  out.push(`herdr config: ${herdrConfigPath()}`);
  const before = readHerdrConfig();
  for (const c of checkConfig(before)) out.push(`  ${MARK[c.state]} ${c.label.padEnd(26)} ${c.detail}`);

  out.push("");
  out.push("Agent integrations (exact pane → session mapping):");
  const status = integrationStatus();
  for (const integ of INTEGRATIONS) {
    if (!integ.present()) continue;
    const s = status.get(integ.name) ?? "unknown";
    out.push(`  ${isInstalled(s) ? MARK.ok : MARK.missing} ${integ.name.padEnd(10)} ${s}`);
  }

  if (doIntegrations) {
    out.push("");
    for (const integ of INTEGRATIONS) {
      if (!integ.present() || isInstalled(status.get(integ.name) ?? "")) continue;
      const res = herdr(["integration", "install", integ.name]);
      out.push(`  ${res.ok ? "installed" : "FAILED"} ${integ.name}${res.ok ? "" : `: ${res.out.split("\n")[0]}`}`);
    }
    out.push("  Restart running agents (or their sessions) so the integrations load.");
  }

  if (apply) {
    const { text, changes, manual } = applyConfig(before);
    out.push("");
    if (changes.length === 0) {
      out.push("config.toml: nothing to change.");
    } else {
      out.push("config.toml changes:");
      for (const c of changes) out.push(`  + ${c}`);
      out.push("");
      out.push(simpleDiff(before, text));
      if (!yes && process.stdin.isTTY) {
        process.stdout.write(out.join("\n") + "\n\nApply these changes? [y/N] ");
        out.length = 0;
        const answer = await readLine();
        if (!/^y(es)?$/i.test(answer.trim())) {
          process.stdout.write("Aborted; nothing written.\n");
          return 1;
        }
      }
      const backup = writeHerdrConfig(text);
      out.push("");
      out.push(`Wrote ${herdrConfigPath()}${backup ? ` (backup: ${backup})` : ""}`);
      try {
        await call("server.reload_config", {}, 5000);
        out.push("Reloaded herdr config.");
      } catch (err) {
        out.push(`Could not reload herdr config automatically (${(err as Error).message}); run: herdr server reload-config`);
      }
    }
    for (const m of manual) out.push("", m);
  } else {
    out.push("");
    out.push("Run `tu setup --apply` to add the missing pieces (backup + diff first),");
    out.push("and `tu setup --integrations` to install the herdr agent integrations.");
  }
  out.push("");
  out.push(`CLI shim: ${shims.tu}   (e.g. alias tu='${shims.tu}')`);
  process.stdout.write(out.join("\n") + "\n");

  if (process.env.HERDR_PLUGIN_ACTION_ID && !apply) {
    const missing = checkConfig(before).filter((c) => c.state !== "ok").length;
    try {
      await notify(
        missing ? `Token usage: ${missing} setup step(s) pending` : "Token usage: setup complete",
        missing ? "Run: tu setup --apply (see `herdr plugin log list`)" : "Sidebar, tab bar, keys and toasts are configured",
        "none",
      );
    } catch {
      // best effort
    }
  }
  return 0;
}

function readLine(): Promise<string> {
  return new Promise((resolve) => {
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (d) => {
      process.stdin.pause();
      resolve(String(d));
    });
  });
}
