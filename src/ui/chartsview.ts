/** Chart sections: burn-up and cost anatomy (Summary) plus the Charts view. */
import { money, shortModel } from "../core/display.ts";
import type { MoneyUnit } from "../core/display.ts";
import { HARNESS_LABEL, HARNESSES } from "../core/types.ts";
import type { Harness, Level } from "../core/types.ts";
import { fmtDay, fmtPct, fmtTokens, fmtUsd } from "../util/format.ts";
import { DAY, startOfLocalDay } from "../util/time.ts";
import { HEAT, bar, boxplot, heatLegend, heatLevel, heatThresholds, hstack, lineChart, stackedColumns, treemap } from "./charts.ts";
import type { TreeGroup } from "./charts.ts";
import { CHART_TABS } from "./chartsdata.ts";
import type { AdvisorRow, Anatomy, Burnup, Calendar, ChartTab, ChartsData, ContextSeries, DailySpend, Speed, Strips, TreeData, WhatIf } from "./chartsdata.ts";
import { burnupPixels } from "./pixels.ts";
import { C, bg, bold, colorRuns, dim, fg, fit, width } from "./style.ts";
import { layoutColumns, sectionTitle, sparkline, tableHeader, tableRow } from "./widgets.ts";

export const HARNESS_COLOR: Record<Harness, string> = {
  opencode: C.blue,
  pi: C.green,
  copilot: C.mauve,
  claude: C.peach,
};

/** Section title with the first legend that fits on the right (none if the pane is too narrow). */
function section(title: string, w: number, ...legends: string[]): string {
  return sectionTitle(title, w, legends.find((l) => width(title) + width(l) + 8 <= w) ?? "");
}

function note(text: string, w: number): string {
  return fit("  " + dim(fg(C.sub, text)), w);
}

/** Round up to a readable axis maximum: 630 → 650, 1,240 → 1,500. */
function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const step = 10 ** Math.floor(Math.log10(v)) / 2;
  return Math.ceil(v / step) * step;
}

export const LEVEL_MARK: Record<Level, { glyph: string; color: string; rank: number }> = {
  critical: { glyph: "■", color: C.red, rank: 3 },
  high: { glyph: "▲", color: C.yellow, rank: 2 },
  low: { glyph: "▽", color: C.green, rank: 1 },
  normal: { glyph: "●", color: C.sub, rank: 0 },
};

function burnupMax(b: Burnup): number {
  return niceCeil(Math.max(b.allowance, b.projected ?? 0, b.used) * 1.04);
}

function axisMoney(unit: MoneyUnit): (usd: number) => string {
  return (usd) => (usd === 0 ? (unit === "usd" ? "$0" : "0cr") : money(unit, usd, usd * 100));
}

function dayLabels(b: Burnup): Array<[number, string]> {
  const labels: Array<[number, string]> = [];
  for (let d = 0; d <= b.days; d += 5) {
    labels.push([d, new Date(b.periodStart + d * DAY).toLocaleDateString("en-AU", { day: "numeric", month: "short", timeZone: "UTC" })]);
  }
  return labels;
}

/** Full legend, then a shorter one for narrower panes. */
function burnupLegends(b: Burnup): [string, string] {
  const first = b.history[0];
  // Before the first quota snapshot the account line is a straight-line estimate.
  const estimated = !first || first[0] > 1;
  return [
    [fg(C.blue, "━ account") + (estimated ? fg(C.blue, " ┄ est.") : ""), fg(C.mauve, "━ this machine"), fg(C.faint, "━ on-budget pace"), fg(C.sky, "┄ projection"), fg(C.red, "━ budget")].join("  "),
    [fg(C.blue, "━ account"), fg(C.mauve, "━ this machine"), fg(C.faint, "━ pace"), fg(C.sky, "┄ projected"), fg(C.red, "━ budget")].join("  "),
  ];
}

