/** Tiny RGBA rasteriser and PNG encoder for Kitty-graphics charts (zero dependencies). */
import { deflateSync } from "node:zlib";
import type { Burnup } from "./chartsdata.ts";
import { C } from "./style.ts";

export type RGB = [number, number, number];

export function hexRgb(hex: string): RGB {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** 8-bit RGBA, no interlace, filter 0 on every scanline. */
export function encodePng(w: number, h: number, rgba: Uint8Array): Buffer {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([PNG_SIGNATURE, pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}

/** Straight-alpha canvas with anti-aliased strokes; transparent so the terminal background shows through. */
export class Raster {
  readonly w: number;
  readonly h: number;
  private readonly rgb: Float32Array;
  private readonly alpha: Float32Array;
  private readonly cov: Float32Array;

  constructor(w: number, h: number) {
    this.w = Math.max(1, Math.round(w));
    this.h = Math.max(1, Math.round(h));
    this.rgb = new Float32Array(this.w * this.h * 3);
    this.alpha = new Float32Array(this.w * this.h);
    this.cov = new Float32Array(this.w * this.h);
  }

  /** Source-over blend of one pixel. */
  blend(x: number, y: number, c: RGB, a: number): void {
    if (a <= 0 || x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = y * this.w + x;
    const da = this.alpha[i];
    const oa = a + da * (1 - a);
    for (let k = 0; k < 3; k++) this.rgb[i * 3 + k] = (c[k] * a + this.rgb[i * 3 + k] * da * (1 - a)) / oa;
    this.alpha[i] = oa;
  }

  /**
   * Anti-aliased polyline. Coverage merges with max() before blending, so
   * joints between segments don't double up. `dash` is [on, off] in pixels.
   */
  polyline(points: Array<[number, number]>, c: RGB, width: number, a = 1, dash: [number, number] | null = null): void {
    if (points.length < 2) return;
    const hw = width / 2;
    let along = 0;
    let bx0 = this.w;
    let bx1 = -1;
    let by0 = this.h;
    let by1 = -1;
    for (let s = 0; s < points.length - 1; s++) {
      const [ax, ay] = points[s];
      const [qx, qy] = points[s + 1];
      const dx = qx - ax;
      const dy = qy - ay;
      const len2 = dx * dx + dy * dy;
      const len = Math.sqrt(len2);
      const x0 = Math.max(0, Math.floor(Math.min(ax, qx) - hw - 1));
      const x1 = Math.min(this.w - 1, Math.ceil(Math.max(ax, qx) + hw + 1));
      const y0 = Math.max(0, Math.floor(Math.min(ay, qy) - hw - 1));
      const y1 = Math.min(this.h - 1, Math.ceil(Math.max(ay, qy) + hw + 1));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const px = x + 0.5;
          const py = y + 0.5;
          const t = len2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
          const cv = Math.min(1, hw + 0.5 - Math.hypot(px - (ax + t * dx), py - (ay + t * dy)));
          if (cv <= 0) continue;
          if (dash && (along + t * len) % (dash[0] + dash[1]) > dash[0]) continue;
          const i = y * this.w + x;
          if (cv > this.cov[i]) this.cov[i] = cv;
        }
      }
      along += len;
      bx0 = Math.min(bx0, x0);
      bx1 = Math.max(bx1, x1);
      by0 = Math.min(by0, y0);
      by1 = Math.max(by1, y1);
    }
    for (let y = by0; y <= by1; y++) {
      for (let x = bx0; x <= bx1; x++) {
        const i = y * this.w + x;
        if (this.cov[i] > 0) {
          this.blend(x, y, c, this.cov[i] * a);
          this.cov[i] = 0;
        }
      }
    }
  }

  /** Vertical gradient under a polyline (points sorted by x) down to `baseY`. */
  areaUnder(points: Array<[number, number]>, baseY: number, c: RGB, top: number, bottom: number): void {
    if (points.length < 2) return;
    let seg = 0;
    for (let x = Math.max(0, Math.ceil(points[0][0])); x <= Math.min(this.w - 1, Math.floor(points[points.length - 1][0])); x++) {
      while (seg < points.length - 2 && points[seg + 1][0] < x) seg++;
      const [ax, ay] = points[seg];
      const [qx, qy] = points[seg + 1];
      const yl = qx === ax ? qy : ay + ((qy - ay) * (x - ax)) / (qx - ax);
      const span = Math.max(1, baseY - yl);
      for (let y = Math.max(0, Math.floor(yl)); y <= Math.min(this.h - 1, baseY); y++) {
        const edge = y === Math.floor(yl) ? 1 - (yl - y) : 1;
        this.blend(x, y, c, edge * (top + ((bottom - top) * (y - yl)) / span));
      }
    }
  }

  disc(cx: number, cy: number, r: number, c: RGB, a = 1): void {
    for (let y = Math.floor(cy - r - 1); y <= Math.ceil(cy + r + 1); y++) {
      for (let x = Math.floor(cx - r - 1); x <= Math.ceil(cx + r + 1); x++) {
        const cv = Math.min(1, Math.max(0, r + 0.5 - Math.hypot(x + 0.5 - cx, y + 0.5 - cy)));
        if (cv > 0) this.blend(x, y, c, cv * a);
      }
    }
  }

  toPng(): Buffer {
    const out = new Uint8Array(this.w * this.h * 4);
    for (let i = 0; i < this.w * this.h; i++) {
      out[i * 4] = Math.round(this.rgb[i * 3]);
      out[i * 4 + 1] = Math.round(this.rgb[i * 3 + 1]);
      out[i * 4 + 2] = Math.round(this.rgb[i * 3 + 2]);
      out[i * 4 + 3] = Math.round(this.alpha[i] * 255);
    }
    return encodePng(this.w, this.h, out);
  }
}

const LEVEL_RGB: Record<string, string> = { critical: C.red, high: C.yellow, low: C.green, normal: C.sub };

/**
 * The Copilot burn-up as a PNG: gradient area under the account line, smooth
 * lines, budget and pace references, alert dots along the floor. Axis labels
 * stay as terminal text around the image so they match the font.
 */
export function burnupPixels(b: Burnup, w: number, h: number, yMax: number): Buffer {
  const r = new Raster(w, h);
  const u = Math.max(1, h / 240); // stroke scale for dense (retina) cells
  const top = Math.round(3 * u);
  const floor = r.h - Math.round(3 * u);
  const X = (d: number) => 1 + (Math.min(b.days, Math.max(0, d)) / b.days) * (r.w - 3);
  const Y = (v: number) => top + (1 - Math.min(1, Math.max(0, v / yMax))) * (floor - top);
  const surface = hexRgb(C.surface);
  for (const f of [0, 0.25, 0.5, 0.75, 1]) r.polyline([[0, Y(yMax * f)], [r.w - 1, Y(yMax * f)]], surface, u, 0.9);
  for (let d = 5; d < b.days; d += 5) r.polyline([[X(d), top], [X(d), floor]], surface, u, 0.7, [3 * u, 5 * u]);
  r.polyline([[X(b.nowX), top], [X(b.nowX), floor]], hexRgb(C.text), u, 0.18);
  r.polyline([[X(0), Y(0)], [X(b.days), Y(b.allowance)]], hexRgb(C.dim), 1.5 * u, 0.8);
  r.polyline([[X(0), Y(b.allowance)], [X(b.days), Y(b.allowance)]], hexRgb(C.red), 2 * u, 0.9);
  const first = b.history[0] ?? ([b.nowX, b.used] as [number, number]);
  const actual: Array<[number, number]> = b.history.length ? [...b.history, [b.nowX, b.used]] : [];
  const account = [[0, 0] as [number, number], ...(b.history.length ? actual : [first])].map(([d, v]) => [X(d), Y(v)] as [number, number]);
  const blue = hexRgb(C.blue);
  r.areaUnder(account, floor, blue, 0.32, 0.02);
  r.polyline([[X(0), Y(0)], [X(first[0]), Y(first[1])]], blue, 2.5 * u, 1, [7 * u, 5 * u]);
  if (actual.length) r.polyline(actual.map(([d, v]) => [X(d), Y(v)]), blue, 2.5 * u);
  r.polyline(b.local.map(([d, v]) => [X(d), Y(v)]), hexRgb(C.mauve), 2 * u);
  if (b.projected != null) r.polyline([[X(b.nowX), Y(b.used)], [X(b.days), Y(b.projected)]], hexRgb(C.sky), 2 * u, 0.9, [8 * u, 6 * u]);
  for (const a of b.alerts) r.disc(X(a.x), floor - 4 * u, 2.5 * u, hexRgb(LEVEL_RGB[a.level] ?? C.sub), 0.95);
  r.disc(X(b.nowX), Y(b.used), 4.5 * u, hexRgb(C.text));
  return r.toPng();
}
