# Research: token usage & performance tracking inside herdr

Status: research complete (four tracks: local verification, herdr internals,
harness formats, quota APIs). Design decisions are in `DESIGN.md`.
Date: 2026-10-19. Machine: macOS 27, herdr 0.9.4 (server protocol 22), Node 26.10.

Everything marked **verified** was checked on this machine or against the herdr
0.9.x docs and the API schema bundled in the installed binary. Anything else is
cited or flagged.

---

## 1. The brief

- Track token usage **and** performance across every harness used inside herdr:
  Pi, OpenCode, Claude Code, GitHub Copilot CLI, local models (Ollama, LM Studio,
  LiteLLM), with room for Codex and others.
- Must work with the **GitHub Copilot** subscription that Pi and OpenCode route through.
- Live updating.
- Rules and notifications that show whether usage is **high or low**.
- A **summary** view and a **detailed** view.
- Must stay within herdr's plugin constraints. Open question from the brief:
  *can a plugin add another panel?*

---

## 2. What a herdr plugin can and cannot do (verified)

Sources: <https://herdr.dev/llms.txt> → `plugins.mdx`, `socket-api.mdx`,
`cli-reference.mdx`, `configuration.mdx`; `herdr api schema --json`; the
official example plugins (`ogulcancelik/herdr-plugin-examples`).

### 2.1 Plugin model

- A plugin is a directory with `herdr-plugin.toml` that declares `[[build]]`,
  `[[startup]]`, `[[actions]]`, `[[events]]`, `[[panes]]` and
  `[[link_handlers]]`. Commands are argv arrays and can be in any language.
- "The entire Herdr CLI is the plugin API." Plugins call back through
  `HERDR_BIN_PATH`. There is no SDK and no sandbox.
- Herdr injects `HERDR_PLUGIN_ID`, `HERDR_PLUGIN_ROOT`, `HERDR_PLUGIN_CONFIG_DIR`,
  `HERDR_PLUGIN_STATE_DIR`, `HERDR_PLUGIN_CONTEXT_JSON`, `HERDR_SOCKET_PATH` and
  `HERDR_BIN_PATH`. Event hooks also get `HERDR_PLUGIN_EVENT` and
  `HERDR_PLUGIN_EVENT_JSON`.
- **No storage API.** Plugins own their files under `HERDR_PLUGIN_STATE_DIR`.
- **No native, non-terminal UI** in plugin v1, and no runtime action registration.
- `[[startup]]` hooks are **one-shot**, not supervised daemons. The docs ask
  plugins to stop detached background processes before their parent command or
  pane exits.

### 2.2 Answer: "can a plugin add another panel?"

**Yes, as a terminal pane, but not as a native sidebar section.** A `[[panes]]`
entrypoint runs our program in a PTY with one of these placements:

| Placement | Behaviour | Fit for us |
| --- | --- | --- |
| `split` | Normal tiled pane next to the target pane | Always-on dashboard beside your agents |
| `tab` | New tab in a workspace | Dedicated "Usage" tab |
| `popup` | Session-modal floating terminal (`width`/`height`, e.g. `"90%"`), closes on exit | Toggle with a key, glance, dismiss |
| `overlay` / `zoomed` | Temporary full-pane view that restores focus on close | Quick detailed view |

Herdr also has **three native surfaces that a plugin can feed with live values**.
These come closest to "living inside herdr":

| Surface | Mechanism | Notes |
| --- | --- | --- |
| **Agent sidebar rows** | `pane.report_metadata` → `tokens: {name: value}`, rendered by `$name` in `[ui.sidebar.agents] rows` | Per-agent line, e.g. `1.2M · 326cr · ctx 48%` |
| **Space (workspace) sidebar rows** | `workspace.report_metadata` → `$name` in `[ui.sidebar.spaces] rows` | Per-workspace totals |
| **Tab bar, right side** | `ui.tab_bar_right = [{ type = "command", command = "…", interval_seconds = N, timeout_seconds = M }]` | Runs on the server on an interval, uses the last line of stdout. Good for a global summary. |

