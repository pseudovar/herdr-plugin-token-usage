/** Minimal terminal driver: alternate screen, raw keys, mouse wheel, resize. */

export type Key =
  | { name: "up" | "down" | "left" | "right" | "pageup" | "pagedown" | "home" | "end" }
  | { name: "enter" | "escape" | "tab" | "backtab" | "backspace" | "ctrl-c" }
  | { name: "char"; ch: string }
  | { name: "wheel"; dir: -1 | 1 }
  | { name: "click"; x: number; y: number };

const out = process.stdout;

export function enter(): void {
  out.write("\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h\x1b[?7l");
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
}

export function leave(): void {
  out.write("\x1b[?1000l\x1b[?1006l\x1b[?7h\x1b[0m\x1b[?25h\x1b[?1049l");
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
}

export function size(): { cols: number; rows: number } {
  // Leave the last column empty: herdr's pane scrollbar can overlay it, and
  // writing the final column risks autowrap glitches in some terminals.
  return { cols: Math.max(20, (out.columns || 100) - 1), rows: out.rows || 30 };
}

/** What the last frame put on screen, line by line. */
let onScreen: string[] = [];

/** Forget what is on screen (after a resize, say), so the next frame redraws every line. */
export function invalidate(): void {
  onScreen = [];
}

/**
 * The writes that turn frame `prev` into `next`: each changed line is
 * cursor-addressed and cleared to its end; unchanged lines cost nothing.
 * Returns the indexes of the lines it rewrites.
 */
export function frameDiff(prev: string[], next: string[]): { seq: string; changed: number[] } {
  let seq = "";
  const changed: number[] = [];
  for (let i = 0; i < next.length; i++) {
    if (prev[i] === next[i]) continue;
    seq += `\x1b[${i + 1};1H${next[i]}\x1b[0m\x1b[K`;
    changed.push(i);
  }
  if (prev.length > next.length) seq += `\x1b[${next.length + 1};1H\x1b[J`;
  return { seq, changed };
}

/**
 * Draw a frame in one write. Only lines that changed since the last frame are
 * sent, so a refresh that moves a clock costs one line rather than a screen.
 * Returns the rewritten line indexes.
 */
export function draw(lines: string[]): number[] {
  const next = lines.slice(0, size().rows);
  const { seq, changed } = frameDiff(onScreen, next);
  onScreen = next;
  if (seq) out.write(seq);
  return changed;
}

export function parseKeys(data: string): Key[] {
  const keys: Key[] = [];
  let i = 0;
  while (i < data.length) {
    const rest = data.slice(i);
    const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(rest);
    if (mouse) {
      const btn = Number(mouse[1]);
      if (btn === 64) keys.push({ name: "wheel", dir: -1 });
      else if (btn === 65) keys.push({ name: "wheel", dir: 1 });
      else if (btn === 0 && mouse[4] === "M") keys.push({ name: "click", x: Number(mouse[2]) - 1, y: Number(mouse[3]) - 1 });
      i += mouse[0].length;
      continue;
    }
    const seqs: Array<[string, Key]> = [
      ["\x1b[A", { name: "up" }],
      ["\x1b[B", { name: "down" }],
      ["\x1b[C", { name: "right" }],
      ["\x1b[D", { name: "left" }],
      ["\x1bOA", { name: "up" }],
      ["\x1bOB", { name: "down" }],
      ["\x1bOC", { name: "right" }],
      ["\x1bOD", { name: "left" }],
      ["\x1b[5~", { name: "pageup" }],
      ["\x1b[6~", { name: "pagedown" }],
      ["\x1b[H", { name: "home" }],
      ["\x1b[F", { name: "end" }],
      ["\x1b[1~", { name: "home" }],
      ["\x1b[4~", { name: "end" }],
      ["\x1b[Z", { name: "backtab" }],
    ];
    const hit = seqs.find(([s]) => rest.startsWith(s));
    if (hit) {
      keys.push(hit[1]);
      i += hit[0].length;
      continue;
    }
    const ch = rest[0];
    if (ch === "\x1b") {
      // Unknown CSI sequence: skip it; a lone ESC is Escape.
      const csi = /^\x1b\[[0-9;?]*[ -/]*[@-~]/.exec(rest);
      if (csi) {
        i += csi[0].length;
        continue;
      }
      keys.push({ name: "escape" });
      i += 1;
      continue;
    }
    if (ch === "\r" || ch === "\n") keys.push({ name: "enter" });
    else if (ch === "\t") keys.push({ name: "tab" });
    else if (ch === "\x7f" || ch === "\b") keys.push({ name: "backspace" });
    else if (ch === "\x03") keys.push({ name: "ctrl-c" });
    else if (ch >= " ") keys.push({ name: "char", ch });
    i += 1;
  }
  return keys;
}
