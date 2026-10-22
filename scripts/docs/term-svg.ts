/**
 * Terminal frames (ANSI truecolor text) as SVG, drawn the way GPU terminals
 * draw them: block elements, braille and box drawing become shapes on the cell
 * grid, so charts stay crisp and aligned whatever font the viewer has. Text
 * runs are stretched to their exact cell width for the same reason.
 */
import { C, charWidth } from "../../src/ui/style.ts";

export interface Cell {
  ch: string;
  fg: string;
  bg: string | null;
  bold: boolean;
  dim: boolean;
  /** Second half of a wide character. */
  cont?: boolean;
}
export type Grid = Cell[][];

export const CELL_W = 9;
export const CELL_H = 19;
const FONT_SIZE = 15;
const BASELINE = 14;
const DIM = 0.6;
const FONT = "'JetBrains Mono','SF Mono',Menlo,Consolas,'DejaVu Sans Mono','Liberation Mono',monospace";

export const blank = (bg: string | null = null): Cell => ({ ch: " ", fg: C.text, bg, bold: false, dim: false });

/** Parse one line of SGR-styled text into exactly `cols` cells. */
export function parseLine(line: string, cols: number, bg0: string | null = null): Cell[] {
  const cells: Cell[] = [];
  let fg = C.text;
  let bg = bg0;
  let bold = false;
  let dim = false;
  let inverse = false;
  for (let i = 0; i < line.length; ) {
    if (line[i] === "\x1b") {
      const rest = line.slice(i);
      const sgr = /^\x1b\[([0-9;]*)m/.exec(rest);
      if (sgr) {
        const ps = sgr[1] === "" ? [0] : sgr[1].split(";").map(Number);
        for (let k = 0; k < ps.length; k++) {
          const p = ps[k];
          if (p === 0) [fg, bg, bold, dim, inverse] = [C.text, bg0, false, false, false];
          else if (p === 1) bold = true;
          else if (p === 2) dim = true;
          else if (p === 22) [bold, dim] = [false, false];
          else if (p === 7) inverse = true;
          else if (p === 27) inverse = false;
          else if (p === 39) fg = C.text;
          else if (p === 49) bg = bg0;
          else if ((p === 38 || p === 48) && ps[k + 1] === 2) {
            const hex = "#" + ps.slice(k + 2, k + 5).map((v) => v.toString(16).padStart(2, "0")).join("");
            if (p === 38) fg = hex;
            else bg = hex;
            k += 4;
          }
        }
        i += sgr[0].length;
        continue;
      }
      const other = /^\x1b(?:\[[0-9;?]*[A-Za-z]|_G[^\x1b]*\x1b\\|.)/.exec(rest);
      i += other ? other[0].length : 1;
      continue;
    }
    const cp = line.codePointAt(i) ?? 32;
    const ch = String.fromCodePoint(cp);
    i += ch.length;
    const w = charWidth(cp);
    if (w === 0) continue;
    const cell: Cell = inverse ? { ch, fg: bg ?? C.base, bg: fg, bold, dim } : { ch, fg, bg, bold, dim };
    cells.push(cell);
    if (w === 2) cells.push({ ...blank(cell.bg), cont: true });
  }
  while (cells.length < cols) cells.push(blank(bg0));
  return cells.slice(0, cols);
}

export function grid(lines: string[], cols: number, bg0: string | null = null): Grid {
  return lines.map((l) => parseLine(l, cols, bg0));
}

export function blankGrid(cols: number, rows: number, bg: string | null): Grid {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => blank(bg)));
}

/** Copy `src` onto `dst` at (row, col). */
export function blit(dst: Grid, src: Grid, row: number, col: number): void {
  src.forEach((line, r) =>
    line.forEach((cell, c) => {
      if (dst[row + r]?.[col + c]) dst[row + r][col + c] = cell;
    }),
  );
}

const n = (v: number) => String(Math.round(v * 100) / 100);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Braille dot bits by [row][column]. */
const BRAILLE = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
];