/** Copilot spend across the billing month against the budget and an on-budget pace line, with alerts underneath. */
export function burnupSection(b: Burnup, w: number, rows: number, unit: MoneyUnit): string[] {
  const first = b.history[0];
  const chart = lineChart(
    [
      { points: [[0, 0], [b.days, b.allowance]], color: C.faint },
      { points: b.local, color: C.mauve },
      { points: [[0, 0], first ?? [b.nowX, b.used]], color: C.blue, dash: 4 },
      ...(b.history.length ? [{ points: [...b.history, [b.nowX, b.used]] as Array<[number, number]>, color: C.blue }] : []),
      ...(b.projected != null ? [{ points: [[b.nowX, b.used], [b.days, b.projected]] as Array<[number, number]>, color: C.sky, dash: 3 }] : []),
    ],
    {
      width: Math.min(w - 2, 160),
      height: rows,
      xMax: b.days,
      yMax: burnupMax(b),
      yFormat: axisMoney(unit),
      xLabels: dayLabels(b),
      refs: [{ y: b.allowance, color: C.red }],
      markers: [{ x: b.nowX, y: b.used, color: C.text }],
      strip: b.alerts.length ? { label: "alerts", marks: b.alerts.map((a) => ({ x: a.x, ...LEVEL_MARK[a.level] })) } : undefined,
    },
  );
  return [section("COPILOT BURN-UP · billing month", w, ...burnupLegends(b)), ...chart.map((l) => " " + l)];
}

/** A Kitty-graphics image the app places over blank cells after drawing the frame. */
export interface ImageBox {
  /** Index of the image's first line in the rendered lines. */
  line: number;
  /** 1-based screen column of the image's left edge. */
  col: number;
  cols: number;
  rows: number;
  /** Changes whenever the picture would; the app only re-sends the PNG then. */
  key: string;
  png: () => Buffer;
}

/** The burn-up as a pixel image, framed by text axis labels. */
function pixelBurnup(b: Burnup, w: number, unit: MoneyUnit, cell: { w: number; h: number }, out: string[], images: ImageBox[]): void {
  const yMax = burnupMax(b);
  const fmt = axisMoney(unit);
  const labels = [fmt(yMax), fmt(yMax / 2), fmt(0)];
  const labelW = Math.max(...labels.map((l) => width(l))) + 1;
  const cols = Math.max(20, Math.min(w - labelW - 3, 160));
  const rows = 12;
  out.push(section("COPILOT BURN-UP · pixels", w, ...burnupLegends(b)));
  const line = out.length;
  for (let r = 0; r < rows; r++) {
    const label = r === 0 ? labels[0] : r === Math.floor((rows - 1) / 2) ? labels[1] : r === rows - 1 ? labels[2] : "";
    out.push(fg(C.dim, label.padStart(labelW - 1) + " ┤") + " ".repeat(cols));
  }
  const axis = new Array<string>(cols).fill(" ");
  for (const [d, text] of dayLabels(b)) {
    const start = Math.max(0, Math.min(cols - text.length, Math.round((d / b.days) * (cols - 1)) - Math.floor(text.length / 2)));
    if (axis.slice(start, start + text.length).some((c) => c !== " ")) continue;
    for (let k = 0; k < text.length; k++) axis[start + k] = text[k];
  }
  out.push(" ".repeat(labelW + 1) + fg(C.dim, axis.join("")));
  const local = b.local[b.local.length - 1]?.[1] ?? 0;
  // Large cells (retina, big fonts) would make huge images; the terminal scales to the box anyway.
  const scale = Math.min(1, 2400 / (cols * cell.w), 1200 / (rows * cell.h));
  const pxW = cols * cell.w * scale;
  const pxH = rows * cell.h * scale;
  // The key changes only when a line would move by a pixel; spend ticking up by
  // cents would otherwise re-render and re-send a ~70 KB image every 10 s.
  const py = (usd: number) => Math.round((usd / yMax) * pxH);
  images.push({
    line,
    col: labelW + 2,
    cols,
    rows,
    key: [cols, rows, cell.w, cell.h, yMax, py(b.used), py(local), py(b.projected ?? 0), Math.round((b.nowX / b.days) * pxW), b.history.length > 0, b.alerts.length].join(":"),
    png: () => burnupPixels(b, pxW, pxH, yMax),
  });
}

