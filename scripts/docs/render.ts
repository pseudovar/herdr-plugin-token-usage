/**
 * Render the docs images from synthetic demo data:
 *   npm run docs:shots
 * Everything is drawn by the plugin's own renderers against a seeded demo
 * ledger and a fake herdr socket (see demo.ts); nothing on this machine is read.
 */
import { NOW, SANDBOX } from "./sandbox.ts";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DISPLAY_STYLES, agentTokens, spaceTokens, tabBarText } from "../../src/core/display.ts";
import type { DisplayConfig } from "../../src/core/display.ts";
import { buildSpaceView, tabView } from "../../src/core/publish.ts";
import { totals } from "../../src/core/metrics.ts";
import { renderFrame } from "../../src/ui/app.ts";
import type { PixelState } from "../../src/ui/app.ts";
import { CHART_TABS } from "../../src/ui/chartsdata.ts";
import { DataSource } from "../../src/ui/model.ts";
import type { Model } from "../../src/ui/model.ts";
import { C, bg, bold, dim, fg, width } from "../../src/ui/style.ts";
import type { UiState } from "../../src/ui/views.ts";
import { openDemo } from "./demo.ts";
import type { LiveAgent } from "./demo.ts";
import { CELL_H, CELL_W, blankGrid, blit, grid, windowSvg } from "./term-svg.ts";
import type { Grid, ImageOverlay } from "./term-svg.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(ROOT, "docs", "public", "shots");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const ui = (over: Partial<UiState>): UiState => ({
  view: 1,
  chartTab: "live",
  selected: 0,
  scroll: 0,
  session: null,
  edit: null,
  confirmReset: false,
  flash: null,
  toastDelivery: "herdr",
  ...over,
});

const written: string[] = [];
function save(name: string, svg: string): void {
  writeFileSync(join(OUT, name), svg);
  written.push(name);
}

