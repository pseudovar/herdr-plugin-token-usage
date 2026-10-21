import { ingest } from "../core/ingest.ts";
import { loadQuota, publishAll } from "../core/publish.ts";
import { openRuntime, publishContext } from "../core/runtime.ts";
import { HARNESS_LABEL } from "../core/types.ts";
import { fmtCredits, fmtTokens, fmtUsd } from "../util/format.ts";

/** Force a full ingest and republish every agent's tokens (action: refresh). */
export async function run(_args: string[]): Promise<number> {
  const rt = openRuntime();
  try {
    const summary = ingest(rt.ledger, rt.pricing, rt.config, { waitMs: 15_000, force: true });
    const quota = loadQuota(rt.ledger, rt.config, true, 5000);
    const res = await publishAll(publishContext(rt, quota), { prune: true });
    const lines = [`ingested in ${summary.ms} ms: ${summary.results.map((r) => `${r.harness} +${r.records}`).join(", ")}`];
    for (const r of res.results) {
      const m = r.metrics;
      const label = `${r.agent.pane_id} ${r.agent.agent}`;
      if (!r.binding?.sessionId) lines.push(`${label}: no session yet`);
      else if (!m) lines.push(`${label}: ${r.binding.sessionId} (no calls)`);
      else
        lines.push(
          `${label}: ${HARNESS_LABEL[m.harness]} ${r.binding.method} ${m.billing === "copilot" ? fmtCredits(m.credits) : fmtUsd(m.costUsd)} · ${fmtTokens(m.workTokens)} work · level ${r.level}`,
        );
    }
    if (quota?.usedPct != null) lines.push(`Copilot: ${quota.usedPct.toFixed(1)}% used, pace ${quota.pace?.toFixed(2) ?? "–"}×`);
    process.stdout.write(lines.join("\n") + "\n");
    return 0;
  } finally {
    rt.close();
  }
}
