import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where tuimspeak keeps things (architecture §10.1, §10.3, §12.2). XDG
 * locations on macOS and Linux alike; the usual AppData folders on Windows.
 */
const home = homedir();
const windows = process.platform === "win32";

const configHome = process.env.XDG_CONFIG_HOME || join(home, ".config");
const stateHome = process.env.XDG_STATE_HOME || join(home, ".local", "state");
const dataHome = process.env.XDG_DATA_HOME || join(home, ".local", "share");
const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
const localAppData = process.env.LOCALAPPDATA || join(home, "AppData", "Local");

const configDir = windows ? join(appData, "tuimspeak") : join(configHome, "tuimspeak");
const stateDir = windows ? join(localAppData, "tuimspeak") : join(stateHome, "tuimspeak");
const installRoot = windows ? join(localAppData, "tuimspeak") : join(dataHome, "tuimspeak");

export const paths = {
  configDir,
  configFile: join(configDir, "config.json"),
  bookmarksFile: join(configDir, "bookmarks.json"),
  identitiesDir: join(configDir, "identities"),
  stateDir,
  logFile: join(stateDir, "tuimspeak.log"),
  /** Last update check (§12.4). */
  updateFile: join(stateDir, "update.json"),
  /** Version directories written by the install scripts and the updater (§12.2). */
  versionsDir: join(installRoot, "versions"),
  /** The command on PATH that runs the current version. */
  launcher: windows ? join(installRoot, "bin", "tuimspeak.cmd") : join(home, ".local", "bin", "tuimspeak"),
};
