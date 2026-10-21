import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { applyConfig, checkConfig } from "../src/commands/herdrconfig.ts";
import { migrateLegacyDirs } from "../src/core/legacy.ts";
import { Ledger } from "../src/core/ledger.ts";

describe("herdr config.toml editing", () => {
  it("adds every missing piece to a near-empty config", () => {
    const { text, changes, manual } = applyConfig("onboarding = false\n");
    assert.equal(manual.length, 0);
    assert.equal(changes.length, 5);
    assert.ok(text.startsWith("onboarding = false\n"), "top-level keys stay before tables");
    assert.match(text, /\[ui\.toast\]\ndelivery = "herdr"/);
    assert.match(text, /tab_bar_right = \[/);
    assert.match(text, /\$tu"/);
    assert.match(text, /\$tu_ws"/);
    assert.match(text, /command = "pseudovar\.token-usage\.open"/);
    assert.ok(checkConfig(text).every((c) => c.state === "ok"));
  });

  it("is idempotent", () => {
    const first = applyConfig("onboarding = false\n").text;
    const second = applyConfig(first);
    assert.equal(second.changes.length, 0);
    assert.equal(second.text, first);
  });

  it("inserts into existing tables and flips toast delivery from off", () => {
    const input = `[ui]\nsidebar_width = 30\n\n[ui.toast]\ndelivery = "off"\n`;
    const { text } = applyConfig(input);
    assert.match(text, /\[ui\]\ntab_bar_right = \[/);
    assert.match(text, /sidebar_width = 30/);
    assert.match(text, /delivery = "herdr"/);
    assert.doesNotMatch(text, /delivery = "off"/);
    assert.equal((text.match(/^\[ui\]$/gm) ?? []).length, 1, "no duplicate [ui] table");
  });

  it("never overwrites customised rows, tab bar or a taken key", () => {
    const input = `[ui]\ntab_bar_right = [{ type = "zoom" }]\n\n[ui.sidebar.agents]\nrows = [["agent"]]\n\n[[keys.command]]\nkey = "prefix+u"\ntype = "shell"\ncommand = "lazygit"\n`;
    const checks = checkConfig(input);
    assert.equal(checks.find((c) => c.id === "tabbar")?.state, "conflict");
    assert.equal(checks.find((c) => c.id === "agents")?.state, "conflict");
    assert.equal(checks.find((c) => c.id === "keys")?.state, "conflict");
    const { text, manual } = applyConfig(input);
    assert.ok(text.includes('tab_bar_right = [{ type = "zoom" }]'));
    assert.ok(text.includes('rows = [["agent"]]'));
    assert.equal(manual.length, 3);
  });

  it("detects a multi-line tab_bar_right that already has the entry", () => {
    const input = `[ui]\ntab_bar_right = [\n  { type = "zoom" },\n  { type = "command", command = "/x/bin/tu-status" },\n]\n`;
    assert.equal(checkConfig(input).find((c) => c.id === "tabbar")?.state, "ok");
  });

  it("upgrades the v1 sidebar layout this plugin wrote, and nothing else", () => {
    const v1 = [
      "onboarding = false",
      "",
      "[ui.sidebar.agents]",
      "rows = [",
      '  ["state_icon", "machine", "workspace", "tab"],',
      '  ["agent", { token = "$tu_ctx", dim = true }],',
      '  [{ token = "$tu", rules = [{ starts_with = "■", fg = "#f38ba8", bold = true }] }],',
      "]",
      "",
      "[ui.sidebar.spaces]",
      "rows = [",
      '  ["state_icon", "workspace"],',
      '  ["branch", "git_status"],',
      '  [{ token = "$tu_ws", dim = true, rules = [{ starts_with = "■", fg = "#f38ba8", dim = false }] }],',
      "]",
      "",
    ].join("\n");
    const checks = checkConfig(v1);
    assert.equal(checks.find((c) => c.id === "agents")?.state, "outdated");
    assert.equal(checks.find((c) => c.id === "spaces")?.state, "outdated");
    const { text, changes } = applyConfig(v1);
    assert.ok(changes.some((c) => c.startsWith("upgraded ui.sidebar.agents")));
    assert.ok(changes.some((c) => c.startsWith("upgraded ui.sidebar.spaces")));
    assert.match(text, /\$tu_sub/);
    assert.match(text, /\$tu_more/);
    assert.match(text, /\$tu_ws_more/);
    assert.doesNotMatch(text, /\$tu_ctx/);
    assert.equal((text.match(/^\[ui\.sidebar\.agents\]$/gm) ?? []).length, 1);
    assert.equal((text.match(/^rows = \[$/gm) ?? []).length, 2, "one rows value per table");
    assert.equal(applyConfig(text).changes.filter((c) => c.includes("sidebar")).length, 0, "idempotent");
  });

  it("leaves custom rows that use $tu alone", () => {
    const custom = '[ui.sidebar.agents]\nrows = [["agent", "$tu"]]\n';
    assert.equal(checkConfig(custom).find((c) => c.id === "agents")?.state, "ok");
    assert.ok(!applyConfig(custom).changes.some((c) => c.includes("sidebar.agents")));
  });

  it("renames keybindings and the tab-bar shim written under the old plugin id", () => {
    const old = applyConfig("")
      .text.split("pseudovar.token-usage")
      .join("jasford.token-usage")
      .replace(/command = "[^"]*tu-status"/, 'command = "~/.local/state/herdr/plugins/jasford.token-usage/bin/tu-status"');
    const checks = checkConfig(old);
    assert.equal(checks.find((c) => c.id === "legacy")?.state, "outdated");
    assert.equal(checks.find((c) => c.id === "keys")?.state, "ok", "the old binding is not mistaken for someone else's prefix+u");
    const { text, changes } = applyConfig(old);
    assert.ok(changes[0].startsWith("renamed the plugin id"));
    assert.doesNotMatch(text, /jasford/);
    assert.match(text, /command = "pseudovar\.token-usage\.open"/);
    assert.match(text, /plugins\/pseudovar\.token-usage\/bin\/tu-status/);
    assert.ok(checkConfig(text).every((c) => c.state === "ok"));
  });
});

describe("plugin id migration", () => {
  it("copies the old ledger and config to the new id's dirs once, keeping the old ones", () => {
    const root = mkdtempSync(join(tmpdir(), "tu-migrate-"));
    const saved = { state: process.env.HERDR_PLUGIN_STATE_DIR, config: process.env.HERDR_PLUGIN_CONFIG_DIR };
    try {
      const oldState = join(root, "state", "jasford.token-usage");
      const oldConfig = join(root, "config", "jasford.token-usage");
      mkdirSync(oldConfig, { recursive: true });
      writeFileSync(join(oldConfig, "config.jsonc"), '{ "display": { "style": "visual" } }');
      const ledger = new Ledger(join(oldState, "ledger.db"));
      ledger.setMeta("snooze_until", "123");
      ledger.close();
      process.env.HERDR_PLUGIN_STATE_DIR = join(root, "state", "pseudovar.token-usage");
      process.env.HERDR_PLUGIN_CONFIG_DIR = join(root, "config", "pseudovar.token-usage");

      assert.equal(migrateLegacyDirs().length, 2);
      const migrated = new Ledger(join(process.env.HERDR_PLUGIN_STATE_DIR, "ledger.db"));
      assert.equal(migrated.getMeta("snooze_until"), "123");
      migrated.close();
      assert.match(readFileSync(join(process.env.HERDR_PLUGIN_CONFIG_DIR, "config.jsonc"), "utf8"), /visual/);
      assert.ok(existsSync(join(oldState, "ledger.db")), "the old ledger stays as a backup");
      assert.equal(migrateLegacyDirs().length, 0, "runs once");
    } finally {
      process.env.HERDR_PLUGIN_STATE_DIR = saved.state;
      process.env.HERDR_PLUGIN_CONFIG_DIR = saved.config;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves custom state dirs alone", () => {
    assert.deepEqual(migrateLegacyDirs(), [], "the test run's own state dir is not named after the plugin");
  });
});
