import type { ConnectorLike } from "../connector/process.ts";
import type { ConnectorEvent } from "../connector/protocol.ts";
import { commands, hasContent } from "../connector/commands.ts";
import {
  appendLine,
  createSessionStore,
  line,
  reduce,
  type SessionStore,
  type Selection,
  type TabId,
  type Transfer,
  type WhisperTargets,
} from "../state/session.ts";
import { log } from "../log.ts";

export interface SessionOptions {
  id: string;
  label: string;
  address: string;
  connector: ConnectorLike;
  /** Called with the connector's identity on connect, to persist it (§10.2). */
  onIdentity?: (identity: string) => void;
  /** Playback audio from this session (only routed for the active one, §8.1). */
  onAudio?: (pcm: Buffer) => void;
  /** Every non-audio event, after it has been reduced into the store. */
  onEvent?: (event: ConnectorEvent, before: ReturnType<SessionStore["getState"]>) => void;
}

let nextTransferId = 1;

/** One server connection: a connector plus the state reduced from its events (§5.2). */
export class Session {
  readonly id: string;
  readonly store: SessionStore;
  private connector: ConnectorLike;
  /** Bumped on every attach, so events from a replaced connector are ignored. */
  private generation = 0;

  constructor(private readonly options: SessionOptions) {
    this.id = options.id;
    this.connector = options.connector;
    this.store = createSessionStore(options.id, options.label, options.address);
    this.listen(this.connector);
  }

  private listen(connector: ConnectorLike): void {
    const generation = ++this.generation;
    connector.on("event", (event) => {
      if (generation === this.generation) this.handle(event);
    });
    connector.on("exit", (code) => {
      if (generation !== this.generation) return;
      const state = this.store.getState();
      if (state.status !== "disconnected") {
        const event: ConnectorEvent = { type: "disconnected", reason: code === null ? "connector failed" : `connector exited (${code})` };
        this.store.setState(reduce(state, event));
        this.options.onEvent?.(event, state);
      }
    });
  }

  /** Replaces a finished connector with a new one for the same server (§9.1). */
  attach(connector: ConnectorLike): void {
    this.connector = connector;
    this.store.setState((s) => ({
      status: "connecting",
      statusText: `Connecting to ${s.address}...`,
      talkers: [],
      whisperers: [],
      whisperLocked: false,
      ...appendLine(s, "server", line("system", "Reconnecting...")),
    }));
    this.listen(connector);
  }

  private handle(event: ConnectorEvent): void {
    if (event.type === "audioOut") {
      this.options.onAudio?.(Buffer.from(event.pcm, "base64"));
      return;
    }
    if (event.type === "connected" && event.identity) this.options.onIdentity?.(event.identity);
    if (event.type === "error" || event.type === "transferError") log.info(`[${this.id}] connector error: ${event.message}`);
    const before = this.store.getState();
    this.store.setState((s) => reduce(s, event));
    this.options.onEvent?.(event, before);
  }

  private send(line: string): void {
    this.connector.send(line);
  }

  private note(text: string, kind: "system" | "error" = "system"): void {
    this.store.setState((s) => appendLine(s, "server", line(kind, text)));
  }

  private clientName(clientId: number): string {
    return this.store.getState().snapshot?.clients.find((c) => c.id === clientId)?.name ?? `#${clientId}`;
  }

  get ownClientId(): number | undefined {
    return this.store.getState().snapshot?.ownClientId;
  }

  get connected(): boolean {
    return this.store.getState().status === "connected";
  }

  // ---- basics (§9.1) ------------------------------------------------------

  joinChannel(channelId: number, password?: string): void {
    this.store.setState({ passwordChannel: null });
    this.send(commands.switchChannel(channelId, password));
  }

  /** Sends text to a chat tab. Channel and server messages are echoed back by the server. */
  sendText(tab: TabId, text: string): void {
    if (!hasContent(text)) return;
    if (tab === "channel") this.send(commands.chat(text));
    else if (tab === "server") this.send(commands.serverChat(text));
    else this.send(commands.privateMessage(Number(tab.slice(3)), text));
  }

  openPrivateChat(clientId: number): void {
    const s = this.store.getState();
    const client = s.snapshot?.clients.find((c) => c.id === clientId);
    if (!client || clientId === s.snapshot?.ownClientId) return;
    const id: TabId = `pm:${clientId}`;
    if (!s.tabs.some((t) => t.id === id)) {
      this.store.setState({ tabs: [...s.tabs, { id, title: client.name, lines: [], unread: 0, partnerId: clientId }] });
    }
    this.selectTab(id);
  }

  poke(clientId: number, message: string): void {
    this.send(commands.poke(clientId, message));
    this.note(`You poked ${this.clientName(clientId)}${message ? `: ${message}` : ""}`);
  }

  setAway(message: string | null): void {
    if (message === null) this.send(commands.unaway());
    else this.send(commands.away(message));
    this.store.setState({ away: message !== null, awayMessage: message ?? "" });
  }

