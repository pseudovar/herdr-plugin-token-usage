import { constants, copyFileSync, existsSync, linkSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LEGACY_PLUGIN_IDS, PLUGIN_ID, configDir, stateDir } from "../env.ts";

/**
 * herdr names a plugin's state and config dirs after its id. On the first run
 * under a new id, copy the ledger (with its alert, quota and binding history)
 * and config.jsonc from the old dirs. The old dirs are left as a backup.
 * Returns what was copied; nothing once the new dirs are in use.
 */
export function migrateLegacyDirs(): string[] {
  const copied: string[] = [];
  const state = stateDir();
  const config = configDir();
  for (const legacy of LEGACY_PLUGIN_IDS) {
    // Only herdr's default layout: tests and custom setups point the dirs elsewhere.
    if (basename(state) === PLUGIN_ID) {
      const from = join(dirname(state), legacy, "ledger.db");
      const to = join(state, "ledger.db");
      if (existsSync(from) && !existsSync(to)) {
        mkdirSync(state, { recursive: true });
        // VACUUM INTO takes a consistent copy (WAL included) even if the old
        // ledger is in use; linking it into place means a concurrent run can
        // never open a half-written file, and only one copy wins.
        const tmp = `${to}.migrating-${process.pid}`;
        // Read-only opens of a WAL database fail when its -shm file is missing; VACUUM INTO never writes the source.
        const db = new DatabaseSync(from);
        try {
          db.exec("PRAGMA busy_timeout = 5000");
          db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
        } finally {
          db.close();
        }
        try {
          linkSync(tmp, to);
          copied.push(`${from} → ${to}`);
        } catch (err) {
          // EEXIST: another process migrated first. Otherwise the filesystem has no hard links.
          if ((err as NodeJS.ErrnoException).code !== "EEXIST" && !existsSync(to)) {
            renameSync(tmp, to);
            copied.push(`${from} → ${to}`);
          }
        } finally {
          if (existsSync(tmp)) unlinkSync(tmp);
        }
      }
    }
    if (basename(config) === PLUGIN_ID) {
      const from = join(dirname(config), legacy, "config.jsonc");
      const to = join(config, "config.jsonc");
      if (existsSync(from) && !existsSync(to)) {
        mkdirSync(config, { recursive: true });
        try {
          copyFileSync(from, to, constants.COPYFILE_EXCL);
          copied.push(`${from} → ${to}`);
        } catch {
          // another process copied it first
        }
      }
    }
  }
  return copied;
}

/** State dirs of earlier ids that still exist (their tab-bar shims may still be referenced). */
export function legacyStateDirs(): string[] {
  const state = stateDir();
  if (basename(state) !== PLUGIN_ID) return [];
  return LEGACY_PLUGIN_IDS.map((id) => join(dirname(state), id)).filter((dir) => existsSync(dir));
}
