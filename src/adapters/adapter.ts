import type { Config } from "../core/config.ts";
import type { Ledger } from "../core/ledger.ts";
import type { Pricing } from "../core/pricing.ts";
import { normalizeProvider } from "../core/pricing.ts";
import type { Billing, Harness } from "../core/types.ts";

export interface AdapterContext {
  ledger: Ledger;
  pricing: Pricing;
  config: Config;
  now: number;
}

/** Restrict an ingest run to specific files (JSONL harnesses). */
export interface IngestScope {
  paths?: string[];
}

export interface AdapterResult {
  harness: Harness;
  records: number;
  sessions: number;
  files: number;
  errors: number;
  note?: string;
}

export interface Adapter {
  harness: Harness;
  /** True when this harness's data store exists on this machine. */
  detect(): boolean;
  ingest(ctx: AdapterContext, scope?: IngestScope): AdapterResult;
}

const LOCAL_PROVIDERS = new Set([
  "ollama",
  "lmstudio",
  "lm-studio",
  "llama.cpp",
  "llamacpp",
  "llama-cpp",
  "vllm",
  "litellm",
  "local",
  "localhost",
  "mlx",
  "jan",
]);

export function billingFor(harness: Harness, provider: string | null, model: string): Billing {
  const p = normalizeProvider(provider);
  if (harness === "copilot" || p === "github-copilot") return "copilot";
  if (LOCAL_PROVIDERS.has(p) || p.startsWith("ollama") || p.startsWith("lmstudio")) return "local";
  if (harness === "claude") return /claude/i.test(model) ? "claude" : "api";
  return "api";
}

export function emptyResult(harness: Harness, note?: string): AdapterResult {
  return { harness, records: 0, sessions: 0, files: 0, errors: 0, note };
}

export function n(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function nOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
