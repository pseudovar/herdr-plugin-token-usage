/** Truecolor styling with NO_COLOR support, and ANSI-aware width/fit helpers. */

const NO_COLOR = Boolean(process.env.NO_COLOR);

export const C = {
  text: "#cdd6f4",
  sub: "#a6adc8",
  dim: "#7f849c",
  faint: "#585b70",
  surface: "#313244",
  base: "#1e1e2e",
  red: "#f38ba8",
  yellow: "#f9e2af",
  green: "#a6e3a1",
  blue: "#89b4fa",
  mauve: "#cba6f7",
  peach: "#fab387",
  teal: "#94e2d5",
  sky: "#89dceb",
  lavender: "#b4befe",
  pink: "#f5c2e7",
};

function rgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function fg(hex: string, s: string): string {
  if (NO_COLOR) return s;
  const [r, g, b] = rgb(hex);
  return `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`;
}

/**
 * Colour a row of cells with one escape sequence per run of equal colours
 * rather than one per cell, which keeps chart frames small. Cells without a
 * colour (blanks) join whatever run they fall in.
 */
export function colorRuns(cells: Array<[color: string | null, text: string]>): string {
  let s = "";
  let run = "";
  let cur: string | null = null;
  for (const [color, text] of cells) {
    if (color != null && color !== cur) {
      if (run) s += cur ? fg(cur, run) : run;
      run = "";
      cur = color;
    }
    run += text;
  }
  if (run) s += cur ? fg(cur, run) : run;
  return s;
}

export function bg(hex: string, s: string): string {
  if (NO_COLOR) return s;
  const [r, g, b] = rgb(hex);
  return `\x1b[48;2;${r};${g};${b}m${s}\x1b[49m`;
}

export function bold(s: string): string {
  return NO_COLOR ? s : `\x1b[1m${s}\x1b[22m`;
}

export function dim(s: string): string {
  return NO_COLOR ? s : `\x1b[2m${s}\x1b[22m`;
}

export function inverse(s: string): string {
  return `\x1b[7m${s}\x1b[27m`;
}

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

export function strip(s: string): string {
  return s.replace(ANSI_RE, "");
}

/** Display width of one code point (wide CJK/emoji = 2, combining = 0). */
export function charWidth(cp: number): number {
  if (cp === 0) return 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp >= 0x300 && cp <= 0x36f) return 0;
  if (cp === 0x200b || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

export function width(s: string): number {
  let w = 0;
  for (const ch of strip(s)) w += charWidth(ch.codePointAt(0) ?? 0);
  return w;
}

/**
 * Fit a styled string to exactly `w` columns: truncate with an ellipsis or
 * pad with spaces. ANSI sequences are preserved; truncation resets styles.
 * Line breaks and tabs become single spaces, since they would split the frame.
 */
export function fit(s: string, w: number, align: "left" | "right" = "left"): string {
  if (w <= 0) return "";
  s = s.replace(/[\t\n\v\f\r]+/g, " ");
  const cur = width(s);
  if (cur <= w) {
    const pad = " ".repeat(w - cur);
    return align === "left" ? s + pad : pad + s;
  }
  let out = "";
  let used = 0;
  let i = 0;
  const limit = w - 1;
  while (i < s.length) {
    if (s[i] === "\x1b") {
      const m = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(s.slice(i));
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    const cp = s.codePointAt(i) ?? 0;
    const ch = String.fromCodePoint(cp);
    const cw = charWidth(cp);
    if (used + cw > limit) break;
    out += ch;
    used += cw;
    i += ch.length;
  }
  return out + (NO_COLOR ? "" : "\x1b[0m") + "…" + " ".repeat(Math.max(0, limit - used));
}

export function levelColor(level: string): string {
  switch (level) {
    case "critical":
      return C.red;
    case "high":
      return C.yellow;
    case "low":
      return C.green;
    default:
      return C.sub;
  }
}