const PARTS = [
  { key: "cacheRead", label: "cache read", short: "read", color: C.mauve },
  { key: "cacheWrite", label: "cache write", short: "write", color: C.peach },
  { key: "output", label: "output", short: "out", color: C.green },
  { key: "input", label: "input", short: "in", color: C.blue },
] as const;

/** What the money is spent on, as 100% bars per scope. */
export function anatomySection(rows: Anatomy[], w: number): string[] {
  const shown = rows.filter((a) => a.input + a.cacheWrite + a.cacheRead + a.output > 0);
  if (shown.length === 0) return [];
  const out = [section("WHAT YOU PAY FOR · cost anatomy", w, PARTS.map((p) => fg(p.color, `█ ${p.label}`)).join("  "))];
  const barW = Math.max(16, Math.min(60, w - 70));
  for (const a of shown) {
    const total = a.input + a.cacheWrite + a.cacheRead + a.output;
    const shares = PARTS.map((p) => `${p.short} ${fmtPct((a[p.key] / total) * 100)}`).join(" · ");
    out.push(
      fit(
        " " + fg(C.text, fit(a.label, 17)) + " " + hstack(PARTS.map((p) => ({ v: a[p.key], color: p.color })), barW) +
          " " + fg(C.text, fmtUsd(total).padStart(7)) + "  " + dim(fg(C.sub, shares)),
        w,
      ),
    );
  }
  const today = rows[0];
  const todayTotal = today.input + today.cacheWrite + today.cacheRead + today.output;
  if (todayTotal > 0 && today.cacheRead / todayTotal >= 0.4) {
    out.push(note(`▸ ${fmtPct((today.cacheRead / todayTotal) * 100)} of today's spend re-reads cached context; /compact or a fresh session resets it`, w));
  }
  return out;
}

export interface ChartsOptions {
  /** Draw the burn-up as a Kitty-graphics image at the top. */
  pixels: boolean;
  /** Shown instead of the pixel chart (e.g. why it's unavailable). */
  pixelNote: string | null;
  burnup: Burnup | null;
  unit: MoneyUnit;
  /** Cell size in pixels, when the terminal reported it. */
  cell: { w: number; h: number } | null;
  now?: number;
}

export const CHART_TAB_INFO: Record<ChartTab, { label: string; about: string }> = {
  live: { label: "Live", about: "your running sessions, now" },
  spend: { label: "Spend", about: "where the money goes" },
  models: { label: "Models", about: "your tokens at other models' prices, and output speed" },
  patterns: { label: "Patterns", about: "when you spend, and when alerts fire" },
};

/** The Charts view's tab strip, with each tab's x range for mouse clicks. */
export function chartTabsBar(active: ChartTab, w: number): { line: string; tabs: Array<{ tab: ChartTab; x0: number; x1: number }> } {
  let line = " ";
  let x = 1;
  const tabs: Array<{ tab: ChartTab; x0: number; x1: number }> = [];
  for (const tab of CHART_TABS) {
    const label = ` ${CHART_TAB_INFO[tab].label} `;
    line += tab === active ? bg(C.surface, bold(fg(C.text, label))) : fg(C.dim, label);
    tabs.push({ tab, x0: x, x1: x + label.length });
    x += label.length;
  }
  return { line: fit(line + dim(fg(C.sub, `   ${CHART_TAB_INFO[active].about}`)), w), tabs };
}

/** One Charts tab: only that tab's sections are drawn. */
export function renderCharts(data: ChartsData, w: number, o: ChartsOptions): { lines: string[]; images: ImageBox[] } {
  const out: string[] = [];
  const images: ImageBox[] = [];
  switch (data.tab) {
    case "live":
      advisorSection(data.advisor, w, out);
      contextSection(data.context, w, out);
      stripsSection(data.strips, w, out);
      break;
    case "spend":
      if (o.pixels && o.burnup) {
        pixelBurnup(o.burnup, w, o.unit, o.cell ?? { w: 16, h: 32 }, out, images);
        out.push("");
      } else if (o.pixelNote) {
        out.push(note(o.pixelNote, w), "");
      }
      treeSection(data.tree, w, out);
      dailySection(data.daily, w, out);
      break;
    case "models":
      if (data.whatIf) whatIfSection(data.whatIf, w, out);
      else out.push(section("MODEL WHAT-IF", w), note("no priced usage this month yet", w), "");
      speedSection(data.speed, w, out);
      break;
    case "patterns":
      calendarSection(data.calendar, w, out);
      hoursSection(data.hours, w, out);
      alertTimeline(data, w, o.now ?? Date.now(), out);
      break;
  }
  return { lines: out, images };
}

