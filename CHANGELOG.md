# Changelog

## 0.5.0 (2026-10-21)

First public release, on GitHub at `pseudovar/herdr-plugin-token-usage`.

- **New plugin ID: `pseudovar.token-usage`** (was `jasford.token-usage`). On the
  first run under the new ID, the ledger (with alert, quota and binding history)
  and `config.jsonc` are copied across; the old directories stay as a backup.
  `tu setup --apply` renames the old ID in herdr's `config.toml` (keybindings
  and the tab-bar command). The old tab-bar launcher keeps working until then.
- **Docs site** at <https://pseudovar.github.io/herdr-plugin-token-usage/>:
  install, setup, every surface and view, alerts, configuration, CLI and
  troubleshooting.
  - The images are rendered from synthetic demo data (`npm run docs:shots`) by
    the plugin's own renderers.
  - `tu dashboard --snapshot` accepts `--tab` for the Charts tabs.
- **Install** from GitHub with `herdr plugin install
  pseudovar/herdr-plugin-token-usage`. The docs run the `setup` action first,
  which writes the `tu` launcher, so setup works without restarting herdr.
- Repository: CI on Linux and macOS, release-please for semantic versioning,
  issue forms, a pull request template, Dependabot and community health files.

## 0.4.0 (2026-10-21)

- **The popup fits the dashboard.** It opens at 92% of the window's width, up to
  164 columns (the dashboard's 160 plus its border), so large screens no longer
  get empty margins inside it.
- **Charts tabs.** The Charts view is split into Live (compaction advisor,
  context growth, live agents), Spend (pixel burn-up, treemap, daily spend),
  Models (what-if, speed) and Patterns (calendar, weekday × hour, alert
  timeline). Switch with `←`/`→` or a click. Each tab fits on one screen and
  only queries its own data.
- **A much lighter dashboard.** In a scripted session it wrote about 50× fewer
  bytes to the terminal.
  - Only lines that changed are redrawn, so a 2-second refresh usually rewrites
    a handful of lines rather than the whole screen.
  - Bursts of input, like a wheel flick, are drawn as one frame.
  - Charts open one colour sequence per run of cells instead of one per cell.
    A Charts frame is 7–13 KB, where the single page was 40 KB.
  - The pixel burn-up is re-sent only when it would change by a pixel, rather
    than every 10 seconds while agents work, and placed again only when its
    cells are redrawn.
- A refresh that finishes after you quit no longer draws over the terminal.

## 0.3.2 (2026-10-21)

- On wide panes the dashboard keeps to a centred column at most 160 columns
  wide, the width the charts were already drawn at. In a 344-column popup,
  labels, numbers and chart legends had drifted up to 250 columns apart.
- Tables give truncated names (spaces, projects, rules, models) room first, and
  flexible columns stop at a useful width instead of stretching.
- Session titles are stored on one line. A Copilot CLI title holding a
  multi-line prompt split its row in the Sessions view; existing titles are
  repaired once on upgrade.
- Summary: alerts are listed under "RECENT ALERTS" with the active count on the
  right, older ones show their day ("Tue 17:48"), and each detail is dimmed so
  the headline stands out. The activity sparkline is labelled with its real
  span (it said "last 6 h" while showing up to 12 h) and gains an hour axis.
- Treemap tiles drop a total or model rather than show fragments like `p…` or
  `$7…`. Other Charts-view labels end in `…` when shortened instead of being cut
  mid-word.
- Dates share one style ("22 Sept", "19 Oct 11:04", "Mon 31 Aug"). Rule
  conditions read `$1.50`, not `$1.5`, and an unmeasured time to first token
  shows `–`.

## 0.3.1 (2026-10-21)

- The sidebar context gauge uses block characters with eighth-cell precision
  (`██▍░░░ 40%`). The old `▰▱` glyphs came from a fallback font (Menlo, in
  Ghostty) and spilled over the space before the percentage.
- The dashboard header shows "updated 10:04:47" instead of `⟳`, which also came
  from a fallback font.
- A test keeps sidebar and tab-bar text to glyphs that render one cell wide.

## 0.3.0 (2026-10-19)

- **Pixel burn-up** on the Charts view, drawn with the Kitty graphics protocol
  by a zero-dependency rasteriser and PNG encoder. The dashboard checks for
  graphics support at start-up and otherwise shows a note; `k` toggles it.
  Image errors from the terminal are logged.
- **Compaction advisor**: for each live session, the hourly cost of
  re-reading its context compared with after `/compact`, the one-off cost,
  payback in calls, and calls left before the 92% line.
- **Model what-if**: the billing month's tokens re-priced at every model on
  the Copilot rate card or in use.
- **Treemap** of spend by project → session → model, replacing the project
  bar.
- **Alert timeline** on the Charts view, and an alert strip under the Summary
  burn-up.

## 0.2.0 (2026-10-19)

- **One grammar, one unit.** Sidebar agents, spaces and the tab bar all show
  `<level> <money> <visual>` in dollars for today, so the numbers add up
  (agents ⊂ space ⊂ tab bar). Copilot AI credits are shown as dollars by
  default (1 credit = $0.01); `display.money = "credits"` restores credits.
- **Display styles** `rich` (default), `visual`, `text` and `spark`, which can be
  switched live from the dashboard's Rules view (`v`). Adds a model name on the
  agent row and a dim detail line under agents and spaces (`$1.76/5m · 79 t/s`,
  `80% of today · 6.9M tok`), capped to fit herdr's 26-column sidebar.
- **Summary** gains a Copilot burn-up chart (account and this machine against
  the budget, on-budget pace and projection) and a cost anatomy (input, cache
  write, cache read, output) with a hint when re-reading cached context
  dominates.
- **Charts view (dashboard 6)**: daily spend stacked by harness, calendar and
  weekday×hour heatmaps, context growth, live agent strips, speed box plots and
  spend by project. Drawn with a zero-dependency braille chart toolkit.
- The dashboard uses one "spend" column in the chosen unit instead of separate
  credits and API-equivalent columns.
- Copilot quota snapshots are recorded over time (account-wide burn-up line).
- `setup --apply` upgrades the v1 sidebar layout in place (backup + reload) and
  leaves custom rows alone.

## 0.1.0 (2026-10-19)

First release.

- Adapters for Pi, OpenCode (v2 and v1.2), GitHub Copilot CLI and Claude Code,
  normalized into a local SQLite ledger with incremental, cursor-based ingest.
- GitHub Copilot quota via `gh api /copilot_internal/user`: AI credits, pace,
  projection and reset. Pi and OpenCode Copilot calls are priced with the
  observed Copilot credit rate card.
- Agent sidebar (`$tu`, `$tu_ctx`, …), space sidebar (`$tu_ws`) and tab-bar
  summary, published by event hooks, the tab-bar tick and the startup hook.
- Rules engine with thresholds, steps and repeating milestones, hysteresis,
  cooldown and snooze. Thirteen default rules; alerts are combined into one
  herdr toast.
- Dashboard (popup, split or tab) with five views. The rules view edits and
  saves `config.jsonc` in place.
- `setup --apply` safely extends `config.toml` (diff, backup, reload).
  `setup --integrations` installs herdr's agent integrations.
