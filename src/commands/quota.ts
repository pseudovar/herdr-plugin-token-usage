import { getCopilotQuota } from "../core/quota/copilot.ts";
import { openRuntime } from "../core/runtime.ts";
import { fmtCredits, fmtPace } from "../util/format.ts";
import { MINUTE } from "../util/time.ts";

export async function run(args: string[]): Promise<number> {
  const rt = openRuntime();
  try {
    const quota = getCopilotQuota(rt.ledger, {
      allowFetch: true,
      maxAgeMs: args.includes("--refresh") ? 0 : rt.config.copilot.refreshMinutes * MINUTE,
      timeoutMs: 8000,
    });
    if (args.includes("--json")) {
      process.stdout.write(JSON.stringify(quota, null, 2) + "\n");
      return quota ? 0 : 1;
    }
    if (!quota) {
      process.stdout.write("Copilot quota unavailable (is `gh` installed and logged in?)\n");
      return 1;
    }
    const unit = quota.unit === "credits" ? "credits" : "premium requests";
    const lines = [
      `GitHub Copilot (${quota.plan ?? "unknown plan"}, ${quota.tokenBased ? "AI-credit billing" : "premium-request billing"})`,
    ];
    if (quota.unlimited) lines.push(`  unlimited allowance · ${fmtCredits(quota.used ?? 0, "")} ${unit} used`);
    else {
      lines.push(
        `  used      ${fmtCredits(quota.used ?? 0, "")} of ${fmtCredits(quota.entitlement ?? 0, "")} ${unit} (${quota.usedPct?.toFixed(1)}%)`,
      );
      lines.push(`  pace      ${fmtPace(quota.pace)}  (${quota.elapsedPct.toFixed(0)}% of the month elapsed)`);
      lines.push(`  projected ${quota.projectedPct?.toFixed(0)}% by reset`);
    }
    lines.push(`  resets    ${new Date(quota.resetAt).toLocaleString()} (${quota.daysLeft.toFixed(1)} days)`);
    if (!quota.ok) lines.push(`  (last refresh failed: ${quota.error}; showing cached data)`);
    process.stdout.write(lines.join("\n") + "\n");
    return 0;
  } finally {
    rt.close();
  }
}
