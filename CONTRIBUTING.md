# Contributing

Thanks for helping! Bug reports, harness formats that changed under us, new
adapters and docs fixes are all welcome.

## Development setup

You need Node.js 22.18 or later and [herdr](https://herdr.dev) 0.9.1 or later.
The plugin itself has no dependencies; `npm install` only fetches TypeScript, the
Node type definitions and VitePress for the docs.

```bash
git clone https://github.com/pseudovar/herdr-plugin-token-usage
cd herdr-plugin-token-usage
npm install
npm run check                # type check + tests
herdr plugin link .          # run your checkout inside herdr
```

A linked plugin runs straight from your checkout. Event hooks and the tab bar
pick up changes on their next run, and the dashboard on its next launch.

Useful while working:

```bash
sh bin/tu dashboard --snapshot --view 1 --cols 160 --rows 50 --plain   # render a view without a TTY
sh bin/tu doctor                                                       # data sources, bindings, quota
npm run docs:dev                                                       # docs site with live reload
npm run docs:shots                                                     # regenerate the docs images
```

`npm run docs:shots` renders every image in `docs/public/shots/` from synthetic
data: a seeded demo ledger and a fake herdr socket (`scripts/docs/`). It never
reads your own usage. PNG export needs Google Chrome.

## Project layout

| Path | What's there |
| --- | --- |
| `herdr-plugin.toml` | The manifest: hooks, actions and panes. |
| `bin/tu` | A POSIX launcher that finds Node.js and runs `src/cli.ts`. |
| `src/adapters/` | One reader per harness: Pi, OpenCode, Copilot CLI, Claude Code. |
| `src/core/` | Ledger, ingest, pricing, binding, metrics, rules, display grammar. |
| `src/commands/` | CLI commands and herdr hooks. |
| `src/ui/` | The dashboard: views, charts, the pixel rasteriser, the terminal driver. |
| `test/` | `node:test` suites with synthetic fixtures. |
| `docs/` | The VitePress site, plus design and research notes. |

[How it works](https://pseudovar.github.io/herdr-plugin-token-usage/guide/how-it-works)
and the [design notes](https://pseudovar.github.io/herdr-plugin-token-usage/DESIGN)
explain the architecture.

## Guidelines

- **No runtime dependencies.** Plugin users never run `npm install`, so `src/`
  may only import Node built-ins.
- **Hooks must be fast.** herdr gives event hooks no timeout and shares 32
  command slots between all plugins, so a hook should finish well under a second.
- **Read-only, usage only.** Never write to a harness's files, and never store
  prompt or response text.
- **Test with synthetic data.** Fixtures must not contain real transcripts,
  paths, project names or account details.
- **Match the surrounding code**, and keep comments for what the code can't say.
- `npm run check` must pass.

## Commits, versions and releases

Versions follow [Semantic Versioning](https://semver.org), and releases are
automated with [release-please](https://github.com/googleapis/release-please).

- Pull requests are squash-merged, and **the PR title becomes the commit
  message**. Titles follow [Conventional Commits](https://www.conventionalcommits.org):
  - `feat: …` for a new feature (minor release);
  - `fix: …` for a bug fix (patch release);
  - `perf:`, `docs:`, `refactor:`, `test:`, `build:`, `ci:` or `chore:` for anything else;
  - `feat!: …`, or a `BREAKING CHANGE:` footer, for a breaking change.

  A check enforces the title format.
- release-please keeps a release pull request open with the next version and
  changelog. Merging it bumps `package.json` and `herdr-plugin.toml`, tags
  `vX.Y.Z` and publishes a GitHub Release. Edit the changelog in that PR if a
  generated entry needs better wording.
- herdr installs plugins from the default branch, so `main` must always work.

## Adding a harness

1. Add an adapter in `src/adapters/` that implements `Adapter`. It must read
   incrementally (keep a cursor), parse defensively, and return normalised
   `UsageRecord`s; see the conventions at the top of `src/core/types.ts`.
2. Register it in `src/core/ingest.ts`, and add the harness to `Harness`,
   `HARNESS_LABEL` and `harnessOf()`.
3. Add a synthetic fixture and tests in `test/`.
4. Document the data source in `docs/guide/harnesses.md`.

## Docs

The site is built from `docs/` with [VitePress](https://vitepress.dev) and
deployed to GitHub Pages on every push to `main`. `npm run docs:build` fails on
dead links. `npm audit` reports advisories in esbuild and vite. They only affect
VitePress's local dev server (`docs:dev`), not the built site or the plugin.
