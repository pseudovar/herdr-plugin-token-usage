import { PLUGIN_ID } from "./env.ts";
import { setLogTag } from "./util/log.ts";

const USAGE = `token-usage (herdr plugin ${PLUGIN_ID})

Usage: tu <command> [options]

Commands:
  report [--today|--week|--month|--days N] [--json]   usage summary by harness and model
  dashboard                                           interactive dashboard (runs in a herdr pane)
  open [popup|split|tab]                              open the dashboard pane in herdr
  status-line                                         one-line summary for ui.tab_bar_right
  refresh                                             ingest everything and republish sidebar tokens
  setup [--apply] [--integrations]                    check / apply herdr config, integrations
  doctor                                              diagnose data sources, bindings and herdr
  snooze [toggle|on|off|<minutes>]                    mute alert toasts
  quota [--json] [--refresh]                          GitHub Copilot quota
  hook | startup                                      herdr plugin entrypoints (event and startup hooks)
`;

const MIN_NODE: [number, number] = [22, 18];

function nodeOk(): boolean {
  const [major, minor] = process.versions.node.split(".").map(Number);
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!nodeOk()) {
    process.stderr.write(`token-usage needs Node.js >= ${MIN_NODE.join(".")} (found ${process.versions.node})\n`);
    return 1;
  }
  setLogTag(cmd ?? "tu");
  switch (cmd) {
    case "report":
      return (await import("./commands/report.ts")).run(rest);
    case "hook":
      return (await import("./commands/hook.ts")).run(rest);
    case "startup":
      return (await import("./commands/startup.ts")).run(rest);
    case "status-line":
    case "statusline":
      return (await import("./commands/statusline.ts")).run(rest);
    case "refresh":
      return (await import("./commands/refresh.ts")).run(rest);
    case "dashboard":
      return (await import("./ui/app.ts")).run(rest);
    case "open":
      return (await import("./commands/open.ts")).run(rest);
    case "setup":
      return (await import("./commands/setup.ts")).run(rest);
    case "doctor":
      return (await import("./commands/doctor.ts")).run(rest);
    case "snooze":
      return (await import("./commands/snooze.ts")).run(rest);
    case "quota":
      return (await import("./commands/quota.ts")).run(rest);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`unknown command: ${cmd}\n\n${USAGE}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`token-usage: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exitCode = 1;
  },
);