function dailySection(daily: DailySpend, w: number, out: string[]): void {
  out.push(section("DAILY SPEND BY HARNESS · last 21 days", w, HARNESSES.map((h) => fg(HARNESS_COLOR[h], `█ ${HARNESS_LABEL[h]}`)).join("  ")));
  out.push(
    ...stackedColumns(
      daily.map((d) => ({ label: d.label, parts: HARNESSES.map((h) => ({ v: d.parts[h], color: HARNESS_COLOR[h] })) })),
      8,
      2,
      (v) => (v === 0 ? "$0" : fmtUsd(v)),
    ).map((l) => "  " + l),
  );
  out.push("");
}

function calendarSection(cal: Calendar, w: number, out: string[]): void {
  const days = cal.weeks.flat().filter((c): c is { day: string; v: number } => c != null);
  const calT = heatThresholds(days.map((c) => c.v));
  out.push(section("CALENDAR · daily spend, last 20 weeks", w, heatLegend()));
  const monthCells = new Array<string>(cal.weeks.length * 2).fill(" ");
  for (const [wk, name] of cal.months) {
    for (let k = 0; k < name.length && wk * 2 + k < monthCells.length; k++) monthCells[wk * 2 + k] = name[k];
  }
  out.push("  " + " ".repeat(4) + fg(C.dim, monthCells.join("")));
  const dayNames = ["Mon", "", "Wed", "", "Fri", "", "Sun"];
  for (let dow = 0; dow < 7; dow++) {
    const cells: Array<[string | null, string]> = [];
    for (const week of cal.weeks) cells.push(week[dow] ? [HEAT[heatLevel(week[dow]!.v, calT)], "■"] : [null, " "], [null, " "]);
    out.push("  " + fg(C.dim, dayNames[dow].padEnd(4)) + colorRuns(cells));
  }
  const top = [...days].sort((a, z) => z.v - a.v)[0];
  if (top && top.v > 0) {
    const [y, m, d] = top.day.split("-").map(Number);
    const at = new Date(y, m - 1, d).getTime();
    out.push(note(`busiest day ${new Date(at).toLocaleDateString("en-AU", { weekday: "short" })} ${fmtDay(at)}: ${fmtUsd(top.v)}`, w));
  }
  out.push("");
}

function hoursSection(hours: number[][], w: number, out: string[]): void {
  const hourT = heatThresholds(hours.flat());
  out.push(section("WHEN YOU SPEND · weekday × hour, last 30 days", w, heatLegend()));
  let hourHead = "  " + " ".repeat(4);
  for (let hr = 0; hr < 24; hr++) hourHead += hr % 3 === 0 ? fg(C.dim, String(hr).padStart(2, "0")) : "  ";
  out.push(hourHead);
  const fullDays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  for (let dow = 0; dow < 7; dow++) {
    const cells: Array<[string | null, string]> = [];
    for (let hr = 0; hr < 24; hr++) cells.push([HEAT[heatLevel(hours[dow][hr], hourT)], "■"], [null, " "]);
    out.push("  " + fg(C.dim, fullDays[dow].padEnd(4)) + colorRuns(cells));
  }
  out.push("");
}

