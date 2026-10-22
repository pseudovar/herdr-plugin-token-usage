# Alerts and rules

Rules decide two things: the **level** shown in front of every sidebar value
(`▽` low, `●` normal, `▲` high, `■` critical), and when to send a **toast**.

## Default rules

| Rule | Fires when | Level |
| --- | --- | --- |
| Copilot on track to exceed monthly credits | pace ≥ 1.1×, after 10% of the month | high |
| Copilot burning credits far too fast | pace ≥ 1.5×, after 10% of the month | critical |
| Copilot monthly credits used | 75% and 90%, once each | high |
| Copilot monthly credits exhausted | 100% | critical |
| Context window filling up | ≥ 80% | high |
| Context window nearly full | ≥ 92% | critical |
| Expensive session (credits) | every 500 credits in one Copilot session | high |
| Expensive session (USD) | every $5 in one Claude session | high |
| Credit burn spike | ≥ 150 credits in 5 minutes (Copilot) | high |
| Spend burn spike | ≥ $1.50 in 5 minutes (Claude) | high |
| Poor prompt-cache hit rate | ≤ 50% over the last 10 calls, after 5 calls | high |
| Copilot credits to spare before reset | pace ≤ 0.5× with 10 days or fewer left | low |
| Copilot well under budget | pace ≤ 0.5×, after 10% of the month (no toast) | low |

## How they behave

- **A rule is active while its condition holds.** A pane's or space's level is
  that of its most severe active rule.
- **Toasts are edge-triggered.** A rule notifies when it becomes active, then at
  most once per cooldown (60 minutes by default) for the same pane.
- **Thresholds have hysteresis.** A value must fall 5% below its threshold
  before the rule clears, so a value hovering at the line doesn't flap.
- **Milestones are events, not states.** An `every` rule, such as every 500
  credits, raises its level for 15 minutes after each milestone. Otherwise every
  long session would stay ▲ forever.
- **Toasts are combined.** herdr shows at most one toast per second and doesn't
  queue them, so alerts raised together become one toast.
- **Nothing is lost.** Every alert is also logged. The dashboard's Summary lists
  recent ones, and the Charts → Patterns tab has a timeline.

![Recent alerts in the dashboard's Summary view](/shots/closeup-alerts.svg)

## Toast delivery

herdr's toast delivery is `"off"` by default, which silences every alert.
`tu setup --apply` sets it to `"herdr"` (in-app toasts). You can also use
`"system"` for macOS notifications:

```toml
[ui.toast]
delivery = "herdr"
```

Press `t` in the Rules view to send a test toast.

## Snooze

`prefix+shift+u`, the **snooze** action, or `s` in the dashboard mutes toasts
for an hour; press it again to resume. Levels and colours keep updating while
snoozed. From a shell:

```bash
tu snooze          # toggle
tu snooze 30       # mute for 30 minutes
tu snooze off
```

## Edit rules {#edit-rules}

![The Rules view: each rule's level, condition, and when it last fired](/shots/closeup-rules.svg)

The dashboard's Rules view is an editor. Select a rule with `↑` `↓`, then:

| Key | Does |
| --- | --- |
| `space` | Turn the rule on or off |
| `n` | Turn its toast on or off |
| `l` | Change its level: low, high, critical |
| `+` / `-` | Nudge the threshold |
| `e` | Type a threshold (comma-separated for step rules) |
| `t` | Send a test toast |
| `N` | Turn all toasts on or off |
| `R` `R` | Reset every rule to the defaults |

Changes are saved to `config.jsonc` immediately. You can also edit the file
directly; see [Configuration](/reference/configuration#rules) for the rule
fields and every metric you can alert on.
