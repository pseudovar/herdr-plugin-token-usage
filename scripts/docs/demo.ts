/**
 * Synthetic usage for the docs renders: four live agents across four spaces,
 * five months of history, a Copilot quota with snapshots, and the alerts that
 * history would have raised. Seeded, so every run produces the same data.
 */
import { createServer } from "node:net";
import type { Server } from "node:net";
import { defaultConfig, saveConfig } from "../../src/core/config.ts";
import { Ledger } from "../../src/core/ledger.ts";
import { normalizeModel } from "../../src/core/pricing.ts";
import { parseCopilotUser } from "../../src/core/quota/copilot.ts";
import type { Billing, Harness, Level, UsageRecord } from "../../src/core/types.ts";
import type { AgentInfo, WorkspaceInfo } from "../../src/herdr/client.ts";
import { DEMO_HOME, NOW } from "./sandbox.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** mulberry32: small, fast and good enough for plausible noise. */
function seeded(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = seeded(20261021);
const between = (a: number, b: number) => a + (b - a) * rand();
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
const hex = (n: number) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join("");

interface ModelSpec {
  id: string;
  billing: Billing;
  provider: string;
  limit: number;
  tps: number;
}

const MODELS = {
  opus: { id: "claude-opus-5.5", billing: "copilot", provider: "github-copilot", limit: 1_000_000, tps: 82 },
  sonnet: { id: "claude-sonnet-5.5", billing: "copilot", provider: "github-copilot", limit: 1_000_000, tps: 112 },
  sol: { id: "gpt-6.1-sol", billing: "copilot", provider: "github-copilot", limit: 400_000, tps: 96 },
  luna: { id: "gpt-6-luna", billing: "copilot", provider: "github-copilot", limit: 400_000, tps: 158 },
  flash: { id: "gemini-3.8-flash", billing: "copilot", provider: "github-copilot", limit: 1_000_000, tps: 214 },
  claude: { id: "claude-sonnet-4-6", billing: "claude", provider: "anthropic", limit: 200_000, tps: 94 },
} satisfies Record<string, ModelSpec>;
type ModelKey = keyof typeof MODELS;

/** Copilot AI credits per 1M tokens (1 credit = $0.01), as Copilot CLI records them. */
export const RATE_CARD: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  [normalizeModel(MODELS.opus.id)]: { input: 400, output: 2000, cacheRead: 20, cacheWrite: 500 },
  [normalizeModel(MODELS.sonnet.id)]: { input: 300, output: 1500, cacheRead: 15, cacheWrite: 375 },
  [normalizeModel(MODELS.sol.id)]: { input: 200, output: 1200, cacheRead: 20, cacheWrite: 200 },
  [normalizeModel(MODELS.luna.id)]: { input: 25, output: 200, cacheRead: 2.5, cacheWrite: 25 },
  [normalizeModel(MODELS.flash.id)]: { input: 30, output: 250, cacheRead: 3, cacheWrite: 30 },
};
/** Claude Code on an API plan: list price in USD per 1M tokens. */
const CLAUDE_PRICES = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

const TITLES: Record<string, string[]> = {
  "acme-checkout": [
    "Fix the flaky payment webhook test",
    "Split the cart reducer into slices",
    "Upgrade the Stripe SDK",
    "Audit checkout for accessibility",
    "Cache shipping quotes per postcode",
    "Add a promo-code field to the basket",
  ],
  "orbital-api": [
    "Add OpenTelemetry tracing to the gateway",
    "Investigate p99 latency on /orders",
    "Write a migration for soft-deleted users",
    "Paginate the audit log endpoint",
    "Harden input validation on /webhooks",
  ],
  "infra-terraform": ["Rotate the staging database credentials", "Move CI runners to arm64", "Add budget alarms per environment", "Split the networking module"],
  blog: ["Draft release notes for 2.3", "Proofread the onboarding guide", "Outline a talk on agent workflows"],
  "mobile-app": ["Fix the iOS deep-link crash", "Add offline mode to the order list", "Migrate push notifications to the new API", "Profile cold start on Android"],
  "data-pipeline": ["Backfill October events", "Speed up the dedupe job", "Add schema checks to ingestion"],
  dotfiles: ["Tidy up the zsh prompt", "Add a herdr layout for code review"],
};
const PROJECTS = Object.keys(TITLES);
const cwdOf = (project: string) => `${DEMO_HOME}/code/${project}`;

