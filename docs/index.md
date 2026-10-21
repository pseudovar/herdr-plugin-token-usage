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

## Install in a minute

You need [herdr](https://herdr.dev) 0.9.1 or later and Node.js 22.18 or later, on macOS or Linux.

```bash
herdr plugin install pseudovar/herdr-plugin-token-usage
~/.local/state/herdr/plugins/pseudovar.token-usage/bin/tu setup --apply
~/.local/state/herdr/plugins/pseudovar.token-usage/bin/tu setup --integrations
```

`setup --apply` adds the sidebar rows, tab-bar entry, keybindings and toast setting to herdr's `config.toml`. It shows a diff first and keeps a backup. Then press `prefix+u` to open the dashboard. See [Install](/guide/install) and [Set up herdr](/guide/setup) for details.
