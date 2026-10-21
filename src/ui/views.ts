import { basename } from "node:path";
import { METRICS } from "../core/config.ts";
import type { Config, Rule } from "../core/config.ts";
import type { AgentResult } from "../core/publish.ts";
import { HARNESS_LABEL, LEVEL_GLYPH } from "../core/types.ts";
import type { Harness, Level } from "../core/types.ts";
import { fmtAgo, fmtClock, fmtDateTime, fmtDay, fmtMs, fmtPace, fmtPct, fmtTokens, fmtUsd, fmtWhen } from "../util/format.ts";
import { money, STYLE_HINT } from "../core/display.ts";
import type { MoneyUnit } from "../core/display.ts";
import { anatomySection, burnupSection } from "./chartsview.ts";
import type { ChartTab } from "./chartsdata.ts";
import type { DataSource, Model, SessionDetail } from "./model.ts";
import { GROUPS, PERIODS, PERIOD_LABEL } from "./model.ts";
import { C, bg, bold, dim, fg, fit, levelColor, width } from "./style.ts";
import { gauge, keyHint, layoutColumns, sectionTitle, shareBar, sparkline, tableHeader, tableRow, timeAxis } from "./widgets.ts";
import type { Column } from "./widgets.ts";

export type ViewId = 1 | 2 | 3 | 4 | 5 | 6;
export const VIEW_NAMES: Record<ViewId, string> = { 1: "Summary", 2: "Agents", 3: "Sessions", 4: "History", 5: "Rules", 6: "Charts" };
export const VIEW_IDS: ViewId[] = [1, 2, 3, 4, 5, 6];

export interface UiState {
  view: ViewId;
  /** Which Charts tab is open (kept while visiting other views). */
  chartTab: ChartTab;
  selected: number;
  scroll: number;
  session: { harness: Harness; sessionId: string } | null;
  edit: { buffer: string } | null;
  confirmReset: boolean;
  flash: { text: string; until: number } | null;
  toastDelivery: string | null;
}

export interface Frame {
  lines: string[];
  /** Number of selectable rows in the current list (for key navigation). */
  listSize: number;
  /** Rows available for the scrollable list. */
  listHeight: number;
  /** Clickable tab regions on the header line. */
  tabs: Array<{ view: ViewId; x0: number; x1: number }>;
}

const SPEND_COLOR = { copilot: C.mauve, claude: C.peach, api: C.peach, local: C.teal } as Record<string, string>;

let MONEY: MoneyUnit = "usd";

/** The dashboard follows the same money unit as the sidebar (display.money). */
export function setMoneyUnit(unit: MoneyUnit): void {
  MONEY = unit;
}

/** Money in the configured unit; mauve when mostly Copilot credits, peach otherwise. */
export function cash(usd: number, credits = 0): string {
  const copilotShare = usd > 0 ? credits / 100 / usd : 0;
  return fg(copilotShare >= 0.5 ? C.mauve : C.peach, money(MONEY, usd, credits));
}

function spend(m: { billing: string; credits: number; costUsd: number } | null | undefined): string {
  if (!m) return "";
  if (m.billing === "local") return fg(C.teal, "local");
  return cash(m.costUsd, m.billing === "copilot" ? m.credits : 0);
}

function glyph(level: Level): string {
  return fg(levelColor(level), LEVEL_GLYPH[level]);
}

function statusText(s: string): string {
  switch (s) {
    case "working":
      return fg(C.yellow, "working");
    case "blocked":
      return fg(C.red, "blocked");
    case "done":
      return fg(C.green, "done");
    default:
      return dim(fg(C.sub, s));
  }
}

function hitRate(t: { input: number; cacheRead: number; cacheWrite: number }): string {
  const prompt = t.input + t.cacheRead + t.cacheWrite;
  return prompt > 0 ? fmtPct((t.cacheRead / prompt) * 100) : "–";
}

function selectedRow(line: string, w: number, on: boolean): string {
  return on ? bg(C.surface, fit(line, w)) : fit(line, w);
}

export function header(model: Model | null, st: UiState, w: number): { line: string; tabs: Frame["tabs"] } {
  let x = 0;
  const parts: string[] = [];
  const title = " " + bold(fg(C.lavender, "◆ TOKEN USAGE")) + "  ";
  parts.push(title);
  x += width(title);
  const tabs: Frame["tabs"] = [];
  for (const id of VIEW_IDS) {
    const label = ` ${id} ${VIEW_NAMES[id]} `;
    const styled = st.view === id ? bg(C.surface, bold(fg(C.text, label))) : fg(C.dim, label);
    tabs.push({ view: id, x0: x, x1: x + width(label) });
    parts.push(styled);
    x += width(label);
  }
  let right = "";
  if (model) {
    const snooze = model.snoozedUntil ? fg(C.yellow, `🔕 until ${fmtClock(model.snoozedUntil)}  `) : "";
    const herdr = model.herdrOk ? "" : fg(C.red, "herdr unreachable  ");
    right = `${snooze}${herdr}${dim(fg(C.sub, `updated ${new Date(model.at).toLocaleTimeString("en-GB")}`))} `;
  }
  const left = parts.join("");
  const gap = Math.max(1, w - width(left) - width(right));
  return { line: left + " ".repeat(gap) + right, tabs };
}

