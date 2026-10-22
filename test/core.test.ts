import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { resolveSession, saveBinding, titleHint } from "../src/core/binding.ts";
import { DEFAULT_DISPLAY, DETAIL_MAX, agentTokens, detailLine, money, spaceTokens, tabBarText, textBar, textGauge, textSpark } from "../src/core/display.ts";
import type { AgentView, DisplayConfig, SpaceView } from "../src/core/display.ts";
import { Ledger } from "../src/core/ledger.ts";
import { parseCopilotUser } from "../src/core/quota/copilot.ts";
import { diffTokens } from "../src/core/surfaces.ts";
import type { AgentInfo } from "../src/herdr/client.ts";
import { fmtCredits, fmtTokens, fmtUsd, fmtWhen } from "../src/util/format.ts";
import { parseJsonc } from "../src/util/jsonc.ts";
import { fit, width } from "../src/ui/style.ts";

function agent(over: Partial<AgentInfo> = {}): AgentInfo {
  return {
    agent: "opencode",
    agent_status: "idle",
    pane_id: "w1:p1",
    terminal_id: "term_1",
    workspace_id: "w1",
    tab_id: "w1:t1",
    cwd: "/work/a",
    foreground_cwd: "/work/a",
    ...over,
  };
}

describe("formatting", () => {
  it("formats compact numbers", () => {
    assert.equal(fmtTokens(950), "950");
    assert.equal(fmtTokens(1234), "1.2k");
    assert.equal(fmtTokens(56_700), "57k");
    assert.equal(fmtTokens(1_250_000), "1.25M");
    assert.equal(fmtCredits(326.4), "326cr");
    assert.equal(fmtCredits(18_100), "18.1kcr");
    assert.equal(fmtUsd(4.1), "$4.10");
    assert.equal(fmtUsd(0.034), "$0.03");
  });

  it("measures and fits styled text by display width", () => {
    const s = "\x1b[1mhello\x1b[22m";
    assert.equal(width(s), 5);
    assert.equal(width(fit(s, 3)), 3);
    assert.equal(width(fit(s, 8)), 8);
    assert.equal(width("日本"), 4);
  });

  it("fits text with line breaks onto one line", () => {
    assert.equal(fit("slide:\n\n\nCurrently:\tManager", 30), "slide: Currently: Manager     ");
    assert.ok(!fit("a\r\nb", 2).includes("\n"));
  });

  it("dates events as briefly as is unambiguous", () => {
    const now = new Date(2026, 9, 21, 10, 0).getTime();
    assert.equal(fmtWhen(new Date(2026, 9, 21, 9, 56).getTime(), now), "09:56");
    assert.equal(fmtWhen(new Date(2026, 9, 20, 17, 48).getTime(), now), "Tue 17:48");
    assert.equal(fmtWhen(new Date(2026, 9, 15, 8, 5).getTime(), now), "Thu 08:05");
    assert.doesNotMatch(fmtWhen(new Date(2026, 9, 14, 23, 59).getTime(), now), /:/, "older events show the date");
  });

  it("parses JSONC with comments and trailing commas", () => {
    assert.deepEqual(parseJsonc<{ a: number[] }>('// x\n{ "a": [1, 2,], /* y */ }'), { a: [1, 2] });
    assert.deepEqual(parseJsonc<{ u: string }>('{ "u": "http://x//y" }'), { u: "http://x//y" });
  });
});

