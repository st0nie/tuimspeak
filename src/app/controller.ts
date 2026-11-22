import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { createStore, type StoreApi } from "zustand/vanilla";
import { AudioProcess, type AudioDevice } from "../audio/process.ts";
import { VoiceEngine } from "../audio/voice.ts";
import { renderSound, type SoundName } from "../audio/sounds.ts";
import { ConnectorProcess, type ConnectOptions, type ConnectorLike } from "../connector/process.ts";
import { MAX_DOWNLOAD_BYTES, MAX_UPLOAD_BYTES, UPLOAD_CHUNK_BYTES } from "../connector/commands.ts";
import type { ClientInfo, ConnectorEvent, FileEntry } from "../connector/protocol.ts";
import {
  expandHome,
  loadIdentity,
  saveBookmarks,
  saveConfig,
  saveIdentity,
  type Bookmark,
  type Config,
} from "../config/config.ts";
import type { HoldKeyName, KeyAction } from "../mouse/sgr.ts";
import { Session } from "../session/session.ts";
import type { SessionState } from "../state/session.ts";
import { desktopNotify } from "../notify.ts";
import { plainText } from "../ui/bbcode.ts";
import { log } from "../log.ts";

export interface MenuItem {
  label: string;
  action: () => void;
  disabled?: boolean;
}

/** Every dialog the UI can show (§7.4). Session-bound ones carry the session id. */
export type Dialog =
  | { kind: "connect"; editBookmark?: number }
  | { kind: "help" }
  | { kind: "settings" }
  | { kind: "menu"; x: number; y: number; title: string; items: MenuItem[] }
  | { kind: "confirm"; title: string; message: string; confirmLabel: string; onConfirm: () => void }
  | { kind: "prompt"; title: string; label: string; initial?: string; mask?: boolean; submitLabel: string; onSubmit: (value: string) => void }
  | { kind: "away" }
  | { kind: "channelPassword"; sessionId: string; channelId: number; name: string; moveClientId?: number }
  | { kind: "volume"; sessionId: string; clientId: number }
  | { kind: "kick"; sessionId: string; clientId: number; from: "channel" | "server" }
  | { kind: "ban"; sessionId: string; clientId: number }
  | { kind: "bans"; sessionId: string }
  | { kind: "complaints"; sessionId: string }
  | { kind: "serverGroups"; sessionId: string; clientId: number }
  | { kind: "channelGroup"; sessionId: string; clientId: number }
  | { kind: "offlineMessages"; sessionId: string }
  | { kind: "sendOfflineMessage"; sessionId: string; uid: string; name: string }
  | { kind: "editServer"; sessionId: string }
  | { kind: "queryLogin"; sessionId: string }
  | { kind: "files"; sessionId: string; channelId: number }
  | { kind: "movePicker"; sessionId: string; clientId: number };

export type Focus = "tree" | "chat" | "filter";

export interface AudioStatus {
  state: "unavailable" | "starting" | "ready" | "error";
  message: string;
  output?: string;
  input?: string;
  host?: string;
  inputs?: AudioDevice[];
  outputs?: AudioDevice[];
}

export interface AppState {
  sessionIds: string[];
  activeId: string | null;
  config: Config;
  bookmarks: Bookmark[];
  audio: AudioStatus;
  micMuted: boolean;
  speakerMuted: boolean;
  talking: boolean;
  /** Input level 0..1 for the meter, throttled. */
  level: number;
  toggled: boolean;
  /** Some hold source currently whispers (§8.3). */
  whisperHeld: boolean;
  /** The terminal answered the kitty keyboard query; hold keys really hold (§8.2). */
  kittyKeys: boolean;
  terminalFocused: boolean;
  dialog: Dialog | null;
  focus: Focus;
  notice: { text: string; kind: "info" | "error" } | null;
}

export interface ConnectRequest extends ConnectOptions {
  label?: string;
  identityName?: string;
}

const LEVEL_UPDATE_MS = 66;
const CLIENT_INFO_INTERVAL_MS = 3000;
const SERVER_INFO_INTERVAL_MS = 5000;
/** Below this, a press on the whisper button is a click that locks whisper (§8.3). */
const WHISPER_CLICK_MS = 300;

export interface ControllerOptions {
  config: Config;
  bookmarks: Bookmark[];
  connectorBinary?: string;
  audioBinary?: string;
  /** Replaces the real connector (demo mode, tests). */
  connectorFactory?: (request: ConnectRequest) => ConnectorLike;
  persist?: boolean;
  now?: () => number;
}

