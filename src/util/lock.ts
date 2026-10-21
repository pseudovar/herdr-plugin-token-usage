import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { sleepSync } from "./time.ts";

/**
 * Cross-process lock file. Hooks fire concurrently with no queueing, so
 * ingestion is single-flight: one process ingests while others wait briefly
 * or skip and read what is already in the ledger.
 */
export class FileLock {
  private fd: number | null = null;
  private readonly path: string;
  private readonly staleMs: number;

  constructor(path: string, staleMs = 30_000) {
    this.path = path;
    this.staleMs = staleMs;
  }

  tryAcquire(): boolean {
    try {
      this.fd = openSync(this.path, "wx");
      writeSync(this.fd, `${process.pid} ${Date.now()}`);
      return true;
    } catch {
      if (this.isStale()) {
        try {
          unlinkSync(this.path);
        } catch {
          // another process removed it first
        }
        return this.tryAcquireOnce();
      }
      return false;
    }
  }

  acquire(waitMs: number): boolean {
    const deadline = Date.now() + waitMs;
    while (true) {
      if (this.tryAcquire()) return true;
      if (Date.now() >= deadline) return false;
      sleepSync(40);
    }
  }

  release(): void {
    if (this.fd == null) return;
    try {
      closeSync(this.fd);
    } catch {
      // ignore
    }
    this.fd = null;
    try {
      unlinkSync(this.path);
    } catch {
      // ignore
    }
  }

  private tryAcquireOnce(): boolean {
    try {
      this.fd = openSync(this.path, "wx");
      writeSync(this.fd, `${process.pid} ${Date.now()}`);
      return true;
    } catch {
      return false;
    }
  }

  private isStale(): boolean {
    try {
      const [pidText, tsText] = readFileSync(this.path, "utf8").split(" ");
      const ts = Number(tsText);
      const pid = Number(pidText);
      if (Number.isFinite(ts) && Date.now() - ts > this.staleMs) return true;
      if (Number.isFinite(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }
}