export function footer(st: UiState, w: number): string {
  if (st.edit) return fit(" " + fg(C.yellow, "edit value: ") + st.edit.buffer + "█  " + keyHint("⏎", "save") + "  " + keyHint("esc", "cancel"), w);
  if (st.flash && st.flash.until > Date.now()) return fit(" " + fg(C.green, st.flash.text), w);
  const common = [keyHint("1-6", "views"), keyHint("r", "refresh"), keyHint("s", "snooze"), keyHint("q", "quit")];
  const per: Record<ViewId, string[]> = {
    1: [keyHint("↑↓", "select"), keyHint("⏎", "session")],
    2: [keyHint("↑↓", "select"), keyHint("⏎", "session")],
    3: st.session ? [keyHint("↑↓", "scroll"), keyHint("esc", "back")] : [keyHint("↑↓", "select"), keyHint("⏎", "open")],
    4: [keyHint("p", "period"), keyHint("g", "group"), keyHint("↑↓", "scroll")],
    5: [keyHint("space", "on/off"), keyHint("n", "toast"), keyHint("l", "level"), keyHint("+/-", "adjust"), keyHint("e", "edit"), keyHint("t", "test"), keyHint("R", "defaults")],
    6: [keyHint("←→", "chart tabs"), keyHint("↑↓", "scroll"), ...(st.chartTab === "spend" ? [keyHint("k", "pixel chart")] : [])],
  };
  return fit(" " + [...per[st.view], ...common].join("  "), w);
}

// ─── 1 Summary ──────────────────────────────────────────────────────────────

function copilotBlock(model: Model, w: number): string[] {
  const q = model.quota;
  const label = bold(fg(C.text, "Copilot budget  "));
  if (!q) return [label + dim(fg(C.sub, "quota unavailable (needs the gh CLI, logged in)"))];
  const qm = (credits: number) => money(MONEY, credits / 100, credits);
  if (q.unlimited) {
    return [label + fg(C.mauve, `${qm(q.used ?? 0)} used`) + dim(fg(C.sub, " · pooled seat, no per-user cap"))];
  }
  const used = q.usedPct ?? 0;
  const color = model.quotaLevel === "critical" ? C.red : model.quotaLevel === "high" ? C.yellow : used >= 75 ? C.yellow : C.blue;
  const gw = Math.max(10, Math.min(50, w - 70));
  const resetDate = new Date(q.resetAt).toLocaleDateString("en-AU", { day: "numeric", month: "short" });
  const line1 =
    label +
    gauge(used, gw, { color, marker: q.elapsedPct }) +
    " " +
    bold(fg(color, fmtPct(used, 1))) +
    fg(C.sub, ` of ${qm(q.entitlement ?? 0)}`) +
    "   pace " +
    fg(levelColor(model.quotaLevel), `${fmtPace(q.pace)} ${LEVEL_GLYPH[model.quotaLevel]}`) +
    dim(fg(C.sub, `   resets ${resetDate} · ${q.daysLeft.toFixed(1)}d`));
  const local = model.billingCopilot.credits;
  const share = q.used ? Math.min(100, (local / q.used) * 100) : null;
  const projected = q.projectedPct != null && q.entitlement ? (q.projectedPct / 100) * q.entitlement : null;
  const line2 =
    " ".repeat(16) +
    dim(fg(C.sub, `${qm(q.used ?? 0)} used · `)) +
    fg(C.sub, `projected ${projected != null ? qm(projected) : "–"} (${fmtPct(q.projectedPct)}) by reset`) +
    dim(fg(C.sub, ` · ┃ = ${fmtPct(q.elapsedPct)} of month elapsed · this machine ${qm(local)}${share != null ? ` (${fmtPct(share)})` : ""}`)) +
    (q.ok ? "" : fg(C.yellow, `  (stale: ${q.error})`));
  return [fit(line1, w), fit(line2, w)];
}

function agentColumns(w: number, wide: boolean): Column[] {
  const cols: Column[] = [
    { title: "", width: 1 },
    { title: "space", width: 14, grow: 24 },
    { title: "agent", width: 9 },
    { title: "session", width: 32, flex: true, min: 10 },
    { title: "spend", width: 9, align: "right" },
    { title: "work tok", width: 8, align: "right" },
    { title: "ctx", width: 5, align: "right" },
    { title: "tok/s", width: 5, align: "right" },
    { title: "5m", width: 8, align: "right" },
    { title: "state", width: 8 },
  ];
  if (wide) {
    cols.splice(4, 0, { title: "model", width: 16, grow: 22 });
    cols.splice(7, 0, { title: "cache", width: 5, align: "right" });
  }
  return layoutColumns(cols, w);
}

