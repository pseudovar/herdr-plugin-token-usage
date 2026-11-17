import { join } from "node:path";
import type { Adapter, AdapterResult, IngestScope } from "../adapters/adapter.ts";
import { claudeAdapter } from "../adapters/claude.ts";
import { copilotAdapter } from "../adapters/copilot.ts";
import { opencodeAdapter } from "../adapters/opencode.ts";
import { piAdapter } from "../adapters/pi.ts";
import { stateDir } from "../env.ts";
import { FileLock } from "../util/lock.ts";
import { log } from "../util/log.ts";
import type { Config } from "./config.ts";
import type { Ledger } from "./ledger.ts";
import type { Pricing } from "./pricing.ts";
import type { Harness } from "./types.ts";

/** Copilot first: its exact credit rate card prices Pi/OpenCode Copilot calls. */
export const ADAPTERS: Record<Harness, Adapter> = {
  copilot: copilotAdapter,
  pi: piAdapter,
  opencode: opencodeAdapter,
  claude: claudeAdapter,
};

export const INGEST_ORDER: Harness[] = ["copilot", "pi", "opencode", "claude"];

const failedKey = (harness: Harness) => `ingest_failed:${harness}`;

export interface IngestOptions {
  harnesses?: Harness[];
  scope?: Partial<Record<Harness, IngestScope>>;
  /** Skip a harness ingested less than this many ms ago (unless scoped or forced). */
  freshMs?: number;
  /** How long to wait for another process's ingest to finish. 0 = skip if busy. */
  waitMs?: number;
  force?: boolean;
}

export interface IngestSummary {
  ran: boolean;
  reason?: string;
  results: AdapterResult[];
  ms: number;
}

export function ingest(ledger: Ledger, pricing: Pricing, config: Config, opts: IngestOptions = {}): IngestSummary {
  const started = Date.now();
  const lock = new FileLock(join(stateDir(), "ingest.lock"));
  if (!lock.acquire(opts.waitMs ?? 0)) {
    return { ran: false, reason: "busy", results: [], ms: Date.now() - started };
  }
  const results: AdapterResult[] = [];
  try {
    const wanted = opts.harnesses ?? INGEST_ORDER;
    for (const harness of INGEST_ORDER) {
      if (!wanted.includes(harness) || !config.harnesses[harness]) continue;
      const adapter = ADAPTERS[harness];
      const scope = opts.scope?.[harness];
      const metaKey = `ingested_at:${harness}`;
      if (!opts.force && !scope && opts.freshMs) {
        const last = Number(ledger.getMeta(metaKey) ?? 0);
        if (Date.now() - last < opts.freshMs) continue;
      }
      if (!adapter.detect()) continue;
      try {
        const res = ledger.transaction(() =>
          adapter.ingest({ ledger, pricing, config, now: Date.now() }, scope),
        );
        results.push(res);
        if (!scope) ledger.setMeta(metaKey, String(Date.now()));
        ledger.deleteMeta(failedKey(harness));
        if (harness === "copilot" && res.records > 0) pricing.reloadCopilotCard(ledger);
      } catch (err) {
        log.error(`ingest ${harness} failed`, err);
        results.push({ harness, records: 0, sessions: 0, files: 0, errors: 1, note: (err as Error).message });
        recordIngestFailure(ledger, harness, (err as Error).message);
      }
    }
  } finally {
    lock.release();
  }
  return { ran: true, results, ms: Date.now() - started };
}

/** A harness has to keep failing this long before it's reported: one bad read can be a file caught mid-write. */
export const FAILURE_GRACE_MS = 5 * 60_000;

export interface IngestFailure {
  harness: Harness;
  /** The first failure since the last good read. */
  since: number;
  /** The latest error. */
  message: string;
  reported: boolean;
}

export function recordIngestFailure(ledger: Ledger, harness: Harness, message: string, now = Date.now()): void {
  const prev = ingestFailures(ledger).find((f) => f.harness === harness);
  ledger.setMeta(failedKey(harness), JSON.stringify({ since: prev?.since ?? now, message, reported: prev?.reported ?? false }));
}

/** Harnesses whose usage can't be read: every read since `since` has failed. */
export function ingestFailures(ledger: Ledger): IngestFailure[] {
  return INGEST_ORDER.flatMap((harness) => {
    const raw = ledger.getMeta(failedKey(harness));
    if (!raw) return [];
    try {
      return [{ harness, ...(JSON.parse(raw) as Omit<IngestFailure, "harness">) }];
    } catch {
      return [];
    }
  });
}

/** Failures past the grace period that haven't been reported; marks them reported, so each is toasted once. */
export function takeUnreportedFailures(ledger: Ledger, now = Date.now()): IngestFailure[] {
  const due = ingestFailures(ledger).filter((f) => !f.reported && now - f.since >= FAILURE_GRACE_MS);
  for (const f of due) ledger.setMeta(failedKey(f.harness), JSON.stringify({ since: f.since, message: f.message, reported: true }));
  return due;
}
