/** Terminal chart primitives for the dashboard (truecolor, zero dependencies). */
import { C, bg, bold, charWidth, colorRuns, fg, width } from "./style.ts";

// Braille cells are 2 dots wide and 4 dots tall: 8× the resolution of plain characters.
const BRAILLE_BITS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
];

export class Braille {
  readonly cols: number;
  readonly rows: number;
  private readonly bits: Uint8Array;
  private readonly colors: Array<string | null>;

  constructor(cols: number, rows: number) {
    this.cols = Math.max(1, cols);
    this.rows = Math.max(1, rows);
    this.bits = new Uint8Array(this.cols * this.rows);
    this.colors = new Array(this.cols * this.rows).fill(null);
  }

  get pw(): number {
    return this.cols * 2;
  }

  get ph(): number {
    return this.rows * 4;
  }

  dot(x: number, y: number, color: string): void {
    const px = Math.round(x);
    const py = Math.round(y);
    if (px < 0 || py < 0 || px >= this.pw || py >= this.ph) return;
    const idx = (py >> 2) * this.cols + (px >> 1);
    this.bits[idx] |= BRAILLE_BITS[py & 3][px & 1];
    this.colors[idx] = color;
  }

  line(x0: number, y0: number, x1: number, y1: number, color: string, dash = 0): void {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let i = 0; i <= steps; i++) {
      if (dash > 0 && i % (dash * 2) >= dash) continue;
      const t = i / steps;
      this.dot(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, color);
    }
  }

  /**
   * Fill below a line point, starting at the next cell row so the line's own
   * cells stay crisp. Alternate dot rows keep the area subtle.
   */
  fillDown(x: number, y: number, color: string): void {
    const start = (Math.floor(Math.round(y) / 4) + 1) * 4;
    for (let py = start; py < this.ph; py += 2) this.dot(x, py, color);
  }

  lines(): string[] {
    const out: string[] = [];
    for (let r = 0; r < this.rows; r++) {
      const cells: Array<[string | null, string]> = [];
      for (let c = 0; c < this.cols; c++) {
        const idx = r * this.cols + c;
        const b = this.bits[idx];
        cells.push(b ? [this.colors[idx] ?? C.text, String.fromCharCode(0x2800 + b)] : [null, " "]);
      }
      out.push(colorRuns(cells));
    }
    return out;
  }
}

export interface Series {
  /** [x, y] points in data units; x in 0 … xMax. */
  points: Array<[number, number]>;
  color: string;
  dash?: number;
  fill?: string;
}

export interface LineChartOptions {
  width: number;
  height: number;
  xMax: number;
  yMax: number;
  yFormat: (v: number) => string;
  xLabels?: Array<[number, string]>;
  /** Horizontal reference lines (budget, limit, thresholds). */
  refs?: Array<{ y: number; color: string; dash?: number }>;
  markers?: Array<{ x: number; y: number; color: string }>;
  /** Event marks on their own row under the plot (e.g. alerts); the highest rank wins a column. */
  strip?: { label: string; marks: Array<{ x: number; glyph: string; color: string; rank: number }> };
}

