import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "../env.ts";

const MAX_LOG_BYTES = 512 * 1024;
let logPath: string | null = null;
let tag = "tu";

export function setLogTag(value: string): void {
  tag = value;
}

function path(): string {
  if (!logPath) {
    const dir = stateDir();
    mkdirSync(dir, { recursive: true });
    logPath = join(dir, "token-usage.log");
  }
  return logPath;
}

function write(level: string, msg: string): void {
  try {
    const p = path();
    try {
      if (statSync(p).size > MAX_LOG_BYTES) renameSync(p, p + ".1");
    } catch {
      // first write
    }
    appendFileSync(p, `${new Date().toISOString()} ${level} [${tag}:${process.pid}] ${msg}\n`);
  } catch {
    // logging must never break a hook
  }
}

export const log = {
  debug(msg: string) {
    if (process.env.TU_DEBUG) write("DEBUG", msg);
  },
  info(msg: string) {
    write("INFO", msg);
  },
  warn(msg: string) {
    write("WARN", msg);
  },
  error(msg: string, err?: unknown) {
    const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : err ? String(err) : "";
    write("ERROR", detail ? `${msg}: ${detail}` : msg);
  },
};
