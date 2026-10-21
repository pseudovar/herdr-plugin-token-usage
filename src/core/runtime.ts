import { loadConfig } from "./config.ts";
import type { Config } from "./config.ts";
import { Ledger } from "./ledger.ts";
import { Pricing } from "./pricing.ts";
import type { PublishContext } from "./publish.ts";
import type { CopilotQuota } from "./quota/copilot.ts";

export interface Runtime {
  ledger: Ledger;
  config: Config;
  pricing: Pricing;
  close(): void;
}

export function openRuntime(): Runtime {
  const config = loadConfig();
  const ledger = Ledger.open();
  const pricing = Pricing.load(ledger, config.contextLimits);
  return {
    ledger,
    config,
    pricing,
    close: () => ledger.close(),
  };
}

export function publishContext(rt: Runtime, quota: CopilotQuota | null, labels = new Map<string, string>()): PublishContext {
  return {
    ledger: rt.ledger,
    pricing: rt.pricing,
    config: rt.config,
    now: Date.now(),
    quota,
    workspaceLabels: labels,
    firings: [],
  };
}
