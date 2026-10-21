# Troubleshooting

Start with:

```bash
tu doctor
```

It checks each data source, the pane → session bindings, the Copilot quota and
herdr's config. The plugin's log is
`~/.local/state/herdr/plugins/pseudovar.token-usage/token-usage.log`, and herdr
keeps each hook's output: `herdr plugin log list --plugin pseudovar.token-usage`.

## The sidebar shows nothing

- Run `tu setup`. The sidebar rows only appear once `config.toml` has them.
- herdr doesn't keep plugin values across a restart. The startup hook
  re-publishes them, or run the **refresh now** action.
- A pane only shows values once its agent has made a call that the plugin could
  match to a session. `tu doctor` lists the bindings.

## No toasts

- herdr's toast delivery defaults to `"off"`. `tu setup` reports it; `tu setup --apply` fixes it.
- Alerts may be snoozed: the dashboard header shows `🔕 until …`. Press `s` to resume.
- Press `t` in the dashboard's Rules view to send a test toast.

## Sessions marked `~`

The pane was matched by working directory and recency, because herdr hasn't
reported its exact session. Run `tu setup --integrations`, then restart the
agent.

## "Copilot quota unavailable"

The quota needs the GitHub CLI, logged in with an account that has Copilot:
check `gh auth status`. The quota uses `gh`'s *active* account, so if you have
several, make sure the Copilot one is active. Everything else works without it.

## `node` not found

herdr runs plugin commands with the server's environment, which may not include
your version manager's shims. The launcher also looks in common places (mise,
Homebrew, nvm, volta, fnm, asdf). To point it at a specific Node.js 22.18+, set
`TU_NODE` in the environment herdr starts with:

```bash
export TU_NODE=/path/to/node
```

## The pixel chart doesn't appear

It needs a terminal with Kitty graphics (Ghostty, kitty or WezTerm) and herdr's
`terminal.kitty_graphics`, which is on by default. Other terminals get a note
instead of the chart. `k` on the Charts → Spend tab forces it on.

## Something else

[Open an issue](https://github.com/pseudovar/herdr-plugin-token-usage/issues/new/choose)
with the output of `tu doctor` and your herdr, Node.js and OS versions.
