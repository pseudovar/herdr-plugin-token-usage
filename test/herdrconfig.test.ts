import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { applyConfig, checkConfig, pluginEntries, restoreIfWiped } from "../src/commands/herdrconfig.ts";
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
});

describe("restoring a wiped herdr config", () => {
  const dir = mkdtempSync(join(tmpdir(), "tu-restore-"));
  const path = join(dir, "config.toml");
  const saved = process.env.HERDR_CONFIG_PATH;
  before(() => {
    process.env.HERDR_CONFIG_PATH = path;
  });
  after(() => {
    if (saved === undefined) delete process.env.HERDR_CONFIG_PATH;
    else process.env.HERDR_CONFIG_PATH = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  const mine = 'onboarding = false\n\n[theme]\nname = "catppuccin"\n';
  const full = applyConfig(mine).text;
  // Each write gets its own mtime: two writes in the same instant would look unchanged.
  let tick = Date.now();
  const write = (text: string) => {
    writeFileSync(path, text);
    tick += 2000;
    utimesSync(path, new Date(tick), new Date(tick));
  };

  it("puts the plugin's entries back when a rewrite removed all of them", async () => {
    const ledger = new Ledger(":memory:");
    write(full);
    assert.equal(await restoreIfWiped(ledger, true), null, "the first look only remembers what is there");
    write(mine);
    const note = await restoreIfWiped(ledger, true);
    assert.match(note?.title ?? "", /restored/);
    const text = readFileSync(path, "utf8");
    assert.equal(pluginEntries(text), "all");
    assert.match(text, /name = "catppuccin"/, "the rest of the config is kept");
    assert.ok(readdirSync(dir).some((f) => f.startsWith("config.toml.bak-")), "the rewritten file is backed up");
    assert.equal(await restoreIfWiped(ledger, true), null, "nothing more to do");
  });

  it("leaves a partial removal alone", async () => {
    const ledger = new Ledger(":memory:");
    write(full);
    await restoreIfWiped(ledger, true);
    const noTabBar = full.replace(/tab_bar_right = \[[\s\S]*?\n\]\n/, "");
    assert.equal(pluginEntries(noTabBar), "some");
    write(noTabBar);
    assert.equal(await restoreIfWiped(ledger, true), null);
    assert.equal(readFileSync(path, "utf8"), noTabBar);
  });

  it("does nothing when autoRestore is off", async () => {
    const ledger = new Ledger(":memory:");
    write(full);
    await restoreIfWiped(ledger, true);
    write(mine);
    assert.equal(await restoreIfWiped(ledger, false), null);
    assert.equal(readFileSync(path, "utf8"), mine);
  });
});
