import { AGENT_TOKEN_KEYS, SPACE_TOKEN_KEYS } from "./display.ts";
import type { TokenMap } from "./display.ts";

export type { TokenMap } from "./display.ts";

/** Every pane token this plugin owns (cleared together when an agent leaves). */
export const PANE_TOKEN_KEYS = AGENT_TOKEN_KEYS;
export const WORKSPACE_TOKEN_KEYS = SPACE_TOKEN_KEYS;

/** Only the keys whose value differs from what herdr currently holds. */
export function diffTokens(current: Record<string, string> | null | undefined, next: TokenMap): TokenMap {
  const patch: TokenMap = {};
  for (const [key, value] of Object.entries(next)) {
    const have = current?.[key] ?? null;
    if (value === null) {
      if (have !== null) patch[key] = null;
    } else if (have !== value) {
      patch[key] = value;
    }
  }
  return patch;
}
