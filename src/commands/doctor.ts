import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ADAPTERS, INGEST_ORDER } from "../core/ingest.ts";
import { Ledger } from "../core/ledger.ts";
import { sessionMetrics } from "../core/metrics.ts";
import { getBinding } from "../core/binding.ts";
import { openRuntime } from "../core/runtime.ts";
import { configPath } from "../core/config.ts";
import { HARNESS_LABEL } from "../core/types.ts";
import { PLUGIN_ID, configDir, herdrSocketPath, pluginRoot, stateDir } from "../env.ts";
import { listAgents, ping } from "../herdr/client.ts";
import { fmtAgo, fmtCredits, fmtTokens, fmtUsd } from "../util/format.ts";
import { checkConfig, readHerdrConfig } from "./herdrconfig.ts";

/** Diagnose data sources, ledger, bindings, quota and herdr wiring. */
export async function run(_args: string[]): Promise<number> {
  const out: string[] = [];
  const rt = openRuntime();
  try {
    out.push(`Token Usage (${PLUGIN_ID}) doctor`);
    out.push(`  node ${process.versions.node} · plugin root ${pluginRoot()}`);
    out.push(`  state  ${stateDir()}`);
    out.push(`  config ${configPath()}${existsSync(configPath()) ? "" : " (defaults)"}`);
    const dbSize = existsSync(Ledger.path()) ? statSync(Ledger.path()).size : 0;
    out.push(`  ledger ${(dbSize / 1024 / 1024).toFixed(1)} MB`);
    out.push("");
    out.push("Data sources:");
    for (const h of INGEST_ORDER) {
      const adapter = ADAPTERS[h];
      const enabled = rt.config.harnesses[h];
      const found = adapter.detect();
      const row = rt.ledger.get<{ n: number; last: number | null }>(
        "SELECT COUNT(*) AS n, MAX(ts) AS last FROM request WHERE harness = ?",
        h,
      );
      const ingested = Number(rt.ledger.getMeta(`ingested_at:${h}`) ?? 0);
      out.push(
        `  ${found ? "✓" : "·"} ${HARNESS_LABEL[h].padEnd(12)} ${enabled ? "" : "(disabled) "}${row?.n ?? 0} calls, ` +
          `last call ${fmtAgo(row?.last ?? null)}, ingested ${ingested ? fmtAgo(ingested) : "never"}`,
      );
    }
    const card = rt.ledger.getMeta("copilot_rate_card");
    out.push(`  Copilot credit rate card: ${card ? Object.keys(JSON.parse(card)).length + " models observed" : "none (prices from model catalogs)"}`);

    out.push("");
    const quotaRow = rt.ledger.get<{ fetched_at: number; ok: number; error: string | null; failures: number }>(
      "SELECT fetched_at, ok, error, failures FROM quota WHERE provider = 'copilot'",
    );
    out.push(
      `Copilot quota: ${quotaRow ? (quotaRow.ok ? `ok, fetched ${fmtAgo(quotaRow.fetched_at)}` : `error "${quotaRow.error}" (${quotaRow.failures} failures)`) : "never fetched"}`,
    );

    out.push("");
    out.push(`herdr socket: ${herdrSocketPath()}`);
    if (await ping()) {
      const agents = await listAgents();
      out.push(`  ${agents.length} live agents`);
      for (const a of agents) {
        const b = getBinding(rt.ledger, a.terminal_id);
        const session = a.agent_session ? `${a.agent_session.kind}:${a.agent_session.value.slice(-24)}` : "no integration";
        let line = `  ${a.pane_id.padEnd(7)} ${a.agent.padEnd(9)} ${a.agent_status.padEnd(8)} ${session}`;
        if (b?.harness && b.sessionId) {
          const m = sessionMetrics(rt.ledger, b.harness, b.sessionId);
          line += ` → ${b.method} ${b.sessionId.slice(0, 12)}…`;
          if (m) line += ` ${m.billing === "copilot" ? fmtCredits(m.credits) : fmtUsd(m.costUsd)} ${fmtTokens(m.workTokens)}`;
        } else {
          line += " → unbound";
        }
        const ours = Object.keys(a.tokens ?? {}).filter((k) => k.startsWith("tu"));
        line += ours.length ? ` [${ours.length} tokens]` : " [no tokens]";
        out.push(line);
      }
    } else {
      out.push("  not reachable (run inside herdr, or set HERDR_SOCKET_PATH)");
    }

    out.push("");
    out.push("herdr config.toml:");
    for (const c of checkConfig(readHerdrConfig())) out.push(`  ${c.state === "ok" ? "✓" : c.state === "conflict" ? "!" : c.state === "outdated" ? "↑" : "·"} ${c.label.padEnd(26)} ${c.detail}`);

    const logPath = join(stateDir(), "token-usage.log");
    if (existsSync(logPath)) {
      const problems = readFileSync(logPath, "utf8")
        .split("\n")
        .filter((l) => / (ERROR|WARN) /.test(l))
        .slice(-8);
      if (problems.length) {
        out.push("");
        out.push("Recent warnings/errors (token-usage.log):");
        for (const p of problems) out.push(`  ${p.slice(0, 200)}`);
      }
    }
    out.push("");
    out.push(`Config dir: ${configDir()}`);
    process.stdout.write(out.join("\n") + "\n");
    return 0;
  } finally {
    rt.close();
  }
}