/** Block elements that fill a cell's whole width, so a run of them can be drawn as one rect. */
const MERGEABLE = new Set([..."█▀▔▁▂▃▄▅▆▇░▒▓"]);

/** Box-drawing glyphs as [left, right, up, down] arm weights (1 light, 2 heavy). */
const BOX: Record<number, [number, number, number, number]> = {
  0x2500: [1, 1, 0, 0], 0x2501: [2, 2, 0, 0], 0x2502: [0, 0, 1, 1], 0x2503: [0, 0, 2, 2],
  0x250c: [0, 1, 0, 1], 0x2510: [1, 0, 0, 1], 0x2514: [0, 1, 1, 0], 0x2518: [1, 0, 1, 0],
  0x251c: [0, 1, 1, 1], 0x2524: [1, 0, 1, 1], 0x252c: [1, 1, 0, 1], 0x2534: [1, 1, 1, 0], 0x253c: [1, 1, 1, 1],
};
/** Dashed lines: [horizontal?, dashes per cell, heavy?]. */
const DASH: Record<number, [boolean, number, boolean]> = {
  0x2504: [true, 3, false], 0x2505: [true, 3, true], 0x2506: [false, 3, false], 0x2507: [false, 3, true],
  0x2508: [true, 4, false], 0x2509: [true, 4, true], 0x250a: [false, 4, false], 0x250b: [false, 4, true],
  0x254c: [true, 2, false], 0x254d: [true, 2, true], 0x254e: [false, 2, false], 0x254f: [false, 2, true],
};

