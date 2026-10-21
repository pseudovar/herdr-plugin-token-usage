# Set up herdr

herdr plugins can't declare sidebar rows, tab-bar entries, keybindings or toast
settings in their manifest. Those belong to your `~/.config/herdr/config.toml`.
`tu setup` writes them for you.

## Check what's missing

```bash
tu setup
```

This prints the state of each piece without changing anything:

```text
Token Usage (pseudovar.token-usage) setup

herdr config: ~/.config/herdr/config.toml
  ✓ Toast delivery (alerts)       delivery = "herdr"
  · Tab bar summary               ui.tab_bar_right not set
  · Agent sidebar rows            default rows (no $tu)
  · Space sidebar rows            default rows (no $tu_ws)
  · Keybinding (prefix+u)         not bound
```

`✓` is done, `·` is missing, `!` conflicts with something you've customised, and
`↑` is outdated (written by an earlier version of this plugin).

## Apply it

```bash
tu setup --apply
```

Setup shows a diff and asks before writing. It then saves a timestamped backup
of `config.toml` and reloads herdr's config. It only adds what's missing:

- Rows you've customised are never overwritten. Setup prints the line to add instead.
- Layouts written by earlier versions of this plugin are upgraded in place.
- The one exception is toast delivery: herdr's default is `"off"`, which would
  silence every alert, so setup turns it to `"herdr"`.

::: details What `setup --apply` adds to config.toml
```toml
[ui.toast]
delivery = "herdr"

[ui]
tab_bar_right = [
  { type = "command", command = "~/.local/state/herdr/plugins/pseudovar.token-usage/bin/tu-status", interval_seconds = 5, timeout_seconds = 4 },
]

[ui.sidebar.agents]
rows = [
  ["state_icon", "machine", "workspace", "tab"],
  ["agent", { token = "$tu_sub", dim = true }],
  [{ token = "$tu", rules = [{ starts_with = "■", fg = "#f38ba8", bold = true }, { starts_with = "▲", fg = "#f9e2af" }, { starts_with = "▽", fg = "#a6e3a1" }] }],
  [{ token = "$tu_more", dim = true }],
]

[ui.sidebar.spaces]
rows = [
  ["state_icon", "workspace"],
  ["branch", "git_status"],
  [{ token = "$tu_ws", rules = [{ starts_with = "■", fg = "#f38ba8", bold = true }, { starts_with = "▲", fg = "#f9e2af" }, { starts_with = "▽", fg = "#a6e3a1" }] }],
  [{ token = "$tu_ws_more", dim = true }],
]

[[keys.command]]
key = "prefix+u"
type = "plugin_action"
command = "pseudovar.token-usage.open"
description = "token usage dashboard"

[[keys.command]]
key = "prefix+shift+u"
type = "plugin_action"
command = "pseudovar.token-usage.snooze"
description = "snooze usage alerts (1h)"
```
:::

## Install the agent integrations

```bash
tu setup --integrations
```

This runs `herdr integration install` for each harness you have (Pi, OpenCode,
Claude Code, Copilot CLI). With an integration, herdr reports which session a
pane is running, so the plugin can attribute spend to the exact session. The
integrations also enable herdr's own session resume.

Without them, the plugin matches panes to sessions by working directory, recency
and pane title. Those matches are marked `~` in the dashboard.

Restart running agents after installing integrations so they load. OpenCode
picks its integration up immediately.

## See values straight away

herdr runs the plugin's startup hook when it starts, and an event hook whenever
an agent finishes a turn. To publish everything now, without waiting, run the
**Token usage: refresh now** action, or:

```bash
tu refresh
```

## Check everything

```bash
tu doctor
```

`doctor` reports each data source it found and how many calls it indexed, the
pane → session bindings, the Copilot quota, and the herdr config checks. Start
here when something looks wrong; see [Troubleshooting](/guide/troubleshooting).

## Actions

The plugin's actions are listed by
`herdr plugin action list --plugin pseudovar.token-usage`:

| Action | Does |
| --- | --- |
| `open` | Opens the dashboard in a popup (bound to `prefix+u`). |
| `open-split` | Opens the dashboard beside the current pane. |
| `open-tab` | Opens the dashboard in a new tab. |
| `refresh` | Indexes new usage now and re-publishes every sidebar value. |
| `snooze` | Mutes alert toasts for an hour, or unmutes them (bound to `prefix+shift+u`). |
| `setup` | Shows the setup status as a toast, and writes the `tu` launcher. |
