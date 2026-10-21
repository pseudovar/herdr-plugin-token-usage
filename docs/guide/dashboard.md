# Dashboard

Press `prefix+u` to open the dashboard in a popup, and `q` or `esc` to close it.
The `open-split` and `open-tab` actions put it beside your current pane or in a
new tab instead.

The popup opens at 92% of the window's width, up to 164 columns: the dashboard's
160 plus its border. On a large screen it stays compact instead of spreading out.
In a split or tab wider than 160 columns, the dashboard keeps to a centred 160
columns.

## Keys

| Key | Does |
| --- | --- |
| `1`–`6`, `tab`, or a click on a tab | Switch views |
| `↑` `↓`, mouse wheel | Select, or scroll |
| `⏎` | Open the selected session |
| `esc` | Back, or close |
| `p` | Cycle the period: today, 7 days, 30 days, Copilot billing month, this month, all time |
| `g` | Cycle the grouping in History: harness, model, project, billing |
| `r` | Refresh now (otherwise every 2 seconds) |
| `s` | Snooze alert toasts for an hour, or resume them |
| `q` | Quit |

## 1 Summary {#summary}

![The Summary view](/shots/dashboard-summary.svg)

- **Copilot budget:** credits used against your monthly allowance, with a marker
  (`┃`) for how much of the month has passed. **Pace** is used ÷ elapsed:
  1.0× is exactly on budget. The projection is where the month will end at the
  current pace. *This machine* is the share of the account's spend you can see
  locally; the rest comes from VS Code, github.com or other machines.
- **Today:** spend (split into Copilot and other), work tokens, calls and cache hit rate.
- **Live agents:** every agent pane herdr knows about, with its spend, work
  tokens, context, speed, 5-minute burn and state. `~` before a session name
  means it was matched by heuristics: see [Set up herdr](/guide/setup#install-the-agent-integrations).
- **Recent alerts:** the latest alerts, and how many rules are active right now.
- **Copilot burn-up:**
  - spend across the billing month for the whole account (blue) and this machine (mauve);
  - the on-budget pace (grey);
  - a projection to the reset (cyan, dashed);
  - the budget line (red);
  - a strip of the alerts that fired.
- **What you pay for:** spend split into input, cache writes, cache reads and
  output, for today, the last 30 days and the busiest live session. Long sessions
  are mostly *cache reads*: every call re-reads the whole context, which
  `/compact` shrinks.
- **By harness**, **Activity** (work tokens per 5 minutes, with an hour axis) and
  **Top models**, when there's room.

## 2 Agents

![The Agents view](/shots/dashboard-agents.svg)

Every live pane with its binding, session totals, cache reads, context
(percentage and tokens), cache hit rate, output speed, time to first token and
the time of its last call. The selected row's session details are shown underneath.

## 3 Sessions

![Recent sessions](/shots/dashboard-sessions.svg)

Recent sessions across every harness, newest first. Press `⏎` to open one and
see each model call:

![One session's calls](/shots/dashboard-session.svg)

The header shows the session's totals, a context gauge and the cost of each
call. The table lists every call: input, output, cache reads and writes, prompt
size, spend, duration, time to first token, output speed, and whether the main
agent or a subagent made it.

## 4 History

![History by project](/shots/dashboard-history.svg)

Thirty days of work tokens, Copilot spend and other spend, then a breakdown for
the selected period. `p` changes the period and `g` the grouping: harness,
model, project or billing.

## 5 Rules

![The Rules view](/shots/dashboard-rules.svg)

Every alert rule with its condition, how many scopes it's active for, and when
it last fired. This is also where you edit rules and switch the sidebar's
display style: see [Alerts and rules](/guide/alerts#edit-rules).

## 6 Charts

Four tabs of charts: Live, Spend, Models and Patterns. See [Charts](/guide/charts).
