import { DEFAULT_RULES, METRICS, saveConfig } from "../core/config.ts";
import type { Rule } from "../core/config.ts";
import { DISPLAY_STYLES } from "../core/display.ts";
import { isSnoozed } from "../core/rules.ts";
import { harnessOf } from "../core/binding.ts";
import { notify } from "../herdr/client.ts";
import { checkConfig, readHerdrConfig } from "../commands/herdrconfig.ts";
import { log } from "../util/log.ts";
import { MINUTE } from "../util/time.ts";
import { chartTabsBar, renderCharts } from "./chartsview.ts";
import type { ImageBox } from "./chartsview.ts";
import { CHART_TABS, buildChartsData } from "./chartsdata.ts";
import type { ChartTab, ChartsData } from "./chartsdata.ts";
import { free, hide, place, probeSequence, takeReplies, transmit } from "./kitty.ts";
import type { Replies } from "./kitty.ts";
import { frameLayout } from "./frame.ts";
import { DataSource, GROUPS, PERIODS } from "./model.ts";
import type { GroupBy, Model, PeriodId } from "./model.ts";
import { enter, invalidate, leave, parseKeys, size, draw } from "./term.ts";
import type { Key } from "./term.ts";
import { C, dim, fg } from "./style.ts";
import { VIEW_IDS, footer, header, renderAgents, renderHistory, renderRules, renderSessions, renderSummary, setMoneyUnit } from "./views.ts";
import type { Frame, UiState, ViewId } from "./views.ts";

const REFRESH_MS = 2000;
const LEVELS: Array<Rule["level"]> = ["low", "high", "critical"];

function indent(lines: string[], margin: number): string[] {
  return margin > 0 ? lines.map((l) => " ".repeat(margin) + l) : lines;
}

function toastDelivery(): string | null {
  try {
    const check = checkConfig(readHerdrConfig()).find((c) => c.id === "toast");
    if (!check) return null;
    const m = /"([^"]+)"/.exec(check.detail);
    return check.state === "ok" ? (m?.[1] ?? "on") : "off";
  } catch {
    return null;
  }
}

/** Charts data is only built for the tab on screen, and only while the Charts view is open. */
function chartsFor(ds: DataSource, model: Model, tab: ChartTab): ChartsData {
  return buildChartsData(ds.rt, tab, model.agents, model.workspaceLabels, model.quota);
}

/** Pixel charts: probed at start-up, toggled with `k` on the Charts view. */
export type PixelMode = "probing" | "on" | "off" | "unsupported";
export interface PixelState {
  mode: PixelMode;
  cell: { w: number; h: number } | null;
}

const PIXEL_NOTE: Record<PixelMode, string | null> = {
  probing: null,
  on: null,
  off: "k: show the burn-up as a pixel chart (Kitty graphics)",
  unsupported: "pixel charts need Kitty graphics (Ghostty, kitty, WezTerm) through herdr; none detected here · k forces them on",
};

type Body = Omit<Frame, "tabs"> & { images?: ImageBox[]; chartTabs?: Array<{ tab: ChartTab; x0: number; x1: number }> };

/** Body lines for the current view (shared by the interactive app and snapshots). */
function renderBody(ds: DataSource, model: Model, charts: ChartsData | null, st: UiState, cols: number, bodyH: number, px?: PixelState): Body {
  setMoneyUnit(ds.rt.config.display.money);
  switch (st.view) {
    case 1:
      return renderSummary(model, st, cols, bodyH);
    case 2:
      return renderAgents(model, st, cols, bodyH);
    case 3:
      return renderSessions(ds, model, st, cols, bodyH);
    case 4:
      return renderHistory(model, st, cols, bodyH);
    case 5:
      return renderRules(model, ds.rt.config, st, cols, bodyH);
    case 6: {
      const mode = px?.mode ?? "off";
      const bar = chartTabsBar(st.chartTab, cols);
      const { lines: all, images } = renderCharts(charts?.tab === st.chartTab ? charts : chartsFor(ds, model, st.chartTab), cols, {
        pixels: mode === "on",
        pixelNote: PIXEL_NOTE[mode],
        burnup: model.burnup,
        unit: ds.rt.config.display.money,
        cell: px?.cell ?? null,
      });
      // The tab strip stays put; the tab's sections scroll beneath it.
      const viewH = Math.max(1, bodyH - 1);
      const start = Math.max(0, Math.min(st.scroll, Math.max(0, all.length - viewH)));
      // Images only show while fully on screen; scrolling moves them with their text.
      const visible = images.filter((im) => im.line >= start && im.line + im.rows <= start + viewH).map((im) => ({ ...im, line: im.line - start + 1 }));
      return { lines: [bar.line, ...all.slice(start, start + viewH)], listSize: all.length, listHeight: viewH, images: visible, chartTabs: bar.tabs };
    }
  }
}

