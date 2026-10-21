import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inflateSync } from "node:zlib";
import { defaultConfig } from "../src/core/config.ts";
import { Ledger } from "../src/core/ledger.ts";
import type { UsageRecord } from "../src/core/types.ts";
import { bar, lineChart, squarify, treemap } from "../src/ui/charts.ts";
import { advise, buildChartsData, buildTree, buildWhatIf, CHART_TABS } from "../src/ui/chartsdata.ts";
import type { Burnup, ChartTab } from "../src/ui/chartsdata.ts";
import { chartTabsBar, renderCharts } from "../src/ui/chartsview.ts";
import { PROBE_ID, place, takeReplies, transmit } from "../src/ui/kitty.ts";
import type { Replies } from "../src/ui/kitty.ts";
import { Raster, burnupPixels, crc32, encodePng } from "../src/ui/pixels.ts";
import { strip, width, colorRuns } from "../src/ui/style.ts";
import { frameDiff } from "../src/ui/term.ts";
import { frameLayout, popupWidth } from "../src/ui/frame.ts";
import { layoutColumns, timeAxis } from "../src/ui/widgets.ts";
import type { Column } from "../src/ui/widgets.ts";
import { testPricing } from "./helpers.ts";

function rec(over: Partial<UsageRecord> & Pick<UsageRecord, "id" | "model">): UsageRecord {
  return {
    harness: "opencode",
    sessionId: "s1",
    rootSessionId: "s1",
    ts: Date.now() - 60_000,
    cwd: "/x/alpha",
    provider: "github-copilot",
    billing: "copilot",
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite1h: 0,
    output: 0,
    reasoning: 0,
    costUsd: 0,
    credits: null,
    creditsExact: false,
    premiumMultiplier: null,
    initiator: null,
    durationMs: null,
    ttftMs: null,
    itlMs: null,
    contextLimit: null,
    isSubagent: false,
    ...over,
  } as UsageRecord;
}

/** Split a PNG into its chunks. */
function chunks(png: Buffer): Array<{ type: string; data: Buffer; crc: number }> {
  const out = [];
  for (let at = 8; at < png.length; ) {
    const len = png.readUInt32BE(at);
    const type = png.subarray(at + 4, at + 8).toString("ascii");
    out.push({ type, data: png.subarray(at + 8, at + 8 + len), crc: png.readUInt32BE(at + 8 + len) });
    at += 12 + len;
  }
  return out;
}

describe("chart toolkit", () => {
  it("squarifies values into rects that tile the area in proportion", () => {
    const values = [6, 6, 4, 3, 2, 2, 1];
    const rects = squarify(values, { x: 0, y: 0, w: 6, h: 4 });
    assert.equal(rects.length, values.length);
    rects.forEach((r, i) => {
      assert.ok(Math.abs(r.w * r.h - values[i]) < 1e-9, `rect ${i} area`);
      assert.ok(r.x >= -1e-9 && r.y >= -1e-9 && r.x + r.w <= 6 + 1e-9 && r.y + r.h <= 4 + 1e-9, `rect ${i} in bounds`);
    });
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i];
        const b = rects[j];
        const ox = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
        const oy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
        assert.ok(ox * oy < 1e-9, `rects ${i} and ${j} overlap`);
      }
    }
  });

  it("draws a treemap of exactly w × h cells, with labels", () => {
    const lines = treemap(
      [
        { label: "alpha $13", v: 13, color: "#89b4fa", children: [{ label: "big session", detail: "$9 · opus", v: 9 }, { label: "small", detail: "$4", v: 4 }] },
        { label: "beta $1", v: 1, color: "#cba6f7", children: [] },
      ],
      40,
      8,
    );
    assert.equal(lines.length, 8);
    for (const l of lines) assert.equal(width(strip(l)), 40);
    const text = lines.map(strip).join("\n");
    assert.match(text, /alpha \$13/);
    assert.match(text, /big session/);
  });

  it("labels treemap tiles without unreadable fragments", () => {
    const groups = [{ label: "web-app", value: "$7.12", v: 7.12, color: "#89b4fa", children: [{ label: "Investigate p99 latency", detail: "$5.29 · opus-5.5", v: 5.29 }] }];
    const text = treemap(groups, 12, 4).map(strip).join("\n");
    assert.match(text, /web-app/);
    assert.doesNotMatch(text, /\$7/, "the project total is dropped, never cut to $7…");
    assert.match(text, /Investiga…/);
    assert.match(text, /\$5\.29 *$/m, "trailing detail parts are dropped whole");
    assert.equal(treemap(groups, 5, 4).map(strip).join("").trim(), "", "a tile too narrow to read gets no label");
  });

  it("draws eighth-block bars padded to width", () => {
    assert.equal(strip(bar(5, 10, 10, "#ffffff")), "█████     ");
    assert.equal(strip(bar(10, 10, 4, "#ffffff")), "████");
    assert.equal(strip(bar(1, 16, 2, "#ffffff")), "▏ ");
    assert.equal(strip(bar(0, 0, 3, "#ffffff")), "   ");
  });

  it("adds an alert strip under a line chart; the highest level wins a column", () => {
    const lines = lineChart([{ points: [[0, 0], [10, 5]], color: "#ffffff" }], {
      width: 30,
      height: 3,
      xMax: 10,
      yMax: 5,
      yFormat: String,
      strip: {
        label: "alerts",
        marks: [
          { x: 5, glyph: "▲", color: "#f9e2af", rank: 2 },
          { x: 5, glyph: "■", color: "#f38ba8", rank: 3 },
        ],
      },
    });
    const row = strip(lines[3]);
    assert.match(row, /^alerts ┤/);
    assert.ok(row.includes("■") && !row.includes("▲"));
  });
});

