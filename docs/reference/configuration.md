# Configuration

The plugin's settings live in
`~/.config/herdr/plugins/config/pseudovar.token-usage/config.jsonc`. The file is
created with defaults on first run. It's JSON with comments, and anything you
leave out keeps its default. The dashboard's Rules view rewrites the file when
you change a rule, so comments other than its header aren't kept.

```jsonc
{
  "harnesses": { "pi": true, "opencode": true, "copilot": true, "claude": true },
  "claude": { "ignore": ["**/*ClaudeBar-Probe*/**", "**/*ClaudeBar-Probe*"] },
  "copilot": { "quota": true, "refreshMinutes": 5 },
  "contextLimits": { "claude-opus-4-8": 200000 },
  "notify": { "enabled": true, "cooldownMinutes": 60, "sound": "request" },
  "statusline": { "refreshPanes": true },
  "display": { "style": "rich", "money": "usd", "agentScope": "today" },
  "rules": [ /* see below */ ]
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `harnesses.<name>` | `true` | Read this harness's data: `pi`, `opencode`, `copilot`, `claude`. |
| `claude.ignore` | ClaudeBar probes | Globs of Claude Code transcripts to skip. |
| `copilot.quota` | `true` | Fetch the Copilot quota with `gh`. |
| `copilot.refreshMinutes` | `5` | How old the cached quota may get before it's fetched again. |
| `contextLimits` | `{}` | Context window per model, overriding what the harness reports. |
| `notify.enabled` | `true` | Send toasts at all. |
| `notify.cooldownMinutes` | `60` | Minimum time between toasts for the same rule and pane. |
| `notify.sound` | `"request"` | Toast sound: `"none"`, `"done"` or `"request"`. |
| `statusline.refreshPanes` | `true` | Let the 5-second tab-bar tick refresh panes that are mid-turn. (`showTokens` has no effect.) |
| `display.style` | `"rich"` | Sidebar and tab-bar style: `rich`, `visual`, `text` or `spark`. |
| `display.money` | `"usd"` | Show dollars, or `"credits"` for Copilot AI credits. |
| `display.agentScope` | `"today"` | Agent rows show today's spend in the pane, or `"session"` for the session total. |

## Rules

Each rule is an object:

```jsonc
{
  "id": "burn-credits",
  "title": "Credit burn spike",
  "enabled": true,
  "notify": true,
  "metric": "session.credits_5m",
  "op": ">=",
  "value": 150,
  "level": "high",
  "billing": "copilot"
}
```

| Field | Meaning |
| --- | --- |
| `id`, `title` | A unique id, and the name shown in toasts and the Rules view. |
| `enabled`, `notify` | Whether the rule is evaluated, and whether it sends toasts. |
| `metric` | What to measure: see the table below. |
| `op` | `">="` or `"<="`. |
| `value` | A threshold. The rule is active while the condition holds. |
| `steps` | Several thresholds, each notified once, e.g. `[75, 90]`. |
| `every` | A repeating milestone, e.g. every `500` credits. |
| `level` | `"low"`, `"high"` or `"critical"`. |
| `billing` | Optional guard: only sessions billed as `"copilot"`, `"claude"`, `"api"` or `"local"`. |
| `minCalls` | Optional guard: only once the session has this many calls. |
| `maxDaysLeft` | Optional guard: only when the Copilot period has at most this many days left. |
| `minElapsedPct` | Optional guard: only after this much of the Copilot period has passed. |

Each rule uses one of `value`, `steps` or `every`.

## Metrics

| Metric | Meaning | Unit |
| --- | --- | --- |
| `session.tokens` | Session work tokens | tokens |
| `session.credits` | Session Copilot credits | credits |
| `session.cost_usd` | Session cost | $ |
| `session.context_pct` | Context window used | % |
| `session.cache_hit_pct` | Cache hit rate over the last 10 calls | % |
| `session.credits_5m` | Credits burned in 5 minutes | credits |
| `session.cost_usd_5m` | Dollars burned in 5 minutes | $ |
| `session.tokens_5m` | Work tokens in 5 minutes | tokens |
| `session.tps_p50` | Median output speed | tok/s |
| `session.calls` | Model calls in the session | calls |
| `today.tokens` | Today's work tokens, all harnesses | tokens |
| `today.credits` | Today's Copilot credits | credits |
| `today.cost_usd` | Today's cost | $ |
| `quota.copilot.used_pct` | Copilot monthly credits used | % |
| `quota.copilot.pace` | Copilot pace: used ÷ elapsed | × |
| `quota.copilot.projected_pct` | Projected month-end usage | % |
| `quota.copilot.days_left` | Days until the Copilot reset | days |

`session.*` metrics are evaluated per pane. The others are evaluated once, for
the whole machine or account.

## Environment

| Variable | Meaning |
| --- | --- |
| `TU_NODE` | The Node.js binary the launcher should use. |
| `NO_COLOR` | Draw the dashboard without colour. |
| `PI_CODING_AGENT_DIR`, `OPENCODE_DB`, `COPILOT_HOME`, `CLAUDE_CONFIG_DIR` | Where each harness keeps its data, as the harnesses themselves use them. |
