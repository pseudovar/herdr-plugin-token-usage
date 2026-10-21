# Design: `token-usage` herdr plugin

Status: **implemented (v0.1.0)**. Decisions are confirmed in §12. §15 records
what changed during implementation and the measured performance. Evidence for
every claim is in `RESEARCH.md`.

---

## 1. TL;DR

A zero-dependency TypeScript plugin (Node ≥ 22.18). It:

1. **Reads the usage data every harness already writes locally.** Pi JSONL,
   OpenCode SQLite, Copilot CLI SQLite and Claude Code JSONL, with Codex and
   others later. No proxies, no API keys, no changes to how agents run.
2. **Normalizes it into one local ledger**: a SQLite file in the plugin state
   dir with one row per model call.
3. **Pulls the account-level truth** for subscriptions. For GitHub Copilot that
   is credits used against the monthly allowance, fetched with the existing `gh` login.
4. **Pushes live values into herdr's native surfaces**: agent sidebar rows,
   space rows and the tab bar. It also offers a **dashboard pane** (summary and
   detailed views) and **rule-based toasts** for "using a lot" and "using a
   little".
5. **Runs without a daemon.** It is driven by herdr event hooks, a startup
   hook, the tab-bar interval and the dashboard while it is open. This follows
   herdr's guidance that plugins are short-lived commands.

---

## 2. Goals and non-goals

**Why build rather than adopt an existing plugin?** About 20 usage plugins
exist (RESEARCH §8). The most complete, senna-lang/herdr-agent-usage,
**explicitly does not support GitHub Copilot**, and none read Copilot quota,
credits or Copilot CLI data. Copilot is the billing path for Pi, OpenCode and
Copilot CLI here. None offer a rules engine with low/high levels or
performance metrics. We reuse their proven patterns instead of their code.
Later, the Copilot collector could be contributed upstream to usagebar.

**Goals**

- Per-agent-pane usage at a glance, live, inside herdr.
- One place that compares Pi, OpenCode, Copilot CLI, Claude Code and local models.
- Copilot credits as a first-class unit, with quota pacing ("on track / over / under").
- Performance: tokens/sec, time to first token (TTFT), cache hit rate, context-window pressure.
- User-defined rules that colour the sidebar and send notifications.
- A summary view and a drill-down detailed view.

**Non-goals (v1)**

- Intercepting traffic (no proxy or MITM). We only read what harnesses persist.
- Exact billing for clients outside this machine (VS Code, web). These are shown
  as "unattributed" using the quota API.
- Windows support (the launcher is POSIX `sh`). The plugin is structured so
  Windows can be added later.
- Storing or displaying prompt or response content.

---

## 3. Architecture

```text
 Harness data (read-only)              Plugin (node, zero deps)                      herdr surfaces
 ────────────────────────             ──────────────────────────                    ───────────────────────────
 Pi        ~/.pi/agent/sessions ──┐
 OpenCode  opencode.db (v2) ──────┤   adapters/*  ── incremental ──▶  ledger.db  ──▶  Agent sidebar   $tu  $tu_ctx …
 Copilot   session-store.db ──────┼─▶ (cursor per    (dedupe keys)    (SQLite/WAL) ─▶  Space sidebar   $tu_ws
 Claude    ~/.claude/projects ────┤    source)                         │           ─▶  Tab bar         status-line
 Codex     ~/.codex/sessions ─────┘                                    │           ─▶  Dashboard pane  (TUI)
                                                                       │           ─▶  Toasts          notification.show
 Copilot quota  `gh api /copilot_internal/user` ──▶ quota cache (5 min)┤
 herdr  `agent list` / events / agent_session ──▶ pane↔session binder ─┘
```

Module layout:

```text
herdr-plugin.toml          manifest (startup, events, panes, actions)
bin/tu                     POSIX launcher: finds node (PATH, mise, brew, nvm…), execs src/cli.ts
src/cli.ts                 subcommands: hook | startup | status-line | dashboard | open | report | setup | doctor | snooze
src/core/ledger.ts         node:sqlite schema, upserts, queries
src/core/ingest.ts         runs adapters incrementally, single-flight lock, skip-if-fresh
src/adapters/{pi,opencode,copilot,claude,codex}.ts
src/core/pricing.ts        rate cards: Copilot (observed) → Pi/models.dev caches → built-in fallback
src/core/binding.ts        herdr pane ↔ harness session
src/core/metrics.ts        aggregations + derived metrics (pace, burn, cache %, ctx %, tok/s)
src/core/rules.ts          rule evaluation, levels, edge-triggering, cooldown, snooze
src/core/quota/{copilot,claude}.ts
src/herdr.ts               HERDR_BIN_PATH wrapper + raw socket subscribe (dashboard only)
src/ui/*                   zero-dep ANSI renderer, views, widgets (gauge, sparkline, table)
test/*                     node:test + sanitized fixtures per harness
```