function contextSection(ctx: ContextSeries | null, w: number, out: string[]): void {
  if (!ctx || ctx.points.length < 2) {
    out.push(section("CONTEXT GROWTH · prompt size per call", w), note("no live session with two or more calls yet", w), "");
    return;
  }
  const maxP = Math.max(...ctx.points);
  const limit = ctx.limit && ctx.limit >= maxP ? ctx.limit : null;
  out.push(
    section("CONTEXT GROWTH · prompt size per call", w, (limit ? fg(C.yellow, "━ 80%") + "  " + fg(C.red, "━ 92%") + "  " : "") + dim(fg(C.sub, ctx.title.slice(0, 50)))),
  );
  out.push(
    ...lineChart([{ points: ctx.points.map((p, i) => [i, p] as [number, number]), color: C.teal, fill: C.surface }], {
      width: Math.min(w - 3, 160),
      height: 8,
      xMax: Math.max(1, ctx.points.length - 1),
      yMax: (limit ?? maxP) * 1.05,
      yFormat: (v) => fmtTokens(v),
      refs: limit ? [{ y: limit * 0.8, color: C.yellow, dash: 2 }, { y: limit * 0.92, color: C.red, dash: 2 }] : [],
      xLabels: [[0, "call 1"], [ctx.points.length - 1, `call ${ctx.points.length}`]],
    }).map((l) => "  " + l),
  );
  const last = ctx.points[ctx.points.length - 1];
  out.push(note(`${ctx.points.length} calls · now ${fmtTokens(last)}${limit ? ` of ${fmtTokens(limit)} (${fmtPct((last / limit) * 100)})` : ""}`, w));
  out.push("");
}

function stripsSection(strips: Strips, w: number, out: string[]): void {
  out.push(section("LIVE AGENTS · spend per 2 min, last hour", w));
  const stripW = Math.min(40, Math.max(12, ...strips.map((s) => width(s.label))));
  for (const s of strips) {
    const glyph = s.level === "critical" ? fg(C.red, "■") : s.level === "high" ? fg(C.yellow, "▲") : s.level === "low" ? fg(C.green, "▽") : fg(C.sub, "●");
    const hourly = s.values.reduce((x, y) => x + y, 0);
    out.push(
      fit(
        `  ${glyph} ${fg(C.text, fit(s.label, stripW))} ${sparkline(s.values, HARNESS_COLOR[s.harness])}  ${dim(fg(C.sub, `${fmtUsd(hourly)}/h · ${fmtUsd(s.burn)}/5m`))}`,
        w,
      ),
    );
  }
  if (strips.length === 0) out.push(note("no live agents", w));
  out.push("");
}

function speedSection(speed: Speed, w: number, out: string[]): void {
  if (speed.length === 0) {
    out.push(section("SPEED BY MODEL · output tok/s, last 7 days", w), note("not enough timed calls in the last 7 days", w), "");
    return;
  }
  const scale = Math.max(...speed.map((s) => s.stats.p90)) * 1.05;
  out.push(section("SPEED BY MODEL · output tok/s, last 7 days", w, dim(fg(C.sub, `├ p10 █ p25–p75 ┃ median ┤ p90 · 0–${Math.round(scale)} t/s`))));
  for (const s of speed) {
    out.push(fit(`  ${fg(C.text, fit(s.model, 20))} ${boxplot(s.stats, scale, 40, C.teal)}  ${fg(C.text, `${Math.round(s.stats.p50)} t/s`)} ${dim(fg(C.sub, `n=${s.n}`))}`, w));
  }
  out.push("");
}

const VERDICT_COLOR: Record<string, string> = { "compact now": C.yellow, "compact soon": C.peach, "keep going": C.green };