  setNickname(name: string): void {
    if (hasContent(name)) this.send(commands.nickname(name));
  }

  publishMute(input: boolean, output: boolean): void {
    this.send(commands.muteInput(input));
    this.send(commands.muteOutput(output));
  }

  sendAudio(frame: Buffer): void {
    this.send(commands.audio(frame));
  }

  setSelfTalking(talking: boolean): void {
    if (this.store.getState().selfTalking !== talking) this.store.setState({ selfTalking: talking });
  }

  // ---- whisper (§8.3) -----------------------------------------------------

  isWhisperTarget(kind: "channel" | "client", id: number): boolean {
    const t = this.store.getState().whisperTargets;
    return (kind === "channel" ? t.channels : t.clients).includes(id);
  }

  toggleWhisperTarget(kind: "channel" | "client", id: number): void {
    this.store.setState((s) => {
      const list = kind === "channel" ? s.whisperTargets.channels : s.whisperTargets.clients;
      const next = list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
      const whisperTargets: WhisperTargets = kind === "channel" ? { ...s.whisperTargets, channels: next } : { ...s.whisperTargets, clients: next };
      return { whisperTargets };
    });
    this.syncWhisperLock();
  }

  clearWhisperTargets(): void {
    this.store.setState({ whisperTargets: { channels: [], clients: [] } });
    this.syncWhisperLock();
  }

  /** Sends the current list (`whisper`) or clears it (`unwhisper`). */
  applyWhisper(on: boolean): void {
    const t = this.store.getState().whisperTargets;
    this.send(on ? commands.whisper(t.channels, t.clients) : commands.whisper([], []));
  }

  setWhisperLocked(locked: boolean): void {
    const hasTargets = this.whisperTargetCount() > 0;
    this.store.setState({ whisperLocked: locked && hasTargets });
    this.applyWhisper(locked && hasTargets);
  }

  whisperTargetCount(): number {
    const t = this.store.getState().whisperTargets;
    return t.channels.length + t.clients.length;
  }

  /** A locked whisper follows list edits; an emptied list unlocks. */
  private syncWhisperLock(): void {
    if (!this.store.getState().whisperLocked) return;
    if (this.whisperTargetCount() === 0) this.setWhisperLocked(false);
    else this.applyWhisper(true);
  }

  setWhisperPolicy(block: boolean, exceptionClientIds: number[]): void {
    this.send(commands.whisperPolicy(block, exceptionClientIds));
  }

  // ---- volume (§8.4) and connection info (§9.2) ----------------------------

  setClientVolume(clientId: number, factor: number): void {
    this.send(commands.clientVolume(clientId, Math.max(0, Math.min(2, factor))));
  }

  requestClientInfo(clientId: number): void {
    this.send(commands.clientConnInfo(clientId));
  }

  requestServerInfo(): void {
    this.send(commands.serverConnInfo());
  }

  // ---- moderation (§9.3) --------------------------------------------------

  moveClient(clientId: number, channelId: number, password?: string): void {
    if (clientId === this.ownClientId) {
      this.joinChannel(channelId, password);
      return;
    }
    this.send(commands.moveClient(clientId, channelId, password));
  }

  kickFromChannel(clientId: number, reason: string): void {
    this.send(commands.kickFromChannel(clientId, reason));
  }

  kickFromServer(clientId: number, reason: string): void {
    this.send(commands.kickFromServer(clientId, reason));
  }

  ban(clientId: number, seconds: number, reason: string): void {
    this.send(commands.ban(clientId, seconds, reason));
  }

  requestBans(): void {
    this.store.setState({ bans: null });
    this.send(commands.banList());
  }

  deleteBan(banId: number): void {
    this.send(commands.banDelete(banId));
    this.store.setState((s) => ({ bans: s.bans?.filter((b) => b.banId !== banId) ?? null }));
  }

  deleteAllBans(): void {
    this.send(commands.banDeleteAll());
    this.store.setState({ bans: [] });
  }

  requestComplaints(): void {
    this.store.setState({ complaints: null });
    this.send(commands.complainList());
  }

  deleteComplaint(targetDbId: number, fromDbId: number): void {
    this.send(commands.complainDelete(targetDbId, fromDbId));
    this.store.setState((s) => ({
      complaints: s.complaints?.filter((c) => !(c.targetClientDbId === targetDbId && c.fromClientDbId === fromDbId)) ?? null,
    }));
  }

  editServer(changes: { name?: string; welcomeMessage?: string; password?: string; maxClients?: number }): void {
    this.send(commands.serverEdit(changes));
  }

  serverQueryLogin(user: string, password: string): void {
    this.send(commands.serverQueryLogin(user, password));
  }

  // ---- groups (§9.4) -------------------------------------------------------

  requestServerGroups(): void {
    this.send(commands.serverGroupList());
  }

