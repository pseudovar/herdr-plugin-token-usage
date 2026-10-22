---
layout: home
title: Token Usage for herdr

hero:
  name: Token Usage
  text: What every coding agent costs, live, inside herdr
  tagline: Spend, GitHub Copilot credits, context and speed for Pi, OpenCode, Copilot CLI and Claude Code, in herdr's sidebar, tab bar and a dashboard. No proxies, no API keys, nothing leaves your machine.
  image:
    src: /logo.svg
    alt: Token Usage logo
  actions:
    - theme: brand
      text: Get started
      link: /guide/install
    - theme: alt
      text: Tour the dashboard
      link: /guide/dashboard
    - theme: alt
      text: View on GitHub
      link: https://github.com/pseudovar/herdr-plugin-token-usage

features:
  - title: Live spend beside every agent
    details: Each agent row in herdr's sidebar shows today's spend, a context gauge, burn rate and output speed. Spaces and the tab bar add up the same way.
    link: /guide/sidebar-and-tab-bar
    linkText: Sidebar and tab bar
  - title: Copilot credits, paced
    details: Reads your real Copilot quota through the gh CLI and tells you whether you're on track for the month, with a burn-up chart and a projection to the reset.
    link: /guide/dashboard#summary
    linkText: The Summary view
  - title: Alerts that mean something
    details: Thirteen editable rules for pace, quota, context, expensive sessions, burn spikes and cache misses. Each fires once per crossing, as a herdr toast.
    link: /guide/alerts
    linkText: Alerts and rules
  - title: Know why it's expensive
    details: Cost anatomy, a compaction advisor, a model what-if and a treemap of where the money went, project by project.
    link: /guide/charts
    linkText: Charts
  - title: Four harnesses, one ledger
    details: Pi, OpenCode, Copilot CLI and Claude Code are read from the files they already write, normalised into one local SQLite ledger.
    link: /guide/harnesses
    linkText: Harnesses and accuracy
  - title: No daemon, no dependencies
    details: Runs on herdr's own hooks and tab-bar tick. Zero npm dependencies; Node 22.18+ runs the TypeScript directly.
    link: /guide/how-it-works
    linkText: How it works
---

<figure class="home-shot">
  <img src="/shots/hero.svg" alt="herdr with Token Usage: spend and context gauges in the sidebar, Copilot budget in the tab bar, and the dashboard open in a popup">
  <figcaption>herdr with the plugin: sidebar rows, the tab bar summary and the dashboard popup (<code>prefix+u</code>). Demo data.</figcaption>
</figure>

## A closer look

Every image here is drawn by the plugin's own renderers, from a synthetic demo.

### Spend beside every agent

Each agent row in herdr's sidebar shows today's spend, how full the context
window is, the last five minutes' burn and the output speed. The glyph turns
yellow (▲) or red (■) when an alert rule fires.
[Sidebar and tab bar →](/guide/sidebar-and-tab-bar)

![Two agent rows in herdr's sidebar: a working Pi pane flagged ▲ by a burn-spike alert, and a finished OpenCode pane](/shots/closeup-sidebar.svg)

### Your Copilot month in the tab bar

Budget used, pace (1.0× is exactly on budget), days to the reset, and what
every harness has spent today. [The tab bar →](/guide/sidebar-and-tab-bar#the-tab-bar)

![The tab-bar summary: Copilot budget, pace, days left, today's spend and 5-minute burn](/shots/closeup-tabbar.svg)

### Am I on track for the month?

The burn-up plots the whole account's Copilot spend, and this machine's, against
the on-budget pace, projects it to the reset and marks when alerts fired. In
Ghostty, kitty and WezTerm it's drawn as a real image. [Charts →](/guide/charts#pixel-burn-up)

![The Copilot burn-up drawn as a pixel image, with the account, this machine, pace, projection and budget lines](/shots/closeup-pixel-burnup.svg)

### Every agent at a glance

Spend, work tokens, context, speed and 5-minute burn for every pane herdr knows
about, with its session and state. [Dashboard →](/guide/dashboard#live-agents)

![The live agents table](/shots/closeup-live-agents.svg)

### What you actually pay for

Long sessions are mostly cache reads: every call re-reads the whole context. The
cost anatomy shows how much, for today, the last 30 days and the busiest session.
[Dashboard →](/guide/dashboard#what-you-pay-for)

![Cost anatomy: spend split into cache reads, cache writes, output and input](/shots/closeup-anatomy.svg)

### When to compact

For each live session: what carrying its context costs per hour, what it would
cost after `/compact`, and how many calls compacting takes to pay back.
[Charts →](/guide/charts#compaction-advisor)

![The compaction advisor, with a verdict per live session](/shots/closeup-advisor.svg)

### Where the money went

Thirty days as a treemap: projects, then their sessions, labelled with spend
and main model. [Charts →](/guide/charts#where-it-goes)

![A treemap of the last 30 days' spend by project and session](/shots/closeup-treemap.svg)

### Alerts you can tune

Thirteen rules for pace, quota, context, expensive sessions, burn spikes and
cache misses. Change thresholds, levels and toasts right in the dashboard.
[Alerts and rules →](/guide/alerts)

![The Rules view: each rule's level, condition, and when it last fired](/shots/closeup-rules.svg)

## Install in a minute

You need [herdr](https://herdr.dev) 0.9.1 or later and Node.js 22.18 or later, on macOS or Linux.

```bash
herdr plugin install pseudovar/herdr-plugin-token-usage
~/.local/state/herdr/plugins/pseudovar.token-usage/bin/tu setup --apply
~/.local/state/herdr/plugins/pseudovar.token-usage/bin/tu setup --integrations
```

`setup --apply` adds the sidebar rows, tab-bar entry, keybindings and toast setting to herdr's `config.toml`. It shows a diff first and keeps a backup. Then press `prefix+u` to open the dashboard. See [Install](/guide/install) and [Set up herdr](/guide/setup) for details.
