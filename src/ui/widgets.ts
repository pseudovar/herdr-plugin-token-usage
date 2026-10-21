import { fmtClock } from "../util/format.ts";
import { C, bold, colorRuns, dim, fg, fit, width } from "./style.ts";

const SPARK = "▁▂▃▄▅▆▇█";

/** Zero-anchored sparkline (height means magnitude, not rank). */
export function sparkline(values: number[], color = C.blue): string {
  const max = Math.max(0, ...values);
  if (max <= 0) return fg(C.faint, "▁".repeat(values.length));
  return colorRuns(
    values.map((v): [string, string] => {
      if (v <= 0) return [C.faint, "▁"];
      const idx = Math.min(SPARK.length - 1, Math.max(0, Math.ceil((v / max) * SPARK.length) - 1));
      return [color, SPARK[idx]];
    }),
  );
}

/** On-the-hour clock labels for a sparkline whose `cells` each cover `bucketMs` from `start`. */
export function timeAxis(start: number, bucketMs: number, cells: number): string {
  const axis = new Array<string>(cells).fill(" ");
  const t = new Date(start);
  t.setMinutes(0, 0, 0);
  if (t.getTime() < start) t.setHours(t.getHours() + 1);
  for (; t.getTime() < start + bucketMs * cells; t.setHours(t.getHours() + 1)) {
    const text = fmtClock(t.getTime());
    const at = Math.floor((t.getTime() - start) / bucketMs) - Math.floor(text.length / 2);
    // Whole labels only, with a space between neighbours (busy axes skip hours).
    if (at < 0 || at + text.length > cells || axis.slice(Math.max(0, at - 1), at + text.length + 1).some((c) => c !== " ")) continue;
    for (let k = 0; k < text.length; k++) axis[at + k] = text[k];
  }
  return axis.join("").trimEnd();
}

/** Horizontal gauge with an optional marker (e.g. elapsed share of the month). */
export function gauge(pct: number, w: number, opts: { color?: string; marker?: number | null } = {}): string {
  const inner = Math.max(4, w - 2);
  const filled = Math.max(0, Math.min(inner, Math.round((pct / 100) * inner)));
  const markerAt = opts.marker != null ? Math.max(0, Math.min(inner - 1, Math.round((opts.marker / 100) * inner))) : -1;
  let bar = "";
  for (let i = 0; i < inner; i++) {
    if (i === markerAt) bar += fg(i < filled ? C.text : C.sub, "┃");
    else if (i < filled) bar += fg(opts.color ?? C.blue, "█");
    else bar += fg(C.surface, "░");
  }
  return fg(C.faint, "▕") + bar + fg(C.faint, "▏");
}

/** Proportional share bar (no frame), e.g. a harness's share of spend. */
export function shareBar(fraction: number, w: number, color = C.mauve): string {
  const n = Math.max(0, Math.min(w, Math.round(fraction * w)));
  return fg(color, "█".repeat(n)) + fg(C.surface, "·".repeat(w - n));
}

export function sectionTitle(title: string, w: number, right = ""): string {
  const left = fg(C.dim, "─ ") + bold(fg(C.lavender, title)) + " ";
  const r = right ? " " + right + " " : "";
  const fill = Math.max(0, w - width(left) - width(r) - 1);
  return left + fg(C.faint, "─".repeat(fill)) + r + fg(C.faint, "─");
}

export interface Column {
  title: string;
  width: number;
  align?: "left" | "right";
  /** Flexible columns share any remaining width. */
  flex?: boolean;
  min?: number;
  /** Flexible columns stop here; on wide panes the table ends early instead of spreading out. */
  max?: number;
  /** A fixed column that widens up to this when there is room, before flexible columns take the rest. */
  grow?: number;
}

/** Resolve flexible column widths to fill `total` columns (1-space gutters). */
export function layoutColumns(cols: Column[], total: number): Column[] {
  const gutters = cols.length - 1;
  const out = cols.map((c) => ({ ...c }));
  // Spare room first lets truncated names (spaces, projects, rules) show in full.
  let spare = total - out.reduce((s, c) => s + c.width, 0) - gutters;
  for (const c of out) {
    if (spare <= 0) break;
    if (!c.flex && c.grow && c.grow > c.width) {
      const add = Math.min(spare, c.grow - c.width);
      c.width += add;
      spare -= add;
    }
  }
  const fixed = out.filter((c) => !c.flex).reduce((s, c) => s + c.width, 0);
  const flex = out.filter((c) => c.flex);
  if (flex.length) {
    const each = Math.floor((total - fixed - gutters) / flex.length);
    for (const c of flex) c.width = Math.min(c.max ?? Infinity, Math.max(c.min ?? 4, each));
  }
  // Drop rightmost non-flex columns if we still overflow.
  let sum = out.reduce((s, c) => s + c.width, 0) + gutters;
  while (sum > total && out.length > 2) {
    const idx = out.map((c, i) => [c, i] as const).filter(([c]) => !c.flex).pop()?.[1];
    if (idx == null) break;
    out.splice(idx, 1);
    sum = out.reduce((s, c) => s + c.width, 0) + (out.length - 1);
  }
  return out;
}

export function tableHeader(cols: Column[]): string {
  return cols.map((c) => fg(C.dim, fit(c.title, c.width, c.align))).join(" ");
}

export function tableRow(cols: Column[], cells: Record<string, string>): string {
  return cols.map((c) => fit(cells[c.title] ?? "", c.width, c.align)).join(" ");
}

export function keyHint(key: string, label: string): string {
  return fg(C.blue, key) + " " + dim(fg(C.sub, label));
}