interface SessionExtras {
  request: ConnectRequest;
  /** Volumes already sent, by client id (§8.4). */
  appliedVolumes: Map<number, number>;
  /** Last whisper policy sent, to avoid re-sending identical ones. */
  policyKey: string;
  lastClientInfo: { clientId: number; at: number } | null;
  lastServerInfo: number;
  /** The server refused connection info once; polling it again would only repeat the error (§9.2). */
  clientInfoDenied: boolean;
  serverInfoDenied: boolean;
}

interface Download {
  sessionId: string;
  transferId: number;
  cid: number;
  path: string;
  localPath: string;
  fd: number;
}

/**
 * Owns everything that is not React (§5.3): sessions, the audio helper, voice
 * gating, configuration and app-level UI state. Components read `store` and
 * call methods.
 */
export class Controller {
  readonly store: StoreApi<AppState>;
  private readonly sessions = new Map<string, Session>();
  private readonly extras = new Map<string, SessionExtras>();
  private readonly voice: VoiceEngine;
  private audio: AudioProcess | undefined;
  private nextSessionId = 1;
  private lastLevelUpdate = 0;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  /** Hold keys latched on by a press in terminals without key releases. */
  private readonly latchedKeys = new Set<HoldKeyName>();
  private whisperPressAt = 0;
  private readonly downloads: Download[] = [];
  private readonly now: () => number;

  constructor(private readonly options: ControllerOptions) {
    this.now = options.now ?? Date.now;
    this.store = createStore<AppState>(() => ({
      sessionIds: [],
      activeId: null,
      config: options.config,
      bookmarks: options.bookmarks,
      audio: { state: "unavailable", message: "Audio helper not found" },
      micMuted: false,
      speakerMuted: false,
      talking: false,
      level: 0,
      toggled: false,
      whisperHeld: false,
      kittyKeys: false,
      terminalFocused: true,
      dialog: null,
      focus: "tree",
      notice: null,
    }));
    this.voice = new VoiceEngine({
      mode: options.config.talkMode,
      threshold: options.config.vadThreshold,
      hangoverMs: options.config.vadHangoverMs,
      send: (frame) => this.activeSession()?.sendAudio(frame),
      onTalkingChange: (talking) => {
        this.store.setState({ talking });
        this.activeSession()?.setSelfTalking(talking);
      },
    });
  }

  get state(): AppState {
    return this.store.getState();
  }

  session(id: string | null | undefined): Session | undefined {
    return id ? this.sessions.get(id) : undefined;
  }

  activeSession(): Session | undefined {
    return this.session(this.state.activeId);
  }

  /** Keys the stdin tap should report: the hold keys (§8.2), plus F1/F2, which Ink does not expose. */
  holdKeys(): HoldKeyName[] {
    return [this.state.config.pttKey, this.state.config.whisperKey, "f1", "f2"];
  }

  // ---- audio (§4, §8) -----------------------------------------------------

  startAudio(): void {
    const binary = this.options.audioBinary;
    if (!binary) return;
    const audio = new AudioProcess(binary);
    this.audio = audio;
    this.store.setState({ audio: { state: "starting", message: "Starting audio..." } });
    audio.on("capture", (frame) => {
      this.voice.push(frame);
      const now = this.now();
      if (now - this.lastLevelUpdate >= LEVEL_UPDATE_MS) {
        this.lastLevelUpdate = now;
        this.store.setState({ level: this.voice.level });
      }
    });
    audio.on("event", (event) => {
      switch (event.event) {
        case "devices":
          this.store.setState((s) => ({ audio: { ...s.audio, host: event.host, inputs: event.inputs, outputs: event.outputs } }));
          break;
        case "outputOpened":
          this.store.setState((s) => ({ audio: { ...s.audio, state: "ready", message: "", output: event.name } }));
          this.syncCapture();
          break;
        case "captureStarted":
          this.store.setState((s) => ({ audio: { ...s.audio, input: event.name } }));
          break;
        case "captureStopped":
          break;
        case "silentInput":
          this.notify("The microphone delivers only silence. On macOS, allow your terminal app under System Settings > Privacy & Security > Microphone.", "error");
          break;
        case "stats":
          log.debug(`audio stats: underruns=${event.underruns} overflows=${event.overflows} buffered=${event.bufferedMs}ms`);
          break;
        case "error":
          log.error(`audio: ${event.message}`);
          this.store.setState((s) => ({ audio: { ...s.audio, state: s.audio.state === "ready" ? "ready" : "error", message: event.message } }));
          break;
      }
    });
    audio.on("exit", () => {
      this.audio = undefined;
      this.store.setState((s) => ({ audio: { ...s.audio, state: "error", message: s.audio.message || "Audio helper exited" } }));
    });
    audio.start();
    audio.open(this.state.config.inputDevice, this.state.config.outputDevice);
    audio.listDevices();
  }