/** The cell as vector shapes, or null when it is ordinary text. */
function shape(cell: Cell, x: number, y: number, span = 1): string | null {
  const cp = cell.ch.codePointAt(0) ?? 32;
  const W = CELL_W;
  const H = CELL_H;
  const paint = `fill="${cell.fg}"${cell.dim ? ` fill-opacity="${DIM}"` : ""}`;
  const rect = (rx: number, ry: number, rw: number, rh: number, opacity = 1) =>
    `<rect x="${n(x + rx)}" y="${n(y + ry)}" width="${n(rw)}" height="${n(rh)}" ${paint}${opacity < 1 ? ` opacity="${opacity}"` : ""} shape-rendering="crispEdges"/>`;
  // Block elements. A run of identical full-width ones is a single rect `span` cells wide, so bars have no seams.
  const RW = W * span;
  if (cp === 0x2588) return rect(0, 0, RW, H);
  if (cp >= 0x2581 && cp <= 0x2587) return rect(0, H - (H * (cp - 0x2580)) / 8, RW, (H * (cp - 0x2580)) / 8);
  if (cp === 0x2580) return rect(0, 0, RW, H / 2);
  if (cp === 0x2594) return rect(0, 0, RW, H / 8);
  if (cp >= 0x2589 && cp <= 0x258f) return rect(0, 0, (W * (0x2590 - cp)) / 8, H);
  if (cp === 0x2590) return rect(W / 2, 0, W / 2, H);
  if (cp === 0x2595) return rect((W * 7) / 8, 0, W / 8, H);
  if (cp >= 0x2591 && cp <= 0x2593) return rect(0, 0, RW, H, [0.22, 0.45, 0.7][cp - 0x2591]);
  // Braille: square dots on a 2 × 4 grid, about as heavy as terminals draw them.
  if (cp >= 0x2801 && cp <= 0x28ff) {
    const bits = cp - 0x2800;
    const d = 3;
    let path = "";
    BRAILLE.forEach((row, r) =>
      row.forEach((bit, c) => {
        if (bits & bit) path += `M${n(x + W * (c ? 0.7 : 0.3) - d / 2)} ${n(y + H * (0.14 + r * 0.24) - d / 2)}h${d}v${d}h-${d}z`;
      }),
    );
    return `<path d="${path}" ${paint}/>`;
  }
  // Box drawing.
  const stroke = (heavy: boolean) => `stroke="${cell.fg}" stroke-width="${heavy ? 2.4 : 1.2}"${cell.dim ? ` stroke-opacity="${DIM}"` : ""} fill="none"`;
  const box = BOX[cp];
  if (box) {
    const [l, r, u, dn] = box;
    const cx = x + W / 2;
    const cy = y + H / 2;
    const arms: string[] = [];
    if (l) arms.push(`<path d="M${n(x)} ${n(cy)}H${n(cx + (r ? 0 : 0.6))}" ${stroke(l === 2)}/>`);
    if (r) arms.push(`<path d="M${n(cx - (l ? 0 : 0.6))} ${n(cy)}H${n(x + W)}" ${stroke(r === 2)}/>`);
    if (u) arms.push(`<path d="M${n(cx)} ${n(y)}V${n(cy + (dn ? 0 : 0.6))}" ${stroke(u === 2)}/>`);
    if (dn) arms.push(`<path d="M${n(cx)} ${n(cy - (u ? 0 : 0.6))}V${n(y + H)}" ${stroke(dn === 2)}/>`);
    return arms.join("");
  }
  const dash = DASH[cp];
  if (dash) {
    const [horizontal, count, heavy] = dash;
    const len = horizontal ? W : H;
    const seg = len / count;
    let d = "";
    for (let k = 0; k < count; k++) {
      d += horizontal ? `M${n(x + k * seg + seg * 0.15)} ${n(y + H / 2)}h${n(seg * 0.7)}` : `M${n(x + W / 2)} ${n(y + k * seg + seg * 0.15)}v${n(seg * 0.7)}`;
    }
    return `<path d="${d}" ${stroke(heavy)}/>`;
  }
  // Geometric shapes used as level and state glyphs.
  const cx = x + W / 2;
  const cy = y + H * 0.54;
  if (cp === 0x25a0) return rect(W * 0.12, H * 0.54 - W * 0.38, W * 0.76, W * 0.76);
  if (cp === 0x25cf) return `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(W * 0.34)}" ${paint}/>`;
  if (cp === 0x25cb) return `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(W * 0.3)}" ${stroke(false)}/>`;
  if (cp === 0x25b2) return `<path d="M${n(cx)} ${n(cy - W * 0.4)}L${n(x + W * 0.06)} ${n(cy + W * 0.36)}H${n(x + W * 0.94)}z" ${paint}/>`;
  if (cp === 0x25bd) return `<path d="M${n(x + W * 0.12)} ${n(cy - W * 0.3)}H${n(x + W * 0.88)}L${n(cx)} ${n(cy + W * 0.38)}z" ${stroke(false)}/>`;
  if (cp === 0x25b8) return `<path d="M${n(x + W * 0.28)} ${n(cy - W * 0.28)}L${n(x + W * 0.74)} ${n(cy)}L${n(x + W * 0.28)} ${n(cy + W * 0.28)}z" ${paint}/>`;
  if (cp === 0x25c6) return `<path d="M${n(cx)} ${n(cy - W * 0.46)}L${n(x + W * 0.96)} ${n(cy)}L${n(cx)} ${n(cy + W * 0.46)}L${n(x + W * 0.04)} ${n(cy)}z" ${paint}/>`;
  return null;
}

