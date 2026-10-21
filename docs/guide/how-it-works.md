# How it works

```text
harness logs (read-only) ─▶ adapters ─▶ ledger.db (SQLite, one row per model call)
                                               │
herdr events / agent list ─▶ pane ↔ session ───┼─▶ sidebar and space tokens
gh api copilot_internal ─▶ quota (5 min cache) ┼─▶ tab-bar line
                                               └─▶ rules ─▶ toasts · dashboard
```

## No background process

herdr asks plugins not to leave daemons running, so the plugin runs only when
herdr starts it:

| Trigger | Work | Typical time |
| --- | --- | --- |
| An agent finishes a turn, appears, moves or closes (event hooks) | Index that harness's new calls, bind the pane to its session, update its sidebar values, evaluate rules | ~0.25 s |
| herdr starts (startup hook) | Index everything new, re-publish every value (herdr doesn't keep them across restarts), refresh the quota, rewrite the launchers | ~0.15 s |
| The tab-bar command, every 5 s | Print the summary line, and refresh panes that are still working mid-turn | ~0.13 s |
| The dashboard, while it's open | Refresh every 2 s | — |

## The ledger

Every model call becomes one row in a local SQLite database
(`~/.local/state/herdr/plugins/pseudovar.token-usage/ledger.db`). Each row has the
harness, session, project, model, billing, tokens by type, cost, credits, timing
and context size.

Indexing is incremental. Each source keeps a cursor (a byte offset, row id or
timestamp), so a hook only reads what's new. Re-reading a call updates its row
instead of counting it twice. A first run over a few months of history takes
about a second.

## Pane → session binding

To know which session a pane is running, the plugin first uses the session that
herdr's agent integration reports. Without one, it falls back to the session in
the pane's working directory that best matches the pane title and was most
recently active. That match is marked `~`, and it moves when the pane starts a
new session.

## Drawing

The dashboard is a small zero-dependency terminal UI:

- It redraws only the lines that changed, and at most one frame every 30 ms.
- Charts use braille dots and block elements, with one colour sequence per run of cells.
- The pixel burn-up is a PNG from a tiny built-in rasteriser, sent with the
  Kitty graphics protocol. It's re-sent only when the picture would change.

For the full design, with measured performance and the decisions behind it,
see the [design notes](/DESIGN) and [research notes](/RESEARCH).