function agentCells(r: AgentResult, model: Model): Record<string, string> {
  const m = r.metrics;
  const ws = model.workspaceLabels.get(r.agent.workspace_id) ?? r.agent.workspace_id;
  const title = m?.title ?? (m?.cwd ? basename(m.cwd) : null) ?? (r.binding?.sessionId ? r.binding.sessionId.slice(0, 12) : dim("(no session yet)"));
  const exact = r.binding?.method === "heuristic" ? dim(fg(C.sub, "~")) : "";
  const burn = m && m.costUsd5m >= 0.01 ? cash(m.costUsd5m, m.billing === "copilot" ? m.credits5m : 0) : "";
  return {
    "": m ? glyph(r.level) : fg(C.faint, "○"),
    space: fg(C.text, ws),
    agent: fg(C.sky, r.agent.agent),
    session: exact + title,
    model: dim(fg(C.sub, m?.model ?? "")),
    spend: spend(m),
    "work tok": m ? fmtTokens(m.workTokens) : "",
    ctx: m?.contextPct != null ? fg(m.contextPct >= 92 ? C.red : m.contextPct >= 80 ? C.yellow : C.text, fmtPct(m.contextPct)) : "",
    cache: m?.cacheHitPct != null ? fmtPct(m.cacheHitPct) : "",
    "tok/s": m?.tpsP50 != null ? String(Math.round(m.tpsP50)) : "",
    "5m": burn,
    state: statusText(r.agent.agent_status),
  };
}

export function renderSummary(model: Model, st: UiState, w: number, h: number): Omit<Frame, "tabs"> {
  const out: string[] = [];
  out.push(...copilotBlock(model, w));
  const t = model.today;
  const other = t.costUsd - model.todayCopilot.costUsd;
  out.push(
    fit(
      bold(fg(C.text, "Today           ")) +
        cash(t.costUsd, model.todayCopilot.credits) +
        (other >= 0.005 && model.todayCopilot.costUsd >= 0.005
          ? dim(fg(C.sub, ` (Copilot ${money(MONEY, model.todayCopilot.costUsd, model.todayCopilot.credits)} · other ${fmtUsd(other)})`))
          : "") +
        dim(fg(C.sub, " · ")) +
        fg(C.text, `${fmtTokens(t.workTokens)} work tok`) +
        dim(fg(C.sub, ` · ${t.calls} calls · cache hit ${hitRate(t)} · ${fmtTokens(t.cacheRead)} cache-read`)),
      w,
    ),
  );
  out.push("");
  const cols = agentColumns(w, w >= 130);
  out.push(sectionTitle(`LIVE AGENTS (${model.agents.length})`, w, model.herdrOk ? "" : fg(C.red, "herdr not reachable")));
  out.push(tableHeader(cols));
  const agentRows = model.agents.length ? model.agents : [];
  if (agentRows.length === 0) out.push(dim(fg(C.sub, "  no agents detected in herdr")));
  agentRows.forEach((r, i) => out.push(selectedRow(tableRow(cols, agentCells(r, model)), w, i === st.selected)));

  const alertLines = alertsBlock(model, w, 4);
  if (alertLines.length) {
    out.push("");
    out.push(...alertLines);
  }

  // Copilot burn-up takes the spare height (4–10 rows) once cost anatomy,
  // by-harness and activity below it are accounted for.
  const anatomy = anatomySection(model.anatomy, w);
  const below = (anatomy.length ? anatomy.length + 1 : 0) + 3 + Math.max(1, model.byHarness.length) + 4;
  if (model.burnup) {
    // 4–10 chart rows + title, alert strip and x labels, plus the blank line above.
    const rows = Math.min(10, h - out.length - below - 4);
    if (rows >= 4) {
      out.push("");
      out.push(...burnupSection(model.burnup, w, rows, MONEY));
    }
  }
  if (anatomy.length) {
    out.push("");
    out.push(...anatomy);
  }

  out.push("");
  out.push(sectionTitle(`BY HARNESS · ${PERIOD_LABEL[model.period]}`, w, dim(fg(C.sub, "p: period"))));
  const hcols = layoutColumns(
    [
      { title: "harness", width: 12 },
      { title: "calls", width: 6, align: "right" },
      { title: "work tok", width: 8, align: "right" },
      { title: "cache rd", width: 8, align: "right" },
      { title: "hit", width: 4, align: "right" },
      { title: "spend", width: 10, align: "right" },
      { title: "share", width: 16, flex: true, min: 6, max: 24 },
    ],
    w,
  );
  out.push(tableHeader(hcols));
  const totalSpend = model.byHarness.reduce((s, g) => s + g.costUsd, 0) || 1;
  for (const g of model.byHarness) {
    out.push(
      tableRow(hcols, {
        harness: fg(C.sky, HARNESS_LABEL[g.key as Harness] ?? g.key),
        calls: String(g.calls),
        "work tok": fmtTokens(g.workTokens),
        "cache rd": fmtTokens(g.cacheRead),
        hit: hitRate(g),
        spend: cash(g.costUsd, g.credits),
        share: shareBar(g.costUsd / totalSpend, hcols[hcols.length - 1].width),
      }),
    );
  }
  if (model.byHarness.length === 0) out.push(dim(fg(C.sub, "  no usage in this period")));

  out.push("");
  const mins = Math.round(model.activityBucketMs / 60_000);
  const span = model.activityBucketMs * model.activity.length;
  const peak = Math.max(0, ...model.activity);
  out.push(sectionTitle(`ACTIVITY · work tokens per ${mins} min, last ${Math.round(span / 3_600_000)} h`, w, dim(fg(C.sub, `peak ${fmtTokens(peak)}`))));
  out.push(" " + sparkline(model.activity, C.blue));
  out.push(" " + dim(fg(C.sub, timeAxis(model.at - span, model.activityBucketMs, model.activity.length))));

  // Tall panes: fill the remaining space with the top models for the period.
  const room = h - out.length - 3;
  if (room >= 3 && model.byModel.length) {
    out.push("");
    out.push(sectionTitle(`TOP MODELS · ${PERIOD_LABEL[model.period]}`, w));
    const longest = Math.max(0, ...model.byModel.map((g) => width(g.key)));
    const mcols = layoutColumns(
      [
        { title: "model", width: 22, flex: true, min: 12, max: Math.min(36, Math.max(12, longest)) },
        { title: "calls", width: 6, align: "right" },
        { title: "work tok", width: 8, align: "right" },
        { title: "cache rd", width: 8, align: "right" },
        { title: "spend", width: 10, align: "right" },
        { title: "share", width: 16 },
      ],
      w,
    );
    out.push(tableHeader(mcols));
    const total = model.byModel.reduce((s, g) => s + g.costUsd, 0) || 1;
    for (const g of model.byModel.slice(0, room - 1)) {
      out.push(
        tableRow(mcols, {
          model: fg(C.text, g.key),
          calls: String(g.calls),
          "work tok": fmtTokens(g.workTokens),
          "cache rd": fmtTokens(g.cacheRead),
          spend: cash(g.costUsd, g.credits),
          share: shareBar(g.costUsd / total, 16, C.blue),
        }),
      );
    }
  }

  return { lines: out.slice(0, h), listSize: model.agents.length, listHeight: h };
}

