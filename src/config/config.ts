import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, userInfo } from "node:os";
import { paths } from "./paths.ts";

export type TalkMode = "vad" | "toggle" | "ptt";
export type IconSet = "unicode" | "ascii" | "nerdfont";
export type DesktopNotifications = "off" | "unfocused" | "always";

/** Hold keys the stdin tap can recognize (§8.2). */
export const HOLD_KEYS = ["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12", "ctrl+space", "alt+space"] as const;
export type HoldKey = (typeof HOLD_KEYS)[number];

/** Keys and defaults are documented in docs/configuration.md. */
export interface Config {
  nickname: string;
  talkMode: TalkMode;
  pttKey: HoldKey;
  whisperKey: HoldKey;
  /** Linear RMS (0..1) at which voice activation opens. webspeak3's default. */
  vadThreshold: number;
  vadHangoverMs: number;
  icons: IconSet;
  inputDevice: string;
  outputDevice: string;
  showQueryClients: boolean;
  wheelLines: number;
  sounds: boolean;
  soundVolume: number;
  desktopNotifications: DesktopNotifications;
  blockWhispers: boolean;
  /** UIDs that get the opposite of blockWhispers (§8.3). */
  whisperExceptions: string[];
  /** Per-user playback volume by UID, 0..2 (§8.4). */
  volumes: Record<string, number>;
  downloadDir: string;
  /** Install new releases in the background (§12.4). */
  autoUpdate: boolean;
}

export interface Bookmark {
  name: string;
  address: string;
  nickname?: string;
  defaultChannel?: string;
  identity?: string;
  /** Only stored when the user opts in. */
  serverPassword?: string;
}

export const DEFAULT_CONFIG: Config = {
  nickname: userInfo().username || "tuimspeak user",
  talkMode: "vad",
  pttKey: "f9",
  whisperKey: "f8",
  vadThreshold: 0.02,
  vadHangoverMs: 300,
  icons: "unicode",
  inputDevice: "default",
  outputDevice: "default",
  showQueryClients: false,
  wheelLines: 3,
  sounds: true,
  soundVolume: 0.5,
  desktopNotifications: "unfocused",
  blockWhispers: false,
  whisperExceptions: [],
  volumes: {},
  downloadDir: "~/Downloads",
  autoUpdate: true,
};

/** Expands a leading `~` (used for downloadDir). */
export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

const clamp = (v: unknown, lo: number, hi: number, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback;

/** Repairs a hand-edited config: unknown enum values and out-of-range numbers fall back to defaults. */
export function normalizeConfig(raw: Partial<Config>): Config {
  const c = { ...DEFAULT_CONFIG, ...raw };
  const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);
  return {
    ...c,
    nickname: typeof c.nickname === "string" && c.nickname.trim() ? c.nickname : DEFAULT_CONFIG.nickname,
    talkMode: oneOf(c.talkMode, ["vad", "toggle", "ptt"], "vad"),
    pttKey: oneOf(c.pttKey, HOLD_KEYS, DEFAULT_CONFIG.pttKey),
    whisperKey: oneOf(c.whisperKey, HOLD_KEYS, DEFAULT_CONFIG.whisperKey),
    vadThreshold: clamp(c.vadThreshold, 0.001, 1, DEFAULT_CONFIG.vadThreshold),
    vadHangoverMs: clamp(c.vadHangoverMs, 0, 5000, DEFAULT_CONFIG.vadHangoverMs),
    icons: oneOf(c.icons, ["unicode", "ascii", "nerdfont"], "unicode"),
    wheelLines: Math.round(clamp(c.wheelLines, 1, 50, DEFAULT_CONFIG.wheelLines)),
    soundVolume: clamp(c.soundVolume, 0, 1, DEFAULT_CONFIG.soundVolume),
    desktopNotifications: oneOf(c.desktopNotifications, ["off", "unfocused", "always"], "unfocused"),
    whisperExceptions: Array.isArray(c.whisperExceptions) ? c.whisperExceptions.filter((u) => typeof u === "string") : [],
    volumes:
      c.volumes && typeof c.volumes === "object"
        ? Object.fromEntries(Object.entries(c.volumes).filter(([, v]) => typeof v === "number" && Number.isFinite(v)).map(([k, v]) => [k, clamp(v, 0, 2, 1)]))
        : {},
    downloadDir: typeof c.downloadDir === "string" && c.downloadDir ? c.downloadDir : DEFAULT_CONFIG.downloadDir,
    autoUpdate: c.autoUpdate !== false,
  };
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function writePrivate(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, content, { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function loadConfig(): Config {
  return normalizeConfig(readJson<Partial<Config>>(paths.configFile) ?? {});
}

export function saveConfig(config: Config): void {
  writePrivate(paths.configFile, `${JSON.stringify(config, null, 2)}\n`);
}

export function loadBookmarks(): Bookmark[] {
  const list = readJson<Bookmark[]>(paths.bookmarksFile);
  return Array.isArray(list) ? list.filter((b) => b && typeof b.address === "string") : [];
}

export function saveBookmarks(bookmarks: Bookmark[]): void {
  // May contain opted-in server passwords, hence private like identities.
  writePrivate(paths.bookmarksFile, `${JSON.stringify(bookmarks, null, 2)}\n`);
}

const identityFile = (name: string) => join(paths.identitiesDir, `${name.replace(/[^\w.-]/g, "_")}.ini`);

/** The connector's identity string; keeps the client UID stable across sessions. */
export function loadIdentity(name = "default"): string | undefined {
  try {
    const text = readFileSync(identityFile(name), "utf8").trim();
    return text || undefined;
  } catch {
    return undefined;
  }
}

export function saveIdentity(identity: string, name = "default"): void {
  writePrivate(identityFile(name), `${identity}\n`);
}
