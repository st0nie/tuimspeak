import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Locates the native helper binaries: explicit env var, then next to the
 * executable (release archives), then the development build output.
 */
function locate(envVar: string, name: string): string | undefined {
  const fromEnv = process.env[envVar];
  if (fromEnv) return fromEnv;
  const candidates = [
    join(dirname(process.execPath), name),
    resolve(dirname(fileURLToPath(import.meta.url)), "..", "native", "target", "release", name),
  ];
  return candidates.find((p) => existsSync(p));
}

const exe = process.platform === "win32" ? ".exe" : "";
export const connectorBinary = () => locate("TUIMSPEAK_CONNECTOR_BIN", `ts-connector${exe}`);
export const audioBinary = () => locate("TUIMSPEAK_AUDIO_BIN", `tuim-audio${exe}`);