  setServerGroup(groupId: number, clientDbId: number, member: boolean): void {
    this.send(member ? commands.addServerGroup(groupId, clientDbId) : commands.removeServerGroup(groupId, clientDbId));
  }

  requestChannelGroups(): void {
    this.send(commands.channelGroupList());
  }

  setChannelGroup(groupId: number, channelId: number, clientDbId: number): void {
    this.send(commands.setChannelGroup(groupId, channelId, clientDbId));
  }

  // ---- offline messages (§9.5) --------------------------------------------

  requestOfflineMessages(): void {
    this.store.setState({ offlineMessages: null, offlineMessage: null });
    this.send(commands.messageList());
  }

  readOfflineMessage(id: number): void {
    this.send(commands.messageGet(id));
    this.send(commands.messageMarkRead(id));
  }

  closeOfflineMessage(): void {
    this.store.setState({ offlineMessage: null });
  }

  deleteOfflineMessage(id: number): void {
    this.send(commands.messageDelete(id));
    this.store.setState((s) => ({
      offlineMessages: s.offlineMessages?.filter((m) => m.messageId !== id) ?? null,
      offlineMessage: s.offlineMessage?.messageId === id ? null : s.offlineMessage,
    }));
  }

  sendOfflineMessage(uid: string, subject: string, text: string): void {
    this.send(commands.messageAdd(uid, subject, text));
    this.note(`Offline message "${subject}" sent`);
  }

  // ---- files (§9.6) ---------------------------------------------------------

  listFiles(channelId: number, path: string): void {
    this.send(commands.fileList(channelId, path));
  }

  closeFiles(): void {
    this.store.setState({ files: null });
  }

  makeDirectory(channelId: number, path: string): void {
    this.send(commands.fileMkdir(channelId, path));
  }

  deleteFile(channelId: number, path: string): void {
    this.send(commands.fileDelete(channelId, path));
  }

  renameFile(channelId: number, from: string, to: string): void {
    this.send(commands.fileRename(channelId, from, to));
  }

  /** Starts a download; chunks arrive as `fileDownloadChunk` events. */
  startDownload(channelId: number, path: string, localPath: string, size: number): Transfer {
    const transfer: Transfer = { id: nextTransferId++, kind: "download", cid: channelId, path, localPath, size, done: 0, state: "active" };
    this.store.setState((s) => ({ transfers: [...s.transfers, transfer] }));
    this.send(commands.fileDownload(channelId, path));
    return transfer;
  }

  /** Sends a whole upload as ordered pieces; the connector answers `fileUploadDone`. */
  startUpload(channelId: number, path: string, localPath: string, data: Uint8Array, chunkBytes: number): Transfer {
    const transfer: Transfer = { id: nextTransferId++, kind: "upload", cid: channelId, path, localPath, size: data.byteLength, done: 0, state: "active" };
    this.store.setState((s) => ({ transfers: [...s.transfers, transfer] }));
    for (let offset = 0; offset < data.byteLength || offset === 0; offset += chunkBytes) {
      const piece = data.subarray(offset, Math.min(data.byteLength, offset + chunkBytes));
      this.send(commands.fileUploadChunk(channelId, path, offset, data.byteLength, piece));
      if (data.byteLength === 0) break;
    }
    return transfer;
  }

  failTransfer(id: number, message: string): void {
    this.store.setState((s) => ({ transfers: s.transfers.map((t) => (t.id === id ? { ...t, state: "error", message } : t)) }));
  }

  clearFinishedTransfers(): void {
    this.store.setState((s) => ({ transfers: s.transfers.filter((t) => t.state === "active") }));
  }

  // ---- UI-only state --------------------------------------------------------

  selectTab(tab: TabId): void {
    this.store.setState((s) => ({
      activeTab: tab,
      tabs: s.tabs.map((t) => (t.id === tab ? { ...t, unread: 0 } : t)),
    }));
  }

  closeTab(tab: TabId): void {
    if (!tab.startsWith("pm:")) return;
    this.store.setState((s) => ({
      tabs: s.tabs.filter((t) => t.id !== tab),
      activeTab: s.activeTab === tab ? "channel" : s.activeTab,
    }));
  }

  select(selection: Selection | null): void {
    this.store.setState({ selection });
  }

  toggleCollapsed(channelId: number, collapsed?: boolean): void {
    this.store.setState((s) => {
      const next = { ...s.collapsed };
      const shouldCollapse = collapsed ?? !next[channelId];
      if (shouldCollapse) next[channelId] = true;
      else delete next[channelId];
      return { collapsed: next };
    });
  }

  setFilter(filter: string | null): void {
    this.store.setState({ filter });
  }

  dismissPoke(): void {
    this.store.setState({ poke: null });
  }

  cancelPassword(): void {
    this.store.setState({ passwordChannel: null });
  }

  disconnect(message = ""): Promise<void> {
    return this.connector.disconnect(message);
  }
}