/** Cells as SVG elements, with the grid's top-left at (x0, y0). */
export function drawGrid(g: Grid, x0: number, y0: number): string {
  const out: string[] = [];
  g.forEach((row, r) => {
    const y = y0 + r * CELL_H;
    for (let c = 0; c < row.length; ) {
      const bg = row[c].bg;
      let e = c + 1;
      while (e < row.length && row[e].bg === bg) e++;
      if (bg) out.push(`<rect x="${n(x0 + c * CELL_W)}" y="${n(y)}" width="${n((e - c) * CELL_W)}" height="${CELL_H}" fill="${bg}" shape-rendering="crispEdges"/>`);
      c = e;
    }
    for (let c = 0; c < row.length; ) {
      const cell = row[c];
      if (cell.cont || cell.ch === " ") {
        c++;
        continue;
      }
      let span = 1;
      if (MERGEABLE.has(cell.ch)) {
        while (c + span < row.length && row[c + span].ch === cell.ch && row[c + span].fg === cell.fg && row[c + span].dim === cell.dim) span++;
      }
      const s = shape(cell, x0 + c * CELL_W, y, span);
      if (s !== null) {
        out.push(s);
        c += span;
        continue;
      }
      // A run of text in one style. A single space never breaks a run, but wider
      // gaps do: browsers collapse repeated spaces, which would stretch the glyphs.
      let e = c + 1;
      while (e < row.length) {
        const next = row[e];
        if (!next.cont && next.ch === " " && row[e + 1]?.ch === " ") break;
        if (!next.cont && next.ch !== " " && (shape(next, 0, 0) !== null || next.fg !== cell.fg || next.bold !== cell.bold || next.dim !== cell.dim)) break;
        e++;
      }
      while (e > c + 1 && row[e - 1].ch === " " && !row[e - 1].cont) e--;
      const text = row
        .slice(c, e)
        .filter((x) => !x.cont)
        .map((x) => x.ch)
        .join("");
      out.push(
        `<text x="${n(x0 + c * CELL_W)}" y="${n(y + BASELINE)}" fill="${cell.fg}"${cell.bold ? ' font-weight="700"' : ""}${cell.dim ? ` fill-opacity="${DIM}"` : ""} textLength="${n((e - c) * CELL_W)}" lengthAdjust="spacingAndGlyphs">${esc(text)}</text>`,
      );
      c = e;
    }
  });
  return out.join("");
}

export interface ImageOverlay {
  /** Grid row and column (0-based) of the image's top-left cell. */
  row: number;
  col: number;
  cols: number;
  rows: number;
  href: string;
}

export interface WindowOptions {
  title: string;
  /** Background of the terminal area. */
  bg?: string;
  images?: ImageOverlay[];
  /** Window chrome (title bar with traffic lights); off for bare panels. */
  chrome?: boolean;
  padding?: number;
  /** Display size relative to the drawing (the viewBox is unchanged, so it stays sharp). */
  scale?: number;
}

/** A terminal window around a grid. */
export function windowSvg(g: Grid, o: WindowOptions): string {
  const cols = Math.max(...g.map((r) => r.length));
  const pad = o.padding ?? 14;
  const bar = o.chrome === false ? 0 : 32;
  const w = cols * CELL_W + pad * 2;
  const h = g.length * CELL_H + pad * 2 + bar;
  const bg = o.bg ?? C.base;
  const s = o.scale ?? 1;
  const chrome =
    o.chrome === false
      ? ""
      : `<rect x="0.5" y="0.5" width="${w - 1}" height="${bar}" rx="10" fill="#181825"/><rect x="0.5" y="${bar - 10}" width="${w - 1}" height="10" fill="#181825"/>` +
        ["#f38ba8", "#f9e2af", "#a6e3a1"].map((c, i) => `<circle cx="${18 + i * 20}" cy="${bar / 2}" r="6" fill="${c}"/>`).join("") +
        `<text x="${w / 2}" y="${bar / 2 + 4.5}" fill="#a6adc8" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif" font-size="13" text-anchor="middle">${esc(o.title)}</text>`;
  const images = (o.images ?? [])
    .map((im) => `<image x="${n(pad + im.col * CELL_W)}" y="${n(bar + pad + im.row * CELL_H)}" width="${n(im.cols * CELL_W)}" height="${n(im.rows * CELL_H)}" preserveAspectRatio="none" href="${im.href}"/>`)
    .join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${n(w * s)}" height="${n(h * s)}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(o.title)}">` +
    `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="10" fill="${bg}" stroke="#45475a"/>` +
    chrome +
    `<g font-family="${FONT}" font-size="${FONT_SIZE}" xml:space="preserve" style="white-space:pre">${drawGrid(g, pad, bar + pad)}</g>` +
    images +
    `</svg>\n`
  );
}
