import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { paths } from "./config/paths.ts";
import { VERSION } from "./version.ts";

/**
 * Release checks and self-update (architecture §12.2, §12.4). The install
 * scripts (install.sh, install.ps1) lay out the same version directories and
 * launcher, so either can take over from the other.
 */

export const REPO = process.env.TUIMSPEAK_REPO || "st0nie/tuimspeak";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5000;

export interface Release {
  version: string;
  assets: { name: string; url: string }[];
}

export type Platform = "linux-x64" | "linux-arm64" | "darwin-arm64" | "windows-x64";

export function currentPlatform(platform: string = process.platform, arch: string = process.arch): Platform | null {
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null;
  if (!cpu) return null;
  if (platform === "linux") return `linux-${cpu}`;
  // No Intel Mac builds (§12.1).
  if (platform === "darwin") return cpu === "arm64" ? "darwin-arm64" : null;
  if (platform === "win32" && cpu === "x64") return "windows-x64";
  return null;
}

export function assetName(platform: Platform): string {
  return `tuimspeak-${platform}${platform.startsWith("windows") ? ".zip" : ".tar.gz"}`;
}

/** Compares x.y.z versions; a pre-release (`1.2.0-rc.1`) sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = "", pre] = v.replace(/^v/, "").split("-", 2);
    return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** The version directory the running executable lives in, if the install scripts put it there. */
export function managedVersionDir(execPath: string = process.execPath, versionsDir: string = paths.versionsDir): string | null {
  const dir = dirname(resolve(execPath));
  return resolve(dirname(dir)) === resolve(versionsDir) ? dir : null;
}

export async function fetchLatestRelease(fetchImpl: typeof fetch = fetch): Promise<Release> {
  const res = await fetchImpl(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "tuimspeak-updater" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for the latest release`);
  const body = (await res.json()) as { tag_name?: string; assets?: { name?: string; browser_download_url?: string }[] };
  if (!body.tag_name) throw new Error("the latest release has no tag");
  return {
    version: body.tag_name.replace(/^v/, ""),
    assets: (body.assets ?? []).filter((a) => a.name && a.browser_download_url).map((a) => ({ name: a.name!, url: a.browser_download_url! })),
  };
}

async function download(url: string, fetchImpl: typeof fetch): Promise<Buffer> {
  const res = await fetchImpl(url, { headers: { "User-Agent": "tuimspeak-updater" }, redirect: "follow" });
  if (!res.ok) throw new Error(`download of ${basename(url)} failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** First hex word of a `.sha256` file (`<hash>  <name>`, as written by CI). */
export function parseChecksum(text: string): string {
  const hash = text.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("malformed checksum file");
  return hash;
}

/** Points the launcher at a version's executable, atomically (§12.2). */
export function switchLauncher(versionDir: string, launcher: string = paths.launcher, platform: string = process.platform): void {
  mkdirSync(dirname(launcher), { recursive: true });
  const tmp = `${launcher}.tmp-${randomBytes(4).toString("hex")}`;
  if (platform === "win32") {
    writeFileSync(tmp, `@echo off\r\n"${join(versionDir, "tuimspeak.exe")}" %*\r\n`);
  } else {
    symlinkSync(join(versionDir, "tuimspeak"), tmp);
  }
  try {
    renameSync(tmp, launcher);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // nothing to clean
    }
    throw err;
  }
}

/** Removes every version directory except the ones to keep. Errors (a version still running on Windows) are skipped. */
export function pruneVersions(keep: string[], versionsDir: string = paths.versionsDir): void {
  if (!existsSync(versionsDir)) return;
  const kept = new Set(keep.map((d) => resolve(d)));
  for (const name of readdirSync(versionsDir)) {
    if (name.startsWith(".tmp-")) continue;
    const dir = join(versionsDir, name);
    if (kept.has(resolve(dir))) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // In use; try again next time.
    }
  }
}

export interface InstallOptions {
  fetchImpl?: typeof fetch;
  versionsDir?: string;
  launcher?: string;
  platform?: Platform;
  /** Directories never pruned, e.g. the running version. */
  keep?: string[];
  progress?: (message: string) => void;
}