Token styling supports **conditional rules** (`equals`, `contains`,
`starts_with`, `gt`, `lt`, plus `hide`). Colour can therefore follow the usage
level natively, with no rendering of our own.

Limits (verified in the docs): token values are capped at 80 characters, 16 keys
per report, 32 keys per pane or workspace, and 32 sequenced sources per pane
lifetime. Token metadata is **not restored after a server restart**, so a
startup hook must re-report it.

### 2.3 Triggers available to us

| Trigger | How | Use |
| --- | --- | --- |
| Agent state changes | `[[events]] on = "pane.agent_status_changed"` (verified in the official telegram example) | Recompute a pane's usage when it goes `working` → `idle`/`done`/`blocked` |
| Agent appears or leaves | `pane.agent_detected`, `pane.closed`, `pane.exited` | Bind or unbind pane ↔ harness session |
| Server start | `[[startup]]` | Re-report sidebar tokens and refresh quota cache |
| Periodic tick | `tab_bar_right` command with `interval_seconds` | Mid-turn freshness without a daemon |
| User | `[[actions]]` + `[[keys.command]] type = "plugin_action"` | Open dashboard, snooze alerts, refresh |
| Long-lived stream | `events.subscribe` over the socket | Only while the dashboard pane is open |

### 2.4 Notifications

`herdr notification show <title> --body … --sound none|done|request` maps to
`notification.show`. Delivery follows `[ui.toast] delivery`, which defaults to
**`off`**. Users must set it to `herdr` (in-app) or `system` (macOS
notifications) for rule alerts to show.

Source-level gotchas (herdr v0.9.4, `server/headless/notifications.rs`):

- With a client attached, the server returns `shown: true` even when the
  client's delivery is `off`. **The plugin cannot detect suppressed toasts**, so
  setup must configure `ui.toast.delivery`.
- Toasts are rate-limited to **1 per second server-wide**, with no queue. On
  `rate_limited`, retry once after 1.1 s.

### 2.4a Hook execution model (from herdr v0.9.4 source)

- **Hookable events** (`PLUGIN_HOOK_EVENT_KINDS`): `pane.created`, `.closed`,
  `.focused`, `.moved`, `.exited`, `.agent_detected` and
  `.agent_status_changed`, plus workspace, tab and worktree lifecycle events.
- Token or metadata changes emit `pane.updated` and
  `workspace.metadata_updated`. These are **deliberately not hookable**, so
  reporting tokens from a hook cannot loop.
- Setting `title`, `display_agent` or `state_labels` *does* re-fire
  `agent_status_changed`. **Report tokens only.**
- `HERDR_PLUGIN_EVENT_JSON` looks like
  `{"event":"pane_agent_status_changed","data":{"pane_id","workspace_id","agent_status","agent"?,…}}`.
  There is **no previous status**, so the plugin must remember it. For pane
  events the context JSON describes the *event's* pane. A turn that finishes in
  the visible tab goes straight to `idle` rather than `done`.
- Hooks are **fire-and-forget threads**: no queue, no debounce, **no timeout**.
  All plugins share **32 global command slots**. When the slots are full, an
  event is **silently dropped**.
- A slot is held until the child exits *and* its stdout/stderr pipes close. A
  background grandchild that keeps those pipes open holds the slot.
- stdout/stderr are kept in memory (64 KiB cap) and read with
  `herdr plugin log list`.
- **Token metadata** has these properties:
  - It lives on the pane's *terminal*, shared by all sources. Prefix keys
    (`tu_*`).
  - It survives the agent exiting and **reappears for the next agent in that
    pane**, so clear it on `pane.agent_detected`.
  - It is lost on server restart and on live handoff.
  - Every report triggers a re-render (coalesced to 16 ms).
  - `workspace.report_metadata` writes 2 INFO log lines per call, so **send
    only on change**.
  - Omit the `agent` guard and use `source: "plugin:<id>"`.