describe("display system (sidebar + tab bar)", () => {
  const agentView: AgentView = {
    level: "high",
    billing: "copilot",
    usd: 17.63,
    credits: 1763,
    sessionUsd: 20.4,
    sessionCredits: 2040,
    workTokens: 1_890_000,
    contextPct: 39.4,
    contextTokens: 394_000,
    model: "claude-opus-5.5",
    tps: 74.6,
    burn5mUsd: 2.4,
    recentCalls: [0.1, 0.12, 0.3, 0.11],
  };
  const space: SpaceView = { level: "normal", usd: 24.1, credits: 2410, workTokens: 6_700_000, sharePct: 62, hourly: [0, 1, 2, 4], agents: 2 };
  const d = (style: DisplayConfig["style"], unit: DisplayConfig["money"] = "usd"): DisplayConfig => ({ ...DEFAULT_DISPLAY, style, money: unit });

  it("formats money in dollars by default, credits on request", () => {
    assert.equal(money("usd", 17.63, 1763), "$17.63");
    assert.equal(money("credits", 17.63, 1763), "1,763cr");
    assert.equal(money("credits", 20.63, 1763), "1,763cr+$3.00");
    assert.equal(money("usd", 185), "$185");
  });

  it("uses one grammar for agents and spaces: glyph, money, visual", () => {
    assert.equal(agentTokens(agentView, d("text")).tu, "▲ $17.63 · ctx 39%");
    assert.equal(agentTokens(agentView, d("visual")).tu, "▲ $17.63 ██▍░░░ 39%");
    assert.equal(agentTokens(agentView, d("spark")).tu, "▲ $17.63 ▃▄█▃ 39%");
    assert.equal(agentTokens(agentView, d("visual")).tu_sub, "opus-5.5");
    assert.equal(agentTokens(agentView, d("rich")).tu_more, "$2.40/5m · 75 t/s", "tokens dropped to fit");
    assert.equal(spaceTokens(space, d("text")).tu_ws, "● $24.10 today");
    assert.equal(spaceTokens(space, d("visual")).tu_ws, "● $24.10 ▁▂▄█");
    assert.equal(spaceTokens(space, d("rich")).tu_ws_more, "62% of today · 6.7M tok", "agent count dropped to fit");
    assert.equal(spaceTokens(space, d("visual")).tu_ws_more, null);
  });

  it("drops the least important detail parts to fit herdr's 26-column sidebar", () => {
    assert.equal(detailLine([["$13.26/5m", 0], ["117 t/s", 1], ["12.3M tok", 2]]), "$13.26/5m · 117 t/s");
    assert.equal(detailLine([[null, 0], ["84 t/s", 1], ["2.45M tok", 2]]), "84 t/s · 2.45M tok");
    assert.equal(detailLine([["a-very-long-single-part-over-the-cap", 0]]), "a-very-long-single-part-over-the-cap");
    assert.equal(detailLine([[null, 0]]), null);
    const busy = { ...agentView, usd: 1234.5, tps: 117, burn5mUsd: 13.26, workTokens: 12_300_000 };
    const busySpace = { ...space, usd: 1234.5, sharePct: 100, workTokens: 12_300_000, agents: 3 };
    for (const v of [agentTokens(busy, d("rich")).tu_more, spaceTokens(busySpace, d("rich")).tu_ws_more]) {
      assert.ok(v && v.length <= DETAIL_MAX, `${v} fits`);
    }
  });

  it("clears every token when there is nothing to show", () => {
    assert.ok(Object.values(agentTokens(null, DEFAULT_DISPLAY)).every((v) => v === null));
    assert.ok(Object.values(spaceTokens(null, DEFAULT_DISPLAY)).every((v) => v === null));
  });

  it("keeps every token under herdr's 80-character cap", () => {
    for (const style of ["text", "visual", "spark", "rich"] as const) {
      for (const v of [...Object.values(agentTokens(agentView, d(style))), ...Object.values(spaceTokens(space, d(style)))]) {
        if (v) assert.ok(v.length <= 80, v);
      }
    }
  });

  it("only uses glyphs that render one cell wide in common terminal fonts", () => {
    // Block elements and box drawing are drawn by terminals themselves; these
    // symbols were checked with `ghostty +show-face` (JetBrains Mono). Shapes
    // like ▰▱ come from fallback fonts and can spill into the next cell.
    const safe = (ch: string) => {
      const cp = ch.codePointAt(0) ?? 0;
      return (cp >= 0x20 && cp < 0x7f) || (cp >= 0x2500 && cp <= 0x259f) || "▲▽●■·×…".includes(ch);
    };
    const quota = parseCopilotUser(
      { token_based_billing: true, quota_reset_date_utc: "2026-11-01T00:00:00.000Z", quota_snapshots: { premium_interactions: { entitlement: 60000, quota_remaining: 41500, percent_remaining: 69.2 } } },
      Date.parse("2026-10-19T02:00:00Z"),
    );
    const tab = { quota, quotaLevel: "normal" as const, todayUsd: 108.4, todayCredits: 10840, workTokens: 6_700_000, daily: [0, 1, 4, 0, 2, 9, 3], burn5mUsd: 2.4, snoozed: true };
    for (const style of ["text", "visual", "spark", "rich"] as const) {
      for (const unit of ["usd", "credits"] as const) {
        const all = [...Object.values(agentTokens(agentView, d(style, unit))), ...Object.values(spaceTokens(space, d(style, unit))), tabBarText(tab, d(style, unit))];
        for (const v of all) for (const ch of v ?? "") assert.ok(safe(ch), `${style}/${unit}: ${JSON.stringify(ch)} (U+${ch.codePointAt(0)?.toString(16)}) in "${v}"`);
      }
    }
  });

  it("draws text gauges, bars and sparklines", () => {
    assert.equal(textGauge(0), "░░░░░░");
    assert.equal(textGauge(1), "▏░░░░░", "any usage shows a sliver");
    assert.equal(textGauge(50), "███░░░");
    assert.equal(textGauge(39.4), "██▍░░░", "eighth-cell precision");
    assert.equal(textGauge(100), "██████");
    assert.equal(textSpark([0, 1, 2, 4]), "▁▂▄█");
    assert.equal(textBar(50, 4, null), "▕██░░▏");
    assert.equal(textBar(30, 10, 60).includes("┃"), true);
  });

  it("builds the tab bar in each style", () => {
    const quota = parseCopilotUser(
      { token_based_billing: true, quota_reset_date_utc: "2026-11-01T00:00:00.000Z", quota_snapshots: { premium_interactions: { entitlement: 60000, quota_remaining: 41500, percent_remaining: 69.2 } } },
      Date.parse("2026-10-19T02:00:00Z"),
    );
    const view = { quota, quotaLevel: "normal" as const, todayUsd: 108.4, todayCredits: 10840, workTokens: 6_700_000, daily: [0, 0, 1, 0, 0, 2, 108], burn5mUsd: 2.4, snoozed: false };
    assert.equal(tabBarText(view, d("text")), "Copilot ● 31% · 0.53× │ today $108 · 6.7M tok");
    assert.match(tabBarText(view, d("visual")), /^Copilot ▕.*▏ 31% 0\.53× │ today \$108$/);
    assert.equal(tabBarText(view, d("rich")), "Copilot ● $185/$600 · 0.53× · 13d left │ today $108 · $2.40/5m");
    assert.equal(tabBarText(view, d("text", "credits")), "Copilot ● 31% · 0.53× │ today 10.8kcr · 6.7M tok");
    for (const style of ["text", "visual", "spark", "rich"] as const) assert.ok(tabBarText(view, d(style)).length <= 80);
  });

  it("diffs against what herdr already holds", () => {
    const next = agentTokens(agentView, DEFAULT_DISPLAY);
    assert.deepEqual(diffTokens({ tu: next.tu as string }, { tu: next.tu }), {});
    assert.deepEqual(diffTokens({ tu: "old", tu_tps: "1 t/s" }, { tu: "new", tu_tps: null }), { tu: "new", tu_tps: null });
    assert.deepEqual(diffTokens(null, { tu_tps: null }), {});
  });
});

