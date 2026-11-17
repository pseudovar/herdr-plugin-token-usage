import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { describe, it } from "node:test";
import { defaultConfig } from "../src/core/config.ts";
import { ADAPTERS, FAILURE_GRACE_MS, ingest, ingestFailures, takeUnreportedFailures } from "../src/core/ingest.ts";
import { Ledger } from "../src/core/ledger.ts";
import { Pricing } from "../src/core/pricing.ts";
import { stateDir } from "../src/env.ts";

describe("a harness whose usage can't be read", () => {
  it("is recorded, reported once after a grace period, and cleared when reads work again", () => {
    mkdirSync(stateDir(), { recursive: true });
    const ledger = new Ledger(":memory:");
    const run = () => ingest(ledger, Pricing.fromParts({}), defaultConfig(), { harnesses: ["opencode"] });
    const real = ADAPTERS.opencode;
    try {
      ADAPTERS.opencode = {
        ...real,
        detect: () => true,
        ingest: () => {
          throw new Error("no such column: time_created");
        },
      };
      run();
      run();
      const [failure] = ingestFailures(ledger);
      assert.equal(failure?.harness, "opencode");
      assert.equal(failure.message, "no such column: time_created");
      assert.deepEqual(takeUnreportedFailures(ledger, failure.since + 60_000), [], "one bad read can be a file caught mid-write");
      assert.equal(takeUnreportedFailures(ledger, failure.since + FAILURE_GRACE_MS).length, 1);
      assert.deepEqual(takeUnreportedFailures(ledger, failure.since + 60 * 60_000), [], "reported once");

      ADAPTERS.opencode = { ...real, detect: () => true, ingest: () => ({ harness: "opencode", records: 0, sessions: 0, files: 0, errors: 0 }) };
      run();
      assert.deepEqual(ingestFailures(ledger), []);
    } finally {
      ADAPTERS.opencode = real;
    }
  });
});