  refreshDevices(): void {
    this.audio?.listDevices();
  }

  setDevices(input: string, output: string): void {
    this.setConfig({ inputDevice: input, outputDevice: output });
    this.audio?.open(input, output);
  }

  /** Capture runs only while connected and unmuted, so the OS mic indicator tells the truth (§4.4). */
  private syncCapture(): void {
    const connected = [...this.sessions.values()].some((s) => s.connected);
    const want = connected && !this.state.micMuted && this.state.audio.state === "ready";
    this.audio?.setCapture(want);
    if (!want) this.store.setState({ level: 0 });
  }

  private playback(sessionId: string, pcm: Buffer): void {
    if (sessionId !== this.state.activeId || this.state.speakerMuted) return;
    this.audio?.play(pcm);
  }

  playSound(name: SoundName): void {
    const { config, speakerMuted, audio } = this.state;
    if (!config.sounds || speakerMuted || audio.state !== "ready") return;
    this.audio?.playEffect(renderSound(name, config.soundVolume));
  }

  // ---- sessions (§5.2, §9.1) ------------------------------------------------

  private createConnector(request: ConnectRequest): ConnectorLike | undefined {
    const identityName = request.identityName ?? "default";
    const options: ConnectOptions = { ...request, identity: request.identity ?? loadIdentity(identityName) };
    if (this.options.connectorFactory) return this.options.connectorFactory(request);
    if (!this.options.connectorBinary) {
      this.notify("ts-connector not found. Run `bun run build:native` or set TUIMSPEAK_CONNECTOR_BIN.", "error");
      return undefined;
    }
    const proc = new ConnectorProcess(this.options.connectorBinary, options);
    proc.start();
    return proc;
  }

  connect(request: ConnectRequest): Session | undefined {
    const connector = this.createConnector(request);
    if (!connector) return undefined;
    const id = `s${this.nextSessionId++}`;
    const identityName = request.identityName ?? "default";
    const session = new Session({
      id,
      label: request.label ?? request.address,
      address: request.address,
      connector,
      onIdentity: (identity) => {
        if (this.options.persist !== false && !request.identity && !loadIdentity(identityName)) saveIdentity(identity, identityName);
      },
      onAudio: (pcm) => this.playback(id, pcm),
      onEvent: (event, before) => this.onSessionEvent(session, event, before),
    });
    this.sessions.set(id, session);
    this.extras.set(id, {
      request,
      appliedVolumes: new Map(),
      policyKey: "",
      lastClientInfo: null,
      lastServerInfo: 0,
      clientInfoDenied: false,
      serverInfoDenied: false,
    });
    this.store.setState((s) => ({ sessionIds: [...s.sessionIds, id], activeId: id }));
    this.ensurePolling();
    return session;
  }

  /** Starts a fresh connector for a session that ended (§9.1). */
  reconnect(id: string): void {
    const session = this.sessions.get(id);
    const extras = this.extras.get(id);
    if (!session || !extras) return;
    const connector = this.createConnector(extras.request);
    if (!connector) return;
    extras.appliedVolumes.clear();
    extras.policyKey = "";
    extras.clientInfoDenied = false;
    extras.serverInfoDenied = false;
    void session.disconnect().catch(() => {});
    session.attach(connector);
  }