/** A dashboard view in a terminal window, sized to its content. */
function dashboardShot(ds: DataSource, model: Model, st: UiState, name: string, title: string, rows: number, cols = 160, px?: PixelState): void {
  const frame = renderFrame(ds, model, st, cols, rows, { px });
  // Trim the blank space between the last line of content and the footer.
  const lines = frame.lines;
  const footer = lines[lines.length - 1];
  const body = lines.slice(0, -1);
  while (body.length > 1 && body[body.length - 1].replace(/\x1b\[[0-9;]*m/g, "").trim() === "") body.pop();
  const g = grid([...body, "", footer], cols);
  const images: ImageOverlay[] = frame.images.map((im) => ({
    row: im.line + 1,
    col: im.col - 1 + frame.margin,
    cols: im.cols,
    rows: im.rows,
    href: `data:image/png;base64,${im.png().toString("base64")}`,
  }));
  save(name, windowSvg(g, { title, images }));
}

const STATE_ICON: Record<string, string> = { working: fg(C.yellow, "●"), blocked: fg(C.red, "!"), done: fg(C.green, "✓"), idle: dim(fg(C.sub, "○")) };
const LEVEL_RULE = (v: string | null) => (!v ? "" : v.startsWith("■") ? bold(fg(C.red, v)) : v.startsWith("▲") ? fg(C.yellow, v) : v.startsWith("▽") ? fg(C.green, v) : fg(C.text, v));
const BRANCHES = ["feat/apple-pay ±4", "main ✓", "plan/vpc-peering ±1", "drafts ±2"];

/**
 * herdr's sidebar with the rows `tu setup --apply` writes: spaces, then agents.
 * Rows whose token is empty disappear, as they do in herdr.
 */
function sidebarLines(model: Model, live: LiveAgent[], display: DisplayConfig): string[] {
  const out: string[] = [];
  const row = (s: string) => out.push(" " + s);
  const todayUsd = totals(dsLedger(), { since: NOW - (NOW % 86_400_000) }).costUsd;
  row(bold(fg(C.dim, "SPACES")));
  live.forEach((l, i) => {
    const view = buildSpaceView(dsLedger(), l.workspace.workspace_id, levelOf(model, l), [l.agent], todayUsd, NOW);
    const t = spaceTokens(view, display);
    row(`${STATE_ICON[l.agent.agent_status]} ${fg(C.text, l.workspace.label)}`);
    row(`  ${dim(fg(C.sub, BRANCHES[i]))}`);
    if (t.tu_ws) row(`  ${LEVEL_RULE(t.tu_ws)}`);
    if (t.tu_ws_more) row(`  ${dim(fg(C.sub, t.tu_ws_more))}`);
    out.push("");
  });
  row(bold(fg(C.dim, "AGENTS")));
  live.forEach((l) => {
    const result = model.agents.find((a) => a.agent.pane_id === l.agent.pane_id);
    const t = agentTokens(result?.view ?? null, display);
    row(`${STATE_ICON[l.agent.agent_status]} ${fg(C.text, l.workspace.label)} ${dim(fg(C.sub, "1"))}`);
    row(`  ${fg(C.sky, l.agent.agent)}${t.tu_sub ? " " + dim(fg(C.sub, t.tu_sub)) : ""}`);
    if (t.tu) row(`  ${LEVEL_RULE(t.tu)}`);
    if (t.tu_more) row(`  ${dim(fg(C.sub, t.tu_more))}`);
    out.push("");
  });
  out.pop();
  return out;
}

let ledgerRef: DataSource | null = null;
const dsLedger = () => ledgerRef!.rt.ledger;
const levelOf = (model: Model, l: LiveAgent) => model.agents.find((a) => a.agent.pane_id === l.agent.pane_id)?.level ?? "normal";

function tabBar(model: Model, display: DisplayConfig): string {
  return tabBarText(tabView(dsLedger(), model.quota, model.quotaLevel, NOW), display);
}

/** The four display styles side by side, each with its tab-bar line underneath. */
function stylesShot(model: Model, live: LiveAgent[], base: DisplayConfig): void {
  const W = 26;
  const gap = 4;
  const panels = DISPLAY_STYLES.map((style) => sidebarLines(model, live, { ...base, style }));
  const rows = Math.max(...panels.map((p) => p.length)) + 2;
  const cols = DISPLAY_STYLES.length * W + (DISPLAY_STYLES.length - 1) * gap;
  const g = blankGrid(cols, rows, null);
  DISPLAY_STYLES.forEach((style, i) => {
    const x = i * (W + gap);
    blit(g, grid([` ${bold(fg(C.lavender, style))}${style === "rich" ? dim(fg(C.sub, " (default)")) : ""}`], W), 0, x);
    blit(g, grid(panels[i], W, "#181825"), 2, x);
  });
  save("sidebar-styles.svg", windowSvg(g, { title: "herdr sidebar · display styles: rich, visual, text, spark" }));
  const tabs = DISPLAY_STYLES.map((style) => `${dim(fg(C.sub, style.padEnd(7)))} ${fg(C.text, tabBar(model, { ...base, style }))}`);
  save("tabbar-styles.svg", windowSvg(grid(tabs, 92), { title: "herdr tab bar · the same four styles" }));
}

/** herdr itself: tab bar, the sidebar with this plugin's rows, an agent pane, and the dashboard popup on top. */
function heroShot(ds: DataSource, model: Model, live: LiveAgent[], display: DisplayConfig): string {
  const SIDE = 26;
  const MAIN = 129;
  const ROWS = 54;
  const cols = SIDE + 1 + MAIN;
  const g = blankGrid(cols, ROWS + 1, C.base);
  // Tab bar across the top: the workspace's tabs, then this plugin's summary on the right.
  const right = fg(C.sub, tabBar(model, display));
  const tabs = " " + bg(C.sky, bold(fg(C.base, " 1 agent "))) + fg(C.sub, " 2 tests  3 shell ");
  blit(g, grid([`${tabs}${" ".repeat(Math.max(1, cols - width(tabs) - width(right) - 1))}${right} `], cols, "#11111b"), 0, 0);
  // Sidebar and separator.
  const side = sidebarLines(model, live, display).slice(0, ROWS);
  blit(g, grid([...side, ...Array.from({ length: ROWS - side.length }, () => "")], SIDE, "#181825"), 1, 0);
  for (let r = 1; r <= ROWS; r++) blit(g, grid([fg(C.surface, "│")], 1), r, SIDE);
  // The focused agent pane, mostly hidden behind the popup.
  const pane = [
    `${fg(C.mauve, "π")} ${bold(fg(C.text, "acme-checkout"))} ${dim(fg(C.sub, "· claude-opus-5.5 · 412k / 1M ctx"))}`,
    "",
    `${fg(C.blue, "›")} ${fg(C.text, "Add Apple Pay as a payment method in the checkout flow; keep the card path working.")}`,
  ];
  const tail = [`${fg(C.green, "●")} ${fg(C.text, "Edit")} ${dim(fg(C.sub, "src/checkout/PaymentStep.tsx  +38 −6"))}`, `${fg(C.green, "●")} ${fg(C.text, "Bash")} ${dim(fg(C.sub, "npm test -- payments   ✓ 214 passed"))}`, `${fg(C.blue, "›")} ${dim(fg(C.sub, "Working… (esc to interrupt)"))}`];
  blit(g, grid(pane.map((l) => " " + l), MAIN, C.base), 1, SIDE + 1);
  blit(g, grid(tail.map((l) => " " + l), MAIN, C.base), ROWS - 2, SIDE + 1);
  // The popup: 92% × 88% of the pane area with herdr's accent border, the dashboard inside.
  const pw = Math.floor((MAIN * 92) / 100);
  const ph = Math.floor((ROWS * 88) / 100);
  const px0 = SIDE + 1 + Math.floor((MAIN - pw) / 2);
  const py0 = 1 + Math.floor((ROWS - ph) / 2);
  const accent = C.sky;
  const title = " Token usage ";
  const border = [
    fg(accent, "┌─") + bold(fg(accent, title)) + fg(accent, "─".repeat(pw - 3 - title.length) + "┐"),
    ...Array.from({ length: ph - 2 }, () => fg(accent, "│") + " ".repeat(pw - 2) + fg(accent, "│")),
    fg(accent, "└" + "─".repeat(pw - 2) + "┘"),
  ];
  blit(g, grid(border, pw, C.base), py0, px0);
  const inner = pw - 2 - 1 - 1;
  const frame = renderFrame(ds, model, ui({ view: 1 }), inner, ph - 2);
  blit(g, grid(frame.lines, inner, C.base), py0 + 1, px0 + 1);
  const svg = windowSvg(g, { title: "herdr — token usage", bg: C.base });
  save("hero.svg", svg);
  return svg;
}

/** A 1280 × 640 card for GitHub's social preview and the docs' Open Graph image. */
function socialSvg(hero: string): string {
  const W = 1280;
  const H = 640;
  const heroW = Number(/width="(\d+)"/.exec(hero)?.[1]);
  const heroH = Number(/height="(\d+)"/.exec(hero)?.[1]);
  const scale = 760 / heroW;
  const inner = hero.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  const logo = readFileSync(join(ROOT, "docs", "public", "logo.svg"), "utf8").replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<defs><linearGradient id="bgfade" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#181825"/><stop offset="1" stop-color="#11111b"/></linearGradient></defs>` +
    `<rect width="${W}" height="${H}" fill="url(#bgfade)"/>` +
    `<g transform="translate(64 70) scale(1.1)">${logo}</g>` +
    `<g font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">` +
    `<text x="64" y="232" fill="#cdd6f4" font-size="54" font-weight="700">Token Usage</text>` +
    `<text x="66" y="280" fill="#89dceb" font-size="26" font-weight="600">a herdr plugin</text>` +
    `<text x="66" y="350" fill="#a6adc8" font-size="22">Live spend, Copilot credits,</text>` +
    `<text x="66" y="382" fill="#a6adc8" font-size="22">context and speed for every</text>` +
    `<text x="66" y="414" fill="#a6adc8" font-size="22">coding agent you run.</text>` +
    `<text x="66" y="560" fill="#7f849c" font-size="18">Pi · OpenCode · Copilot CLI · Claude Code</text>` +
    `</g>` +
    `<g transform="translate(470 ${(H - heroH * scale) / 2}) scale(${scale})">${inner}</g>` +
    `</svg>\n`
  );
}