const MODELS_BY_HARNESS: Record<Harness, ModelKey[]> = {
  pi: ["opus", "opus", "sol"],
  opencode: ["sonnet", "opus", "flash"],
  copilot: ["opus", "luna", "sol"],
  claude: ["claude"],
};

interface SessionSpec {
  harness: Harness;
  project: string;
  title: string | null;
  model: ModelKey;
  start: number;
  calls: number;
  /** Seconds between calls (tool use, reading, thinking). */
  gap: [number, number];
  /** Prompt size of the first call, and how much each call adds. */
  ctx0: number;
  growth: number;
  /** Live sessions: the prompt ramps to this size by the last call (no compaction), so "now" is predictable. */
  target?: number;
  /** Stop before this time (live sessions run up to "now"). */
  until?: number;
  /** Calls closer together than usual over the last few minutes (a burn spike). */
  burstAfter?: number;
}

function sessionId(harness: Harness): string {
  switch (harness) {
    case "opencode":
      return `ses_${hex(12)}${hex(14).toUpperCase()}`;
    case "pi":
      return `01a1${hex(4)}-${hex(4)}-7${hex(3)}-${hex(4)}-${hex(12)}`;
    default:
      return `${hex(8)}-${hex(4)}-4${hex(3)}-${hex(4)}-${hex(12)}`;
  }
}

function price(m: ModelSpec, t: { input: number; output: number; cacheRead: number; cacheWrite: number }): { usd: number; credits: number | null } {
  if (m.billing === "copilot") {
    const r = RATE_CARD[normalizeModel(m.id)];
    const credits = (t.input * r.input + t.output * r.output + t.cacheRead * r.cacheRead + t.cacheWrite * r.cacheWrite) / 1e6;
    return { usd: credits / 100, credits };
  }
  const r = CLAUDE_PRICES;
  return { usd: (t.input * r.input + t.output * r.output + t.cacheRead * r.cacheRead + t.cacheWrite * r.cacheWrite) / 1e6, credits: null };
}

/** One model call per step: the prompt grows as the session goes, mostly served from cache. */
function generateCalls(spec: SessionSpec, id: string): UsageRecord[] {
  const m: ModelSpec = MODELS[spec.model];
  const until = spec.until ?? Infinity;
  // Timeline first, so a live session's context can ramp to its target by the last call.
  const steps: Array<{ ts: number; output: number; ttft: number; tps: number }> = [];
  for (let ts = spec.start; steps.length < spec.calls && ts < until; ) {
    const output = Math.round(Math.exp(between(Math.log(220), Math.log(3800))));
    const tps = m.tps * between(0.75, 1.25);
    const ttft = between(500, 2600);
    steps.push({ ts, output, ttft, tps });
    const burst = spec.burstAfter != null && ts >= spec.burstAfter;
    ts += ttft + (output / tps) * 1000 + (burst ? between(2, 6) : between(spec.gap[0], spec.gap[1])) * 1000;
  }
  const out: UsageRecord[] = [];
  let prompt = spec.ctx0;
  steps.forEach((s, i) => {
    if (spec.target != null) {
      prompt = Math.round((spec.ctx0 + (spec.target - spec.ctx0) * (i / Math.max(1, steps.length - 1))) * between(0.985, 1.015));
    } else if (prompt > m.limit * 0.82) {
      // Long sessions get compacted before they hit the limit.
      prompt = spec.ctx0 + 9_000;
    }
    const cacheWrite = Math.round(spec.growth * between(0.3, 1.9));
    const input = Math.round(between(2, 420));
    const cacheRead = Math.max(0, prompt - cacheWrite - input);
    const t = { input, output: s.output, cacheRead, cacheWrite };
    const cost = price(m, t);
    out.push({
      id: `${spec.harness}:${id}:${i}`,
      harness: spec.harness,
      sessionId: id,
      rootSessionId: id,
      ts: Math.round(s.ts),
      cwd: cwdOf(spec.project),
      provider: m.provider,
      model: m.id,
      billing: m.billing,
      ...t,
      cacheWrite1h: 0,
      reasoning: Math.round(s.output * between(0, 0.3)),
      costUsd: cost.usd,
      credits: cost.credits,
      creditsExact: spec.harness === "copilot",
      premiumMultiplier: null,
      initiator: i === 0 ? "user" : "agent",
      durationMs: Math.round(s.ttft + (s.output / s.tps) * 1000),
      ttftMs: spec.harness === "copilot" ? Math.round(s.ttft) : null,
      itlMs: spec.harness === "copilot" ? 1000 / s.tps : null,
      contextLimit: m.limit,
      isSubagent: false,
    });
    prompt += cacheWrite + s.output;
  });
  return out;
}