/**
 * One whole frame (header, view, footer) as the dashboard draws it at `cols` ×
 * `rows`, centred on wide panes. Used by `--snapshot` and the docs renders.
 */
export function renderFrame(
  ds: DataSource,
  model: Model,
  st: UiState,
  cols: number,
  rows: number,
  opts: { charts?: ChartsData | null; px?: PixelState } = {},
): { lines: string[]; images: ImageBox[]; margin: number } {
  const { w, margin } = frameLayout(cols);
  const body = renderBody(ds, model, opts.charts ?? null, st, w, rows - 2, opts.px);
  return { lines: indent([header(model, st, w).line, ...body.lines, footer(st, w)], margin), images: body.images ?? [], margin };
}

/**
 * Render one view without a TTY, for tests, docs and debugging:
 * `tu dashboard --snapshot [--view N] [--tab live|spend|models|patterns] [--cols N] [--rows N] [--scroll N] [--plain] [--no-publish]`.
 */
async function snapshot(args: string[]): Promise<number> {
  const opt = (name: string, def: number) => {
    const i = args.indexOf(name);
    return i >= 0 ? Number(args[i + 1]) : def;
  };
  const view = opt("--view", 1) as ViewId;
  const tabArg = args[args.indexOf("--tab") + 1] as ChartTab;
  const cols = opt("--cols", 120);
  const rows = opt("--rows", 40);
  const ds = new DataSource();
  try {
    const model = await ds.build("today", "harness", Math.max(12, Math.min(144, frameLayout(cols).w - 4)), {
      dryRun: args.includes("--no-publish"),
    });
    const st: UiState = {
      view,
      chartTab: args.includes("--tab") && CHART_TABS.includes(tabArg) ? tabArg : "live",
      selected: 0,
      scroll: opt("--scroll", 0),
      session: null,
      edit: null,
      confirmReset: false,
      flash: null,
      toastDelivery: toastDelivery(),
    };
    const text = renderFrame(ds, model, st, cols, rows).lines.join("\n") + "\n";
    process.stdout.write(args.includes("--plain") ? text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "") : text);
    return 0;
  } finally {
    ds.close();
  }
}