/** Braille line/area chart with y-axis labels and x tick labels. */
export function lineChart(series: Series[], o: LineChartOptions): string[] {
  const yLabels = [o.yMax, o.yMax / 2, 0].map(o.yFormat);
  const labelW = Math.max(...yLabels.map((l) => width(l)), o.strip ? width(o.strip.label) : 0) + 1;
  const plotW = Math.max(8, o.width - labelW - 1);
  const canvas = new Braille(plotW, Math.max(2, o.height));
  const px = (x: number) => (o.xMax <= 0 ? 0 : (Math.min(o.xMax, Math.max(0, x)) / o.xMax) * (canvas.pw - 1));
  const py = (v: number) => (1 - Math.min(1, Math.max(0, v / (o.yMax || 1)))) * (canvas.ph - 1);
  for (const ref of o.refs ?? []) canvas.line(0, py(ref.y), canvas.pw - 1, py(ref.y), ref.color, ref.dash ?? 0);
  for (const s of series) {
    let prev: [number, number] | null = null;
    for (const [x, y] of s.points) {
      const p: [number, number] = [px(x), py(y)];
      if (s.fill) {
        const from = prev ? Math.round(prev[0]) : Math.round(p[0]);
        for (let cx = from; cx <= Math.round(p[0]); cx++) {
          const t = prev && p[0] !== prev[0] ? (cx - prev[0]) / (p[0] - prev[0]) : 1;
          canvas.fillDown(cx, prev ? prev[1] + (p[1] - prev[1]) * t : p[1], s.fill);
        }
      }
      if (prev) canvas.line(prev[0], prev[1], p[0], p[1], s.color, s.dash ?? 0);
      else canvas.dot(p[0], p[1], s.color);
      prev = p;
    }
  }
  for (const m of o.markers ?? []) {
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1], [-1, 0], [0, -1]]) canvas.dot(px(m.x) + dx, py(m.y) + dy, m.color);
  }
  const rows = canvas.lines();
  const out: string[] = [];
  rows.forEach((row, r) => {
    let label = "";
    if (r === 0) label = yLabels[0];
    else if (r === Math.floor((rows.length - 1) / 2)) label = yLabels[1];
    else if (r === rows.length - 1) label = yLabels[2];
    out.push(fg(C.dim, label.padStart(labelW - 1) + " ┤") + row);
  });
  if (o.strip) {
    const cells = new Array<{ glyph: string; color: string; rank: number } | null>(plotW).fill(null);
    for (const m of o.strip.marks) {
      const col = Math.min(plotW - 1, Math.max(0, Math.floor(px(m.x) / 2)));
      const have = cells[col];
      if (!have || m.rank > have.rank) cells[col] = m;
    }
    out.push(fg(C.dim, o.strip.label.padStart(labelW - 1) + " ┤") + cells.map((c) => (c ? fg(c.color, c.glyph) : " ")).join(""));
  }
  if (o.xLabels?.length) {
    const axis = new Array<string>(plotW).fill(" ");
    for (const [i, text] of o.xLabels) {
      const col = Math.round(px(i) / 2);
      const start = Math.max(0, Math.min(plotW - text.length, col - Math.floor(text.length / 2)));
      if (axis.slice(start, start + text.length).some((c) => c !== " ")) continue;
      for (let k = 0; k < text.length; k++) axis[start + k] = text[k];
    }
    out.push(" ".repeat(labelW + 1) + fg(C.dim, axis.join("")));
  }
  return out;
}

/** Dark → bright scale for heatmaps (catppuccin-ish mauve). */
export const HEAT = ["#313244", "#45396a", "#6a4f96", "#9a73c9", "#cba6f7"];

export function heatLevel(v: number, thresholds: number[]): number {
  if (v <= 0) return 0;
  for (let i = 0; i < thresholds.length; i++) if (v <= thresholds[i]) return i + 1;
  return HEAT.length - 1;
}

/** Quantile thresholds over the non-zero values (4 buckets). */
export function heatThresholds(values: number[]): number[] {
  const nz = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (nz.length === 0) return [Infinity, Infinity, Infinity];
  const q = (p: number) => nz[Math.min(nz.length - 1, Math.floor(p * nz.length))];
  return [q(0.25), q(0.5), q(0.75)];
}

export function heatLegend(): string {
  return fg(C.dim, "less ") + HEAT.map((c) => fg(c, "■")).join(" ") + fg(C.dim, " more");
}

export interface Column {
  label: string;
  parts: Array<{ v: number; color: string }>;
}

/** Stacked vertical columns (e.g. daily spend split by harness). */
export function stackedColumns(cols: Column[], height: number, colWidth = 2, yFormat: (v: number) => string = String): string[] {
  const totals = cols.map((c) => c.parts.reduce((s, p) => s + p.v, 0));
  const max = Math.max(0, ...totals);
  const labelW = Math.max(width(yFormat(max)), width(yFormat(0))) + 1;
  const out: string[] = [];
  for (let r = 0; r < height; r++) {
    const mid = ((height - r - 0.5) / height) * max;
    const cells: Array<[string | null, string]> = [];
    cols.forEach((c, i) => {
      let color: string | null = null;
      if (max > 0 && totals[i] >= mid) {
        let acc = 0;
        for (const p of c.parts) {
          acc += p.v;
          if (acc >= mid) {
            color = p.color;
            break;
          }
        }
      }
      cells.push(color ? [color, "█".repeat(colWidth)] : r === height - 1 ? [C.surface, "▁".repeat(colWidth)] : [null, " ".repeat(colWidth)], [null, " "]);
    });
    const label = r === 0 ? yFormat(max) : r === height - 1 ? yFormat(0) : "";
    out.push(fg(C.dim, label.padStart(labelW - 1) + " ┤") + colorRuns(cells));
  }
  let labels = "";
  cols.forEach((c) => {
    labels += c.label.slice(0, colWidth).padEnd(colWidth) + " ";
  });
  out.push(" ".repeat(labelW + 1) + fg(C.dim, labels));
  return out;
}