---

## 4. Process model: how it stays live without a daemon

| Trigger | Command | Work | Budget |
| --- | --- | --- | --- |
| `pane.agent_status_changed` (hook) | `tu hook` | Ingest that pane's harness, (re)bind pane, report pane and workspace tokens, evaluate rules, maybe notify | < 300 ms |
| `pane.agent_detected`, `pane.closed`, `pane.moved` (hooks) | `tu hook` | Bind a new agent and clear stale tokens, retire a binding, or re-key a moved pane | < 200 ms |
| `[[startup]]` | `tu startup` | Full incremental ingest, re-report tokens for every live agent (herdr does not persist them), refresh quota, write shims | async, < 3 s |
| `ui.tab_bar_right` command, every 5 s (opt-in) | `tu status-line` | Cheap ingest, refresh `working` panes (mid-turn freshness), print the one-line summary | < 500 ms |
| Dashboard pane open | `tu dashboard` | `fs.watch` + 2 s poll + `events.subscribe`; re-renders | live |
| Keybinding or action | `tu open` / `snooze` / `refresh` | Open popup, split or tab; mute alerts | instant |

Notes:

- **Hooks must be short and self-contained.** herdr gives hooks no timeout and
  shares 32 command slots across all plugins; overflow events are silently
  dropped. Each hook therefore:
  - touches only the event's pane;
  - never spawns children that keep stdout/stderr open;
  - exits in well under a second.
- **Single-flight ingest.** A lock file plus `ingested_at` lets concurrent hooks
  skip work done in the last second. SQLite runs in WAL mode with
  `busy_timeout`. All writes are idempotent upserts on dedupe keys.
- **State is keyed by `terminal_id`**, not `pane_id`, because pane IDs change
  on `pane.moved`. Hooks also listen to `pane.moved`.
- **Previous status is ours to remember.** herdr's event carries no prior
  state. `idle` and `done` both mean "turn finished".
- **Agent changes clear tokens.** Metadata lives on the terminal and would
  otherwise reappear for the next agent in that pane.
- **Diff before reporting.** Compare against the tokens herdr returns for the
  pane. Send only changed keys (≤ 16 per report) over the socket directly
  (`HERDR_SOCKET_PATH`), falling back to `HERDR_BIN_PATH`. Workspace reports
  are especially important to diff, because each one writes 2 INFO log lines.
- **Why not a daemon?** herdr startup hooks are one-shot by design and plugins
  must not leave detached processes. The tab-bar interval is herdr-supervised
  (no overlap, timeout, process-group kill), so it is the sanctioned periodic
  tick. Its default timeout is 2 s, so `status-line` must answer in < 1 s.
  Heavy work is left to hooks, startup and the dashboard.
- **Optional later:** harness push adapters (a Pi extension or OpenCode plugin
  calling `tu push` on every message end) for sub-second updates mid-turn.
  They are probably unnecessary given the 5 s tick.

---

## 5. Data model (ledger)

One row per model call (`request`), keyed by a harness-specific dedupe id:

