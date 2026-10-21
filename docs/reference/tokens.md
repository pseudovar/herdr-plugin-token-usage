# Sidebar tokens

The plugin reports these values to herdr for every agent pane and workspace. Use
them in `[ui.sidebar.agents]` and `[ui.sidebar.spaces]` rows as `$name`. herdr
hides a row whose tokens are all empty.

## Agent panes

| Token | Example | Notes |
| --- | --- | --- |
| `$tu` | `▲ $13.72 ██▍░░░ 41%` | The main row, in the chosen [display style](/guide/sidebar-and-tab-bar#display-styles). |
| `$tu_sub` | `opus-5.5` | The model, shortened. |
| `$tu_more` | `$1.85/5m · 68 t/s` | The detail line (`rich` style only). |
| `$tu_money` | `$13.72` | Today's spend in the pane, or the session's with `agentScope = "session"`. |
| `$tu_cost` | `$20.40` | The session total. |
| `$tu_cost_num` | `20.40` | The same, unitless, for `gt`/`lt` rules. |
| `$tu_tok` | `758k` | Work tokens. |
| `$tu_tps` | `68 t/s` | Median output speed. |
| `$tu_ctx` | `ctx 41%` | Context window used. |
| `$tu_ctx_bar` | `██▍░░░` | The same as a gauge. |
| `$tu_ctx_num` | `41` | Unitless, for `gt`/`lt` rules. |
| `$tu_level` | `high` | `low`, `normal`, `high` or `critical`. |
| `$tu_sort` | `000002040123` | Zero-padded session spend, for `agent.view.set` sorting. |

## Workspaces

| Token | Example | Notes |
| --- | --- | --- |
| `$tu_ws` | `● $4.03 ▁▁▃▅█▂▃▁` | The main row, in the chosen display style. |
| `$tu_ws_more` | `17% of today · 317k tok` | The detail line (`rich` style only). |
| `$tu_ws_cost` | `$4.03` | Today's spend in the workspace. |
| `$tu_ws_tok` | `317k` | Today's work tokens. |
| `$tu_ws_spark` | `▁▁▃▅█▂▃▁` | Spend per hour, last 8 hours. |

## Colour by value

herdr's colour rules match text (`starts_with`, `contains`, `equals`) or compare
numbers (`gt`, `lt`). Numeric rules only work on fully numeric values, hence the
`_num` tokens. For example, a red context gauge above 80%:

```toml
[ui.sidebar.agents]
rows = [
  ["state_icon", "workspace", "tab"],
  ["agent", { token = "$tu_money" }, { token = "$tu_ctx_num", rules = [{ gt = 80, fg = "#f38ba8" }] }],
]
```

The rows `tu setup --apply` writes colour `$tu` and `$tu_ws` by their level
glyph instead:

```toml
{ token = "$tu", rules = [
  { starts_with = "■", fg = "#f38ba8", bold = true },
  { starts_with = "▲", fg = "#f9e2af" },
  { starts_with = "▽", fg = "#a6e3a1" },
] }
```