  private onSessionEvent(session: Session, event: ConnectorEvent, before: SessionState): void {
    const state = session.store.getState();
    const active = session.id === this.state.activeId;
    switch (event.type) {
      case "connected":
        session.publishMute(this.state.micMuted, this.state.speakerMuted);
        this.syncCapture();
        this.playSound("connected");
        break;
      case "disconnected":
        this.syncCapture();
        this.playSound("disconnected");
        this.failDownloads(session.id, "Disconnected");
        break;
      case "channels":
        this.applyVolumes(session);
        this.applyWhisperPolicy(session);
        if (active) this.joinLeaveSounds(before, state);
        break;
      case "poke":
        process.stdout.write("\x07");
        this.playSound("poke");
        this.desktop(`${event.from} poked you`, plainText(event.message) || state.server?.serverName || "");
        break;
      case "privateMessage":
        if (!event.fromSelf) {
          this.playSound("privateMessage");
          this.desktop(`Message from ${event.partnerName}`, plainText(event.message));
        }
        break;
      case "chatMessage": {
        const own = state.snapshot?.clients.find((c) => c.id === state.snapshot?.ownClientId);
        if (active && event.from !== own?.name) this.playSound("channelMessage");
        break;
      }
      case "channelPasswordRequired": {
        const name = state.snapshot?.channels.find((c) => c.id === event.channelId)?.name ?? "";
        this.openDialog({ kind: "channelPassword", sessionId: session.id, channelId: event.channelId, name });
        break;
      }
      case "serverLog": {
        // Labels from the connector's pending-request names (main.rs).
        const extras = this.extras.get(session.id);
        if (event.kind === "permissionError" && extras) {
          if (event.action === "Server connection info") extras.serverInfoDenied = true;
          if (event.action === "Connection info") extras.clientInfoDenied = true;
        }
        break;
      }
      case "fileDownloadChunk":
        this.writeDownloadChunk(session.id, event);
        break;
      case "transferError":
        this.failDownloads(session.id, event.message, event.cid, event.path);
        break;
      case "fileUploadDone":
        this.notify(`Uploaded ${basename(event.path)}`);
        if (state.files?.cid === event.cid) session.listFiles(event.cid, state.files.path);
        break;
      default:
        break;
    }
  }

  /** A sound when someone enters or leaves our channel, but not when we moved ourselves. */
  private joinLeaveSounds(before: SessionState, after: SessionState): void {
    const prev = before.snapshot;
    const next = after.snapshot;
    if (!prev || !next) return;
    const ownBefore = prev.clients.find((c) => c.id === prev.ownClientId)?.channel;
    const ownAfter = next.clients.find((c) => c.id === next.ownClientId)?.channel;
    if (ownBefore === undefined || ownBefore !== ownAfter) return;
    const inChannel = (list: ClientInfo[]) => new Set(list.filter((c) => c.channel === ownAfter && c.id !== next.ownClientId && !c.isQuery).map((c) => c.id));
    const was = inChannel(prev.clients);
    const now = inChannel(next.clients);
    if ([...now].some((id) => !was.has(id))) this.playSound("join");
    else if ([...was].some((id) => !now.has(id))) this.playSound("leave");
  }

  private desktop(title: string, body: string): void {
    const mode = this.state.config.desktopNotifications;
    if (mode === "off" || (mode === "unfocused" && this.state.terminalFocused)) return;
    desktopNotify(title, body);
  }

  setActive(id: string): void {
    if (!this.sessions.has(id) || id === this.state.activeId) return;
    this.releaseAll();
    this.store.setState({ activeId: id });
  }

  async closeSession(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    this.extras.delete(id);
    this.failDownloads(id, "Connection closed");
    this.store.setState((s) => {
      const sessionIds = s.sessionIds.filter((x) => x !== id);
      return { sessionIds, activeId: s.activeId === id ? (sessionIds[sessionIds.length - 1] ?? null) : s.activeId };
    });
    this.syncCapture();
    await session.disconnect("leaving");
  }

