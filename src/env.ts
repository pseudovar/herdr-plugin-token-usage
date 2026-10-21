import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PLUGIN_ID = "pseudovar.token-usage";
/** Metadata source id used for every herdr token report from this plugin. */
export const SOURCE = `plugin:${PLUGIN_ID}`;
/** Prefix for every sidebar token this plugin owns. */
export const TOKEN_PREFIX = "tu";

const home = homedir();

function xdg(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() ? value : fallback;
}

export function pluginRoot(): string {
  if (process.env.HERDR_PLUGIN_ROOT) return process.env.HERDR_PLUGIN_ROOT;
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export function stateDir(): string {
  if (process.env.HERDR_PLUGIN_STATE_DIR) return process.env.HERDR_PLUGIN_STATE_DIR;
  return join(xdg("XDG_STATE_HOME", join(home, ".local", "state")), "herdr", "plugins", PLUGIN_ID);
}

export function configDir(): string {
  if (process.env.HERDR_PLUGIN_CONFIG_DIR) return process.env.HERDR_PLUGIN_CONFIG_DIR;
  return join(xdg("XDG_CONFIG_HOME", join(home, ".config")), "herdr", "plugins", "config", PLUGIN_ID);
}

export function herdrConfigPath(): string {
  return process.env.HERDR_CONFIG_PATH || join(home, ".config", "herdr", "config.toml");
}

export function herdrSocketPath(): string {
  if (process.env.HERDR_SOCKET_PATH) return process.env.HERDR_SOCKET_PATH;
  const session = process.env.HERDR_SESSION;
  if (session) return join(home, ".config", "herdr", "sessions", session, "herdr.sock");
  return join(home, ".config", "herdr", "herdr.sock");
}

export function herdrBin(): string {
  return process.env.HERDR_BIN_PATH || "herdr";
}

const piAgentDir = () => process.env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent");

export const harnessPaths = {
  piSessions: () => process.env.PI_CODING_AGENT_SESSION_DIR || join(piAgentDir(), "sessions"),
  piModels: () => join(piAgentDir(), "models-store.json"),
  claudeProjects: () => join(process.env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "projects"),
  opencodeDb: () =>
    process.env.OPENCODE_DB || join(xdg("XDG_DATA_HOME", join(home, ".local", "share")), "opencode", "opencode.db"),
  opencodeModels: () => join(xdg("XDG_CACHE_HOME", join(home, ".cache")), "opencode", "models.json"),
  copilotHome: () => process.env.COPILOT_HOME || join(home, ".copilot"),
  codexHome: () => process.env.CODEX_HOME || join(home, ".codex"),
};

export const HOME = home;