- **Pane IDs change on `pane.moved`**, while `terminal_id` is stable. Key
  plugin state by `terminal_id`.
- **Plugin panes are not relaunched after a server restart.** They come back as
  plain shells. Re-opening an entrypoint creates a **duplicate**, with no
  singleton check. Popups are never persisted and there is one per session.
- **`tab_bar_right` command**:
  - Runs once on the server, even with no client attached, under
    `/bin/sh -lc`.
  - The default timeout is **2 s**.
  - Its process group is SIGKILLed after each run.
  - Herdr shows the last stdout line, capped at 80 chars, with escape sequences
    stripped (no colour).
  - Its environment has `HERDR_SOCKET_PATH`, `HERDR_BIN_PATH` and
    `HERDR_ACTIVE_{WORKSPACE,TAB,PANE}_ID`, but **no `HERDR_PLUGIN_*`**. The
    script must locate the plugin state dir itself
    (`~/.local/state/herdr/plugins/<id>`).
- **`agent.view.set`** compares token values as **strings**, so sort keys must
  be zero-padded. There is one global view slot, shared with other plugins.
- **The manifest cannot declare keybindings**, sidebar rows, tab-bar entries or
  toast delivery. These are user config, so a `setup` helper is needed.
- **Version gates**: popup and `$name` tokens arrived in 0.7.4, startup hooks
  in 0.7.5, `tab_bar_right` in 0.8.2, colour `rules` in 0.9.0 and `hide` in
  0.9.1. Target `min_herdr_version = "0.9.1"`.

### 2.5 Pane → harness session mapping

`herdr agent list` gives `agent`, `pane_id`, `workspace_id`, `cwd`,
`foreground_cwd`, `terminal_title` and `agent_status` for every live agent
(verified: 2× Pi, 1× OpenCode running right now). When a herdr **integration**
is installed for that agent, `agent_session {source, agent, kind, value}` also
appears and identifies the native session exactly. **None are installed on this
machine yet** (`herdr integration status`). Without them we must use heuristics:
cwd, harness, recency, process start time, and terminal title (OpenCode's title
is the session title, `OC | <title>`).

What each integration reports (herdr v0.9.4 source, `src/agent_resume.rs`):

| Agent | `kind` | `value` | Reported when |
| --- | --- | --- | --- |
| Pi | `path` | absolute session `.jsonl` path | `session_start`, `agent_start`, state reports |
| OpenCode | `id` | **root** `ses_…` id (child sessions mapped to the root) | TUI plugin polls its route every 100 ms |
| Claude Code | `id` | session UUID (the hook sends `transcript_path`, but herdr drops it) | SessionStart (startup, resume, clear, compact, fork) |
| Copilot CLI | `id` | session id (`~/.copilot/session-state/<id>/`) | SessionStart |
| Codex | `id` | session id | SessionStart |

The stored reference can go **stale**: herdr issue #4463 reports Pi restarting
within a second, and Claude resumes. No hook fires when only the session id
changes, so the plugin re-reads `agent_session` on every status hook and checks
it against file mtime and cwd.

---

## 3. Local data sources (verified on this machine)