| Column | Notes |
| --- | --- |
| `id` (PK) | e.g. `claude:<message.id>:<requestId>`, `pi:<responseId‖entryId>`, `opencode:<message id>`, `copilot:<row id>` |
| `harness`, `session_id`, `root_session_id` | Subagents roll up to the root (OpenCode `parent_id`, Claude sidechains) |
| `ts`, `cwd`, `project` | Local-time day bucketing |
| `provider`, `model`, `billing` | `billing` ∈ `copilot` · `claude-sub` · `api` · `local` |
| `input`, `output`, `cache_read`, `cache_write`, `reasoning` | Tokens |
| `cost_usd` | Recorded by the harness, else computed at list price ("API-equivalent") |
| `credits` | Copilot credits. Exact for Copilot CLI (`nano_aiu/1e9`). For Pi/OpenCode on `github-copilot`, recomputed from tokens × the Copilot rate card (observed in Copilot CLI's `token_details_json`), falling back to the harness's catalog `cost_usd × 100`. `isByok` is excluded. |
| `premium_requests` | For premium-request plans: multiplier × user-initiated calls |
| `duration_ms`, `ttft_ms`, `itl_ms` | Performance, where available |
| `initiator` | `user` / `agent` |
| `context_tokens`, `context_limit` | For context-window % |

Other tables: `session`, `binding` (pane → session, with method and confidence),
`cursor` (per-source offset, inode, rowid or mtime), `alert` (rule state,
cooldown, snooze), `quota` (provider snapshots), `meta` (schema version).

---

## 6. Adapters (v1)

| Adapter | Discovery | Cursor | Dedupe | Normalization notes |
| --- | --- | --- | --- | --- |
| Pi | `~/.pi/agent/sessions/*/*.jsonl` (`PI_CODING_AGENT_DIR`) | byte offset + inode | `entry.id`+`message.timestamp`+`responseId`, across the `parentSession` fork chain | Also counts `usage`, `compaction`, `branch_summary` and `toolResult` usage. `durationMs` gives speed. |
| OpenCode v2 | `~/.local/share/opencode/opencode.db` read-only (`OPENCODE_DB`) | `time_updated` high-water mark minus a safety window | message id (upsert) | **output = `tokens.output + tokens.reasoning`**. Skip fork copies. Root via `session_v2.parent_id`. v1 JSON storage fallback later. |
| Copilot CLI | `~/.copilot/session-store.db` → `assistant_usage_events` (`COPILOT_HOME`) | `id` high-water mark | row id | **uncached input = `input − cache_read − cache_write`**. USD = `nano_aiu/1e11`. Exact credits, TTFT, ITL. Skips `isByok`. Falls back to `events.jsonl`. |
| Claude Code | `~/.claude/projects/**/*.jsonl` (`CLAUDE_CONFIG_DIR`) | byte offset + inode | `message.id`+`requestId` (upsert, **keep max output**) | Skips `<synthetic>`. Ignores `**/*ClaudeBar-Probe*/**` by default. Includes `subagents/` (53% of calls). |
| Codex (P2) | `~/.codex/sessions/**/rollout-*.jsonl[.zst]` | byte offset | `response_id`, or count only when the cumulative total advances | Uncached input = `input − cached_input`; model from `turn_context`; rate limits |

All adapters parse defensively. Unknown fields are ignored, malformed lines are
counted, and `tu doctor` surfaces both.

---

## 7. Pane ↔ session binding

1. **Exact**: when a herdr integration is installed, `agent_session` from
   `herdr agent list` identifies the native session (⚑ install integrations):
   - Pi reports the session **file path**.
   - OpenCode reports its **root** `ses_…` id.
   - Claude, Copilot and Codex report session **ids**, which resolve to their
     files.
   - The reference is validated against file mtime and cwd, because herdr's
     copy can lag (issue #4463).
2. **Heuristic** (fallback), scored per harness:
   - same harness and `foreground_cwd`;
   - session active since the agent process started (`pane.process_info`);
   - **title match**: OpenCode's terminal title is `OC | <session title>`, and
     Claude transcripts carry `ai-title` lines;
   - most recent activity;
   - not already bound to another live pane.
3. **Sticky with re-evaluation** on every hook. If Pi `/new` or OpenCode starts
   a new session, the binding moves.
4. Bindings are recorded with method and confidence. The dashboard marks
   heuristic bindings with `~`.

---

## 8. Units, metrics and levels

**Units (lenses).** ⚑ Default: tokens everywhere, plus credits for
Copilot-routed usage.

| Billing | Headline unit | Secondary |
| --- | --- | --- |
| Copilot (Pi/OpenCode via `github-copilot`, Copilot CLI) | credits, % of monthly quota, pace (legacy plans: premium requests × multiplier) | tokens, API-equivalent $ |
| Claude API or enterprise plans | API-equivalent $ | tokens |
| Claude Pro/Max (other users) | tokens (+ 5h/7d window % via opt-in statusline bridge) | API-equivalent $ |
| Pay-per-token API | $ | tokens |
| Local (LM Studio, Ollama, LiteLLM) | tokens, tok/s | n/a |

**Derived metrics**

| Metric | Definition |
| --- | --- |
| work tokens | input + cache_write + output (+ reasoning). This is the default "tokens" figure. Cache reads are excluded here because the whole prefix is re-reported every turn, so totals would otherwise grow quadratically. They remain in credits and cost. |
| processed tokens | work tokens + cache_read (shown in detail views) |
| context % | last call's prompt tokens ÷ effective window (harness limit beats registry) |
| cache hit % | cache_read ÷ (input + cache_read + cache_write) |
| burn rate | work tokens or credits per minute, 5 min window |
| tok/s | output ÷ generation time |
| TTFT | p50 / p95 |
| pace | quota used % ÷ period elapsed %; < 1 means under budget |
| projected | used + 7-day burn × days left |

**Levels:** `low ▽` · `normal ●` · `high ▲` · `critical ■`. Levels come from
rules and are encoded as a leading glyph in token values. herdr's
`starts_with` style rules then colour them natively, so the plugin never draws
the sidebar.

---

## 9. Surfaces

### 9.1 Agent sidebar (per pane)

Tokens reported via `pane.report_metadata`, all prefixed `tu_` to avoid
collisions:

| Token | Example | Purpose |
| --- | --- | --- |
| `$tu` | `▲ 1.2M · 326cr · 48%` | compact default (fits a 26-col sidebar). The leading level glyph lets herdr `starts_with` rules colour it. |
| `$tu_tok` / `$tu_cost` / `$tu_ctx` / `$tu_tps` | `1.2M` / `326cr` / `ctx 84%` / `62 t/s` | build your own row |
| `$tu_ctx_num` / `$tu_cost_num` | `84` / `326` | unitless numbers for your own `gt`/`lt` colour rules (herdr only matches fully numeric values) |

Suggested layout (written by `tu setup`):

```toml
[ui.sidebar.agents]
rows = [
  ["state_icon", "workspace", "tab"],
  ["agent", { token = "$tu", rules = [
      { starts_with = "■", fg = "#f38ba8", bold = true },
      { starts_with = "▲", fg = "#f9e2af" },
      { starts_with = "▽", fg = "#a6e3a1" } ] }],
]
```

### 9.2 Space sidebar (per workspace)

`$tu_ws` holds today's total for sessions bound to panes in that workspace, e.g.
`● 2.1M · 540cr today`.

### 9.3 Tab bar (global)

```toml
[ui]
tab_bar_right = [{ type = "command", command = "~/.local/state/herdr/plugins/pseudovar.token-usage/bin/tu-status", interval_seconds = 5, timeout_seconds = 3 }]
```

It prints e.g. `Copilot ▽ 14% · 0.24× │ today 3.4M tok · 1.2k cr`, capped at
80 chars with no colour (herdr strips escape sequences).

Tab-bar commands get no `HERDR_PLUGIN_*` variables and run under
`/bin/sh -lc`. The startup hook therefore rewrites a **stable shim** at the
fixed state-dir path, with absolute paths to `node` and the current plugin
root, so it survives plugin updates. The shim reads cached aggregates and does
a cheap incremental ingest within the 2–3 s timeout budget. As a side effect it
refreshes tokens for panes still `working`, which keeps the sidebar fresh
mid-turn.

### 9.4 Dashboard pane (summary and detailed views)

Opened with `prefix+u` (popup, 90%×85%) or as a split or tab. One TUI, five views:

```text
 TOKEN USAGE · today                                              ⟳ live 11:42:05
 Copilot credits ▕██████░░░░░░░░░░░░░░░░░░░░░░▏ 14.4% of 60k · pace 0.24× ▽ under
                 8,640 used · resets 1 Nov (13d) · projected 24% · 4.1k attributed here
 Today           3.4M tok · 1,240 cr · $12.40 API-eq · 212 calls · cache 89%
 ─ LIVE AGENTS ───────────────────── tokens ── credits ─ ctx ── tok/s ── state ─
 ▲ w1 acme-checkout    pi           1.25M       326     84%      62    working
 ● w3 herdr-plugin     opencode     0.89M       231     22%      71    working
 ▽ w4 Code             pi             12k         3      1%       —    idle
 ─ BY HARNESS (today) ─────────────── tokens ── credits ── $API ── calls ─ cache ─
 Copilot CLI                         1.10M       320     $3.20      88    91%
 Pi · OpenCode · Claude Code · Local …
 ─ ACTIVITY tokens/10 min, last 6 h ─  ▁▁▂▃▅▇█▆▃▂▁▁▂▅▆▇▅▃
 ─ ALERTS ─  ▲ w1 pi: context 84% (≥ 80)   ▽ Copilot pace 0.24× (≤ 0.5)
 [1]Summary [2]Agents [3]Session [4]History [5]Rules   ↑↓ ⏎ drill  p period  s snooze  q quit
```

| View | Content |
| --- | --- |
| 1 Summary | Quota gauges with pace, today's totals, live agents, harness breakdown, sparkline, alerts |
| 2 Agents | Every live pane with its binding (exact or `~`), session totals, ctx %, cache %, tok/s |
| 3 Session (detailed) | Per-call table (time, model, in/out/cache, credits, $, duration, TTFT, tok/s), model mix, context-growth sparkline |
| 4 History | Day/week/month by harness, model or project; 30-day sparkline |
| 5 Rules | Each rule, its current value and state (ok/firing/snoozed); snooze toggle |

The renderer is a small zero-dependency ANSI layer: alternate screen, one write
per frame, ≤ 4 fps, responsive from about 40 columns (split) to full screen
(popup). It respects `NO_COLOR`.

**Placement behaviour (herdr constraints)**

- The **popup** is the default. It is a singleton per session and is never
  persisted, so nothing goes stale.
- **Split and tab** dashboards are normal panes, but herdr does **not**
  relaunch them after a server restart; they come back as plain shells.
  Re-opening an entrypoint also creates duplicates.
- The plugin therefore records its dashboard pane/terminal ids in state. `open`
  focuses an existing dashboard instead of duplicating it, and `startup` tidies
  up a dashboard pane that came back as a bare shell.

### 9.5 Notifications

Sent with `herdr notification show` when a rule *enters* a notifying level.

- **Firing**: edge-triggered, rate-limited per rule and scope by a cooldown,
  and snoozable globally (`prefix+shift+u` → snooze 1 h).
- **Coalescing**: herdr allows one toast per second server-wide, with no queue.
  Alerts raised in the same hook are merged into one toast; on `rate_limited`
  the plugin retries once.
- **Delivery**: herdr reports `shown: true` even when the client's delivery is
  `off`, so the plugin cannot detect a suppressed toast. `tu setup` checks
  `ui.toast.delivery` and offers to set it (⚑ choose `herdr` or `system`).
- **History**: every fired alert is also logged in the ledger and shown in the
  dashboard's alerts strip, so nothing is lost if toasts are off.

---

## 10. Rules

Config lives at `$HERDR_PLUGIN_CONFIG_DIR/config.jsonc` and is created with
commented defaults on first run (`tu config` prints the path).

```jsonc
{
  "rules": [
    { "id": "ctx-high",      "metric": "session.context_pct",  "op": ">=", "value": 80,  "level": "high",     "notify": true },
    { "id": "ctx-critical",  "metric": "session.context_pct",  "op": ">=", "value": 92,  "level": "critical", "notify": true },
    { "id": "session-spend", "metric": "session.credits",      "op": ">=", "value": 500, "level": "high",     "notify": true },
    { "id": "burn",          "metric": "session.burn_tpm_5m",  "op": ">=", "value": 400000, "level": "high",  "notify": true },
    { "id": "cache-poor",    "metric": "session.cache_hit_pct","op": "<",  "value": 40,  "level": "high",     "min_calls": 5 },
    { "id": "copilot-over",  "metric": "quota.copilot.pace",   "op": ">=", "value": 1.1, "level": "high",     "notify": true },
    { "id": "copilot-under", "metric": "quota.copilot.pace",   "op": "<=", "value": 0.5, "level": "low" },
    { "id": "copilot-90",    "metric": "quota.copilot.used_pct","op": ">=","value": 90,  "level": "critical", "notify": true },
    { "id": "daily-tokens",  "metric": "today.tokens",         "op": ">=", "value": 20000000, "level": "high", "notify": true }
  ],
  "notify": { "cooldown_minutes": 60, "sound": "request" }
}
```

**Metric catalogue**

| Scope | Metrics |
| --- | --- |
| `session.*` (pane-bound) | `tokens`, `credits`, `cost_usd`, `context_pct`, `cache_hit_pct`, `burn_tpm_5m`, `tps_p50`, `ttft_p50_ms`, `calls` |
| `workspace.today.*` | `tokens`, `credits`, `cost_usd` |
| `today.*`, `week.*`, `month.*` | `tokens`, `credits`, `cost_usd`, `calls` |
| `harness.<name>.today.*` | `tokens`, `credits`, `cost_usd`, `calls` |
| `quota.copilot.*` | `used_pct`, `remaining`, `pace`, `projected_pct`, `days_left` |
| `quota.claude.*` (opt-in ⚑) | `five_hour_pct`, `seven_day_pct` |
| `quota.codex.*` (P2) | `primary_pct`, `secondary_pct` |

**Semantics**

- A rule is active while its condition holds.
- A scope's level is the most severe active rule.
- Notifications fire on the inactive → active edge, then at most once per
  cooldown.
- Hysteresis: a rule must drop 5% below its threshold to clear.
- `low` rules are how "using little / plenty of headroom" is expressed.

---

## 11. Privacy, safety and footprint

- **Read-only.** Harness stores are opened read-only. Only usage fields are
  kept. Prompts and responses are never stored or shown.
- **Network.** Only the Copilot quota call via `gh` (cached 5 min), plus
  opt-in providers. No telemetry.
- **No harness changes.** Integrations are installed only through herdr's own
  `herdr integration install` and only with consent. herdr's `config.toml` is
  changed only by `tu setup --apply`, with a timestamped backup and
  `herdr server reload-config`.
- **Footprint.** No `npm install`. State is roughly 1 KB per call in SQLite.
  Hooks run in about 200 ms.

---

## 12. Decisions (confirmed with the maintainer, 2026-10-19)

| # | Decision | Outcome |
| --- | --- | --- |
| 1 | Build vs adopt | **Build our own**, Copilot-first, reusing proven patterns from existing plugins |
| 2 | Headline unit | **Credits + pace for Copilot-routed usage; API-equivalent $ for Claude.** Tokens are secondary everywhere. |
| 3 | Where the UI lives | **Agent sidebar + space rows + tab bar** (ambient) and a **popup dashboard on `prefix+u`**. Split/tab available as actions. |
| 4 | herdr integrations | **Install pi, opencode, claude, copilot** for exact pane → session mapping. Heuristics remain the fallback. |
| 5 | Editing `config.toml` | **Yes**, via `tu setup`: show a diff, take a timestamped backup, append only missing sections, then `reload-config` |
| 6 | Toast delivery | **`herdr` in-app toasts** |
| 7 | Local models | **Not in v1.** Local-provider calls are still recorded (priced $0, billing `local`); no probes or LiteLLM API. |
| 8 | Default alerts | **All seven categories toast by default**: Copilot pace, Copilot 75/90/100%, context high, expensive session, burn spike, poor cache, under-using. **Every rule is configurable inside the plugin**: the dashboard Rules view is an editor (toggle, notify, level, threshold) that saves to `config.jsonc`. |
| 9 | Name and distribution | **Prepare for the marketplace now**: id `pseudovar.token-usage`, MIT, macOS + Linux, README, `herdr-plugin` topic. |

---

## 13. Delivery plan

| Phase | Scope | Exit check |
| --- | --- | --- |
| **P1 Ledger** | Ledger, 4 adapters (Pi, OpenCode v2, Copilot CLI, Claude Code), pricing, `tu report` | Per-harness credit totals reconcile with the local data in RESEARCH §4 |
| **P2 Live in herdr** | Manifest, launcher, hooks, binding, sidebar/space tokens, startup re-report, status-line, `tu setup`/`doctor` | Sidebar shows live values for the 3 running agents |
| **P3 Quota and rules** | Copilot quota + pace, rules engine, toasts, snooze | Rules fire once, respect cooldown, colour the sidebar |
| **P4 Dashboard** | TUI views 1–5, live refresh, popup/split/tab | Usable at 40 cols and full screen |
| **P5 Later** | Codex/Gemini adapters, Claude limits, local probes, push adapters, Windows, marketplace | n/a |

---

## 14. Risks

| Risk | Mitigation |
| --- | --- |
| Harness formats change (Claude Code and OpenCode change often) | Isolated adapters, tolerant parsing, fixtures, `tu doctor` parse stats |
| `copilot_internal` is an internal endpoint | 5-min cache, graceful "quota unavailable", local data still works |
| Hook storms or slot exhaustion (32 shared slots; overflow events are dropped silently) | Hooks finish in < 300 ms; single-flight lock; skip-if-fresh; startup and tab-bar tick reconcile anything missed |
| Stale tokens on a pane after its agent changes | Clear on `pane.agent_detected`; key state by `terminal_id` |
| `node` not on the herdr server PATH | `bin/tu` launcher probes PATH, mise, Homebrew, nvm, volta, fnm |
| Heuristic binding mistakes | Integrations recommended; confidence shown; title matching |
| Sidebar tokens lost on server restart | Startup hook re-reports |
| First-run backfill cost (≈ 200 MB of logs) | Measured at 0.7 s for 13.8k calls across all harnesses, so no special handling is needed. Incremental runs take 20–150 ms. |

---

## 15. Implementation notes (v0.1.0)

**Changes from the draft, all found while testing against live data:**

- **`every` rules hold their level for 15 minutes** after each milestone
  instead of staying active. Otherwise every long session would show ▲ forever,
  the "standing alarm" failure from RESEARCH §8. Threshold and `steps` rules
  stay standing conditions.
- **For Copilot-billed calls, $ = credits ÷ 100.** OpenCode's own cost estimate
  for `github-copilot` omits cache writes and reasoning tokens; Copilot bills
  both, as Copilot CLI's `token_details_json` shows. Credits come from the
  observed rate card. Checked against Pi's own totals and OpenCode's session
  totals, the ledger agreed to within 0.2% before re-pricing.
- **Rule evaluation runs in a SQLite `BEGIN IMMEDIATE` transaction.** Hooks,
  the tab-bar tick and the dashboard can evaluate the same scope at once, and
  this keeps edge-triggered toasts single.
- **The dashboard leaves the last column empty.** herdr reports the full pane
  width to the PTY, but its pane scrollbar overlays the final column.
- **Ledger migrations are additive** (`ensureColumn`), so existing state
  survives upgrades.
- **There is a dry-run publish mode** (`dashboard --snapshot --no-publish`) for
  rendering tests and docs without touching the live sidebar.
- **OpenCode v2 hot-loads herdr's integration.** Panes switch from heuristic to
  exact binding without a restart. Pi, Claude and Copilot pick it up on their
  next session start.

**Measured on this machine** (herdr 0.9.4, Node 26.10):

| Path | Time |
| --- | --- |
| Event hook (real agent pane, incl. socket calls, ingest, rules) | ≈ 0.24 s |
| Tab-bar `status-line` (cached quota / with fetch) | 0.13 s / 0.23 s |
| Startup hook (incremental) | 0.15 s |
| Full first ingest (5,346 Claude + 800 OpenCode + 324 Pi + 720 Copilot calls) | 0.7 s |
| Unique Claude calls vs an independent `jq` count of message ids | 5,346 = 5,346 |

**Deferred to later phases:**

- Codex and Gemini adapters
- local-server probes (Ollama `/api/ps`, LM Studio `stats`, LiteLLM spend logs)
- an opt-in Claude statusline bridge for Pro/Max window limits
- harness push adapters
- Windows support

## 16. Display system and charts (v0.2.0)

- **One grammar on every herdr surface:** `<level glyph> <money> <visual>`, in
  dollars, for today, so agents ⊂ space ⊂ tab bar add up. Copilot credits
  convert at exactly $0.01 (`display.money = "credits"` shows credits instead).
  Agent rows default to today's spend in that pane (sessions found through
  `binding_history`); `display.agentScope = "session"` shows the session total.
- **Styles** (`src/core/display.ts`) are pure functions from a view to a token
  map, so one `config.toml` layout serves all of them. Rows whose token is
  empty disappear. Rich detail lines are capped at 24 characters (herdr's
  sidebar is 26 columns by default) and drop their lowest-ranked part to fit.
- **Prototyping:** an interim Lab view showed every style and chart side by
  side on real data. The user picked `rich`; burn-up and cost anatomy moved to
  the Summary and the rest became the Charts view.
- **Charts** (`src/ui/charts.ts`) use braille cells (2×4 dots) for lines,
  plus block characters for stacked columns, 100% bars, heatmaps and box plots.
  One colour per cell, so the last series drawn wins where lines cross.
- **Burn-up history:** each successful Copilot quota fetch also writes
  `quota_history` (at most every 5 minutes). Before the first snapshot of a
  month the account line is a dashed straight-line estimate.
- **Cost anatomy** splits token sums by billing/provider/model with
  `Pricing.ratesUsd` (Copilot rate card ÷ 100 for Copilot-billed calls). It
  reconciles with `SUM(cost_usd)` to the cent over 30 days.
- **Deferred chart ideas** from this round were built in v0.3.0 (§17).

## 17. Pixel charts, advisor, what-if, treemap (v0.3.0)

- **Kitty graphics through herdr.** herdr parses the protocol from pane output
  and renders it in capable outer terminals (`terminal.kitty_graphics`, on by
  default).
  - At start-up the dashboard sends a support query (`a=q`), `CSI 16 t` for
    the cell size, and DA1 as a sentinel.
  - Replies are stripped from stdin before key parsing, including replies
    split across reads. A stray DA1 reply such as `ESC[?62;22c` would
    otherwise read as the keys 6, 2 and c.
  - In herdr 0.9.4 the query answers OK. Transmissions and placements sent
    with `q=1` (errors only) return no errors; any error is logged.
- **Placement.** The burn-up uses a single image id.
  - The PNG is sent (`a=t`) only when the picture changes: at once on resize,
    otherwise at most every 10 s.
  - After every frame the image is placed again (`a=p,p=1`) at its text box,
    wrapped in cursor save/restore.
  - It is hidden (`d=i`) when it scrolls partly out of view or the view
    changes, and freed (`d=I`) on exit.
- **Rasteriser.** Straight-alpha RGBA on a transparent canvas.
  - Strokes are anti-aliased by distance to the segment. Coverage is merged
    with max() per polyline, so joints aren't blended twice.
  - It also does gradient area fills and discs. The PNG uses
    `zlib.deflateSync` and a table-driven CRC32.
  - Axis labels stay as terminal text, in the user's font.
  - A 2400×384 burn-up renders in about 45 ms and is about 50 KB (66 KB as
    base64).
- **Compaction advisor.**
  - Each call re-reads the prompt, costing `prompt × cache-read rate`. After
    `/compact` the prompt is about the session's first prompt plus an
    8k-token summary.
  - The one-off cost covers reading the prompt once, writing the summary and
    re-caching the prefix.
  - Pace is main-agent calls in the last hour. Idle sessions are judged on
    their next 20 calls.
  - Verdicts: "compact now" at ≥ 80% context or ≥ $2/h savings, "compact
    soon" at ≥ $0.50/h.
- **Model what-if.** Re-prices the period's token sums at each model's rate:
  the Copilot rate card first, then the catalogs. Missing cache rates fall
  back to the input rate. It ignores differences in tokenizer, verbosity and
  caching, and says so.
- **Treemap.** Squarified layout (Bruls, Huizing & van Wijk).
  - Laid out in square units because cells are about 2:1, then snapped to
    cell edges so neighbours share borders.
  - Projects get a hue and a header row. Sessions alternate shades and have a
    gap column on the right.
- Charts-view data costs about 13 ms per refresh with the new sections.

## 18. Readability pass (v0.3.2)

- **A centred column on wide panes.** The dashboard renders at most 160
  columns (`MAX_COLS` in `src/ui/frame.ts`) and centres the frame. Mouse tab
  regions and the Kitty image placement are offset by the margin. Charts were
  already capped near 160, so this mainly stops tables and section rules from
  spreading out.
- **Column layout.** `layoutColumns` widens columns with `grow` (names that
  would truncate) from room left over after every preferred width, then gives
  flexible columns the rest up to `max`. A flexible column's `width` is now its
  preferred width, so names only grow from room it doesn't need.
- **Ledger schema v2.** Session titles are stored on one line, and existing
  titles with line breaks are repaired once. `fit()` also turns line breaks
  into spaces, so no cell can split the frame.

## 19. Popup width, Charts tabs, drawing cost (v0.4.0)

- **Popup width.** herdr popups take an outer size in cells or a percentage of
  the pane area. In client-shell mode that area is the tab's pane surface,
  which `pane.layout` reports. herdr clamps cell sizes to the area and keeps 3
  columns for the border and a spare column. `open` sends `min(⌊area × 92 /
  100⌋, MAX_COLS + 4)`, so a wide window gets a popup exactly the dashboard's
  width, and narrow ones keep 92%.
- **Where the lag came from.** Measured on the dev machine:
  - Building every chart took about 21 ms and rendering 2 ms, so the CPU work
    was small.
  - The refresh is about 240 ms, mostly two herdr round trips (`ping` ≈ 105 ms,
    `publishAll` ≈ 118 ms). They're asynchronous and don't block keys.
  - The cost was output. Each frame was 40 KB, with a colour sequence per
    braille or heatmap cell, and every key or wheel event redrew all of it.
  - The pixel burn-up was placed again after every frame and re-sent (about
    70 KB) every 10 seconds while spend ticked up.
- **Fixes.**
  - `draw()` diffs against the previous frame (`frameDiff`) and writes only the
    changed lines, cursor-addressed.
  - Renders are coalesced to one per 30 ms.
  - `colorRuns` emits one colour sequence per run, and blank cells join the
    current run.
  - The image key is quantised to whole pixels. The image is placed again only
    when it was re-sent, moved, or had its rows redrawn.
  - A scripted 12-second session (Summary, Charts, 24 wheel events) wrote
    1.5 MB before and 30 KB after.
- **Charts tabs.** `ChartsData` is a union keyed by tab. `buildChartsData`
  queries only the open tab's sections; each tab is 25–45 rows.