export async function run(args: string[]): Promise<number> {
  if (args.includes("--snapshot")) return snapshot(args);
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    process.stderr.write("dashboard needs a terminal; try `tu report`\n");
    return 1;
  }
  const ds = new DataSource();
  const st: UiState = {
    view: 1,
    chartTab: "live",
    selected: 0,
    scroll: 0,
    session: null,
    edit: null,
    confirmReset: false,
    flash: null,
    toastDelivery: toastDelivery(),
  };
  let period: PeriodId = "today";
  let groupBy: GroupBy = "harness";
  let model: Model | null = null;
  let charts: ChartsData | null = null;
  let frame: Frame | null = null;
  let chartTabs: Body["chartTabs"] = [];
  let refreshing = false;
  let pending = false;
  let closed = false;
  let finish: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });

  // Kitty graphics: one image id for the pixel burn-up.
  const IMAGE_ID = 7301;
  const px: PixelState = { mode: "probing", cell: null };
  const replies: Replies = {};
  const image = { key: "", sentAt: 0, placed: "" };
  /** `redrawn`: screen rows (0-based) this frame rewrote. */
  const syncImage = (img: ImageBox | undefined, margin: number, redrawn: number[]) => {
    if (!img || px.mode !== "on") {
      if (image.placed) process.stdout.write(hide(IMAGE_ID));
      image.placed = "";
      return;
    }
    let out = "";
    const now = Date.now();
    // Re-send the PNG when the picture changes: at once for a new size, else at most every 10 s.
    const size = img.key.split(":").slice(0, 4).join(":");
    let sent = false;
    if (img.key !== image.key && (!image.key.startsWith(size + ":") || now - image.sentAt > 10_000)) {
      try {
        out += transmit(IMAGE_ID, img.png());
        image.key = img.key;
        image.sentAt = now;
        sent = true;
      } catch (err) {
        log.warn(`pixel chart: ${(err as Error).message}`);
      }
    }
    if (image.key) {
      // Place again only when needed: new data, a new position, or text redrawn over its cells.
      const at = place(IMAGE_ID, img.line + 2, img.col + margin, img.cols, img.rows);
      const covered = redrawn.some((row) => row > img.line && row <= img.line + img.rows);
      if (sent || covered || at !== image.placed) {
        out += at;
        image.placed = at;
      }
    }
    if (out) process.stdout.write(out);
  };

  const render = () => {
    // A refresh can finish after quitting; never draw over the restored terminal.
    if (closed) return;
    const { cols, rows } = size();
    const { w, margin } = frameLayout(cols);
    const hdr = header(model, st, w);
    const bodyH = Math.max(1, rows - 2);
    let body: Body;
    try {
      if (!model) body = { lines: ["", fg(C.sub, "  loading usage data… (first run indexes your history)")], listSize: 0, listHeight: 1 };
      else {
        if (st.view === 6 && charts?.tab !== st.chartTab) charts = chartsFor(ds, model, st.chartTab);
        body = renderBody(ds, model, charts, st, w, bodyH, px);
      }
    } catch (err) {
      log.error("render", err);
      body = { lines: ["", fg(C.red, `  render error: ${(err as Error).message}`)], listSize: 0, listHeight: 1 };
    }
    const lines = [hdr.line, ...body.lines];
    while (lines.length < rows - 1) lines.push("");
    lines.length = rows - 1;
    lines.push(footer(st, w));
    frame = { ...body, tabs: hdr.tabs.map((t) => ({ ...t, x0: t.x0 + margin, x1: t.x1 + margin })) };
    chartTabs = (body.chartTabs ?? []).map((t) => ({ ...t, x0: t.x0 + margin, x1: t.x1 + margin }));
    const redrawn = draw(indent(lines, margin));
    syncImage(body.images?.[0], margin, redrawn);
  };

  // Input arrives in bursts (a wheel flick is a dozen events): draw at most one frame per FRAME_MS.
  const FRAME_MS = 30;
  let frameTimer: ReturnType<typeof setTimeout> | null = null;
  let lastFrameAt = 0;
  const requestRender = () => {
    if (frameTimer) return;
    frameTimer = setTimeout(
      () => {
        frameTimer = null;
        lastFrameAt = Date.now();
        render();
      },
      Math.max(0, lastFrameAt + FRAME_MS - Date.now()),
    );
  };

  const refresh = async () => {
    if (closed) return;
    if (refreshing) {
      pending = true;
      return;
    }
    refreshing = true;
    try {
      const { w } = frameLayout(size().cols);
      ds.reloadConfig();
      model = await ds.build(period, groupBy, Math.max(12, Math.min(144, w - 4)));
      if (closed) return;
      charts = st.view === 6 ? chartsFor(ds, model, st.chartTab) : null;
    } catch (err) {
      if (closed) return;
      log.error("dashboard refresh", err);
      st.flash = { text: `refresh failed: ${(err as Error).message}`, until: Date.now() + 4000 };
    } finally {
      refreshing = false;
      requestRender();
      if (pending) {
        pending = false;
        void refresh();
      }
    }
  };

  const flash = (text: string) => {
    st.flash = { text, until: Date.now() + 2500 };
  };

  const setView = (v: ViewId) => {
    if (st.view !== v) {
      st.view = v;
      st.selected = 0;
      st.scroll = 0;
      st.confirmReset = false;
    }
  };

  const setChartTab = (tab: ChartTab) => {
    if (st.chartTab === tab) return;
    st.chartTab = tab;
    st.scroll = 0;
  };

  const clampSelection = () => {
    const n = frame?.listSize ?? 0;
    st.selected = Math.max(0, Math.min(st.selected, Math.max(0, n - 1)));
    const h = Math.max(1, frame?.listHeight ?? 1);
    if (st.selected < st.scroll) st.scroll = st.selected;
    if (st.selected >= st.scroll + h) st.scroll = st.selected - h + 1;
  };

  const scrollOnly = () => st.view === 4 || st.view === 6 || (st.view === 3 && st.session != null);

  const move = (delta: number) => {
    if (scrollOnly()) {
      const max = st.view === 6 ? Math.max(0, (frame?.listSize ?? 0) - (frame?.listHeight ?? 0)) : Math.max(0, (frame?.listSize ?? 0) - 1);
      st.scroll = Math.max(0, Math.min(st.scroll + delta, max));
    } else {
      st.selected += delta;
      clampSelection();
    }
  };

  /** Lab: switch how the real sidebar and tab bar look, then republish. */
  const setDisplay = (patch: Partial<typeof ds.rt.config.display>, label: string) => {
    ds.rt.config.display = { ...ds.rt.config.display, ...patch };
    try {
      saveConfig(ds.rt.config);
      flash(`${label} · sidebar updates now, tab bar within 5 s`);
    } catch (err) {
      flash(`could not save config: ${(err as Error).message}`);
    }
    void refresh();
  };

  const saveRules = (msg: string) => {
    try {
      saveConfig(ds.rt.config);
      flash(`saved · ${msg}`);
    } catch (err) {
      flash(`could not save config: ${(err as Error).message}`);
    }
  };

  const adjustRule = (rule: Rule, dir: 1 | -1) => {
    const step = METRICS[rule.metric]?.step ?? 1;
    const round = (v: number) => Math.round(v / step) * step;
    const clean = (v: number) => Number(round(v).toPrecision(6));
    if (rule.steps?.length) rule.steps = rule.steps.map((s) => clean(Math.max(step, s + dir * step)));
    else if (rule.every) rule.every = clean(Math.max(step, rule.every + dir * step));
    else if (rule.value != null) rule.value = clean(Math.max(0, rule.value + dir * step));
    saveRules(`${rule.title}`);
  };

  const commitEdit = () => {
    const rule = ds.rt.config.rules[st.selected];
    const buf = st.edit?.buffer.trim() ?? "";
    st.edit = null;
    if (!rule || !buf) return;
    const nums = buf.split(/[,\s]+/).filter(Boolean).map(Number);
    if (nums.length === 0 || nums.some((x) => !Number.isFinite(x) || x < 0)) {
      flash("not a number: nothing changed");
      return;
    }
    if (rule.steps?.length) rule.steps = [...nums].sort((a, b) => a - b);
    else if (rule.every) rule.every = nums[0];
    else rule.value = nums[0];
    saveRules(rule.title);
  };

  const openSession = () => {
    if (!model) return;
    if (st.view === 1 || st.view === 2) {
      const r = model.agents[st.selected];
      const harness = harnessOf(r?.agent.agent);
      if (r?.binding?.sessionId && harness) {
        st.session = { harness, sessionId: r.binding.sessionId };
        st.view = 3;
        st.scroll = 0;
      } else flash("no session bound to this pane yet");
    } else if (st.view === 3 && !st.session) {
      const s = ds.recentSessions(Math.max(10, size().rows))[st.selected];
      if (s) {
        st.session = { harness: s.harness, sessionId: s.id };
        st.scroll = 0;
      }
    }
  };

  const onKey = (key: Key) => {
    if (st.edit) {
      if (key.name === "enter") commitEdit();
      else if (key.name === "escape") st.edit = null;
      else if (key.name === "backspace") st.edit.buffer = st.edit.buffer.slice(0, -1);
      else if (key.name === "char" && /[0-9., ]/.test(key.ch)) st.edit.buffer += key.ch;
      return;
    }
    switch (key.name) {
      case "ctrl-c":
        finish();
        return;
      case "escape":
        if (st.confirmReset) st.confirmReset = false;
        else if (st.view === 3 && st.session) {
          st.session = null;
          st.scroll = 0;
        } else finish();
        return;
      case "up":
        move(-1);
        return;
      case "down":
        move(1);
        return;
      case "pageup":
        move(-Math.max(1, (frame?.listHeight ?? 10) - 1));
        return;
      case "pagedown":
        move(Math.max(1, (frame?.listHeight ?? 10) - 1));
        return;
      case "home":
        st.selected = 0;
        st.scroll = 0;
        return;
      case "end":
        move(1_000_000);
        return;
      case "wheel":
        move(key.dir * 3);
        return;
      case "tab":
        setView(VIEW_IDS[(VIEW_IDS.indexOf(st.view) + 1) % VIEW_IDS.length]);
        return;
      case "backtab":
        setView(VIEW_IDS[(VIEW_IDS.indexOf(st.view) + VIEW_IDS.length - 1) % VIEW_IDS.length]);
        return;
      case "enter":
        openSession();
        return;
      case "left":
      case "right": {
        if (st.view !== 6) return;
        const n = CHART_TABS.length;
        setChartTab(CHART_TABS[(CHART_TABS.indexOf(st.chartTab) + (key.name === "right" ? 1 : n - 1)) % n]);
        return;
      }
      case "click": {
        if (key.y === 0) {
          const tab = frame?.tabs.find((t) => key.x >= t.x0 && key.x < t.x1);
          if (tab) setView(tab.view);
        } else if (key.y === 1 && st.view === 6) {
          const tab = chartTabs?.find((t) => key.x >= t.x0 && key.x < t.x1);
          if (tab) setChartTab(tab.tab);
        }
        return;
      }
      case "char":
        break;
      default:
        return;
    }
    const ch = key.ch;
    if (ch === "q") return finish();
    if (ch >= "1" && ch <= "6") return setView(Number(ch) as ViewId);
    if (st.view === 6 && st.chartTab === "spend" && ch === "k" && px.mode !== "probing") {
      flash(
        px.mode === "unsupported"
          ? "forcing pixel charts: if nothing appears, this terminal can't show Kitty graphics"
          : `pixel charts ${px.mode === "on" ? "off" : "on"}`,
      );
      px.mode = px.mode === "on" ? "off" : "on";
      return;
    }
    if (st.view === 5) {
      const d = ds.rt.config.display;
      if (ch === "v") {
        const next = DISPLAY_STYLES[(DISPLAY_STYLES.indexOf(d.style) + 1) % DISPLAY_STYLES.length];
        return setDisplay({ style: next }, `style: ${next}`);
      }
      if (ch === "m") {
        const next = d.money === "usd" ? "credits" : "usd";
        return setDisplay({ money: next }, `money: ${next === "usd" ? "$" : "credits"}`);
      }
      if (ch === "o") {
        const next = d.agentScope === "today" ? "session" : "today";
        return setDisplay({ agentScope: next }, `agent money: ${next}`);
      }
    }
    if (ch === "r") {
      flash("refreshing…");
      void refresh();
      return;
    }
    if (ch === "s") {
      const snoozed = isSnoozed(ds.rt.ledger);
      if (snoozed) ds.rt.ledger.deleteMeta("snooze_until");
      else ds.rt.ledger.setMeta("snooze_until", String(Date.now() + 60 * MINUTE));
      flash(snoozed ? "alerts resumed" : "alerts snoozed for 1 hour");
      void refresh();
      return;
    }
    if (ch === "p" && (st.view === 1 || st.view === 4)) {
      period = PERIODS[(PERIODS.indexOf(period) + 1) % PERIODS.length];
      st.scroll = 0;
      void refresh();
      return;
    }
    if (ch === "g" && st.view === 4) {
      groupBy = GROUPS[(GROUPS.indexOf(groupBy) + 1) % GROUPS.length];
      st.scroll = 0;
      void refresh();
      return;
    }
    if (st.view === 5) onRulesKey(ch);
  };

  const onRulesKey = (ch: string) => {
    const rules = ds.rt.config.rules;
    const rule = rules[st.selected];
    if (ch === "R") {
      if (!st.confirmReset) {
        st.confirmReset = true;
        return;
      }
      st.confirmReset = false;
      ds.rt.config.rules = structuredClone(DEFAULT_RULES);
      saveRules("rules reset to defaults");
      return;
    }
    if (ch === "t") {
      void notify("Token usage: test alert", "If you can see this, usage alerts will reach you.", ds.rt.config.notify.sound)
        .then((reason) =>
          flash(
            st.toastDelivery === "off"
              ? 'sent, but herdr toast delivery is "off": run `tu setup --apply`'
              : `test toast sent (${reason})`,
          ),
        )
        .catch((err: Error) => flash(`toast failed: ${err.message}`))
        .finally(requestRender);
      return;
    }
    if (ch === "N") {
      ds.rt.config.notify.enabled = !ds.rt.config.notify.enabled;
      saveRules(`notifications ${ds.rt.config.notify.enabled ? "on" : "off"}`);
      return;
    }
    if (!rule) return;
    switch (ch) {
      case " ":
        rule.enabled = !rule.enabled;
        saveRules(`${rule.title} ${rule.enabled ? "on" : "off"}`);
        break;
      case "n":
        rule.notify = !rule.notify;
        saveRules(`${rule.title}: toast ${rule.notify ? "on" : "off"}`);
        break;
      case "l":
        rule.level = LEVELS[(LEVELS.indexOf(rule.level) + 1) % LEVELS.length];
        saveRules(`${rule.title}: level ${rule.level}`);
        break;
      case "+":
      case "=":
        adjustRule(rule, 1);
        break;
      case "-":
      case "_":
        adjustRule(rule, -1);
        break;
      case "e":
        st.edit = {
          buffer: rule.steps?.length ? rule.steps.join(", ") : String(rule.every ?? rule.value ?? ""),
        };
        break;
    }
  };

  enter();
  // Ask whether Kitty graphics work here; replies are filtered out of stdin below.
  process.stdout.write(probeSequence());
  const probeTimer = setTimeout(() => {
    if (px.mode === "probing") {
      px.mode = "unsupported";
      requestRender();
    }
  }, 1500);
  const restore = () => {
    try {
      if (image.key) process.stdout.write(free(IMAGE_ID));
      leave();
    } catch {
      // terminal already gone
    }
  };
  process.on("exit", restore);
  for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"] as const) process.on(sig, () => finish());
  process.stdout.on("resize", () => {
    // The terminal may have reflowed or cleared: redraw every line.
    invalidate();
    image.placed = "";
    requestRender();
  });
  process.stdin.on("data", (data: string) => {
    const input = takeReplies(String(data), replies);
    if (replies.cell) px.cell = replies.cell;
    if (px.mode === "probing" && (replies.kitty !== undefined || replies.da1)) px.mode = replies.kitty ? "on" : "unsupported";
    if (replies.errors?.length) {
      log.warn(`kitty graphics: ${replies.errors.join("; ")}`);
      replies.errors = [];
    }
    for (const key of parseKeys(input)) onKey(key);
    requestRender();
  });
  render();
  const timer = setInterval(() => void refresh(), REFRESH_MS);
  void refresh();
  await done;
  closed = true;
  clearInterval(timer);
  clearTimeout(probeTimer);
  if (frameTimer) clearTimeout(frameTimer);
  restore();
  ds.close();
  process.stdout.write(dim(""));
  return 0;
}
