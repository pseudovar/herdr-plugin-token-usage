# Introduction

Token Usage is a plugin for [herdr](https://herdr.dev), the terminal workspace
manager for AI coding agents. It shows what each agent is spending as it works,
whether you're on track for the month, and why a session is expensive. All of
it lives inside herdr's own sidebar, tab bar and a dashboard popup.

![The plugin's rows in herdr's sidebar, in each of the four display styles](/shots/sidebar-styles.svg)

## The problem

Coding agents bill in different units, and none of them show you the whole picture.

- **GitHub Copilot** (used by Pi, OpenCode and Copilot CLI) spends *AI credits*
  against a monthly allowance. 1 credit is $0.01.
- **Claude Code** on an API plan spends dollars at list price.
- **Local models** cost nothing but have their own speed limits.

Each harness writes its own usage records locally, in its own format. Token Usage
reads those records (read-only), normalises them into one ledger on your machine,
and answers three questions:

1. **What is each pane spending right now?** Each agent row in herdr's sidebar
   shows today's spend, a context-window gauge, the burn rate and output speed.
2. **Am I on track for the month?** The Copilot quota with *pace*: under 1.0×
   means you're under budget.
3. **What's expensive, and why?** Context size, prompt-cache hit rate, burn
   rate, cost per call, and where the money went by project and session.

## What you get

| Surface | What it shows |
| --- | --- |
| **Agent sidebar rows** | The model, then `▲ $13.72 ██▍░░░ 41%` (today's spend and context gauge) and a dim detail line `$1.85/5m · 68 t/s`. The leading glyph's colour follows the alert level. |
| **Space sidebar rows** | The same grammar per workspace: `● $4.03 ▁▁▃▅█▂▃▁` (spend and hourly activity), then `17% of today · 317k tok`. |
| **Tab bar** | `Copilot ● $115/$200 · 0.86× · 11d left │ today $24.23 · $1.94/5m` |
| **Dashboard** (`prefix+u`) | Summary, Agents, Sessions, History, Rules and Charts views. |
| **Toasts** | Alerts when a rule crosses its threshold, combined so herdr never drops one. |

Agents, spaces and the tab bar all use **one grammar and one unit**:
`<level> <money> <visual>`, in dollars, for today. That way the numbers add up:
agents ⊂ space ⊂ tab bar. Prefer credits? Set `display.money = "credits"`.

## Supported harnesses

Pi, OpenCode (v2 and v1.2), GitHub Copilot CLI and Claude Code. Calls routed to
local providers (Ollama, LM Studio, LiteLLM) are recorded at $0. See
[Harnesses and accuracy](/guide/harnesses).

## How it fits into herdr

herdr plugins can't add native panels, so the plugin uses herdr's extension points:

- **Sidebar tokens.** The plugin reports values like `$tu` to herdr, and
  `[ui.sidebar]` rows in your config display them. herdr's own colour rules
  colour them.
- **A tab-bar command** that herdr runs every 5 seconds.
- **A popup pane** for the dashboard.
- **Event hooks** that update a pane's values when its agent finishes a turn.

There's no background process: see [How it works](/guide/how-it-works).

Next: [install the plugin](/guide/install).
