# Harnesses and accuracy

The plugin reads the usage records each harness already writes on your machine.
It opens them read-only and keeps only usage fields: tokens, model, timing and cost.

| Harness | Source | Unit | Notes |
| --- | --- | --- | --- |
| **Pi** | `~/.pi/agent/sessions/**/*.jsonl` | credits when routed through `github-copilot`, else $ | Follows forked sessions; counts compaction and branch-summary calls too. |
| **OpenCode** (v2 and v1.2) | `~/.local/share/opencode/opencode.db` | credits through Copilot, else $ | Subagent sessions roll up to their parent. Output includes reasoning tokens. |
| **GitHub Copilot CLI** | `~/.copilot/session-store.db` | credits (exact) | Exact AI-credit cost, time to first token and inter-token latency. |
| **Claude Code** | `~/.claude/projects/**/*.jsonl`, including subagents | API-equivalent $ | Streaming duplicates are removed per API response, keeping the final output count. |

Environment variables the harnesses themselves honour also move the plugin:
`PI_CODING_AGENT_DIR`, `OPENCODE_DB`, `COPILOT_HOME` and `CLAUDE_CONFIG_DIR`.

Calls routed to **local providers** (Ollama, LM Studio, LiteLLM) are recorded
with their tokens and timing, at $0.

## Copilot credits

Since June 2026, GitHub Copilot bills **AI credits** per token, at per-model
rates; 1 credit is $0.01.

- **Copilot CLI** records the exact credit cost of every call.
- **Pi and OpenCode** don't. The plugin prices their Copilot-routed calls with
  the per-model credit rate card it learns from Copilot CLI's data. Before
  Copilot CLI has run, it falls back to the harness's own price catalogue.
  OpenCode's own estimate leaves out cache writes and reasoning tokens, which
  Copilot bills.

## The Copilot quota

The budget, pace and burn-up come from GitHub's own figures, fetched with your
existing `gh` login (`gh api /copilot_internal/user`, at most every 5 minutes).
That's the account-wide truth. It includes usage the plugin can't see, such as
VS Code, github.com, other machines and deleted sessions. The dashboard shows how
much of it this machine accounts for.

`copilot_internal` is an internal endpoint. If it changes or `gh` isn't logged
in, the quota shows as unavailable and everything else keeps working.

Plans still on premium-request billing show requests × multiplier instead of credits.

## Claude Code

Claude Code costs are **API-equivalent list prices**: what the same tokens would
cost on the Anthropic API. That is close to the real bill on an API plan. On a Pro
or Max subscription it's a measure of usage rather than money: the plugin doesn't
read your subscription's 5-hour or 7-day limits.

## Tokens: what "work tokens" means

Every call re-sends the whole conversation, and most of it is served from the
prompt cache. Counting those cache reads as tokens would make totals grow
quadratically with session length. So the plugin's **work tokens** are input +
cache writes + output. Cache reads are shown separately, and are always included
in cost.

## Not supported yet

Codex and Gemini CLI adapters, local-server probes (Ollama, LM Studio, LiteLLM
speed and load times), Claude subscription limits and Windows are not supported
yet. [Open an issue](https://github.com/pseudovar/herdr-plugin-token-usage/issues/new/choose)
if you need one of them.