/** Per live session: what carrying its context costs, and what /compact would save. */
function advisorSection(rows: AdvisorRow[], w: number, out: string[]): void {
  out.push(section("COMPACTION ADVISOR · the cost of carrying context", w, dim(fg(C.sub, "every call re-reads the whole prompt from cache"))));
  if (rows.length === 0) {
    out.push(note("no live agent sessions", w), "");
    return;
  }
  const cols = layoutColumns(
    [
      { title: "", width: 1 },
      { title: "agent · space", width: 30, flex: true, min: 14, max: 44 },
      { title: "context", width: 11, align: "right" },
      { title: "pace", width: 6, align: "right" },
      { title: "now", width: 10, align: "right" },
      { title: "compacted", width: 10, align: "right" },
      { title: "one-off", width: 7, align: "right" },
      { title: "pays back", width: 9, align: "right" },
      { title: "verdict", width: 40 },
    ],
    w,
  );
  out.push(tableHeader(cols));
  for (const r of rows) {
    const a = r.advice;
    const hourly = a.carryPerHour != null;
    const rate = (perCall: number, perHour: number | null) => (perHour != null ? `${fmtUsd(perHour)}/h` : `${fmtUsd(perCall)}/call`);
    const saves = a.savingsPerHour != null ? `saves ≈${fmtUsd(a.savingsPerHour)}/h` : a.savingsPerCall >= 0.005 ? `saves ≈${fmtUsd(a.savingsPerCall)}/call` : "";
    const limit = a.callsToLimit != null && a.callsToLimit < 60 ? `~${a.callsToLimit} calls to 92%` : "";
    out.push(
      tableRow(cols, {
        "": fg(LEVEL_MARK[r.level].color, LEVEL_MARK[r.level].glyph),
        "agent · space": fg(C.text, r.label),
        context: `${fmtTokens(r.input.prompt)}${a.contextPct != null ? dim(fg(C.sub, ` ${fmtPct(a.contextPct)}`)) : ""}`,
        pace: r.input.callsPerHour > 0 ? `${r.input.callsPerHour}/h` : dim(fg(C.sub, "idle")),
        now: fg(C.peach, rate(a.carryPerCall, a.carryPerHour)),
        compacted: fg(C.green, hourly ? `${fmtUsd(a.compactPerCall * r.input.callsPerHour)}/h` : `${fmtUsd(a.compactPerCall)}/call`),
        "one-off": fmtUsd(a.compactCost),
        "pays back": a.breakEvenCalls != null ? `${a.breakEvenCalls} call${a.breakEvenCalls === 1 ? "" : "s"}` : "–",
        verdict: fg(VERDICT_COLOR[a.verdict], a.verdict) + dim(fg(C.sub, [saves, limit].filter(Boolean).map((x) => ` · ${x}`).join(""))),
      }),
    );
  }
  out.push(note("▸ compacting keeps the first prompt plus a summary; a fresh session pays only the first prompt but loses the context", w), "");
}

/** The same tokens priced at each model's rate. */
function whatIfSection(wi: WhatIf, w: number, out: string[]): void {
  const t = wi.tokens;
  out.push(
    section(
      `MODEL WHAT-IF · ${wi.label}'s tokens at each model's price`,
      w,
      dim(fg(C.sub, `${fmtTokens(t.input)} in · ${fmtTokens(t.cacheWrite)} cache wr · ${fmtTokens(t.cacheRead)} cache rd · ${fmtTokens(t.output)} out`)),
    ),
  );
  const all = [...wi.rows.map((r) => ({ ...r, actual: false })), { model: "actual (your mix)", usd: wi.actual, used: true, actual: true }].sort((a, b) => a.usd - b.usd);
  const max = Math.max(...all.map((r) => r.usd));
  const barW = Math.max(16, Math.min(60, w - 48));
  for (const r of all) {
    const delta = r.actual || wi.actual <= 0 ? "" : r.usd >= wi.actual ? fg(C.red, `+${fmtPct((r.usd / wi.actual - 1) * 100)}`) : fg(C.green, `−${fmtPct((1 - r.usd / wi.actual) * 100)}`);
    const tag = r.used ? " •" : "";
    const name = width(r.model) + tag.length > 22 ? fit(r.model, 22 - tag.length) : r.model;
    const label = r.actual ? bold(fg(C.peach, r.model.padEnd(22))) : fg(r.used ? C.text : C.sub, fit(name + tag, 22));
    out.push(fit(`  ${label} ${bar(r.usd, max, barW, r.actual ? C.peach : r.used ? C.lavender : C.faint)} ${fg(C.text, fmtUsd(r.usd).padStart(7))}  ${delta}`, w));
  }
  out.push(note("▸ • = models you used. Same tokens at list price; real runs differ by tokenizer, verbosity and caching", w), "");
}

const TREE_PALETTE = [C.blue, C.mauve, C.green, C.peach, C.teal, C.pink];

