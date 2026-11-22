import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { paths } from "./config/paths.ts";

/**
 * File logger. stdout belongs to the UI, so nothing may be printed there
 * while the app runs. Debug lines are only written with --debug.
 */
let debugEnabled = false;
let ready = false;

function write(level: string, message: string): void {
  try {
    if (!ready) {
      mkdirSync(dirname(paths.logFile), { recursive: true });
      ready = true;
    }
    appendFileSync(paths.logFile, `${new Date().toISOString()} ${level} ${message}\n`);
  } catch {
    // Logging must never take the app down.
  }
}

export const log = {
  setDebug(on: boolean) {
    debugEnabled = on;
  },
  debug(message: string) {
    if (debugEnabled) write("DEBUG", message);
  },
  info(message: string) {
    write("INFO", message);
  },
  error(message: string) {
    write("ERROR", message);
  },
};
