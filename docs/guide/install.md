# Install

## Requirements

- **herdr 0.9.1** or later.
- **Node.js 22.18** or later. The plugin runs its TypeScript directly, with no
  build step and no npm dependencies.
- **macOS or Linux.**
- Optional: the **GitHub CLI** (`gh`), logged in, for the Copilot quota.
- Optional: a terminal with **Kitty graphics** (Ghostty, kitty or WezTerm) for the
  pixel burn-up chart.

## Install from GitHub

```bash
herdr plugin install pseudovar/herdr-plugin-token-usage
```

herdr shows a preview of the manifest and the commands the plugin runs, then
installs it. The plugin ID is `pseudovar.token-usage`.

Next, create the `tu` command-line launcher and wire the plugin into herdr's config:

```bash
# Writes the `tu` launcher into the plugin's state directory.
herdr plugin action invoke pseudovar.token-usage.setup

# Adds sidebar rows, the tab-bar entry, keybindings and toast delivery.
~/.local/state/herdr/plugins/pseudovar.token-usage/bin/tu setup --apply

# Recommended: herdr's agent integrations, for exact pane → session mapping.
~/.local/state/herdr/plugins/pseudovar.token-usage/bin/tu setup --integrations
```

[Set up herdr](/guide/setup) explains each step and exactly what changes.

::: tip A shorter command
Add an alias to your shell profile:

```bash
alias tu=~/.local/state/herdr/plugins/pseudovar.token-usage/bin/tu
```

The rest of these docs write `tu` for short.
:::

## Update

```bash
herdr plugin update pseudovar.token-usage
```

herdr installs the new version next to the old one. Commands that are already
running finish on the old files, and new ones use the new version. The plugin's
ledger and config live outside the install directory, so they carry over.

## Install from a local checkout

For development, or to try an unreleased change:

```bash
git clone https://github.com/pseudovar/herdr-plugin-token-usage
herdr plugin link ./herdr-plugin-token-usage
```

A linked plugin runs straight from your checkout, so edits take effect on the
next hook, tab-bar tick or dashboard launch. See [Contributing](/contributing).

## Uninstall

```bash
herdr plugin uninstall pseudovar.token-usage
```

Then remove the rows, tab-bar entry and keybindings that `setup --apply` added to
`~/.config/herdr/config.toml`. Each `setup --apply` saves a timestamped backup
beside it. To remove the plugin's own data:

```bash
rm -rf ~/.local/state/herdr/plugins/pseudovar.token-usage        # ledger, launchers, log
rm -rf ~/.config/herdr/plugins/config/pseudovar.token-usage      # config.jsonc
```
