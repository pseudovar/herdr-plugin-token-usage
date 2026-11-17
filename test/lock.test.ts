import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { FileLock } from "../src/util/lock.ts";

describe("ingest lock", () => {
  const dir = mkdtempSync(join(tmpdir(), "tu-lock-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("takes over an empty lock file once it is older than the stale limit", () => {
    // A holder killed between creating the file and writing its pid leaves it empty.
    const path = join(dir, "empty-old.lock");
    writeFileSync(path, "");
    const old = new Date(Date.now() - 60_000);
    utimesSync(path, old, old);
    const lock = new FileLock(path);
    assert.ok(lock.acquire(0));
    assert.match(readFileSync(path, "utf8"), new RegExp(`^${process.pid} `));
    lock.release();
    assert.ok(!existsSync(path));
  });

  it("respects a fresh empty lock file, whose holder may still be writing it", () => {
    const path = join(dir, "empty-new.lock");
    writeFileSync(path, "");
    assert.equal(new FileLock(path).acquire(0), false);
  });
});
