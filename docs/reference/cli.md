# CLI

The plugin's command-line interface is `tu`. After the first herdr start, or
after running the `setup` action, it lives at
`~/.local/state/herdr/plugins/pseudovar.token-usage/bin/tu`:

```bash
alias tu=~/.local/state/herdr/plugins/pseudovar.token-usage/bin/tu
```

| Command | Does |
| --- | --- |
| `tu setup [--apply] [--integrations] [--yes]` | Checks herdr's config and agent integrations. `--apply` adds what's missing (diff, backup, reload); `--integrations` installs herdr's agent integrations; `--yes` skips the prompt. See [Set up herdr](/guide/setup). |
| `tu doctor` | Data sources, bindings, the Copilot quota and herdr's config. |
| `tu report [period] [--json]` | Usage by harness and model. The period is today by default, or `--week`, `--month`, `--billing` (the Copilot billing month), `--days N` or `--all`. `--verbose` adds per-model detail. |
| `tu quota [--refresh] [--json]` | The Copilot quota, from the cache unless `--refresh`. |
| `tu refresh` | Indexes new usage now and re-publishes every sidebar value. |
| `tu snooze [toggle\|on\|off\|<minutes>]` | Mutes alert toasts (an hour by default) or resumes them. |
| `tu open [popup\|split\|tab]` | Opens the dashboard in herdr. |
| `tu dashboard` | Runs the dashboard in the current terminal. |
| `tu dashboard --snapshot [--view N] [--tab T] [--cols N] [--rows N] [--plain]` | Renders one view to stdout, without a TTY. |
| `tu status-line` | Prints the tab-bar line. |

`hook` and `startup` are herdr's entry points for the plugin's event and startup
hooks; you don't need to run them.