function alertsBlock(model: Model, w: number, max: number): string[] {
  const out: string[] = [];
  if (model.alerts.length === 0 && model.alertLog.length === 0) return out;
  const active = model.alerts.length;
  const status = [
    active ? fg(C.yellow, `${active} active now`) : dim(fg(C.sub, "none active now")),
    model.snoozedUntil ? fg(C.yellow, "snoozed") : "",
  ].filter(Boolean);
  out.push(sectionTitle("RECENT ALERTS", w, status.join(dim(fg(C.sub, " · ")))));
  const seen = new Set<string>();
  const shown: typeof model.alertLog = [];
  for (const a of model.alertLog) {
    if (shown.length >= max) break;
    const key = `${a.rule_id}:${a.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    shown.push(a);
  }
  const whenW = Math.max(0, ...shown.map((a) => fmtWhen(a.ts).length));
  for (const a of shown) {
    // Messages read "headline — detail"; the headline carries the news.
    const cut = a.message.indexOf(" — ");
    const head = cut >= 0 ? a.message.slice(0, cut) : a.message;
    const detail = cut >= 0 ? a.message.slice(cut) : "";
    out.push(
      fit(
        ` ${fg(levelColor(a.level), LEVEL_GLYPH[a.level as Level] ?? "●")} ${dim(fg(C.sub, fmtWhen(a.ts).padStart(whenW)))}  ${fg(C.text, head)}${dim(fg(C.sub, detail))}${a.notified ? "" : dim(fg(C.sub, " (no toast)"))}`,
        w,
      ),
    );
  }
  return out;
}

// ─── 2 Agents ───────────────────────────────────────────────────────────────

export function renderAgents(model: Model, st: UiState, w: number, h: number): Omit<Frame, "tabs"> {
  const out: string[] = [];
  out.push(sectionTitle(`LIVE AGENTS (${model.agents.length})`, w, dim(fg(C.sub, "~ = matched by heuristics (install herdr integrations for exact)"))));
  const cols = layoutColumns(
    [
      { title: "", width: 1 },
      { title: "pane", width: 7 },
      { title: "agent", width: 9 },
      { title: "session", width: 22, flex: true, min: 10, max: 60 },
      { title: "model", width: 16, grow: 22 },
      { title: "calls", width: 5, align: "right" },
      { title: "spend", width: 9, align: "right" },
      { title: "work tok", width: 8, align: "right" },
      { title: "cache rd", width: 8, align: "right" },
      { title: "ctx", width: 9, align: "right" },
      { title: "hit", width: 4, align: "right" },
      { title: "tok/s", width: 5, align: "right" },
      { title: "ttft", width: 6, align: "right" },
      { title: "last", width: 7, align: "right" },
      { title: "state", width: 8 },
    ],
    w,
  );
  out.push(tableHeader(cols));
  model.agents.forEach((r, i) => {
    const m = r.metrics;
    const title = m?.title ?? (m?.cwd ? basename(m.cwd) : dim("(no session yet)"));
    const ctx =
      m?.contextPct != null
        ? fg(m.contextPct >= 92 ? C.red : m.contextPct >= 80 ? C.yellow : C.text, `${fmtPct(m.contextPct)} ${fmtTokens(m.contextTokens ?? 0)}`)
        : m?.contextTokens != null
          ? fmtTokens(m.contextTokens)
          : "";
    out.push(
      selectedRow(
        tableRow(cols, {
          "": m ? glyph(r.level) : fg(C.faint, "○"),
          pane: fg(C.text, r.agent.pane_id),
          agent: fg(C.sky, r.agent.agent),
          session: (r.binding?.method === "heuristic" ? dim("~") : "") + title,
          model: dim(fg(C.sub, m?.model ?? "")),
          calls: m ? String(m.calls) : "",
          spend: spend(m),
          "work tok": m ? fmtTokens(m.workTokens) : "",
          "cache rd": m ? fmtTokens(m.cacheRead) : "",
          ctx,
          hit: m?.cacheHitPct != null ? fmtPct(m.cacheHitPct) : "",
          "tok/s": m?.tpsP50 != null ? String(Math.round(m.tpsP50)) : "",
          ttft: m ? fmtMs(m.ttftP50) : "",
          last: m?.lastTs ? fmtAgo(m.lastTs) : "",
          state: statusText(r.agent.agent_status),
        }),
        w,
        i === st.selected,
      ),
    );
  });
  if (model.agents.length === 0) out.push(dim(fg(C.sub, "  no agents detected in herdr")));
  const sel = model.agents[st.selected];
  if (sel?.metrics) {
    const m = sel.metrics;
    out.push("");
    out.push(sectionTitle("SELECTED", w));
    out.push(fit(` ${fg(C.text, m.title ?? m.sessionId)} ${dim(fg(C.sub, `· ${HARNESS_LABEL[m.harness]} · ${m.cwd ?? ""}`))}`, w));
    out.push(
      fit(
        ` ${dim(fg(C.sub, "session"))} ${m.sessionId}  ${dim(fg(C.sub, "binding"))} ${sel.binding?.method ?? "–"}  ${dim(fg(C.sub, "subagents"))} ${cash(m.subagentCostUsd, m.subagentCredits)}  ${dim(fg(C.sub, "started"))} ${m.firstTs ? fmtDateTime(m.firstTs) : "–"}`,
        w,
      ),
    );
  }
  return { lines: out.slice(0, h), listSize: model.agents.length, listHeight: h };
}

// ─── 3 Sessions ─────────────────────────────────────────────────────────────

export function renderSessions(ds: DataSource, model: Model, st: UiState, w: number, h: number): Omit<Frame, "tabs"> {
  if (st.session) return renderSessionDetail(ds.session(st.session.harness, st.session.sessionId), model, st, w, h);
  const out: string[] = [];
  const sessions = ds.recentSessions(Math.max(10, h));
  out.push(sectionTitle("RECENT SESSIONS", w, dim(fg(C.sub, "⏎ open"))));
  const cols = layoutColumns(
    [
      { title: "harness", width: 11 },
      { title: "session", width: 30, flex: true, min: 10 },
      { title: "project", width: 22, grow: 32 },
      { title: "last", width: 8, align: "right" },
      { title: "work tok", width: 8, align: "right" },
      { title: "spend", width: 9, align: "right" },
    ],
    w,
  );
  out.push(tableHeader(cols));
  const listHeight = Math.max(1, h - out.length);
  const start = Math.max(0, Math.min(st.scroll, Math.max(0, sessions.length - listHeight)));
  sessions.slice(start, start + listHeight).forEach((s, i) => {
    const idx = start + i;
    out.push(
      selectedRow(
        tableRow(cols, {
          harness: fg(C.sky, HARNESS_LABEL[s.harness] ?? s.harness),
          session: s.title ?? dim(s.id.slice(0, 18)),
          project: dim(fg(C.sub, s.cwd ? basename(s.cwd) : "")),
          last: fmtAgo(s.last),
          "work tok": fmtTokens(s.work),
          spend: cash(s.usd, s.credits),
        }),
        w,
        idx === st.selected,
      ),
    );
  });
  return { lines: out.slice(0, h), listSize: sessions.length, listHeight };
}

function renderSessionDetail(d: SessionDetail, model: Model, st: UiState, w: number, h: number): Omit<Frame, "tabs"> {
  const out: string[] = [];
  const m = d.metrics;
  out.push(sectionTitle(`${HARNESS_LABEL[d.harness].toUpperCase()} SESSION`, w, dim(fg(C.sub, "esc: back"))));
  if (!m) {
    out.push(dim(fg(C.sub, `  no data for ${d.sessionId}`)));
    return { lines: out, listSize: 0, listHeight: h };
  }
  out.push(fit(` ${bold(fg(C.text, m.title ?? m.sessionId))}  ${dim(fg(C.sub, `${m.cwd ?? ""} · ${m.model ?? ""} · ${m.billing}`))}`, w));
  out.push(
    fit(
      ` ${m.calls} calls · ${fg(C.text, fmtTokens(m.workTokens))} work · ${fmtTokens(m.cacheRead)} cache-read · ` +
        spend(m) +
        (m.billing === "copilot" && MONEY === "credits" ? dim(fg(C.sub, ` (${fmtUsd(m.costUsd)})`)) : "") +
        dim(fg(C.sub, ` · subagents `)) + cash(m.subagentCostUsd, m.subagentCredits),
      w,
    ),
  );
  const gw = Math.max(10, Math.min(40, w - 50));
  out.push(
    fit(
      ` context ${gauge(m.contextPct ?? 0, gw, { color: (m.contextPct ?? 0) >= 92 ? C.red : (m.contextPct ?? 0) >= 80 ? C.yellow : C.green })} ` +
        (m.contextPct != null ? `${fmtPct(m.contextPct)} of ${fmtTokens(m.contextLimit ?? 0)}` : `${fmtTokens(m.contextTokens ?? 0)} (limit unknown)`) +
        dim(fg(C.sub, `   cache hit ${m.cacheHitPct != null ? fmtPct(m.cacheHitPct) : "–"} · tok/s ${m.tpsP50 != null ? Math.round(m.tpsP50) : "–"} · ttft ${fmtMs(m.ttftP50)}`)),
      w,
    ),
  );
  const chronological = [...d.calls].reverse();
  const sparkW = Math.max(10, w - 22);
  const costs = chronological.slice(-sparkW).map((c) => (c.credits ?? 0) / 100 + (c.billing === "copilot" ? 0 : (c.cost_usd ?? 0)));
  out.push(fit(` ${dim(fg(C.sub, "spend/call"))}  ${sparkline(costs, SPEND_COLOR[m.billing] ?? C.blue)}`, w));
  out.push("");
  const cols = layoutColumns(
    [
      { title: "time", width: 8 },
      { title: "model", width: 18, flex: true, min: 8, max: 30 },
      { title: "input", width: 7, align: "right" },
      { title: "output", width: 7, align: "right" },
      { title: "cache rd", width: 8, align: "right" },
      { title: "cache wr", width: 8, align: "right" },
      { title: "ctx", width: 7, align: "right" },
      { title: "spend", width: 9, align: "right" },
      { title: "dur", width: 6, align: "right" },
      { title: "ttft", width: 6, align: "right" },
      { title: "tok/s", width: 5, align: "right" },
      { title: "who", width: 10 },
    ],
    w,
  );
  out.push(tableHeader(cols));
  const listHeight = Math.max(1, h - out.length);
  const start = Math.max(0, Math.min(st.scroll, Math.max(0, d.calls.length - listHeight)));
  for (const c of d.calls.slice(start, start + listHeight)) {
    const tps = c.itl_ms ? 1000 / c.itl_ms : c.duration_ms && c.duration_ms > 500 && c.output > 20 ? c.output / (c.duration_ms / 1000) : null;
    out.push(
      tableRow(cols, {
        time: dim(fg(C.sub, new Date(c.ts).toLocaleTimeString("en-GB"))),
        model: fg(C.text, c.model),
        input: fmtTokens(c.input),
        output: fmtTokens(c.output),
        "cache rd": fmtTokens(c.cache_read),
        "cache wr": fmtTokens(c.cache_write),
        ctx: fmtTokens(c.input + c.cache_read + c.cache_write),
        spend: cash(c.cost_usd ?? 0, c.billing === "copilot" ? (c.credits ?? 0) : 0),
        dur: fmtMs(c.duration_ms),
        ttft: fmtMs(c.ttft_ms),
        "tok/s": tps ? String(Math.round(tps)) : "",
        who: dim(fg(C.sub, c.is_subagent ? "subagent" : (c.initiator ?? "main"))),
      }),
    );
  }
  return { lines: out.slice(0, h), listSize: d.calls.length, listHeight };
}

// ─── 4 History ──────────────────────────────────────────────────────────────

export function renderHistory(model: Model, st: UiState, w: number, h: number): Omit<Frame, "tabs"> {
  const out: string[] = [];
  const periodLine =
    " " +
    dim(fg(C.sub, "period ")) +
    PERIODS.map((p) => (p === model.period ? bg(C.surface, bold(fg(C.text, ` ${PERIOD_LABEL[p]} `))) : fg(C.dim, ` ${PERIOD_LABEL[p]} `))).join("") +
    dim(fg(C.sub, "   group ")) +
    GROUPS.map((g) => (g === model.groupBy ? bg(C.surface, bold(fg(C.text, ` ${g === "cwd" ? "project" : g} `))) : fg(C.dim, ` ${g === "cwd" ? "project" : g} `))).join("");
  out.push(fit(periodLine, w));
  const t = model.periodTotals;
  out.push(
    fit(
      ` ${cash(t.costUsd, t.credits)} · ${bold(fg(C.text, fmtTokens(t.workTokens)))} work tok · ${fmtTokens(t.cacheRead)} cache-read · ${t.calls} calls · cache hit ${hitRate(t)}`,
      w,
    ),
  );
  out.push("");
  out.push(sectionTitle("LAST 30 DAYS", w));
  const byDay = new Map(model.daily.map((d) => [d.day, d]));
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - 29);
  const work: number[] = [];
  const copilotUsd: number[] = [];
  const otherUsd: number[] = [];
  for (let i = 0; i < 30; i++) {
    const d = new Date(start.getTime());
    d.setDate(start.getDate() + i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const row = byDay.get(key);
    work.push(row?.work ?? 0);
    copilotUsd.push((row?.credits ?? 0) / 100);
    otherUsd.push(row?.usd ?? 0);
  }
  const stretch = (v: number[]) => v.flatMap((x) => [x, x]);
  out.push(fit(` ${fg(C.sub, "work tok ")} ${sparkline(stretch(work), C.blue)}  ${dim(fg(C.sub, `max ${fmtTokens(Math.max(...work))}`))}`, w));
  out.push(fit(` ${fg(C.sub, "Copilot  ")} ${sparkline(stretch(copilotUsd), C.mauve)}  ${dim(fg(C.sub, `max ${money(MONEY, Math.max(...copilotUsd), Math.max(...copilotUsd) * 100)}`))}`, w));
  out.push(fit(` ${fg(C.sub, "other $  ")} ${sparkline(stretch(otherUsd), C.peach)}  ${dim(fg(C.sub, `max ${fmtUsd(Math.max(...otherUsd))}`))}`, w));
  const first = fmtDay(start.getTime());
  const last = fmtDay(model.at);
  out.push(fit(` ${" ".repeat(9)} ${dim(fg(C.sub, first))}${" ".repeat(Math.max(1, 60 - first.length - last.length))}${dim(fg(C.sub, last))}`, w));
  out.push("");
  const label = model.groupBy === "cwd" ? "project" : model.groupBy;
  out.push(sectionTitle(`BY ${label.toUpperCase()} · ${PERIOD_LABEL[model.period]}`, w));
  const keyOf = (g: (typeof model.groups)[number]) =>
    model.groupBy === "harness" ? (HARNESS_LABEL[g.key as Harness] ?? g.key) : model.groupBy === "cwd" ? shortPath(g.key) : g.key;
  const longest = Math.max(0, ...model.groups.map((g) => width(keyOf(g))));
  const cols = layoutColumns(
    [
      { title: label, width: 30, flex: true, min: 12, max: Math.min(48, Math.max(12, longest)) },
      { title: "calls", width: 6, align: "right" },
      { title: "work tok", width: 8, align: "right" },
      { title: "cache rd", width: 8, align: "right" },
      { title: "hit", width: 4, align: "right" },
      { title: "spend", width: 10, align: "right" },
      { title: "share", width: 14 },
    ],
    w,
  );
  out.push(tableHeader(cols));
  const listHeight = Math.max(1, h - out.length);
  const total = model.groups.reduce((s, g) => s + g.costUsd, 0) || 1;
  const start2 = Math.max(0, Math.min(st.scroll, Math.max(0, model.groups.length - listHeight)));
  for (const g of model.groups.slice(start2, start2 + listHeight)) {
    out.push(
      tableRow(cols, {
        [label]: fg(C.text, keyOf(g)),
        calls: String(g.calls),
        "work tok": fmtTokens(g.workTokens),
        "cache rd": fmtTokens(g.cacheRead),
        hit: hitRate(g),
        spend: cash(g.costUsd, g.credits),
        share: shareBar(g.costUsd / total, 14),
      }),
    );
  }
  if (model.groups.length === 0) out.push(dim(fg(C.sub, "  no usage in this period")));
  return { lines: out.slice(0, h), listSize: model.groups.length, listHeight };
}

function shortPath(p: string): string {
  const home = process.env.HOME ?? "";
  return home && p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

// ─── 5 Rules ────────────────────────────────────────────────────────────────

export function conditionText(rule: Rule): string {
  const meta = METRICS[rule.metric];
  const unit = meta?.unit ?? "";
  const val = (v: number) => (unit === "%" ? `${v}%` : unit === "$" ? `$${Number.isInteger(v) ? v : v.toFixed(2)}` : unit === "×" ? `${v}×` : `${v} ${unit}`);
  const op = rule.op === ">=" ? "≥" : "≤";
  let cond = "";
  if (rule.steps?.length) cond = `${op} ${rule.steps.map(val).join(", ")} (each once)`;
  else if (rule.every) cond = `every ${val(rule.every)}`;
  else if (rule.value != null) cond = `${op} ${val(rule.value)}`;
  const guards: string[] = [];
  if (rule.billing) guards.push(`${rule.billing} only`);
  if (rule.minCalls) guards.push(`after ${rule.minCalls} calls`);
  if (rule.maxDaysLeft != null) guards.push(`≤ ${rule.maxDaysLeft}d left`);
  if (rule.minElapsedPct != null) guards.push(`after ${rule.minElapsedPct}% of month`);
  return `${meta?.label ?? rule.metric} ${cond}${guards.length ? ` · ${guards.join(", ")}` : ""}`;
}

export function renderRules(model: Model, config: Config, st: UiState, w: number, h: number): Omit<Frame, "tabs"> {
  const out: string[] = [];
  const n = config.notify;
  const delivery =
    st.toastDelivery && st.toastDelivery !== "off"
      ? fg(C.green, `toast delivery "${st.toastDelivery}"`)
      : fg(C.yellow, 'herdr toast delivery is off: run `tu setup --apply` (alerts only colour the sidebar)');
  out.push(
    fit(
      ` ${dim(fg(C.sub, "notifications"))} ${n.enabled ? fg(C.green, "on") : fg(C.red, "off")}  ${dim(fg(C.sub, "cooldown"))} ${n.cooldownMinutes}m  ${dim(fg(C.sub, "sound"))} ${n.sound}  ${model.snoozedUntil ? fg(C.yellow, `snoozed until ${fmtClock(model.snoozedUntil)}`) : ""}  ${delivery}`,
      w,
    ),
  );
  const d = config.display;
  out.push(
    fit(
      ` ${dim(fg(C.sub, "display"))}  ${fg(C.blue, "v")} ${fg(C.text, d.style)} ${dim(fg(C.sub, `(${STYLE_HINT[d.style]})`))}  ${fg(C.blue, "m")} ${fg(C.text, d.money === "usd" ? "$" : "credits")}  ${fg(C.blue, "o")} ${dim(fg(C.sub, "agent money:"))} ${fg(C.text, d.agentScope)}  ${dim(fg(C.sub, "· sidebar and tab bar follow live"))}`,
      w,
    ),
  );
  out.push(sectionTitle(`RULES (${config.rules.filter((r) => r.enabled).length}/${config.rules.length} on)`, w, dim(fg(C.sub, "saved to config.jsonc automatically"))));
  const cols = layoutColumns(
    [
      { title: "on", width: 3 },
      { title: "toast", width: 5 },
      { title: "level", width: 10 },
      { title: "rule", width: 34, grow: 44 },
      { title: "condition", width: 40, flex: true, min: 12, max: 64 },
      { title: "active", width: 6, align: "right" },
      { title: "last fired", width: 10, align: "right" },
    ],
    w,
  );
  out.push(tableHeader(cols));
  const activeBy = new Map<string, number>();
  for (const a of model.alerts) activeBy.set(a.rule_id, (activeBy.get(a.rule_id) ?? 0) + 1);
  const lastBy = new Map<string, number>();
  for (const l of model.alertLog) if (!lastBy.has(l.rule_id)) lastBy.set(l.rule_id, l.ts);
  const listHeight = Math.max(1, h - out.length - 6);
  const start = Math.max(0, Math.min(st.scroll, Math.max(0, config.rules.length - listHeight)));
  config.rules.slice(start, start + listHeight).forEach((rule, i) => {
    const idx = start + i;
    const line = tableRow(cols, {
      on: rule.enabled ? fg(C.green, "[x]") : fg(C.faint, "[ ]"),
      toast: rule.notify ? fg(C.text, " 🔔") : fg(C.faint, " ·"),
      level: fg(levelColor(rule.level), `${LEVEL_GLYPH[rule.level]} ${rule.level}`),
      rule: rule.enabled ? fg(C.text, rule.title) : dim(fg(C.sub, rule.title)),
      condition: dim(fg(C.sub, conditionText(rule))),
      active: activeBy.get(rule.id) ? fg(levelColor(rule.level), String(activeBy.get(rule.id))) : "",
      "last fired": lastBy.get(rule.id) ? fmtAgo(lastBy.get(rule.id)) : "",
    });
    out.push(selectedRow(line, w, idx === st.selected));
  });
  const sel = config.rules[st.selected];
  if (sel) {
    out.push("");
    out.push(sectionTitle("SELECTED RULE", w));
    out.push(fit(` ${bold(fg(C.text, sel.title))} ${dim(fg(C.sub, `(${sel.id})`))}`, w));
    out.push(fit(` ${conditionText(sel)}`, w));
    const fired = model.alertLog.filter((l) => l.rule_id === sel.id).slice(0, 2);
    for (const f of fired) out.push(fit(` ${dim(fg(C.sub, fmtAgo(f.ts)))} ${f.message}`, w));
    if (st.confirmReset) out.push(fg(C.yellow, " Reset all rules to defaults? press R again to confirm, esc to cancel"));
  }
  return { lines: out.slice(0, h), listSize: config.rules.length, listHeight };
}