/** 100% stacked horizontal bar using largest-remainder rounding. */
export function hstack(parts: Array<{ v: number; color: string }>, w: number): string {
  const total = parts.reduce((s, p) => s + Math.max(0, p.v), 0);
  if (total <= 0) return fg(C.surface, "░".repeat(w));
  const exact = parts.map((p) => (Math.max(0, p.v) / total) * w);
  const cells = exact.map(Math.floor);
  let left = w - cells.reduce((s, c) => s + c, 0);
  const order = exact.map((e, i) => [e - Math.floor(e), i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    if (left <= 0) break;
    cells[i]++;
    left--;
  }
  return parts.map((p, i) => fg(p.color, "█".repeat(cells[i]))).join("");
}

export interface BoxStats {
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
}

/** One-line box plot: whiskers p10–p90, box p25–p75, median marker. */
export function boxplot(s: BoxStats, scaleMax: number, w: number, color: string): string {
  const pos = (v: number) => Math.max(0, Math.min(w - 1, Math.round((v / (scaleMax || 1)) * (w - 1))));
  const a = pos(s.p10);
  const b = pos(s.p25);
  const m = pos(s.p50);
  const d = pos(s.p75);
  const e = pos(s.p90);
  let out = "";
  for (let i = 0; i < w; i++) {
    if (i === m) out += fg(C.text, "┃");
    else if (i >= b && i <= d) out += fg(color, "█");
    else if (i === a) out += fg(C.dim, "├");
    else if (i === e) out += fg(C.dim, "┤");
    else if (i > a && i < e) out += fg(C.dim, "─");
    else out += " ";
  }
  return out;
}

const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

/** Left-aligned horizontal bar with eighth-block precision, padded to `w`. */
export function bar(value: number, max: number, w: number, color: string): string {
  const exact = max > 0 ? Math.max(0, Math.min(w, (value / max) * w)) : 0;
  let full = Math.floor(exact);
  let part = Math.round((exact - full) * 8);
  if (part === 8) {
    full++;
    part = 0;
  }
  const s = "█".repeat(full) + (full < w ? EIGHTHS[part] : "");
  return fg(color, s) + " ".repeat(Math.max(0, w - width(s)));
}

function hex2(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Blend two hex colours: t = 0 gives `a`, t = 1 gives `b`. */
export function mix(a: string, b: string, t: number): string {
  const x = hex2(a);
  const y = hex2(b);
  return "#" + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, "0")).join("");
}