/** Downloads, verifies and unpacks a release into its version directory, then switches the launcher. */
export async function installRelease(release: Release, options: InstallOptions = {}): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const versionsDir = options.versionsDir ?? paths.versionsDir;
  const platform = options.platform ?? currentPlatform();
  const progress = options.progress ?? (() => {});
  if (!platform) throw new Error(`no release build for ${process.platform}-${process.arch}`);
  const name = assetName(platform);
  const asset = release.assets.find((a) => a.name === name);
  const sum = release.assets.find((a) => a.name === `${name}.sha256`);
  if (!asset || !sum) throw new Error(`release ${release.version} has no ${name}`);

  progress(`Downloading ${name}...`);
  const [archive, checksum] = await Promise.all([download(asset.url, fetchImpl), download(sum.url, fetchImpl)]);
  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual !== parseChecksum(checksum.toString("utf8"))) throw new Error(`checksum mismatch for ${name}`);

  mkdirSync(versionsDir, { recursive: true });
  // Unpack next to the versions, so the final rename stays on one filesystem.
  const work = join(versionsDir, `.tmp-${randomBytes(4).toString("hex")}`);
  mkdirSync(work, { recursive: true });
  try {
    const file = join(work, name);
    writeFileSync(file, archive);
    progress("Unpacking...");
    const args = name.endsWith(".zip") ? ["-xf", file, "-C", work] : ["-xzf", file, "-C", work];
    const tar = spawnSync("tar", args, { stdio: "pipe" });
    if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr?.toString().trim() || tar.error?.message || tar.status}`);
    const unpacked = join(work, `tuimspeak-${platform}`);
    const exe = join(unpacked, platform.startsWith("windows") ? "tuimspeak.exe" : "tuimspeak");
    if (!existsSync(exe)) throw new Error("the archive does not contain tuimspeak");
    const target = join(versionsDir, release.version);
    rmSync(target, { recursive: true, force: true });
    renameSync(unpacked, target);
    switchLauncher(target, options.launcher, platform.startsWith("windows") ? "win32" : "posix");
    pruneVersions([target, ...(options.keep ?? [])], versionsDir);
    progress(`Installed ${release.version}`);
    return target;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

interface CheckState {
  lastCheck: number;
}

function readCheckState(): CheckState {
  try {
    return JSON.parse(readFileSync(paths.updateFile, "utf8")) as CheckState;
  } catch {
    return { lastCheck: 0 };
  }
}

function writeCheckState(state: CheckState): void {
  try {
    mkdirSync(dirname(paths.updateFile), { recursive: true });
    writeFileSync(paths.updateFile, JSON.stringify(state));
  } catch {
    // Next start checks again.
  }
}

export type UpdateOutcome =
  | { kind: "skipped" }
  | { kind: "current" }
  | { kind: "available"; version: string }
  | { kind: "installed"; version: string };

/**
 * The startup check (§12.4): at most once a day; installs in the background
 * when this copy was installed by a script and autoUpdate is on.
 */
export async function startupUpdateCheck(autoUpdate: boolean, now = Date.now()): Promise<UpdateOutcome> {
  if (process.env.TUIMSPEAK_NO_UPDATE === "1") return { kind: "skipped" };
  const state = readCheckState();
  if (now - state.lastCheck < CHECK_INTERVAL_MS) return { kind: "skipped" };
  writeCheckState({ lastCheck: now });
  const release = await fetchLatestRelease();
  if (compareVersions(release.version, VERSION) <= 0) return { kind: "current" };
  const running = managedVersionDir();
  if (!autoUpdate || !running) return { kind: "available", version: release.version };
  await installRelease(release, { keep: [running] });
  return { kind: "installed", version: release.version };
}

/** `tuimspeak update` (§12.4). */
export async function updateCommand(out: (line: string) => void): Promise<number> {
  out(`tuimspeak ${VERSION}, checking ${REPO}...`);
  let release: Release;
  try {
    release = await fetchLatestRelease();
  } catch (err) {
    out(`Update check failed: ${(err as Error).message}`);
    return 1;
  }
  if (compareVersions(release.version, VERSION) <= 0) {
    out(`Already up to date (latest release: ${release.version}).`);
    return 0;
  }
  const running = managedVersionDir();
  if (!running) {
    out(`Version ${release.version} is available. This copy was not installed by the install script, so update it the way you installed it:`);
    out(process.platform === "win32" ? `  irm https://raw.githubusercontent.com/${REPO}/main/install.ps1 | iex` : `  curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | sh`);
    return 0;
  }
  try {
    await installRelease(release, { keep: [running], progress: out });
  } catch (err) {
    out(`Update failed: ${(err as Error).message}`);
    return 1;
  }
  writeCheckState({ lastCheck: Date.now() });
  out(`Updated to ${release.version}. Restart tuimspeak to use it.`);
  return 0;
}