| Harness | Location | Shape | Per-call fields | Live? |
| --- | --- | --- | --- | --- |
| **Pi** 1.3.0 | `~/.pi/agent/sessions/--<cwd>--/<ISO>_<uuid>.jsonl` | Append-only JSONL tree (`id`/`parentId`) | `provider`, `model`, `usage{input,output,cacheRead,cacheWrite,reasoning,totalTokens,cost{…,total}}`, `durationMs`, `responseId`, `stopReason` | Yes, appended per message |
| **OpenCode** 2.0.28 | `~/.local/share/opencode/opencode.db` (SQLite, WAL) | `session_v2` (running totals) + `session_message` (`type='assistant'`, JSON `data`) | `model{id,providerID,variant}`, `agent`, `cost`, `tokens{input,output,reasoning,cache{read,write}}`, `time{created,streamed,completed}` | Yes. Totals update live. Legacy `session/message/part` tables are empty in v2. |
| **Copilot CLI** 1.0.99 | `~/.copilot/session-store.db` → `assistant_usage_events` (720 rows) and `~/.copilot/session-state/<id>/events.jsonl` | One normalized row per API call | tokens (in/out/cache r/w/reasoning), `total_nano_aiu`, `request_multiplier`, `duration_ms`, `time_to_first_token_ms`, `inter_token_latency_ms`, `initiator`, `finish_reason`, `token_details_json` (per-model credit rate card) | Yes |
| **Claude Code** 2.1.287 | `~/.claude/projects/<cwd-dashed>/<sessionId>.jsonl` (+ `<id>/subagents/agent-*.jsonl`) | JSONL transcript | `message.usage{input_tokens,output_tokens,cache_creation_input_tokens,cache_read_input_tokens,cache_creation{5m,1h},output_tokens_details.thinking_tokens}`, `message.model`, `message.id`, `requestId` | Yes |
| **Codex** | `~/.codex/sessions/**/rollout-*.jsonl` | `token_count` events | See §5 | Not installed here (config only) |
| **Local** | LM Studio app present (server off), Ollama data dir (no models), LiteLLM proxy configured as an OpenCode provider | n/a | Usage is captured by the harness that calls the model | Via harness |

Gotchas found:

- **Claude Code streaming duplicates**: 369 of 1,175 assistant lines in one
  transcript share a `message.id`. Dedupe on `message.id` + `requestId`,
  keeping the line with the **maximum** `output_tokens`; early lines carry
  placeholder counts. Skip `model == "<synthetic>"`.
- **ClaudeBar probe noise**: 382 of 585 Claude transcripts are menu-bar probes
  under `…ClaudeBar-Probe/`. These must be ignored (configurable ignore globs).
- **OpenCode subagents** are child sessions (`parent_id`). They roll up to the
  parent session, and therefore to the pane.
- Volumes are small to moderate (Claude 116 MB, Copilot 83 MB, OpenCode 13 MB,
  Pi 1.7 MB). Incremental, cursor-based ingestion is required. A full rescan on
  every hook is not acceptable.

---

## 4. GitHub Copilot: the account-level truth (verified)

`gh api /copilot_internal/user` works with the existing `gh` login, so no new
credentials are needed:

```json
"copilot_plan": "business", "token_based_billing": true,
"quota_reset_date_utc": "2026-11-01T00:00:00.000Z",
"premium_interactions": {
  "entitlement": 30000, "remaining": 25680, "percent_remaining": 85.6,
  "credits_used": 4320, "overage_permitted": true, "unlimited": false
}
```

(Values are illustrative.)

**Credits = list-price USD × 100 (1 credit = 1 AIU = $0.01).** Verified three ways:

1. Copilot CLI rate card (`token_details_json`, nano-AIU per 1M tokens ÷ 1e9):
   `claude-opus-5.5` costs 400 in / 2000 out / 20 cache-read / 500 cache-write
   credits per 1M tokens.
2. Pi's `models-store.json` prices for `github-copilot/claude-opus-5.5` are
   $4 / $20 / $0.20 / $5 per 1M tokens.
3. OpenCode's models.dev snapshot has the same prices, and the same holds for
   `gpt-6.1-sol`, `gpt-6-luna` and `claude-sonnet-5.5`.

**Reconciliation.** Summing Copilot CLI, Pi and OpenCode credits for the month
accounted for **under half of the account-wide credits used**. The rest comes
from clients the plugin cannot see (VS Code, github.com, other machines,
deleted sessions). So:

- Use the **quota API as the headline gauge** (truth).
- Use **local data for attribution** (which pane, session, model or project spent it).
- Show the **unattributed remainder** explicitly instead of hiding it.

**Pacing** is the natural "a lot vs a little" signal. With 61% of the month
elapsed and 14% of credits used, the pace is 0.24×: well under budget.

Copilot CLI also records `request_multiplier` (e.g. 15× for Opus 5.5, 1× for
GPT models) for plans that are still on premium-request billing.

---

## 5. Pricing and context windows (verified, no network needed)

| Source | Path | Contents |
| --- | --- | --- |
| Copilot CLI | `session-store.db` → `token_details_json` | Exact Copilot credit rates per model and token type (observed) |
| Pi | `~/.pi/agent/models-store.json` | Per provider/model `cost{input,output,cacheRead,cacheWrite}` $/M, `contextWindow`, `maxTokens` |
| OpenCode | `~/.cache/opencode/models.json` | models.dev snapshot (5.6 MB): `cost{input,output,cache_read,cache_write,tiers}`, `limit{context,input,output}` for every provider |

Context-window percentage = last call's prompt-side tokens (input + cache read +
cache write) ÷ the effective window. Prefer the harness-reported limit (Copilot
CLI `maxPromptTokens` = 200k for Opus 5.5) over registry values (1M), because
harnesses can cap prompts below the model maximum.

---

## 6. Performance signals available

| Harness | Latency | Throughput | Other |
| --- | --- | --- | --- |
| Copilot CLI | `duration_ms`, `time_to_first_token_ms` | `inter_token_latency_ms` → tok/s | tool count, finish reason, request bytes |
| OpenCode v2 | `time.streamed − time.created` = response duration. **No TTFT**: `streamed` marks the *end* of the response body. | output ÷ duration (lower bound) | finish reason, agent |
| Pi | `durationMs` (request start → response end, excludes tools; includes TTFT) | output ÷ `durationMs` (lower bound) | stop reason, thinking level |
| Claude Code | none per request in transcripts (OTel `api_request` has `duration_ms`). `system/turn_duration` gives per-turn duration. | approximate | `speed`, `service_tier`, cache 5m/1h split |
| Local servers | Ollama native API, LM Studio REST v0/v1 `stats`, LiteLLM `/spend/logs` `completionStartTime` | server-side only | Harnesses never record TTFT or load time for local models |

Derived metrics that matter: **cache hit %** (cache read ÷ prompt tokens),
**context %**, **burn rate** (tokens or credits per minute over 5 min),
**cost per turn**, **TTFT p50/p95** (Copilot CLI only today), **tok/s p50**.

---

## 7. Runtime choice (verified)

- Node 26.10 is on PATH (via mise). It runs `.ts` files directly through
  built-in type stripping (available since Node 22.18). `node:sqlite` reads the
  OpenCode and Copilot databases read-only in about 10 ms.
- `node -e 0` starts in about 40 ms, and a TS hook that opens two SQLite
  databases finishes in about 220 ms wall time. That is fine for event hooks.
- This gives a **zero-dependency** plugin: no `npm install` and no build step.
  It matches the herdr example plugins (Node) and the Pi and OpenCode ecosystems
  (TypeScript).
- Alternatives considered: Go with Bubble Tea (nicer TUI widgets, but needs a Go
  toolchain at install and SQLite via cgo or a large pure-Go port), Python 3.9
  (too old here), Rust (not installed).

---

## 8. Prior art: existing herdr plugins

The marketplace index (`assets.herdr.dev/plugins/index.json`, 1,738 repos on
2026-10-19) has about 20 usage-related plugins. The closest:

| Plugin | Stack | Harnesses | Surfaces | Copilot |
| --- | --- | --- | --- | --- |
| [senna-lang/herdr-agent-usage](https://github.com/senna-lang/herdr-agent-usage) (53★) | Go | Claude, Codex, OpenCode, Pi, OMP, Grok, Kilo, Cursor | sidebar `$context`/`$cache_*`/`$limit`, limits pane, toasts | **Explicitly unsupported**: "a subscription whose collector is not implemented (for example Copilot) is intentionally not presented" |
| [Davidcreador/herdr-token-dashboard](https://github.com/Davidcreador/herdr-token-dashboard) (25★) | Go / Bubble Tea | Pi, OpenCode (server API or **v1** disk), Claude, Codex | tab pane, toasts only while the dashboard is open | No |
| [kwanwooi25/herdr-plugin-agent-quota](https://github.com/kwanwooi25/herdr-plugin-agent-quota) | Node, zero deps | Claude, Codex, Grok | popup, statusbar pane, sidebar gauges (background reporter), tab bar | No |
| [KeithMoc/herdr-tokenlens](https://github.com/KeithMoc/herdr-tokenlens) | Python | Claude, OpenCode | single-session cost ledger pane | No |
| [dkbo/herdr-model-badge](https://github.com/dkbo/herdr-model-badge) | Python | Claude, Codex, agy | sidebar tokens (model, ctx, cost, limits) | No |
| [jordanhawkes/herdr-metrics](https://github.com/jordanhawkes/herdr-metrics) | Python | Claude, Codex, TraeX | sidebar `$context`/`$usage`/`$limit` | No |

**Gap:** no plugin handles GitHub Copilot (quota, credits or Copilot CLI), and
none reads OpenCode v2 as a Copilot-billed harness. The same goes for rules
with low/high levels or performance metrics (tok/s, TTFT). Those are exactly
this plugin's purpose.

**Patterns worth reusing:**

- **A quota window belongs to the account, not the harness** (usagebar). Key
  usage blocks by billing provider, not by harness.
- **Diff before reporting.** Compare against the tokens herdr already holds and
  send nothing for a settled pane (model-badge).
- **Pre-split numeric tokens** for `gt`/`lt` colour rules (`$ctx` vs
  `$ctx_num`) (model-badge). **Variant tokens** (`_ok`/`_warn`/`_bad`, exactly
  one set) for colour without rules (agent-quota, usagebar).
- **Use TTL for account-level values** that can go stale on a quiet pane
  (model-badge).
- **Republish everything from `[[startup]]`.** Write a stable launcher into the
  state dir on every startup so it survives plugin updates (model-badge,
  usagebar).
- **`setup` and `enable-toast` actions** print snippets and append only when a
  key is missing. They never overwrite (usagebar).
- **Dedupe Claude streaming lines** on `requestId`. Without it figures inflate
  about 1.92× (tokenlens).
- **Count subagent spend** but keep it out of the parent's context
  (tokenlens: 12% of spend lives in subagent files).
- **Codex** reports cumulative totals, so the last event wins, and its
  `input_tokens` includes cached tokens (token-dashboard).
- **Exclude cache reads from "work" tokens.** Otherwise totals grow
  quadratically with turns (herdr-metrics). Keep them in cost, though.
- **Avoid standing alarms.** A signal that fires on 90% of frames carries no
  information (tokenlens). Tune default rules to be rare and actionable.

## 9. Quota and plan-limit sources (external research, 2026-10)

| Provider | Best source (no polling) | Pull endpoint (undocumented) | Auth to reuse | Unit / reset |
| --- | --- | --- | --- | --- |
| **GitHub Copilot** | Copilot API response headers `x-quota-snapshot-premium_interactions`; Copilot CLI `session.usage_checkpoint` | `GET api.github.com/copilot_internal/user` (**verified working here via `gh api`**) | existing `gh` login, so the plugin never handles tokens | AI credits; resets **1st of month 00:00 UTC** |
| **Claude** (Pro/Max) | Claude Code statusLine stdin `rate_limits.{five_hour,seven_day}` (documented) | `GET api.anthropic.com/api/oauth/usage` (heavily rate-limited, grey-area ToS) | Keychain `Claude Code-credentials`; never refresh it, because refresh tokens rotate | % of 5h / 7d windows |
| **Codex** (ChatGPT) | rollout `token_count.rate_limits` (3 schema versions); app-server `account/rateLimits/read` | `GET chatgpt.com/backend-api/wham/usage` | `~/.codex/auth.json` (read-only) | % of primary/secondary windows |

**Copilot billing changed on 2026-06-01.** Premium requests were replaced by
**GitHub AI Credits** (1 credit = 1 AIU = $0.01), metered per token at
per-model rates. Code completions remain unlimited.

| Plan | Monthly credits |
| --- | --- |
| Pro | 1,500 |
| Pro+ | 7,000 |
| Max | 20,000 |
| Business | 1,900 per user, pooled |
| Enterprise | 3,900 per user, pooled |

For org seats, `entitlement` appears to be the **user-level budget**. That
explains entitlements well above a plan's per-user figure. Annual Pro/Pro+ subscribers stay on legacy
premium requests (multipliers) until renewal. The plugin must handle both
shapes.

Parsing rules for `quota_snapshots.premium_interactions`, mirroring VS Code's
`parseQuotas()`:

1. If `unlimited`, show `credits_used` only (pooled seat with no budget).
2. If `entitlement == 0`, it is a placeholder: skip.
3. `used% = 100 − percent_remaining`. This can exceed 100 in overage
   (`percent_remaining < 0`).
4. `used credits = entitlement − quota_remaining`.
5. Reset is taken from `quota_reset_at` (epoch s), else
   `quota_reset_date_utc`, else `quota_reset_date`.
6. `entitlement` may arrive as a number **or a string**.

The schema changed about 7 times in 2026, always additively. Poll **≤ every
5 min** (VS Code core polls hourly) and honour 429 / `Retry-After` /
`X-RateLimit-Remaining: 0`.

**Claude Enterprise and Team seats** (`organizationType: claude_enterprise`
and similar) behave differently from Pro/Max. On those:

- statusLine `rate_limits` only appears for Pro/Max (or a gateway
  `spend_limit`), so 5h/7d windows are **not expected**.
- `~/.claude.json` has no `cachedUsageUtilization`.
- API-equivalent $ is likely close to real spend.

The plugin therefore **does not touch Claude OAuth tokens**. An opt-in
statusLine bridge (chaining any existing statusline, as usagebar and
model-badge do) is the only planned Claude quota source.

**Prior art for quota display:**

- CodexBar (MIT, 106 providers): Copilot via its own device flow, adaptive
  2–30 min polling.
- ClaudeBar (Apache-2.0): Copilot via the `gh` Keychain token.
- burnrate-copilot (MIT): `gh auth token`, 5-min cache, circuit breaker.
- pi-usage-meters (MIT): reuses Pi's stored token.
- onWatch (GPL-3.0): Claude statusline bridge.

## 10. Harness tooling prior art and normalization

**Multi-harness usage tools** (sources read at 2026-10 commits):

| Tool | Notes |
| --- | --- |
| **ccusage** v20 | Now a Rust CLI. The `@ccusage/*` packages are deprecated and there are no library exports. Covers 18 harnesses including Copilot CLI and Pi. `--json` gives **aggregates only**. Useful as a **test oracle** (`ccusage daily --json --by-agent`). |
| **tokscale** v4.20 | Rust core, 60+ clients. Copilot via `session-store.db` first. Includes LM Studio logs. Its `UnifiedMessage` per-request record is the closest prior art to our ledger schema. |
| **splitrail** | Rust. Real-time file-watcher TUI. `stats --include-messages` gives per-message rows (no cwd or timing). |
| CodexBar, Claude-Code-Usage-Monitor, toktrack | Narrower coverage. Monitor keeps the *first* Claude line, which undercounts output. |

Decision: **write our own parsers** (small, zero-dependency) and use
ccusage/tokscale as optional cross-check oracles.

**Normalization convention:**

- `input` = uncached prompt tokens only.
- `cache_read`, `cache_write` (with a 1h subset).
- `output` *includes* reasoning; `reasoning` is a subset of `output`.

| Harness | input (uncached) | cache_read | cache_write | output (incl. reasoning) | cost_usd | duration | ttft | dedupe key |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Claude Code | `input_tokens` | `cache_read_input_tokens` | `cache_creation_input_tokens` (5m/1h split) | **max** `output_tokens` in the group (early lines carry placeholders) | compute | — | — | `message.id`+`requestId` |
| OpenCode v2 | `tokens.input` | `tokens.cache.read` | `tokens.cache.write` | **`tokens.output + tokens.reasoning`** | `cost` (catalog estimate) | `streamed − created` | — | message id; skip fork copies (`time_created < session.time_created`) |
| Pi | `usage.input` | `cacheRead` | `cacheWrite` (`cacheWrite1h` is a subset) | `usage.output` | `usage.cost.total` (catalog estimate) | `durationMs` | — | `entry.id`+`message.timestamp`+`responseId`, across the `parentSession` fork chain |
| Copilot CLI | **`input − cache_read − cache_write`** | `cache_read_tokens` | `cache_write_tokens` | `output_tokens` | **`total_nano_aiu / 1e11`** (`cost` is the PR multiplier, *not* USD) | `duration_ms` | `time_to_first_token_ms` | row `id` |
| Codex | `input − cached_input` | `cached_input_tokens` | `cache_write_input_tokens` | `output_tokens` | compute | per turn only | per turn only | `response_id`, or count only when the cumulative total advances |
| Gemini CLI | `input − cached` | `cached` | — | `output + thoughts` | compute | — | — | last record per message id |

**Harness-specific pitfalls:**

- **Claude Code**
  - Subagent files hold 53% of assistant lines here. Include them and roll up
    to the parent `sessionId`.
  - `/btw` replays reuse `message.id` with a new `requestId`.
  - Transcripts are deleted after 30 days by default (`cleanupPeriodDays`), so
    our ledger becomes the durable history.
  - `cost-state` lines are a cumulative session cross-check. Take the last per
    session; never sum.
  - Compaction calls are not logged.
- **OpenCode v2**
  - In-flight rows have no `tokens` until the step ends. Poll on `time_updated`.
  - `session_v2` counters also include title generation, which has no message
    row. Treat that as an unattributable per-session remainder.
  - Child sessions (`parent_id`) are *not* included in parent counters.
  - Open the DB with `mode=ro` and keep reads short.
- **Pi**
  - Also count `usage` entries, `compaction.usage`, `branch_summary.usage` and
    `toolResult.usage`.
  - `/fork` copies entries verbatim into a new file with `parentSession` in the
    header.
  - The 8-hex entry id alone collides across sessions.
- **Copilot CLI**
  - `initiator` ∈ `user | agent | sub-agent | compaction`.
  - `isByok` requests are not billed in credits.
  - SQLite is primary (720 rows) and `events.jsonl` the fallback (only builds
    ≥ 1.0.89 have `usage_record`).
- **Local models**
  - Harnesses record tokens and durations for local providers, at $0 cost.
  - TTFT, gen tok/s and load time exist only server-side: Ollama native API,
    LM Studio REST `stats`, LiteLLM `LiteLLM_SpendLogs` (incl.
    `completionStartTime` and a `request_tags` User-Agent that identifies the
    harness).
  - LM Studio verbose server logs contain prompt text. Avoid them.
- **Pricing feeds**
  - LiteLLM JSON: USD per token, has a 1h cache-write price.
  - models.dev `api.json`: USD per 1M, no 1h price (use 2× input).
  - Copilot's official table:
    `github/docs/…/copilot/models-and-pricing.yml`.
  - Local caches (§5) are enough for v1.