  /** Requests connection info for the selected client and the active server (§9.2). */
  private ensurePolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.poll(), 1000);
    this.pollTimer.unref?.();
  }

  poll(): void {
    const session = this.activeSession();
    const extras = session && this.extras.get(session.id);
    if (!session || !extras || !session.connected) return;
    const now = this.now();
    const selection = session.store.getState().selection;
    if (selection?.kind === "client" && !extras.clientInfoDenied) {
      const last = extras.lastClientInfo;
      if (!last || last.clientId !== selection.id || now - last.at >= CLIENT_INFO_INTERVAL_MS) {
        extras.lastClientInfo = { clientId: selection.id, at: now };
        session.requestClientInfo(selection.id);
      }
    }
    if (!extras.serverInfoDenied && now - extras.lastServerInfo >= SERVER_INFO_INTERVAL_MS) {
      extras.lastServerInfo = now;
      session.requestServerInfo();
    }
  }

  // ---- voice, mute and hold keys (§8.2) ----------------------------------------

  toggleMic(): void {
    const micMuted = !this.state.micMuted;
    this.voice.muted = micMuted;
    if (micMuted) this.releaseAll();
    this.store.setState({ micMuted });
    for (const s of this.sessions.values()) s.publishMute(micMuted, this.state.speakerMuted);
    this.syncCapture();
  }

  toggleSpeaker(): void {
    const speakerMuted = !this.state.speakerMuted;
    this.store.setState({ speakerMuted });
    for (const s of this.sessions.values()) s.publishMute(this.state.micMuted, speakerMuted);
  }

  toggleTalk(): void {
    if (this.state.config.talkMode === "vad") {
      this.notify("Toggle to talk is off: talk mode is voice activation (change it in Settings, F2)", "info");
      return;
    }
    this.store.setState({ toggled: this.voice.toggle() });
  }

  setHold(source: string, held: boolean): void {
    this.voice.setHold(source, held);
  }

  /** Whisper while a source holds (§8.3). */
  setWhisperHold(source: string, held: boolean): void {
    const session = this.activeSession();
    if (!session) return;
    if (held) {
      if (session.whisperTargetCount() === 0) {
        this.notify("The whisper list is empty: add people or channels from their menu (right-click)", "info");
        return;
      }
      session.applyWhisper(true);
      this.voice.setHold(`whisper:${source}`, true);
      this.store.setState({ whisperHeld: true });
    } else {
      this.voice.setHold(`whisper:${source}`, false);
      this.store.setState({ whisperHeld: false });
      if (!session.store.getState().whisperLocked) session.applyWhisper(false);
    }
  }

  /** The `[Whisper n]` button: a short press locks or unlocks, a long one is a hold (§8.3). */
  whisperButtonPress(): void {
    this.whisperPressAt = this.now();
    this.setWhisperHold("mouse", true);
  }

  whisperButtonRelease(): void {
    const short = this.now() - this.whisperPressAt < WHISPER_CLICK_MS;
    const session = this.activeSession();
    if (short && session && session.whisperTargetCount() > 0) {
      this.voice.setHold("whisper:mouse", false);
      this.store.setState({ whisperHeld: false });
      session.setWhisperLocked(!session.store.getState().whisperLocked);
      return;
    }
    this.setWhisperHold("mouse", false);
  }

  /** A configured hold key from the stdin tap. */
  holdKey(key: HoldKeyName, action: KeyAction): void {
    if (action === "repeat") return;
    const { pttKey, whisperKey } = this.state.config;
    if (key !== pttKey && key !== whisperKey) {
      if (action === "press" && !this.state.dialog) {
        if (key === "f1") this.openDialog({ kind: "help" });
        else if (key === "f2") this.openDialog({ kind: "settings" });
      }
      return;
    }
    const apply = (held: boolean) => {
      if (key === pttKey) this.setHold("key", held);
      if (key === whisperKey) this.setWhisperHold("key", held);
    };
    if (this.state.kittyKeys) {
      apply(action === "press");
      return;
    }
    // No key releases from this terminal: each press toggles (§8.2).
    if (action !== "press") return;
    const latched = !this.latchedKeys.has(key);
    if (latched) this.latchedKeys.add(key);
    else this.latchedKeys.delete(key);
    apply(latched);
  }

  kittyDetected(): void {
    this.store.setState({ kittyKeys: true });
  }

  /** Drops every hold, latch and toggle (focus loss, server switch, mute). */
  releaseAll(): void {
    this.voice.releaseAll();
    this.latchedKeys.clear();
    const session = this.activeSession();
    if (this.state.whisperHeld && session && !session.store.getState().whisperLocked) session.applyWhisper(false);
    this.store.setState({ toggled: false, whisperHeld: false });
  }

  terminalFocus(focused: boolean): void {
    this.store.setState({ terminalFocused: focused });
    if (!focused) this.releaseAll();
  }

  // ---- whisper policy (§8.3) and volumes (§8.4) ------------------------------------

  private applyWhisperPolicy(session: Session): void {
    const extras = this.extras.get(session.id);
    const snapshot = session.store.getState().snapshot;
    if (!extras || !snapshot) return;
    const { blockWhispers, whisperExceptions } = this.state.config;
    const uids = new Set(whisperExceptions);
    const ids = snapshot.clients.filter((c) => uids.has(c.uid)).map((c) => c.id).sort((a, b) => a - b);
    const key = `${blockWhispers}:${ids.join(",")}`;
    if (key === extras.policyKey) return;
    extras.policyKey = key;
    session.setWhisperPolicy(blockWhispers, ids);
  }

  isWhisperException(uid: string): boolean {
    return this.state.config.whisperExceptions.includes(uid);
  }

  toggleWhisperException(uid: string): void {
    const list = this.state.config.whisperExceptions;
    this.setConfig({ whisperExceptions: list.includes(uid) ? list.filter((u) => u !== uid) : [...list, uid] });
    for (const s of this.sessions.values()) this.applyWhisperPolicy(s);
  }

  setBlockWhispers(block: boolean): void {
    this.setConfig({ blockWhispers: block });
    for (const s of this.sessions.values()) this.applyWhisperPolicy(s);
  }

  volumeOf(uid: string): number {
    return this.state.config.volumes[uid] ?? 1;
  }

  private applyVolumes(session: Session): void {
    const extras = this.extras.get(session.id);
    const snapshot = session.store.getState().snapshot;
    if (!extras || !snapshot) return;
    const present = new Set<number>();
    for (const c of snapshot.clients) {
      present.add(c.id);
      if (c.id === snapshot.ownClientId) continue;
      const volume = this.volumeOf(c.uid);
      const applied = extras.appliedVolumes.get(c.id) ?? 1;
      if (volume !== applied) {
        session.setClientVolume(c.id, volume);
        extras.appliedVolumes.set(c.id, volume);
      }
    }
    for (const id of extras.appliedVolumes.keys()) if (!present.has(id)) extras.appliedVolumes.delete(id);
  }

  /** Stores a volume by UID and applies it on every server where that person is (§8.4). */
  setVolume(uid: string, volume: number): void {
    const clamped = Math.round(Math.max(0, Math.min(2, volume)) * 100) / 100;
    const volumes = { ...this.state.config.volumes };
    if (clamped === 1) delete volumes[uid];
    else volumes[uid] = clamped;
    this.setConfig({ volumes });
    for (const s of this.sessions.values()) this.applyVolumes(s);
  }

  // ---- files (§9.6) -----------------------------------------------------------------

  private uniqueLocalPath(name: string): string {
    const dir = expandHome(this.state.config.downloadDir);
    mkdirSync(dir, { recursive: true });
    const safe = basename(name).replace(/[\0/]/g, "_") || "download";
    const ext = extname(safe);
    const stem = safe.slice(0, safe.length - ext.length);
    let candidate = join(dir, safe);
    for (let n = 1; existsSync(candidate); n++) candidate = join(dir, `${stem} (${n})${ext}`);
    return candidate;
  }

  download(sessionId: string, cid: number, entry: FileEntry): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (entry.size > MAX_DOWNLOAD_BYTES) {
      this.notify(`${entry.name} is larger than 25 MiB; the connector can't download it`, "error");
      return;
    }
    let localPath: string;
    let fd: number;
    try {
      localPath = this.uniqueLocalPath(entry.name);
      fd = openSync(localPath, "w", 0o644);
    } catch (err) {
      this.notify(`Can't save ${entry.name}: ${(err as Error).message}`, "error");
      return;
    }
    const remote = joinRemote(entry.path, entry.name);
    const transfer = session.startDownload(cid, remote, localPath, entry.size);
    this.downloads.push({ sessionId, transferId: transfer.id, cid, path: remote, localPath, fd });
  }

  private writeDownloadChunk(sessionId: string, event: Extract<ConnectorEvent, { type: "fileDownloadChunk" }>): void {
    const index = this.downloads.findIndex((d) => d.sessionId === sessionId && d.cid === event.cid && d.path === event.path);
    const d = this.downloads[index];
    if (!d) return;
    try {
      const bytes = Buffer.from(event.data, "base64");
      writeSync(d.fd, bytes, 0, bytes.length, event.offset);
    } catch (err) {
      this.sessions.get(sessionId)?.failTransfer(d.transferId, (err as Error).message);
      this.finishDownload(index, true);
      return;
    }
    if (event.done) {
      this.finishDownload(index, false);
      this.notify(`Downloaded ${basename(d.localPath)} to ${this.state.config.downloadDir}`);
    }
  }

  private finishDownload(index: number, removeFile: boolean): void {
    const [d] = this.downloads.splice(index, 1);
    if (!d) return;
    try {
      closeSync(d.fd);
      if (removeFile) unlinkSync(d.localPath);
    } catch {
      // Already gone.
    }
  }

  private failDownloads(sessionId: string, message: string, cid?: number, path?: string): void {
    for (let i = this.downloads.length - 1; i >= 0; i--) {
      const d = this.downloads[i]!;
      if (d.sessionId !== sessionId || (cid !== undefined && (d.cid !== cid || d.path !== path))) continue;
      this.sessions.get(sessionId)?.failTransfer(d.transferId, message);
      this.finishDownload(i, true);
    }
  }

  upload(sessionId: string, cid: number, remoteDir: string, localPath: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const path = expandHome(localPath.trim());
    let data: Buffer;
    try {
      const st = statSync(path);
      if (!st.isFile()) throw new Error("not a regular file");
      if (st.size > MAX_UPLOAD_BYTES) throw new Error("larger than 24 MiB, which the connector refuses");
      data = readFileSync(path);
    } catch (err) {
      this.notify(`Can't upload ${localPath}: ${(err as Error).message}`, "error");
      return;
    }
    session.startUpload(cid, joinRemote(remoteDir, basename(path)), path, data, UPLOAD_CHUNK_BYTES);
  }

  // ---- bookmarks (§9.1) ---------------------------------------------------------------

  saveBookmark(bookmark: Bookmark, index?: number): void {
    const list = [...this.state.bookmarks];
    if (index !== undefined && list[index]) list[index] = bookmark;
    else list.push(bookmark);
    this.store.setState({ bookmarks: list });
    if (this.options.persist !== false) saveBookmarks(list);
  }

  deleteBookmark(index: number): void {
    const list = this.state.bookmarks.filter((_, i) => i !== index);
    this.store.setState({ bookmarks: list });
    if (this.options.persist !== false) saveBookmarks(list);
  }

  connectBookmark(b: Bookmark): void {
    this.connect({
      label: b.name,
      address: b.address,
      nickname: b.nickname || this.state.config.nickname,
      defaultChannel: b.defaultChannel,
      serverPassword: b.serverPassword,
      identityName: b.identity,
    });
  }

  /** The connect request behind a session, for "Add to bookmarks". */
  requestOf(sessionId: string): ConnectRequest | undefined {
    return this.extras.get(sessionId)?.request;
  }

  // ---- config and UI state ----------------------------------------------------------

  setConfig(patch: Partial<Config>): void {
    const config = { ...this.state.config, ...patch };
    this.voice.mode = config.talkMode;
    this.voice.threshold = config.vadThreshold;
    this.voice.hangoverMs = config.vadHangoverMs;
    this.store.setState({ config });
    if (this.options.persist !== false) {
      try {
        saveConfig(config);
      } catch (err) {
        this.notify(`Can't save settings: ${(err as Error).message}`, "error");
      }
    }
  }

  openDialog(dialog: Dialog): void {
    this.store.setState({ dialog });
  }

  closeDialog(): void {
    const dialog = this.state.dialog;
    if (dialog?.kind === "channelPassword") this.session(dialog.sessionId)?.cancelPassword();
    if (dialog?.kind === "files") this.session(dialog.sessionId)?.closeFiles();
    this.store.setState({ dialog: null });
  }

  setFocus(focus: Focus): void {
    if (this.state.focus !== focus) this.store.setState({ focus });
  }

  notify(text: string, kind: "info" | "error" = "info"): void {
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.store.setState({ notice: { text, kind } });
    this.noticeTimer = setTimeout(() => this.store.setState({ notice: null }), kind === "error" ? 10_000 : 4_000);
    this.noticeTimer.unref?.();
  }

  /** Disconnects everything; resolves when the helpers are gone or timed out (§5.4). */
  async shutdown(): Promise<void> {
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    for (let i = this.downloads.length - 1; i >= 0; i--) this.finishDownload(i, true);
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    this.audio?.stop();
    await Promise.all(sessions.map((s) => s.disconnect("tuimspeak closed").catch(() => {})));
  }
}

/** Joins a remote directory and a name with exactly one slash. */
export function joinRemote(dir: string, name: string): string {
  const base = dir.endsWith("/") ? dir : `${dir}/`;
  return `${base.startsWith("/") ? base : `/${base}`}${name.replace(/^\/+/, "")}`;
}
