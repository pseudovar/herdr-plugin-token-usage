# Sidebar and tab bar

These are the plugin's ambient surfaces: always on screen, updated as your agents
work, and coloured by herdr itself.

![The four display styles in herdr's sidebar](/shots/sidebar-styles.svg)

## Agent rows

Each agent pane gets three rows under herdr's own agent row:

| Row | Token | Example |
| --- | --- | --- |
| Model (dim) | `$tu_sub` | `opus-5.5` |
| Spend and context | `$tu` | `▲ $13.72 ██▍░░░ 41%` |
| Detail (dim) | `$tu_more` | `$1.85/5m · 68 t/s` |

`$13.72` is what the pane has spent **today**, across every session it has run.
To show the current session's total instead, set `display.agentScope = "session"`.
The gauge shows how full the context window is, to the nearest eighth of a cell.
The detail line shows the 5-minute burn and the median output speed.

## Space rows

Each workspace gets the same grammar, totalled over its panes:

| Row | Token | Example |
| --- | --- | --- |
| Spend and activity | `$tu_ws` | `● $4.03 ▁▁▃▅█▂▃▁` (spend per hour over the last 8 hours) |
| Detail (dim) | `$tu_ws_more` | `17% of today · 317k tok` |

## Levels and colours

Every value starts with a level glyph, set by the [alert rules](/guide/alerts):

| Glyph | Level | Colour (from the rows `setup` writes) |
| --- | --- | --- |
| `▽` | low: plenty of headroom | green |
| `●` | normal | default |
| `▲` | high | yellow |
| `■` | critical | red, bold |

herdr applies the colour with its own `starts_with` rules, so the plugin never
draws the sidebar itself.

## The tab bar

![The tab bar in each display style](/shots/tabbar-styles.svg)

The right-hand side of herdr's tab bar shows your Copilot budget and today's
total, refreshed every 5 seconds:

```text
Copilot ● $115/$200 · 0.86× · 11d left │ today $24.23 · $1.94/5m
```

That reads: $115 of the $200 monthly budget used, a pace of 0.86× (under
budget), 11 days to the reset, $24.23 spent today across every harness, and
$1.94 in the last 5 minutes.

## One grammar, one unit

Agents, spaces and the tab bar all read `<level> <money> <visual>`, in dollars,
for today. The numbers therefore add up: agents ⊂ space ⊂ tab bar.

Copilot spends AI credits, and 1 credit is exactly $0.01, so `1,372cr` is
`$13.72`. Prefer credits? Set `display.money = "credits"`.

## Display styles

| Style | Agent row | Space row | Tab bar |
| --- | --- | --- | --- |
| `rich` (default) | gauge, plus a detail line | sparkline, plus a detail line | budget, pace, days left, today, burn |
| `visual` | `▲ $13.72 ██▍░░░ 41%` | `● $4.03 ▁▁▃▅█▂▃▁` | a budget bar with a month-elapsed marker |
| `text` | `▲ $13.72 · ctx 41%` | `● $4.03 today` | percentages and token counts, no glyphs |
| `spark` | `▲ $13.72 ▃▄█▃▂▅ 41%` (cost per call) | `● $4.03 ▁▁▃▅█▂▃▁` | a 7-day spend sparkline |

Switch styles live from the dashboard: press `prefix+u`, then `5` for the Rules
view, then `v`. Your real sidebar and tab bar change as you press. `m` switches
between dollars and credits, and `o` switches agent rows between today and the
session total. Every change is saved to `config.jsonc`.

Detail lines are capped at 24 characters to fit herdr's default 26-column
sidebar. When a line is too long, the least useful part is dropped first.

## Build your own rows

The styles fill `$tu`, `$tu_sub`, `$tu_more`, `$tu_ws` and `$tu_ws_more`. For
hand-made rows, the plugin also publishes stable building blocks such as
`$tu_money`, `$tu_ctx_bar` and `$tu_ctx_num`. The numeric ones work with herdr's
`gt`/`lt` colour rules. See [Sidebar tokens](/reference/tokens).