/** Spend as nested rectangles: projects, then their sessions (labelled with the main model). */
function treeSection(tree: TreeData, w: number, out: string[]): void {
  out.push(section(`WHERE IT GOES · project → session → model, ${tree.label}`, w, dim(fg(C.sub, `${fmtUsd(tree.total)} total`))));
  if (tree.total <= 0) {
    out.push(note("no spend in this period", w), "");
    return;
  }
  const top = tree.groups.slice(0, 6);
  const rest = tree.groups.slice(6);
  const groups: TreeGroup[] = top.map((g, i) => {
    const shown = g.sessions.slice(0, 8);
    const more = g.sessions.slice(8).reduce((s, x) => s + x.usd, 0);
    return {
      label: g.key,
      value: fmtUsd(g.usd),
      v: g.usd,
      color: TREE_PALETTE[i],
      children: [
        ...shown.map((s) => ({ label: s.title, detail: `${fmtUsd(s.usd)} · ${shortModel(s.model)}${s.models > 1 ? ` +${s.models - 1}` : ""}`, v: s.usd })),
        ...(more > 0 ? [{ label: `${g.sessions.length - 8} more sessions`, detail: fmtUsd(more), v: more }] : []),
      ],
    };
  });
  const restUsd = rest.reduce((s, g) => s + g.usd, 0);
  if (restUsd > 0) groups.push({ label: `${rest.length} more projects`, value: fmtUsd(restUsd), v: restUsd, color: C.faint, children: [] });
  out.push(...treemap(groups, Math.max(20, Math.min(w - 4, 150)), 14).map((l) => "  " + l), "");
}

/** One row per rule: when it fired over the last week, at the highest level per time slot. */
function alertTimeline(data: Extract<ChartsData, { tab: "patterns" }>, w: number, now: number, out: string[]): void {
  out.push(
    section(
      "ALERT TIMELINE · last 7 days",
      w,
      (["critical", "high", "low"] as Level[]).map((l) => fg(LEVEL_MARK[l].color, `${LEVEL_MARK[l].glyph} ${l}`)).join("  "),
    ),
  );
  if (data.alerts.length === 0) {
    out.push(note("no alerts in the last 7 days", w), "");
    return;
  }
  const labelW = 26;
  const hoursPer = Math.max(1, Math.ceil(168 / Math.max(14, Math.min(w - labelW - 12, 168))));
  const slots = Math.ceil(168 / hoursPer);
  const slotMs = hoursPer * 3_600_000;
  const start = now - slots * slotMs;
  const byRule = new Map<string, { cells: Array<Level | null>; count: number }>();
  for (const a of data.alerts) {
    const c = Math.floor((a.ts - start) / slotMs);
    if (c < 0 || c >= slots) continue;
    const row = byRule.get(a.ruleId) ?? { cells: new Array<Level | null>(slots).fill(null), count: 0 };
    row.count++;
    const have = row.cells[c];
    if (!have || LEVEL_MARK[a.level].rank > LEVEL_MARK[have].rank) row.cells[c] = a.level;
    byRule.set(a.ruleId, row);
  }
  const midnights = new Map<number, string>();
  for (let d = startOfLocalDay(start) + DAY; d < now; d += DAY) {
    midnights.set(Math.floor((d - start) / slotMs), new Date(d).toLocaleDateString("en-AU", { weekday: "short", day: "numeric" }));
  }
  for (const [id, row] of [...byRule.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 10)) {
    const title = data.ruleTitles.get(id) ?? id;
    let line = "  " + fg(C.text, (title.length > labelW - 1 ? title.slice(0, labelW - 2) + "…" : title).padEnd(labelW));
    const cells: Array<[string, string]> = [];
    for (let c = 0; c < slots; c++) {
      const level = row.cells[c];
      cells.push(level ? [LEVEL_MARK[level].color, LEVEL_MARK[level].glyph] : midnights.has(c) ? [C.faint, "┊"] : [C.surface, "·"]);
    }
    line += colorRuns(cells);
    out.push(fit(line + dim(fg(C.sub, ` ×${row.count}`)), w));
  }
  const axis = new Array<string>(slots).fill(" ");
  for (const [c, text] of midnights) {
    if (c + text.length > slots || axis.slice(c, c + text.length).some((x) => x !== " ")) continue;
    for (let k = 0; k < text.length; k++) axis[c + k] = text[k];
  }
  out.push("  " + " ".repeat(labelW) + fg(C.dim, axis.join("")));
  out.push(note(`each column is ${hoursPer} h; ┊ marks midnight`, w), "");
}
