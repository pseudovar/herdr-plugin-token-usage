import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AdapterContext } from "../src/adapters/adapter.ts";
import { defaultConfig } from "../src/core/config.ts";
import type { Config } from "../src/core/config.ts";
import { Ledger } from "../src/core/ledger.ts";
import { Pricing } from "../src/core/pricing.ts";

export function tempDir(prefix = "tu-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function writeLines(path: string, lines: unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
}

/** Tiny price catalog: Anthropic list prices and Copilot list prices ($/1M). */
export function testPricing(): Pricing {
  return Pricing.fromParts({
    anthropic: {
      "claude-opus-4-8": { rates: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, contextLimit: 200000 },
      "claude-sonnet-5": { rates: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }, contextLimit: 1000000 },
    },
    "github-copilot": {
      "claude-opus-5-5": { rates: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }, contextLimit: 1000000 },
    },
  });
}

export function testContext(overrides: Partial<Config> = {}): AdapterContext {
  const config = { ...defaultConfig(), ...overrides };
  return { ledger: new Ledger(":memory:"), pricing: testPricing(), config, now: Date.now() };
}

export function count(ctx: AdapterContext, where = "1=1"): number {
  return ctx.ledger.get<{ n: number }>(`SELECT COUNT(*) AS n FROM request WHERE ${where}`)?.n ?? 0;
}
