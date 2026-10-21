/**
 * Kitty graphics protocol helpers (https://sw.kovidgoyal.net/kitty/graphics-protocol/).
 * herdr parses these from pane output and renders them in Kitty-capable outer
 * terminals (Ghostty, kitty, WezTerm) when `terminal.kitty_graphics` is on.
 */
const ESC = "\x1b";
const CHUNK = 4096;
export const PROBE_ID = 31;

/**
 * Ask whether graphics work (a=q replies OK or an error), ask for the cell size
 * in pixels, then send DA1 as a sentinel: a terminal without graphics answers
 * DA1 without ever replying to the query.
 */
export function probeSequence(): string {
  return `${ESC}_Gi=${PROBE_ID},s=1,v=1,a=q,t=d,f=24;AAAA${ESC}\\${ESC}[16t${ESC}[c`;
}

/** Transmit a PNG under `id` without displaying it, in ≤ 4096-byte chunks (q=1: errors only). */
export function transmit(id: number, png: Uint8Array): string {
  const b64 = Buffer.from(png).toString("base64");
  const parts: string[] = [];
  for (let i = 0; i < b64.length; i += CHUNK) {
    const more = i + CHUNK < b64.length ? 1 : 0;
    const head = i === 0 ? `a=t,f=100,i=${id},q=1,m=${more}` : `m=${more},q=1`;
    parts.push(`${ESC}_G${head};${b64.slice(i, i + CHUNK)}${ESC}\\`);
  }
  return parts.join("");
}

/** Show image `id` at a 1-based screen cell, scaled to cols × rows; re-placing moves it. */
export function place(id: number, row: number, col: number, cols: number, rows: number): string {
  return `${ESC}7${ESC}[${row};${col}H${ESC}_Ga=p,i=${id},p=1,c=${cols},r=${rows},C=1,q=1${ESC}\\${ESC}8`;
}

/** Remove the image from the screen but keep its data for re-placing. */
export function hide(id: number): string {
  return `${ESC}_Ga=d,d=i,i=${id},q=2${ESC}\\`;
}

/** Remove the image and free its data. */
export function free(id: number): string {
  return `${ESC}_Ga=d,d=I,i=${id},q=2${ESC}\\`;
}

export interface Replies {
  /** true once the terminal answered the probe with OK, false on an error reply. */
  kitty?: boolean;
  /** Cell size in pixels (CSI 16 t), if the terminal reports it. */
  cell?: { w: number; h: number };
  /** DA1 arrived (the probe is finished). */
  da1?: boolean;
  /** An incomplete reply held back until the rest arrives. */
  partial?: string;
  /** Error replies to our own images (q=1 suppresses OKs), for the log. */
  errors?: string[];
}

/**
 * Strip probe replies out of stdin data so they never reach the key parser
 * (a stray DA1 reply like `ESC[?62;22c` would otherwise read as keys 6, 2, c).
 */
export function takeReplies(data: string, into: Replies): string {
  let input = (into.partial ?? "") + data;
  delete into.partial;
  const cut = /\x1b(?:_G[^\x1b]*\x1b?|\[\?[\d;]*|\[6;[\d;]*)$/.exec(input);
  if (cut) {
    into.partial = cut[0];
    input = input.slice(0, cut.index);
  }
  return input
    .replace(/\x1b_G([^\x1b]*)\x1b\\/g, (_all, body: string) => {
      if (body.startsWith(`i=${PROBE_ID}`)) into.kitty = /;OK$/.test(body);
      else if (!/;OK$/.test(body)) (into.errors ??= []).push(body);
      return "";
    })
    .replace(/\x1b\[6;(\d+);(\d+)t/g, (_all, h: string, w: string) => {
      if (Number(w) > 0 && Number(h) > 0) into.cell = { w: Number(w), h: Number(h) };
      return "";
    })
    .replace(/\x1b\[\?[\d;]*c/g, () => {
      into.da1 = true;
      return "";
    });
}
