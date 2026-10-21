import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { harnessPaths, stateDir } from "../env.ts";
import type { Ledger } from "./ledger.ts";

/** Prices per 1M tokens (USD, or Copilot credits for the credit rate card). */
export interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface ModelEntry {
  rates?: Rates;
  contextLimit?: number;
}

interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
}

/** provider → normalized model → entry */
type Catalog = Record<string, Record<string, ModelEntry>>;

interface CatalogCache {
  sources: Record<string, number>;
  catalog: Catalog;
}

/** Fallback list prices (USD per 1M) by Claude family when no catalog is cached locally. */
const CLAUDE_FAMILY_FALLBACK: Array<[RegExp, Rates]> = [
  [/opus-4-[01]|opus-3/, { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }],
  [/opus/, { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
  [/sonnet/, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  [/haiku-3/, { input: 0.25, output: 1.25, cacheRead: 0.03, cacheWrite: 0.3 }],
  [/haiku/, { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }],
];

/** Normalize model ids so `claude-opus-4.8`, `claude-opus-4-8` and `claude-opus-4-8-20260101` match. */
export function normalizeModel(model: string): string {
  return model
    .toLowerCase()
    .trim()
    .replace(/\[[^\]]*\]$/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-(1m|1m-internal)$/, "")
    .replace(/\./g, "-");
}

const PROVIDER_ALIASES: Record<string, string> = {
  copilot: "github-copilot",
  "github_copilot": "github-copilot",
  claude: "anthropic",
};

export function normalizeProvider(provider: string | null | undefined): string {
  const p = (provider ?? "").toLowerCase().trim();
  return PROVIDER_ALIASES[p] ?? p;
}

export class Pricing {
  private readonly catalog: Catalog;
  private copilotCard: Record<string, Rates>;
  private readonly overrides: Record<string, number>;

  private constructor(catalog: Catalog, copilotCard: Record<string, Rates>, overrides: Record<string, number>) {
    this.catalog = catalog;
    this.copilotCard = copilotCard;
    this.overrides = overrides;
  }

  /** Re-read the Copilot credit rate card after the Copilot adapter refreshed it. */
  reloadCopilotCard(ledger: Ledger): void {
    const raw = ledger.getMeta("copilot_rate_card");
    if (!raw) return;
    try {
      this.copilotCard = JSON.parse(raw) as Record<string, Rates>;
    } catch {
      // keep previous card
    }
  }

  static load(ledger: Ledger | null, contextOverrides: Record<string, number> = {}): Pricing {
    const catalog = loadCatalog();
    let card: Record<string, Rates> = {};
    const raw = ledger?.getMeta("copilot_rate_card");
    if (raw) {
      try {
        card = JSON.parse(raw) as Record<string, Rates>;
      } catch {
        card = {};
      }
    }
    const overrides: Record<string, number> = {};
    for (const [model, limit] of Object.entries(contextOverrides)) overrides[normalizeModel(model)] = limit;
    return new Pricing(catalog, card, overrides);
  }

  /** For tests. */
  static fromParts(catalog: Catalog, card: Record<string, Rates> = {}): Pricing {
    return new Pricing(catalog, card, {});
  }

  private entry(provider: string | null, model: string): ModelEntry | undefined {
    const p = normalizeProvider(provider);
    const m = normalizeModel(model);
    return this.catalog[p]?.[m];
  }

  /** API-equivalent list cost in USD, or null when the model is unknown. */
  usd(provider: string | null, model: string, t: TokenCounts): number | null {
    let rates = this.entry(provider, model)?.rates;
    const p = normalizeProvider(provider);
    if (!rates && (p === "anthropic" || p === "" || /claude/.test(model))) {
      rates = this.catalog["anthropic"]?.[normalizeModel(model)]?.rates ?? claudeFallback(model);
    }
    if (!rates) return null;
    return applyRates(rates, t, rates.input * 2);
  }

  /**
   * Copilot AI credits for a Copilot-billed call. Uses the exact per-model
   * credit rate card observed in Copilot CLI data when available, otherwise
   * the github-copilot list price × 100 (1 credit = $0.01).
   */
  credits(model: string, t: TokenCounts): number | null {
    const m = normalizeModel(model);
    const card = this.copilotCard[m];
    if (card) return applyRates(card, t, card.input * 2);
    const rates = this.catalog["github-copilot"]?.[m]?.rates;
    if (rates) return applyRates(rates, t, rates.input * 2) * 100;
    return null;
  }

  hasCopilotCard(model: string): boolean {
    return normalizeModel(model) in this.copilotCard;
  }

  /** Models on the observed Copilot rate card (for what-if pricing). */
  copilotCardModels(): string[] {
    return Object.keys(this.copilotCard);
  }

  /**
   * Per-token-type prices in USD per 1M tokens, for splitting a bill into
   * input / cache write / cache read / output. Copilot-billed calls use the
   * credit rate card (credits ÷ 100).
   */
  ratesUsd(billing: string, provider: string | null, model: string): Rates | null {
    const m = normalizeModel(model);
    if (billing === "copilot") {
      const card = this.copilotCard[m];
      if (card) return { input: card.input / 100, output: card.output / 100, cacheRead: card.cacheRead / 100, cacheWrite: card.cacheWrite / 100 };
      return this.catalog["github-copilot"]?.[m]?.rates ?? null;
    }
    return this.entry(provider, model)?.rates ?? this.catalog["anthropic"]?.[m]?.rates ?? claudeFallback(model) ?? null;
  }

  contextLimit(provider: string | null, model: string): number | null {
    const m = normalizeModel(model);
    if (this.overrides[m]) return this.overrides[m];
    const direct = this.entry(provider, model)?.contextLimit;
    if (direct) return direct;
    for (const p of ["anthropic", "github-copilot", "openai", "google"]) {
      const limit = this.catalog[p]?.[m]?.contextLimit;
      if (limit) return limit;
    }
    return null;
  }

  knownProviders(): string[] {
    return Object.keys(this.catalog);
  }
}

function claudeFallback(model: string): Rates | undefined {
  const m = normalizeModel(model);
  if (!m.includes("claude")) return undefined;
  for (const [re, rates] of CLAUDE_FAMILY_FALLBACK) if (re.test(m)) return rates;
  return undefined;
}

function applyRates(r: Rates, t: TokenCounts, oneHourWriteRate: number): number {
  const cw1h = Math.min(t.cacheWrite1h ?? 0, t.cacheWrite);
  const cw5m = t.cacheWrite - cw1h;
  return (
    (t.input * r.input + t.output * r.output + t.cacheRead * r.cacheRead + cw5m * r.cacheWrite + cw1h * oneHourWriteRate) /
    1e6
  );
}

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Build a compact provider/model catalog from the model registries that
 * harnesses already cache locally (OpenCode's models.dev snapshot and Pi's
 * models-store.json). No network access. Cached in the state dir and rebuilt
 * when a source file changes.
 */
function loadCatalog(): Catalog {
  const sources = {
    modelsDev: harnessPaths.opencodeModels(),
    piStore: harnessPaths.piModels(),
  };
  const stamps: Record<string, number> = {
    [sources.modelsDev]: mtime(sources.modelsDev),
    [sources.piStore]: mtime(sources.piStore),
  };
  const cachePath = join(stateDir(), "catalog-cache.json");
  try {
    const cached = JSON.parse(readFileSync(cachePath, "utf8")) as CatalogCache;
    const fresh = Object.entries(stamps).every(([k, v]) => cached.sources[k] === v);
    if (fresh) return cached.catalog;
  } catch {
    // rebuild
  }
  const catalog: Catalog = {};
  const put = (provider: string, model: string, entry: ModelEntry) => {
    const p = normalizeProvider(provider);
    const m = normalizeModel(model);
    const bucket = (catalog[p] ??= {});
    const prev = bucket[m];
    bucket[m] = { rates: entry.rates ?? prev?.rates, contextLimit: entry.contextLimit ?? prev?.contextLimit };
  };

  if (stamps[sources.modelsDev]) {
    try {
      const data = JSON.parse(readFileSync(sources.modelsDev, "utf8")) as Record<
        string,
        { models?: Record<string, { cost?: Record<string, unknown>; limit?: { context?: number } }> }
      >;
      for (const [provider, info] of Object.entries(data)) {
        for (const [model, m] of Object.entries(info.models ?? {})) {
          const cost = m.cost ?? {};
          const input = numberOr(cost.input);
          const output = numberOr(cost.output);
          const rates =
            input != null && output != null
              ? {
                  input,
                  output,
                  cacheRead: numberOr(cost.cache_read) ?? input,
                  cacheWrite: numberOr(cost.cache_write) ?? input,
                }
              : undefined;
          put(provider, model, { rates, contextLimit: m.limit?.context });
        }
      }
    } catch {
      // unreadable snapshot: fall through to Pi + built-ins
    }
  }

  if (stamps[sources.piStore]) {
    try {
      const data = JSON.parse(readFileSync(sources.piStore, "utf8")) as Record<
        string,
        {
          models?: Array<{
            id: string;
            provider?: string;
            contextWindow?: number;
            cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
          }>;
        }
      >;
      for (const [provider, info] of Object.entries(data)) {
        for (const m of info.models ?? []) {
          const c = m.cost;
          const rates =
            c && c.input != null && c.output != null
              ? { input: c.input, output: c.output, cacheRead: c.cacheRead ?? c.input, cacheWrite: c.cacheWrite ?? c.input }
              : undefined;
          put(m.provider ?? provider, m.id, { rates, contextLimit: m.contextWindow });
        }
      }
    } catch {
      // ignore
    }
  }

  try {
    writeFileSync(cachePath, JSON.stringify({ sources: stamps, catalog } satisfies CatalogCache));
  } catch {
    // state dir not writable: use in-memory catalog
  }
  return catalog;
}

function numberOr(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
