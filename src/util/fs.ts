import { closeSync, fstatSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import type { Stats } from "node:fs";
import { join } from "node:path";

export function safeStat(path: string): Stats | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

export function listDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

/** Saved read position for an append-only file. */
export interface FileCursor {
  ino: number;
  offset: number;
  size: number;
  mtimeMs: number;
}

export interface TailResult {
  lines: string[];
  cursor: FileCursor;
  /** True when the file was replaced or truncated and re-read from the start. */
  reset: boolean;
}

const MAX_CHUNK = 64 * 1024 * 1024;

/**
 * Read complete new lines appended since `prev`. A partial trailing line is
 * left for the next call. A changed inode or a shrunken file restarts from 0
 * (callers dedupe by key, so re-reading is safe).
 */
export function readNewLines(path: string, prev: FileCursor | null): TailResult | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    let offset = prev?.offset ?? 0;
    let reset = false;
    if (prev && (prev.ino !== st.ino || st.size < prev.offset)) {
      offset = 0;
      reset = true;
    }
    const cursorBase = { ino: st.ino, size: st.size, mtimeMs: st.mtimeMs };
    if (st.size <= offset) {
      return { lines: [], cursor: { ...cursorBase, offset }, reset };
    }
    const length = Math.min(st.size - offset, MAX_CHUNK);
    const buf = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buf, read, length - read, offset + read);
      if (n <= 0) break;
      read += n;
    }
    const lastNewline = buf.lastIndexOf(0x0a, read - 1);
    if (lastNewline < 0) {
      return { lines: [], cursor: { ...cursorBase, offset }, reset };
    }
    const text = buf.toString("utf8", 0, lastNewline);
    const lines = text.split("\n").filter((l) => l.length > 0);
    return { lines, cursor: { ...cursorBase, offset: offset + lastNewline + 1 }, reset };
  } finally {
    closeSync(fd);
  }
}

/** Read the last `bytes` of a file as complete lines (first partial line dropped). */
export function readTailLines(path: string, bytes: number): string[] {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return [];
  }
  try {
    const st = fstatSync(fd);
    const start = Math.max(0, st.size - bytes);
    const length = st.size - start;
    if (length <= 0) return [];
    const buf = Buffer.allocUnsafe(length);
    readSync(fd, buf, 0, length, start);
    const text = buf.toString("utf8");
    const lines = text.split("\n");
    if (start > 0) lines.shift();
    return lines.filter((l) => l.length > 0);
  } finally {
    closeSync(fd);
  }
}

/** Recursively collect files matching `accept`, up to `maxDepth` directories deep. */
export function walkFiles(
  root: string,
  accept: (name: string, path: string) => boolean,
  skipDir: (path: string) => boolean,
  maxDepth = 4,
): string[] {
  const out: string[] = [];
  const visit = (dir: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth && !skipDir(path)) visit(path, depth + 1);
      } else if (entry.isFile() && accept(entry.name, path)) {
        out.push(path);
      }
    }
  };
  visit(root, 0);
  return out;
}

export function parseJson<T = unknown>(line: string): T | null {
  try {
    return JSON.parse(line) as T;
  } catch {
    return null;
  }
}

/** Minimal glob → RegExp supporting `**`, `*` and `?` for ignore patterns. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$+.()|{}[]".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}
