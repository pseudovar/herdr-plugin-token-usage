# Privacy

- **Read-only.** Harness databases and transcripts are opened read-only. The
  plugin never changes how your agents run.
- **Usage only.** Only usage fields are stored: tokens, model, timing, cost and
  session titles. Prompts and responses are never stored or shown.
- **Local.** Everything lives in two directories on your machine:
  - `~/.local/state/herdr/plugins/pseudovar.token-usage/` holds the ledger, the
    launchers and the log.
  - `~/.config/herdr/plugins/config/pseudovar.token-usage/` holds `config.jsonc`.
- **One network call.** The optional Copilot quota lookup goes through your
  existing `gh` login, at most every 5 minutes. Turn it off with
  `"copilot": { "quota": false }`. There is no telemetry.
- **herdr's config** is only changed by `tu setup --apply`, which shows a diff,
  asks first and keeps a backup. Agent integrations are only installed by
  `tu setup --integrations`, through herdr's own `herdr integration install`.

To delete everything the plugin has stored, uninstall it and remove the two
directories above.