function luminance(hex: string): number {
  const [r, g, b] = hex2(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function worst(sum: number, max: number, min: number, side: number): number {
  const s2 = side * side;
  const sum2 = sum * sum;
  return Math.max((s2 * max) / sum2, sum2 / (s2 * min));
}

/**
 * Squarified treemap layout (Bruls, Huizing & van Wijk). `values` must be
 * positive and sorted descending; rects come back in the same order and tile
 * `r` exactly.
 */
export function squarify(values: number[], r: Rect): Rect[] {
  const total = values.reduce((s, v) => s + v, 0);
  if (total <= 0 || r.w <= 0 || r.h <= 0) return values.map(() => ({ x: r.x, y: r.y, w: 0, h: 0 }));
  const areas = values.map((v) => (v / total) * r.w * r.h);
  const out: Rect[] = [];
  let rect = { ...r };
  let i = 0;
  while (i < areas.length) {
    const side = Math.min(rect.w, rect.h);
    let sum = areas[i];
    let max = areas[i];
    let min = areas[i];
    let j = i + 1;
    while (j < areas.length) {
      const a = areas[j];
      if (worst(sum + a, Math.max(max, a), Math.min(min, a), side) > worst(sum, max, min, side)) break;
      sum += a;
      max = Math.max(max, a);
      min = Math.min(min, a);
      j++;
    }
    const last = j >= areas.length;
    if (rect.w >= rect.h) {
      const colW = last ? rect.w : sum / rect.h;
      let y = rect.y;
      for (let k = i; k < j; k++) {
        const hk = k === j - 1 ? rect.y + rect.h - y : areas[k] / colW;
        out.push({ x: rect.x, y, w: colW, h: hk });
        y += hk;
      }
      rect = { x: rect.x + colW, y: rect.y, w: rect.w - colW, h: rect.h };
    } else {
      const rowH = last ? rect.h : sum / rect.w;
      let x = rect.x;
      for (let k = i; k < j; k++) {
        const wk = k === j - 1 ? rect.x + rect.w - x : areas[k] / rowH;
        out.push({ x, y: rect.y, w: wk, h: rowH });
        x += wk;
      }
      rect = { x: rect.x, y: rect.y + rowH, w: rect.w, h: rect.h - rowH };
    }
    i = j;
  }
  return out;
}

export interface TreeLeaf {
  label: string;
  /** Parts joined by " · "; trailing parts are dropped to fit, never cut mid-figure. */
  detail: string;
  v: number;
}

export interface TreeGroup {
  label: string;
  /** Shown after the label when there is room (e.g. the project's total). */
  value?: string;
  v: number;
  color: string;
  children: TreeLeaf[];
}

interface Cell {
  ch: string;
  fg: string;
  bg: string | null;
  bold: boolean;
}

/** Cells are about twice as tall as wide; lay out in square units, then snap edges to cells. */
function toCells(r: Rect): { x0: number; x1: number; y0: number; y1: number } {
  return { x0: Math.round(r.x), x1: Math.round(r.x + r.w), y0: Math.round(r.y / 2), y1: Math.round((r.y + r.h) / 2) };
}

/**
 * Two-level treemap (groups → leaves) drawn with background colours. Each
 * group gets a hue and a header row; leaves alternate shades, with a gap
 * column on their right edge.
 */
export function treemap(groups: TreeGroup[], w: number, h: number): string[] {
  const grid: Cell[][] = Array.from({ length: h }, () => Array.from({ length: w }, () => ({ ch: " ", fg: C.text, bg: null, bold: false })));
  const paint = (x0: number, x1: number, y0: number, y1: number, color: string | null) => {
    for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) grid[y][x] = { ch: " ", fg: C.text, bg: color, bold: false };
  };
  /**
   * Write the first candidate that fits. With `cut`, the last one may be
   * shortened with an ellipsis while at least 4 characters stay readable;
   * smaller fragments ("p…", "$7…") would only mislead.
   */
  const write = (x: number, y: number, maxW: number, candidates: string[], color: string, opts: { bold?: boolean; cut?: boolean } = {}) => {
    if (y < 0 || y >= h || maxW <= 0 || candidates.length === 0) return;
    const cells = (s: string) => [...s].filter((ch) => charWidth(ch.codePointAt(0) ?? 32) === 1);
    let shown = candidates.map(cells).find((c) => c.length <= maxW);
    if (!shown) {
      if (!opts.cut || maxW < 5) return;
      const head = cells(candidates[candidates.length - 1]).slice(0, maxW - 1);
      while (head.length && /[\s·,]/.test(head[head.length - 1])) head.pop();
      if (head.length < 4) return;
      shown = [...head, "…"];
    }
    shown.forEach((ch, k) => {
      const cell = grid[y][x + k];
      if (cell) grid[y][x + k] = { ...cell, ch, fg: color, bold: opts.bold ?? false };
    });
  };
  /** "a · b · c", "a · b", "a": the detail with trailing parts dropped. */
  const shorter = (detail: string) => detail.split(" · ").map((_, i, parts) => parts.slice(0, parts.length - i).join(" · "));
  const ink = (back: string) => (luminance(back) > 0.45 ? "#11111b" : C.text);
  const shown = groups.filter((g) => g.v > 0).sort((a, b) => b.v - a.v);
  squarify(shown.map((g) => g.v), { x: 0, y: 0, w, h: h * 2 }).forEach((gr, gi) => {
    const g = shown[gi];
    const { x0, x1, y0, y1 } = toCells(gr);
    if (x1 - x0 < 2 || y1 - y0 < 1) return;
    const leaves = g.children.filter((l) => l.v > 0).sort((a, b) => b.v - a.v);
    const header = y1 - y0 >= 3 && x1 - x0 >= 8 && leaves.length > 0;
    paint(x0, x1 - 1, y0, y0 + 1, g.color);
    write(x0 + 1, y0, x1 - x0 - 2, g.value ? [`${g.label} ${g.value}`, g.label] : [g.label], ink(g.color), { bold: true, cut: true });
    if (!header) {
      paint(x0, x1 - 1, y0 + 1, y1, mix(g.color, C.base, 0.35));
      return;
    }
    squarify(leaves.map((l) => l.v), { x: x0, y: (y0 + 1) * 2, w: x1 - x0, h: (y1 - y0 - 1) * 2 }).forEach((lr, li) => {
      const leaf = leaves[li];
      const c = toCells(lr);
      if (c.x1 - c.x0 < 1 || c.y1 - c.y0 < 1) return;
      const shade = mix(g.color, C.base, [0.3, 0.5, 0.4, 0.6][li % 4]);
      paint(c.x0, c.x1 - 1, c.y0, c.y1, shade);
      write(c.x0 + 1, c.y0, c.x1 - c.x0 - 2, [leaf.label], ink(shade), { cut: true });
      if (c.y1 - c.y0 >= 2) write(c.x0 + 1, c.y0 + 1, c.x1 - c.x0 - 2, shorter(leaf.detail), ink(shade));
    });
  });
  return grid.map((row) => {
    let line = "";
    let run = "";
    let style: Cell | null = null;
    const flush = () => {
      if (!style || !run) return;
      const text = style.bold ? bold(fg(style.fg, run)) : fg(style.fg, run);
      line += style.bg ? bg(style.bg, text) : text;
      run = "";
    };
    for (const cell of row) {
      if (!style || cell.fg !== style.fg || cell.bg !== style.bg || cell.bold !== style.bold) {
        flush();
        style = cell;
      }
      run += cell.ch;
    }
    flush();
    return line;
  });
}
