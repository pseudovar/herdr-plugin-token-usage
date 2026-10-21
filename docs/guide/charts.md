# Charts

The dashboard's sixth view has four tabs. Switch with `←` `→` or a click; `↑` `↓`
scroll on short panes. Only the open tab's data is queried, and each tab fits on
one screen.

## Live

![The Live tab](/shots/charts-live.svg)

Your running sessions, now.

- **Compaction advisor.** Every call re-reads the whole prompt from the cache,
  so a long context costs money on every turn. For each live session, the
  advisor shows:
  - what carrying that context costs per hour at the current pace;
  - what it would cost after `/compact`;
  - the one-off cost of compacting;
  - how many calls compacting takes to pay back.

  Its verdict is *compact now* at 80% context or when compacting would save
  $2 an hour or more, and *compact soon* from $0.50 an hour.
- **Context growth** of the fullest live session, call by call, against the 80%
  and 92% lines.
- **Live agents:** spend per 2 minutes over the last hour, per pane.

## Spend

![The Spend tab](/shots/charts-spend.svg)

Where the money goes.

- **Pixel burn-up:** the Copilot burn-up drawn as a real image. It uses the Kitty
  graphics protocol, which herdr passes through to Ghostty, kitty and WezTerm
  (`terminal.kitty_graphics`, on by default). The dashboard checks for support
  when it starts and otherwise shows a note. `k` turns the chart off, or forces
  it on.
- **Where it goes:** a treemap of the last 30 days. Each project is a coloured
  block, and each session inside it is labelled with its title, spend and main model.
- **Daily spend by harness** for the last 21 days.

## Models

![The Models tab](/shots/charts-models.svg)

- **Model what-if:** this billing month's tokens priced at every model on the
  Copilot rate card, against what you actually spent. `•` marks models you used.
  It's list price only: real runs differ in tokenizer, verbosity and caching.
- **Speed by model:** output tokens per second over the last 7 days, as box
  plots (p10, p25–p75, median, p90).

## Patterns

![The Patterns tab](/shots/charts-patterns.svg)

- **Calendar:** daily spend over the last 20 weeks, with the busiest day called out.
- **When you spend:** a weekday × hour heatmap for the last 30 days.
- **Alert timeline:** when each rule fired over the last week.