describe("dashboard layout", () => {
  it("keeps wide panes to a centred, readable column", () => {
    assert.deepEqual(frameLayout(344), { w: 160, margin: 92 });
    assert.deepEqual(frameLayout(120), { w: 120, margin: 0 });
  });

  it("opens the popup at 92% of the pane area, but no wider than the dashboard", () => {
    assert.equal(popupWidth(349), 164, "160 columns of dashboard plus border and spare columns");
    assert.equal(popupWidth(150), 138, "herdr's own rounding of 92%");
    assert.equal(popupWidth(null), "92%");
  });

  it("writes only the lines that changed between frames", () => {
    const first = frameDiff([], ["a", "b", "c"]);
    assert.deepEqual(first.changed, [0, 1, 2]);
    const next = frameDiff(["a", "b", "c"], ["a", "B", "c"]);
    assert.deepEqual(next.changed, [1]);
    assert.equal(next.seq, "\x1b[2;1HB\x1b[0m\x1b[K");
    assert.equal(frameDiff(["a", "b"], ["a", "b"]).seq, "");
    assert.match(frameDiff(["a", "b", "c"], ["a"]).seq, /\x1b\[2;1H\x1b\[J$/, "a shorter frame clears what's left below");
  });

  it("colours runs of cells with one escape sequence each", () => {
    const s = colorRuns([["#ff0000", "a"], ["#ff0000", "b"], [null, " "], ["#ff0000", "c"], ["#00ff00", "d"]]);
    assert.equal(strip(s), "ab cd");
    assert.equal(s.match(/\x1b\[38;2/g)?.length, 2, "blanks join the red run");
    const row = lineChart([{ points: [[0, 0], [10, 10]], color: "#ffffff", fill: "#333333" }], { width: 60, height: 6, xMax: 10, yMax: 10, yFormat: String })[5];
    assert.ok((row.match(/\x1b\[38;2/g)?.length ?? 0) <= 4, "a filled chart row is a few runs, not a sequence per cell");
  });

  it("widens truncated name columns first, and stops flexible columns at their cap", () => {
    const cols: Column[] = [
      { title: "space", width: 8, grow: 20 },
      { title: "session", width: 10, flex: true, max: 30 },
      { title: "spend", width: 4, align: "right" },
    ];
    assert.deepEqual(layoutColumns(cols, 100).map((c) => c.width), [20, 30, 4], "the table ends early on wide panes");
    assert.deepEqual(layoutColumns(cols, 26).map((c) => c.width), [10, 10, 4]);
    assert.deepEqual(layoutColumns(cols, 20).map((c) => c.width), [8, 6, 4], "narrow panes shrink the flexible column");
  });

  it("labels a sparkline's hours, skipping any that would crowd", () => {
    const fiveMin = timeAxis(new Date(2026, 9, 20, 22, 20).getTime(), 5 * 60_000, 144);
    assert.equal(fiveMin.indexOf("23:00"), 6, "centred on the 23:00 bucket");
    assert.equal(fiveMin.match(/\d\d:00/g)?.length, 12);
    assert.match(fiveMin, /10:00$/);
    assert.equal(timeAxis(new Date(2026, 9, 20, 22, 0).getTime(), 30 * 60_000, 12), "23:00 02:00");
  });
});

describe("pixel charts", () => {
  it("encodes a valid RGBA PNG", () => {
    assert.equal(crc32(Buffer.from("IEND")), 0xae426082);
    const png = encodePng(3, 2, new Uint8Array(3 * 2 * 4).fill(200));
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const parts = chunks(png);
    assert.deepEqual(parts.map((c) => c.type), ["IHDR", "IDAT", "IEND"]);
    for (const c of parts) assert.equal(c.crc, crc32(Buffer.concat([Buffer.from(c.type), c.data])));
    assert.equal(parts[0].data.readUInt32BE(0), 3);
    assert.equal(parts[0].data.readUInt32BE(4), 2);
    assert.equal(parts[0].data[9], 6, "colour type RGBA");
    const raw = inflateSync(parts[1].data);
    assert.equal(raw.length, (3 * 4 + 1) * 2);
    assert.equal(raw[0], 0, "filter byte");
    assert.equal(raw[1], 200);
  });

  it("rasterises anti-aliased lines onto a transparent canvas", () => {
    const r = new Raster(20, 10);
    r.polyline([[0, 5], [20, 5]], [255, 0, 0], 2);
    const raw = inflateSync(chunks(r.toPng())[1].data);
    const alphaAt = (x: number, y: number) => raw[y * (20 * 4 + 1) + 1 + x * 4 + 3];
    assert.ok(alphaAt(10, 4) > 200 && alphaAt(10, 5) > 200, "line is opaque");
    assert.equal(alphaAt(10, 0), 0, "background stays transparent");
  });

  it("renders the burn-up at the requested size", () => {
    const b: Burnup = {
      days: 31,
      nowX: 18.5,
      local: [[0, 0], [10, 40], [18.5, 175]],
      history: [[18.4, 209], [18.5, 224]],
      allowance: 600,
      used: 224,
      projected: 381,
      periodStart: Date.UTC(2026, 9, 1),
      alerts: [{ x: 18.45, level: "high" }],
    };
    const ihdr = chunks(burnupPixels(b, 320, 120, 650))[0].data;
    assert.equal(ihdr.readUInt32BE(0), 320);
    assert.equal(ihdr.readUInt32BE(4), 120);
  });

  it("chunks Kitty transmissions at 4096 bytes and places with cursor save/restore", () => {
    const png = Buffer.alloc(10_000, 7);
    const seq = transmit(9, png);
    const parts = [...seq.matchAll(/\x1b_G([^;]*);([^\x1b]*)\x1b\\/g)];
    assert.equal(parts.length, Math.ceil(png.toString("base64").length / 4096));
    assert.match(parts[0][1], /^a=t,f=100,i=9,q=1,m=1$/);
    assert.match(parts[parts.length - 1][1], /^m=0/);
    assert.ok(parts.every((p) => p[2].length <= 4096));
    assert.equal(parts.map((p) => p[2]).join(""), png.toString("base64"));
    assert.equal(place(9, 3, 7, 40, 12), "\x1b7\x1b[3;7H\x1b_Ga=p,i=9,p=1,c=40,r=12,C=1,q=1\x1b\\\x1b8");
  });

  it("filters probe replies out of keyboard input", () => {
    const r: Replies = {};
    const rest = takeReplies(`q\x1b_Gi=${PROBE_ID};OK\x1b\\\x1b[6;38;18t\x1b[?62;22c`, r);
    assert.equal(rest, "q");
    assert.deepEqual(r, { kitty: true, cell: { w: 18, h: 38 }, da1: true });
    const no: Replies = {};
    assert.equal(takeReplies(`\x1b_Gi=${PROBE_ID};ENOTSUPPORTED:nope\x1b\\`, no), "");
    assert.equal(no.kitty, false);
    assert.equal(takeReplies("\x1b_Gi=7301;EINVAL:bad png\x1b\\\x1b_Gi=7301;OK\x1b\\", no), "");
    assert.deepEqual(no.errors, ["i=7301;EINVAL:bad png"], "errors for our images are kept for the log; OKs are dropped");
  });

  it("holds back replies split across reads instead of leaking them as keys", () => {
    const r: Replies = {};
    assert.equal(takeReplies(`j\x1b_Gi=${PROBE_ID};O`, r), "j");
    assert.equal(takeReplies(`K\x1b\\\x1b[?62;2`, r), "");
    assert.equal(r.kitty, true);
    assert.equal(takeReplies("2c", r), "");
    assert.equal(r.da1, true);
    assert.equal(takeReplies("\x1b", r), "\x1b", "a lone Escape is still a key");
    assert.equal(takeReplies("\x1b[A", r), "\x1b[A", "arrow keys pass through");
  });
});

describe("compaction advisor", () => {
  const rates = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };

  it("prices carrying a long context against compacting it", () => {
    const a = advise({ prompt: 200_000, baseline: 20_000, limit: 1_000_000, callsPerHour: 30, growthPerCall: 2_000, rates });
    assert.ok(Math.abs(a.carryPerCall - 0.1) < 1e-9);
    assert.ok(Math.abs(a.compactPerCall - 0.014) < 1e-9, "first prompt + 8k summary");
    assert.ok(Math.abs((a.savingsPerHour ?? 0) - 2.58) < 1e-9);
    assert.ok(Math.abs(a.compactCost - 0.475) < 1e-9, "read once + summary output + re-cache");
    assert.equal(a.breakEvenCalls, 6);
    assert.equal(a.callsToLimit, 360);
    assert.equal(a.contextPct, 20);
    assert.equal(a.verdict, "compact now");
  });

  it("says keep going when the context is near its starting size", () => {
    assert.equal(advise({ prompt: 30_000, baseline: 20_000, limit: 1_000_000, callsPerHour: 10, growthPerCall: 500, rates }).verdict, "keep going");
  });

  it("judges idle sessions on their next 20 calls", () => {
    const a = advise({ prompt: 600_000, baseline: 20_000, limit: 1_000_000, callsPerHour: 0, growthPerCall: 0, rates });
    assert.equal(a.carryPerHour, null);
    assert.equal(a.callsToLimit, null);
    assert.equal(a.verdict, "compact now");
  });
});

describe("what-if and treemap data", () => {
  const ledger = new Ledger(":memory:");
  ledger.upsertRequests(
    [
      rec({ id: "a", model: "claude-opus-5-5", input: 1e6, cacheRead: 10e6, cacheWrite: 1e6, output: 0.1e6, costUsd: 13 }),
      rec({ id: "b", model: "claude-sonnet-5", harness: "claude", sessionId: "s2", rootSessionId: "s2", cwd: "/x/beta", provider: "anthropic", billing: "claude", output: 0.1e6, costUsd: 1 }),
    ],
    "replace",
  );
  const src = { ledger, pricing: testPricing(), config: defaultConfig() };

  it("re-prices the period's tokens at each model's rate", () => {
    const wi = buildWhatIf(src, 0, "all time");
    assert.ok(wi);
    assert.equal(wi.actual, 14);
    assert.deepEqual(wi.tokens, { input: 1e6, cacheWrite: 1e6, cacheRead: 10e6, output: 0.2e6 });
    assert.deepEqual(
      wi.rows.map((r) => [r.model, Math.round(r.usd * 100) / 100, r.used]),
      [
        ["claude-sonnet-5", 8.5, true],
        ["claude-opus-5-5", 15, true],
      ],
    );
  });

  it("groups spend by project, then session, naming the main model", () => {
    const tree = buildTree(ledger, 0, "all time");
    assert.equal(tree.total, 14);
    assert.deepEqual(tree.groups.map((g) => [g.key, g.usd]), [["alpha", 13], ["beta", 1]]);
    const s = tree.groups[0].sessions[0];
    assert.match(s.title, /^opencode · \d{1,2} \w{3},? \d{2}:\d{2}$/, "untitled sessions are named by harness and start time");
    assert.deepEqual({ ...s, title: "" }, { title: "", usd: 13, model: "claude-opus-5-5", models: 1 });
  });

  it("builds and draws only the open Charts tab", () => {
    const sections: Record<ChartTab, RegExp[]> = {
      live: [/COMPACTION ADVISOR/, /CONTEXT GROWTH/, /LIVE AGENTS/],
      spend: [/WHERE IT GOES/, /DAILY SPEND BY HARNESS/],
      models: [/MODEL WHAT-IF/, /SPEED BY MODEL/],
      patterns: [/CALENDAR/, /WHEN YOU SPEND/, /ALERT TIMELINE/],
    };
    const opts = { pixels: false, pixelNote: null, burnup: null, unit: "usd" as const, cell: null };
    for (const tab of CHART_TABS) {
      const data = buildChartsData(src, tab, [], new Map(), null);
      assert.equal(data.tab, tab);
      const text = renderCharts(data, 120, opts).lines.map(strip).join("\n");
      for (const re of sections[tab]) assert.match(text, re, `${tab} shows ${re}`);
      for (const other of CHART_TABS.filter((t) => t !== tab)) {
        for (const re of sections[other]) assert.doesNotMatch(text, re, `${tab} leaves ${re} to the ${other} tab`);
      }
    }
    const bar = chartTabsBar("models", 120);
    assert.deepEqual(bar.tabs.map((t) => t.tab), [...CHART_TABS]);
    assert.equal(strip(bar.line).slice(bar.tabs[2].x0, bar.tabs[2].x1), " Models ", "click regions line up with the labels");
  });
});