describe("ledger", () => {
  it("stores session titles on one line, and repairs ledgers written before v2", () => {
    const dir = mkdtempSync(join(tmpdir(), "tu-ledger-"));
    const path = join(dir, "ledger.db");
    let ledger = new Ledger(path);
    const title = () => ledger.get<{ title: string }>("SELECT title FROM session WHERE id = 'a'")?.title;
    try {
      ledger.upsertSession({ harness: "copilot", id: "a", rootId: "a", parentId: null, cwd: null, title: "Rewrite my intro:\n\n\nCurrently:\tManager ", path: null, firstTs: 1, lastTs: 2 });
      assert.equal(title(), "Rewrite my intro: Currently: Manager");
      ledger.run("UPDATE session SET title = ? WHERE id = 'a'", "Rewrite my intro:\r\n\r\nCurrently:");
      ledger.db.exec("PRAGMA user_version = 1");
      ledger.close();
      ledger = new Ledger(path);
      assert.equal(title(), "Rewrite my intro: Currently:");
    } finally {
      ledger.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pane → session binding", () => {
  function ledgerWithSessions() {
    const ledger = new Ledger(":memory:");
    const add = (id: string, title: string, last: number, cwd = "/work/a") =>
      ledger.upsertSession({ harness: "opencode", id, rootId: id, parentId: null, cwd, title, path: null, firstTs: last - 1000, lastTs: last });
    add("ses_old", "Old work", 1000);
    add("ses_new", "Herder plugin for tracking token usage and performance", 5000);
    add("ses_other", "Unrelated", 9000, "/work/b");
    return ledger;
  }

  it("extracts the OpenCode session title from the pane title", () => {
    assert.equal(titleHint(agent({ terminal_title_stripped: "OC | Herder plugin for tracking token usag…" })), "Herder plugin for tracking token usag");
    assert.equal(titleHint(agent({ agent: "pi", terminal_title_stripped: "π - proj" })), null);
  });

  it("prefers a title match, then recency, in the pane's cwd", () => {
    const ledger = ledgerWithSessions();
    const byTitle = resolveSession(ledger, agent({ terminal_title_stripped: "OC | Old work" }), "opencode", null, new Set());
    assert.deepEqual(byTitle, { sessionId: "ses_old", method: "heuristic" });
    const byRecency = resolveSession(ledger, agent(), "opencode", null, new Set());
    assert.equal(byRecency?.sessionId, "ses_new");
  });

  it("never binds a session another live pane owns", () => {
    const ledger = ledgerWithSessions();
    const r = resolveSession(ledger, agent(), "opencode", null, new Set(["ses_new"]));
    assert.equal(r?.sessionId, "ses_old");
  });

  it("uses the integration's exact session reference when present", () => {
    const ledger = ledgerWithSessions();
    const r = resolveSession(ledger, agent({ agent_session: { source: "herdr:opencode", agent: "opencode", kind: "id", value: "ses_old" } }), "opencode", null, new Set());
    assert.deepEqual(r, { sessionId: "ses_old", method: "exact" });
    const pi = resolveSession(
      ledger,
      agent({ agent: "pi", agent_session: { source: "herdr:pi", agent: "pi", kind: "path", value: "/s/--a--/2026-10-19T01-03-45-623Z_01a151af-9bd7.jsonl" } }),
      "pi",
      null,
      new Set(),
    );
    assert.equal(pi?.sessionId, "01a151af-9bd7");
    assert.equal(pi?.method, "exact");
  });

  it("waits for a freshly started agent's own session", () => {
    const ledger = ledgerWithSessions();
    const prev = { terminalId: "term_1", paneId: "w1:p1", workspaceId: "w1", agent: "opencode", harness: "opencode" as const, sessionId: null, method: null, boundAt: 9_000_000, agentSeenAt: 9_000_000, lastStatus: null, statusAt: null };
    assert.equal(resolveSession(ledger, agent(), "opencode", prev, new Set()), null);
  });

  describe("after two sessions start in the pane's folder", () => {
    // The pane ran "earlier", then two sessions started in its folder at once and it was bound to one.
    function laterStart(earlierLast: number) {
      const ledger = new Ledger(":memory:");
      const add = (id: string, first: number, last: number) =>
        ledger.upsertSession({ harness: "pi", id, rootId: id, parentId: null, cwd: "/work/a", title: null, path: null, firstTs: first, lastTs: last });
      add("earlier", 1_000, earlierLast);
      add("later-1", 20_000, 27_000);
      add("later-2", 20_000, 26_000);
      const bind = (sessionId: string, from: number, to: number) => {
        const b = { terminalId: "term_1", paneId: "w1:p1", workspaceId: "w1", agent: "pi", harness: "pi" as const, sessionId, method: "heuristic" as const, boundAt: from, agentSeenAt: null, lastStatus: null, statusAt: null };
        saveBinding(ledger, b, from);
        saveBinding(ledger, b, to);
        return b;
      };
      bind("earlier", 1_000, 19_000);
      return { ledger, prev: bind("later-1", 20_100, 49_000) };
    }
    const pi = () => agent({ agent: "pi", cwd: "/work/a", foreground_cwd: "/work/a", terminal_title_stripped: "π - a" });

    it("goes back to the earlier session once it writes again (they were side runs)", () => {
      const { ledger, prev } = laterStart(50_000);
      assert.equal(resolveSession(ledger, pi(), "pi", prev, new Set())?.sessionId, "earlier");
    });

    it("stays on the new session when the earlier one stopped (a real /new)", () => {
      const { ledger, prev } = laterStart(19_000);
      assert.equal(resolveSession(ledger, pi(), "pi", prev, new Set())?.sessionId, "later-1");
    });
  });
});
