# Security policy

## Supported versions

Only the latest release gets fixes. herdr installs plugins from the default
branch, so `herdr plugin update pseudovar.token-usage` brings you up to date.

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub's private vulnerability reporting](https://github.com/pseudovar/herdr-plugin-token-usage/security/advisories/new),
not in a public issue. Include what you found, how to reproduce it, and the
versions of the plugin, herdr, Node.js and your OS.

You can expect an acknowledgement within a week. Once a fix is released, the
advisory is published and you're credited unless you'd rather not be.

## Scope

The plugin runs with your user's permissions, inside herdr. Issues worth reporting include:

- reading or exposing prompt or response content, credentials or tokens;
- writing to a harness's data, or to herdr's config without `tu setup --apply`;
- command or path injection through harness data, session titles or config;
- the Copilot quota lookup (`gh api`) leaking or misusing your GitHub login.