function toPng(svgPath: string, pngPath: string, w: number, h: number): boolean {
  if (!existsSync(CHROME)) {
    console.warn(`  (skipped ${pngPath}: Google Chrome not found for PNG export)`);
    return false;
  }
  rmSync(pngPath, { force: true });
  spawnSync(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", `--window-size=${w},${h}`, `--screenshot=${pngPath}`, `file://${svgPath}`], { stdio: "ignore", timeout: 60_000 });
  // Headless Chrome can exit non-zero after writing the screenshot; the file is what counts.
  if (existsSync(pngPath)) return true;
  console.warn(`  (Chrome did not write ${pngPath})`);
  return false;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const demo = await openDemo();
  const ds = new DataSource();
  ledgerRef = ds;
  try {
    const today = await ds.build("today", "harness", 144, { dryRun: true });
    const month = await ds.build("30d", "cwd", 144, { dryRun: true });
    const display = ds.rt.config.display;

    const hero = heroShot(ds, today, demo.live, display);
    stylesShot(today, demo.live, display);

    dashboardShot(ds, today, ui({ view: 1 }), "dashboard-summary.svg", "Token usage · 1 Summary", 60);
    dashboardShot(ds, today, ui({ view: 2 }), "dashboard-agents.svg", "Token usage · 2 Agents", 14);
    dashboardShot(ds, today, ui({ view: 3 }), "dashboard-sessions.svg", "Token usage · 3 Sessions", 26);
    const acme = demo.live[0];
    dashboardShot(ds, today, ui({ view: 3, session: { harness: "pi", sessionId: acme.sessionId } }), "dashboard-session.svg", "Token usage · 3 Sessions · one session's calls", 26);
    dashboardShot(ds, month, ui({ view: 4 }), "dashboard-history.svg", "Token usage · 4 History · last 30 days by project", 22);
    dashboardShot(ds, today, ui({ view: 5, selected: 8 }), "dashboard-rules.svg", "Token usage · 5 Rules", 26);
    const cell = { w: CELL_W * 2, h: CELL_H * 2 };
    for (const tab of CHART_TABS) {
      const px: PixelState = { mode: tab === "spend" ? "on" : "off", cell };
      dashboardShot(ds, today, ui({ view: 6, chartTab: tab }), `charts-${tab}.svg`, `Token usage · 6 Charts · ${tab[0].toUpperCase()}${tab.slice(1)}`, 60, 160, px);
    }

    const socialPath = join(SANDBOX, "social.svg");
    writeFileSync(socialPath, socialSvg(hero));
    if (toPng(socialPath, join(OUT, "social-preview.png"), 1280, 640)) written.push("social-preview.png");
  } finally {
    ds.close();
    await demo.close();
    rmSync(SANDBOX, { recursive: true, force: true });
  }
  console.log(`docs/public/shots: ${written.join(", ")}`);
}

await main();