export interface LiveAgent {
  agent: AgentInfo;
  workspace: WorkspaceInfo;
  sessionId: string;
  title: string;
}

export interface Demo {
  ledger: Ledger;
  live: LiveAgent[];
  agents: AgentInfo[];
  workspaces: WorkspaceInfo[];
  server: Server;
  close(): Promise<void>;
}

/** Build the demo ledger and config, and answer herdr's socket API with the demo panes. */
export async function openDemo(): Promise<Demo> {
  const config = defaultConfig();
  config.harnesses = { pi: false, opencode: false, copilot: false, claude: false };
  config.copilot = { quota: true, refreshMinutes: 24 * 60 };
  saveConfig(config);

  const ledger = Ledger.open();
  ledger.setMeta("copilot_rate_card", JSON.stringify(RATE_CARD));

  const sessions: Array<{ spec: SessionSpec; id: string }> = [];
  const today0 = NOW - (NOW % DAY);

  // Live now: four agents in four spaces.
  const liveSpecs: Array<SessionSpec & { agent: Harness; status: AgentInfo["agent_status"]; pane: string }> = [
    { agent: "pi", status: "working", pane: "w1", harness: "pi", project: "acme-checkout", title: "Add Apple Pay to the checkout flow", model: "opus", start: today0 + 13 * HOUR + 4 * MIN, calls: 400, gap: [20, 70], ctx0: 34_000, growth: 3_100, target: 412_000, until: NOW - 20_000, burstAfter: NOW - 6 * MIN },
    { agent: "opencode", status: "done", pane: "w2", harness: "opencode", project: "orbital-api", title: "Refactor the rate limiter middleware", model: "sonnet", start: today0 + 10 * HOUR + 18 * MIN, calls: 96, gap: [25, 110], ctx0: 26_000, growth: 1_900, target: 186_000, until: NOW - 7 * MIN },
    { agent: "copilot", status: "working", pane: "w3", harness: "copilot", project: "infra-terraform", title: "Plan the VPC peering change", model: "sol", start: today0 + 14 * HOUR + 52 * MIN, calls: 120, gap: [30, 80], ctx0: 18_000, growth: 1_200, target: 36_000, until: NOW - 45_000 },
    { agent: "claude", status: "done", pane: "w4", harness: "claude", project: "blog", title: "Write a post about prompt-cache hit rates", model: "claude", start: today0 + 11 * HOUR + 31 * MIN, calls: 70, gap: [30, 140], ctx0: 22_000, growth: 2_200, target: 172_000, until: NOW - 26 * MIN },
  ];
  for (const s of liveSpecs) sessions.push({ spec: s, id: sessionId(s.harness) });

  // Earlier today, finished.
  sessions.push({ spec: { harness: "opencode", project: "acme-checkout", title: "Fix the flaky payment webhook test", model: "sonnet", start: today0 + 9 * HOUR + 5 * MIN, calls: 34, gap: [20, 60], ctx0: 21_000, growth: 1_600 }, id: sessionId("opencode") });
  sessions.push({ spec: { harness: "copilot", project: "infra-terraform", title: "Add budget alarms per environment", model: "luna", start: today0 + 8 * HOUR + 32 * MIN, calls: 22, gap: [15, 45], ctx0: 14_000, growth: 1_100 }, id: sessionId("copilot") });

  // History: busier on weekdays, lighter further back (the calendar shows 20 weeks).
  for (let d = 1; d <= 140; d++) {
    const day = today0 - d * DAY;
    const dow = new Date(day).getUTCDay();
    const weekend = dow === 0 || dow === 6;
    const recent = d <= 30;
    const count = weekend ? (rand() < 0.3 ? 1 : 0) : recent ? Math.floor(between(1, 4)) : rand() < 0.45 ? Math.floor(between(1, 3)) : 0;
    for (let k = 0; k < count; k++) {
      const harness = pick<Harness>(["pi", "pi", "opencode", "opencode", "copilot", "claude"]);
      const project = pick(PROJECTS);
      const title = harness === "pi" && rand() < 0.2 ? null : pick(TITLES[project]);
      sessions.push({
        spec: {
          harness,
          project,
          title,
          model: pick(MODELS_BY_HARNESS[harness]),
          start: day + between(8.5, 19) * HOUR,
          calls: Math.floor(between(12, recent ? 140 : 70)),
          gap: [15, 90],
          ctx0: Math.round(between(12_000, 40_000)),
          growth: Math.round(between(900, 3_200)),
        },
        id: sessionId(harness),
      });
    }
  }

  const records: UsageRecord[] = [];
  const bySession = new Map<string, UsageRecord[]>();
  for (const { spec, id } of sessions) {
    const calls = generateCalls(spec, id);
    if (calls.length === 0) continue;
    bySession.set(id, calls);
    records.push(...calls);
    ledger.upsertSession({
      harness: spec.harness,
      id,
      rootId: id,
      parentId: null,
      cwd: cwdOf(spec.project),
      title: spec.title,
      path: null,
      firstTs: calls[0].ts,
      lastTs: calls[calls.length - 1].ts,
    });
  }
  ledger.upsertRequests(records, "replace");

  // Copilot quota: the account also spends outside this machine (VS Code, github.com).
  const periodStart = Date.UTC(2026, 9, 1);
  const local = records.filter((r) => r.billing === "copilot" && r.ts >= periodStart).sort((a, b) => a.ts - b.ts);
  const localCredits = local.reduce((s, r) => s + (r.credits ?? 0), 0);
  const accountUsed = localCredits * 1.22;
  const elapsedPct = ((NOW - periodStart) / (Date.UTC(2026, 10, 1) - periodStart)) * 100;
  // Size the budget so the month is on pace (about 0.9×).
  const entitlement = Math.ceil(accountUsed / ((elapsedPct * 0.9) / 100) / 1000) * 1000;
  const quota = parseCopilotUser(
    {
      copilot_plan: "business",
      token_based_billing: true,
      quota_reset_date_utc: "2026-11-01T00:00:00.000Z",
      quota_snapshots: {
        premium_interactions: {
          entitlement,
          quota_remaining: entitlement - accountUsed,
          percent_remaining: 100 - (accountUsed / entitlement) * 100,
          overage_permitted: true,
          unlimited: false,
        },
      },
    },
    NOW,
  );
  ledger.run(
    "INSERT INTO quota (provider, fetched_at, ok, payload, error, failures) VALUES ('copilot', ?, 1, ?, NULL, 0)",
    NOW,
    JSON.stringify(quota),
  );
  // Quota snapshots every 6 hours, tracking local spend plus the other clients' share.
  let cum = 0;
  let i = 0;
  for (let t = periodStart + 6 * HOUR; t <= NOW; t += 6 * HOUR) {
    while (i < local.length && local[i].ts <= t) cum += local[i++].credits ?? 0;
    ledger.run("INSERT INTO quota_history (provider, ts, used, entitlement, used_pct) VALUES ('copilot', ?, ?, ?, ?)", t, cum * 1.22, entitlement, ((cum * 1.22) / entitlement) * 100);
  }

  seedAlerts(ledger, sessions, bySession);

  const workspaces: WorkspaceInfo[] = liveSpecs.map((s, k) => ({ workspace_id: s.pane, label: s.project, focused: k === 0 }));
  const live: LiveAgent[] = liveSpecs.map((s, k) => {
    const id = sessions[k].id;
    const titles: Record<Harness, string> = {
      pi: `π - ${s.project}`,
      opencode: `OC | ${s.title}`,
      copilot: `GitHub Copilot - ${s.project}`,
      claude: `✳ ${s.title}`,
    };
    const agent: AgentInfo = {
      agent: s.agent,
      agent_status: s.status,
      pane_id: `${s.pane}:p1`,
      terminal_id: `term_demo_${k + 1}`,
      workspace_id: s.pane,
      tab_id: `${s.pane}:t1`,
      cwd: cwdOf(s.project),
      foreground_cwd: cwdOf(s.project),
      focused: k === 0,
      terminal_title: titles[s.harness],
      terminal_title_stripped: titles[s.harness],
      agent_session: { source: `herdr:${s.agent}`, agent: s.agent, kind: "id", value: id },
      tokens: null,
    };
    return { agent, workspace: workspaces[k], sessionId: id, title: s.title ?? "" };
  });
  const agents = live.map((l) => l.agent);
  const server = await fakeHerdr(agents, workspaces);
  return {
    ledger,
    live,
    agents,
    workspaces,
    server,
    close: () =>
      new Promise((resolve) => {
        ledger.close();
        server.close(() => resolve());
      }),
  };
}

