import { loadConfig } from "../core/config.ts";
import { ingest } from "../core/ingest.ts";
import { Ledger } from "../core/ledger.ts";
import { totals, totalsBy } from "../core/metrics.ts";
import type { GroupTotals, Totals } from "../core/metrics.ts";
import { Pricing } from "../core/pricing.ts";
import { HARNESS_LABEL } from "../core/types.ts";
import type { Harness } from "../core/types.ts";
import { fmtCredits, fmtTokens, fmtUsd } from "../util/format.ts";
import { DAY, startOfLocalDay, startOfLocalMonth, startOfLocalWeek, startOfUtcMonth } from "../util/time.ts";

interface Period {
  label: string;
  since: number;
}

function parsePeriod(args: string[]): Period {
  const now = Date.now();
  if (args.includes("--week")) return { label: "this week", since: startOfLocalWeek(now) };
  if (args.includes("--month")) return { label: "this month (local)", since: startOfLocalMonth(now) };
  if (args.includes("--billing")) return { label: "this Copilot billing month (UTC)", since: startOfUtcMonth(now) };
  const daysIdx = args.indexOf("--days");
  if (daysIdx >= 0) {
    const days = Number(args[daysIdx + 1] ?? 7);
    return { label: `last ${days} days`, since: now - days * DAY };
  }
  if (args.includes("--all")) return { label: "all time", since: 0 };
  return { label: "today", since: startOfLocalDay(now) };
}

export async function run(args: string[]): Promise<number> {
  const config = loadConfig();
  const ledger = Ledger.open();
  try {
    const pricing = Pricing.load(ledger, config.contextLimits);
    const summary = ingest(ledger, pricing, config, { waitMs: 15_000, force: args.includes("--force") });
    const period = parsePeriod(args);
    const all = totals(ledger, { since: period.since });
    const byHarness = totalsBy(ledger, "harness", { since: period.since });
    const byModel = totalsBy(ledger, "model", { since: period.since }, 20);
    const byBilling = totalsBy(ledger, "billing", { since: period.since });

    if (args.includes("--json")) {
      process.stdout.write(
        JSON.stringify({ period, ingest: summary, totals: all, byHarness, byBilling, byModel }, null, 2) + "\n",
      );
      return 0;
    }

    const out: string[] = [];
    out.push(`Token usage, ${period.label}`);
    if (args.includes("--verbose")) {
      for (const r of summary.results) {
        out.push(`  ingest ${r.harness}: +${r.records} calls, ${r.files} files, ${r.sessions} sessions${r.errors ? `, ${r.errors} errors` : ""}${r.note ? ` (${r.note})` : ""}`);
      }
      out.push(`  ingest took ${summary.ms} ms`);
    }
    out.push("");
    out.push(line(["", "calls", "work tok", "cache read", "credits", "API-eq $"], [22, 7, 10, 11, 11, 10]));
    for (const g of byHarness) out.push(row(HARNESS_LABEL[g.key as Harness] ?? g.key, g));
    out.push(row("Total", all));
    out.push("");
    out.push(line(["By billing", "calls", "work tok", "cache read", "credits", "API-eq $"], [22, 7, 10, 11, 11, 10]));
    for (const g of byBilling) out.push(row(g.key, g));
    out.push("");
    out.push(line(["Top models", "calls", "work tok", "cache read", "credits", "API-eq $"], [22, 7, 10, 11, 11, 10]));
    for (const g of byModel.slice(0, 12)) out.push(row(g.key, g));
    process.stdout.write(out.join("\n") + "\n");
    return 0;
  } finally {
    ledger.close();
  }
}

function row(label: string, t: Totals | GroupTotals): string {
  return line(
    [
      label,
      String(t.calls),
      fmtTokens(t.workTokens),
      fmtTokens(t.cacheRead),
      t.credits ? fmtCredits(t.credits) : "–",
      fmtUsd(t.costUsd),
    ],
    [22, 7, 10, 11, 11, 10],
  );
}

function line(cells: string[], widths: number[]): string {
  return cells
    .map((c, i) => {
      const w = widths[i];
      const text = c.length > w ? c.slice(0, w - 1) + "…" : c;
      return i === 0 ? text.padEnd(w) : text.padStart(w);
    })
    .join(" ");
}