/** The alerts this history would have raised, in the plugin's own message format. */
function seedAlerts(ledger: Ledger, sessions: Array<{ spec: SessionSpec; id: string }>, bySession: Map<string, UsageRecord[]>): void {
  const since = NOW - 31 * DAY;
  const harnessLabel: Record<Harness, string> = { pi: "Pi", opencode: "OpenCode", copilot: "Copilot CLI", claude: "Claude Code" };
  const log = (ts: number, ruleId: string, scope: string, level: Level, value: number, message: string) =>
    ledger.run("INSERT INTO alert_log (ts, rule_id, scope, level, value, message, notified) VALUES (?, ?, ?, ?, ?, ?, 1)", ts, ruleId, scope, level, value, message);
  for (const { spec, id } of sessions) {
    const calls = bySession.get(id);
    if (!calls || calls[calls.length - 1].ts < since) continue;
    const who = `${spec.project} · ${harnessLabel[spec.harness]}`;
    const where = spec.title ? `${spec.title} · ` : "";
    const scope = `session:${spec.harness}:${id}`;
    const model = calls[0].model;
    let cum = 0;
    let work = 0;
    let milestone = 0;
    let lastBurst = 0;
    let ctxWarned = false;
    // Credits in the 5 minutes up to each call (two pointers over the session's calls).
    let windowStart = 0;
    let windowCredits = 0;
    for (let k = 0; k < calls.length; k++) {
      const c = calls[k];
      cum += spec.harness === "claude" ? (c.costUsd ?? 0) : (c.credits ?? 0);
      work += c.input + c.cacheWrite + c.output;
      const step = spec.harness === "claude" ? 5 : 500;
      if (Math.floor(cum / step) > milestone) {
        milestone = Math.floor(cum / step);
        const amount = spec.harness === "claude" ? milestone * 5 : (milestone * 500) / 100;
        log(c.ts, spec.harness === "claude" ? "session-cost" : "session-credits", scope, "high", cum, `${who}: session passed $${amount.toFixed(2)} — ${where}${(work / 1e6).toFixed(2)}M work tokens · ${model}`);
      }
      if (spec.harness !== "claude") {
        windowCredits += c.credits ?? 0;
        while (calls[windowStart].ts <= c.ts - 5 * MIN) windowCredits -= calls[windowStart++].credits ?? 0;
        if (windowCredits >= 150 && c.ts - lastBurst > 30 * MIN) {
          lastBurst = c.ts;
          log(c.ts, "burn-credits", scope, "high", windowCredits, `${who}: $${(windowCredits / 100).toFixed(2)} in 5 min — ${where}burn spike · ${model}`);
        }
      }
      const pct = c.contextLimit ? ((c.input + c.cacheRead + c.cacheWrite) / c.contextLimit) * 100 : 0;
      if (pct >= 80 && !ctxWarned) {
        ctxWarned = true;
        log(c.ts, "context-high", scope, "high", pct, `${who}: context ${Math.round(pct)}% full — ${where}${model} · consider /compact or a fresh session`);
      }
    }
  }
  // Rules that are active right now colour the live panes and spaces.
  const active = (ruleId: string, scope: string, value: number) =>
    ledger.run(
      "INSERT OR REPLACE INTO alert_state (rule_id, scope, active, level, value, mark, since, last_notified) VALUES (?, ?, 1, 'high', ?, NULL, ?, ?)",
      ruleId,
      scope,
      value,
      NOW - 4 * MIN,
      NOW - 4 * MIN,
    );
  const [acme, , , blog] = sessions;
  active("burn-credits", `session:${acme.spec.harness}:${acme.id}`, 190);
  active("context-high", `session:${blog.spec.harness}:${blog.id}`, 86);
}

/** Just enough of herdr's socket API for DataSource.build: ping, agents and workspaces. */
function fakeHerdr(agents: AgentInfo[], workspaces: WorkspaceInfo[]): Promise<Server> {
  const server = createServer((sock) => {
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const req = JSON.parse(buf.slice(0, nl)) as { id: string; method: string };
        buf = buf.slice(nl + 1);
        const result =
          req.method === "agent.list"
            ? { agents }
            : req.method === "workspace.list"
              ? { workspaces }
              : req.method === "pane.list"
                ? { panes: agents.map((a) => ({ pane_id: a.pane_id, terminal_id: a.terminal_id, workspace_id: a.workspace_id, tab_id: a.tab_id })) }
                : {};
        sock.write(JSON.stringify({ id: req.id, result }) + "\n");
      }
    });
    sock.on("error", () => {});
  });
  return new Promise((resolve) => server.listen(process.env.HERDR_SOCKET_PATH, () => resolve(server)));
}
