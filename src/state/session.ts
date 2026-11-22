import { createStore, type StoreApi } from "zustand/vanilla";
import type {
  BanEntry,
  ClientConnectionInfo,
  ComplaintEntry,
  ConnectedInfo,
  ConnectorEvent,
  FileEntry,
  GroupEntry,
  OfflineMessageEntry,
  ServerConnectionInfo,
  ServerLogEntry,
  Snapshot,
} from "../connector/protocol.ts";

export type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "disconnected";

export type ChatLineKind = "message" | "system" | "poke" | "error";

export interface ChatLine {
  id: number;
  time: number;
  kind: ChatLineKind;
  from?: string;
  text: string;
  self?: boolean;
}

export type TabId = "server" | "channel" | `pm:${number}`;

export interface ChatTab {
  id: TabId;
  title: string;
  lines: ChatLine[];
  unread: number;
  /** Private chats only. */
  partnerId?: number;
}

export type Selection = { kind: "server" } | { kind: "channel"; id: number } | { kind: "client"; id: number };

/** §8.3: channels and clients our whisper goes to. */
export interface WhisperTargets {
  channels: number[];
  clients: number[];
}

/** §9.6 */
export interface Transfer {
  id: number;
  kind: "download" | "upload";
  cid: number;
  /** Remote path. */
  path: string;
  localPath: string;
  size: number;
  done: number;
  state: "active" | "done" | "error";
  message?: string;
}

/** How long a repeated whisper from the same person is not logged again (§8.3). */
export const WHISPER_LOG_INTERVAL_MS = 60_000;

export interface SessionState {
  id: string;
  /** Tab label: bookmark name or address until the server name is known. */
  label: string;
  address: string;
  status: ConnectionStatus;
  statusText: string;
  server: Omit<ConnectedInfo, "identity"> | null;
  snapshot: Snapshot | null;
  /** Other clients currently talking. */
  talkers: number[];
  selfTalking: boolean;
  away: boolean;
  awayMessage: string;
  tabs: ChatTab[];
  activeTab: TabId;
  collapsed: Record<number, true>;
  selection: Selection | null;
  /** Set when the server asked for a channel password; drives the password dialog. */
  passwordChannel: number | null;
  /** Latest poke, shown as a banner until dismissed. */
  poke: { from: string; message: string; time: number } | null;
  /** Clients currently whispering to us (§8.3). */
  whisperers: number[];
  whisperLogged: Record<number, number>;
  whisperTargets: WhisperTargets;
  whisperLocked: boolean;
  /** Tree filter text; null while the filter field is closed (§7.2). */
  filter: string | null;
  /** §9.2 */
  clientInfo: Record<number, ClientConnectionInfo>;
  serverInfo: ServerConnectionInfo | null;
  /** Latest answers to list requests; null until requested and answered (§9.3–9.5). */
  bans: BanEntry[] | null;
  complaints: ComplaintEntry[] | null;
  serverGroups: GroupEntry[] | null;
  channelGroups: GroupEntry[] | null;
  offlineMessages: OfflineMessageEntry[] | null;
  offlineMessage: { messageId: number; clientUid: string; subject: string; message: string; timestamp: string } | null;
  /** The directory shown in the file browser (§9.6). */
  files: { cid: number; path: string; entries: FileEntry[] } | null;
  transfers: Transfer[];
}

export type SessionStore = StoreApi<SessionState>;

export const MAX_LINES = 1000;
let nextLineId = 1;

export function createSessionStore(id: string, label: string, address: string): SessionStore {
  return createStore<SessionState>(() => ({
    id,
    label,
    address,
    status: "connecting",
    statusText: `Connecting to ${address}...`,
    server: null,
    snapshot: null,
    talkers: [],
    selfTalking: false,
    away: false,
    awayMessage: "",
    tabs: [
      { id: "server", title: "Server", lines: [], unread: 0 },
      { id: "channel", title: "Channel", lines: [], unread: 0 },
    ],
    activeTab: "server",
    collapsed: {},
    selection: null,
    passwordChannel: null,
    poke: null,
    whisperers: [],
    whisperLogged: {},
    whisperTargets: { channels: [], clients: [] },
    whisperLocked: false,
    filter: null,
    clientInfo: {},
    serverInfo: null,
    bans: null,
    complaints: null,
    serverGroups: null,
    channelGroups: null,
    offlineMessages: null,
    offlineMessage: null,
    files: null,
    transfers: [],
  }));
}

export function line(kind: ChatLineKind, text: string, extra: Partial<ChatLine> = {}, now = Date.now()): ChatLine {
  return { id: nextLineId++, time: now, kind, text, ...extra };
}

/** Appends a line to a tab (creating a private tab on demand) and tracks unread counts. */
export function appendLine(state: SessionState, tabId: TabId, entry: ChatLine, title?: string): Pick<SessionState, "tabs"> {
  let tabs = state.tabs;
  if (!tabs.some((t) => t.id === tabId)) {
    const partnerId = tabId.startsWith("pm:") ? Number(tabId.slice(3)) : undefined;
    tabs = [...tabs, { id: tabId, title: title ?? tabId, lines: [], unread: 0, partnerId }];
  }
  return {
    tabs: tabs.map((t) => {
      if (t.id !== tabId) return t;
      const lines = t.lines.length >= MAX_LINES ? [...t.lines.slice(t.lines.length - MAX_LINES + 1), entry] : [...t.lines, entry];
      const unread = state.activeTab === tabId || entry.self ? t.unread : t.unread + 1;
      return { ...t, lines, unread, title: title ?? t.title };
    }),
  };
}

export function serverLogText(entry: ServerLogEntry): string {
  switch (entry.kind) {
    case "clientJoin":
      return `${entry.client} connected to ${entry.channel}`;
    case "clientLeave":
      return `${entry.client} disconnected`;
    case "clientChannelSwitch":
      return `${entry.client} switched from ${entry.fromChannel} to ${entry.toChannel}`;
    case "clientChannelGroupAssigned":
      return `${entry.client} was assigned channel group ${entry.group}`;
    case "channelCreated":
      return `Channel ${entry.channel} was created`;
    case "channelDeleted":
      return `Channel ${entry.channel} was deleted`;
    case "channelEdited":
      return `Channel ${entry.channel} was edited`;
    case "serverEdited":
      return "Server settings were changed";
    case "permissionError":
      return `Insufficient permissions: ${entry.action}`;
  }
}

/**
 * Applies one connector event. Pure apart from reading `now`, so it can be
 * tested without a connector. `audioOut` is not state and never comes here.
 */
export function reduce(state: SessionState, event: ConnectorEvent, now = Date.now()): Partial<SessionState> {
  switch (event.type) {
    case "connected": {
      const { identity: _identity, type: _type, ...server } = event;
      const welcome = server.welcomeMessage ? [line("system", server.welcomeMessage, {}, now)] : [];
      let next: Partial<SessionState> = {
        status: "connected",
        statusText: `Connected to ${server.serverName}`,
        server,
        label: server.serverName || state.label,
      };
      for (const l of [line("system", `Connected to ${server.serverName} (${server.serverVersion})`, {}, now), ...welcome]) {
        next = { ...next, ...appendLine({ ...state, ...next }, "server", l) };
      }
      return next;
    }
    case "channels": {
      const { type: _type, ...snapshot } = event;
      const own = snapshot.clients.find((c) => c.id === snapshot.ownClientId);
      const ownChannel = snapshot.channels.find((c) => c.id === own?.channel);
      // Private tabs follow nickname changes of their partner.
      const names = new Map(snapshot.clients.map((c) => [c.id, c.name]));
      const tabs = state.tabs.map((t) => {
        if (t.id === "channel") return ownChannel ? { ...t, title: ownChannel.name } : t;
        if (t.partnerId !== undefined && names.has(t.partnerId)) return { ...t, title: names.get(t.partnerId)! };
        return t;
      });
      // Whisper targets that left the server are dropped.
      const channelIds = new Set(snapshot.channels.map((c) => c.id));
      const targets = state.whisperTargets;
      const whisperTargets =
        targets.channels.every((id) => channelIds.has(id)) && targets.clients.every((id) => names.has(id))
          ? targets
          : { channels: targets.channels.filter((id) => channelIds.has(id)), clients: targets.clients.filter((id) => names.has(id)) };
      return {
        snapshot,
        tabs,
        away: own?.away ?? state.away,
        talkers: state.talkers.filter((id) => names.has(id)),
        whisperers: state.whisperers.filter((id) => names.has(id)),
        whisperTargets,
      };
    }
    case "talkers": {
      // Someone whispering to us stops being a whisperer once they stop talking.
      const talking = new Set(event.clients);
      return { talkers: event.clients, whisperers: state.whisperers.filter((id) => talking.has(id)) };
    }
    case "whisperReceived": {
      const whisperers = state.whisperers.includes(event.clientId) ? state.whisperers : [...state.whisperers, event.clientId];
      const last = state.whisperLogged[event.clientId] ?? -Infinity;
      if (now - last < WHISPER_LOG_INTERVAL_MS) return { whisperers };
      const name = state.snapshot?.clients.find((c) => c.id === event.clientId)?.name ?? `#${event.clientId}`;
      return {
        whisperers,
        whisperLogged: { ...state.whisperLogged, [event.clientId]: now },
        ...appendLine(state, "server", line("system", `${name} is whispering to you`, {}, now)),
      };
    }
    case "chatMessage":
      return appendLine(state, "channel", line("message", event.message, { from: event.from }, now));
    case "serverMessage":
      return appendLine(state, "server", line("message", event.message, { from: event.from }, now));
    case "privateMessage": {
      const own = state.snapshot?.clients.find((c) => c.id === state.snapshot?.ownClientId);
      return appendLine(
        state,
        `pm:${event.partnerId}`,
        line("message", event.message, { from: event.fromSelf ? (own?.name ?? "me") : event.partnerName, self: event.fromSelf }, now),
        event.partnerName,
      );
    }
    case "poke":
      return {
        ...appendLine(state, "server", line("poke", event.message ? `poked you: ${event.message}` : "poked you", { from: event.from }, now)),
        poke: { from: event.from, message: event.message, time: now },
      };
    case "serverLog":
      return appendLine(state, "server", line("system", serverLogText(event), {}, now));
    case "channelPasswordRequired":
      return { passwordChannel: event.channelId };
    case "reconnecting":
      return {
        status: "reconnecting",
        statusText: `Reconnecting: ${event.reason}`,
        ...appendLine(state, "server", line("error", `Connection lost (${event.reason}), reconnecting...`, {}, now)),
      };
    case "reconnected":
      return {
        status: "connected",
        statusText: `Connected to ${state.server?.serverName ?? state.address}`,
        ...appendLine(state, "server", line("system", "Reconnected", {}, now)),
      };
    case "disconnected":
      return {
        status: "disconnected",
        statusText: `Disconnected: ${event.reason}`,
        talkers: [],
        whisperers: [],
        ...appendLine(state, "server", line("error", `Disconnected: ${event.reason}`, {}, now)),
      };
    case "error":
      return appendLine(state, "server", line("error", event.message, {}, now));
    case "transferError":
      return {
        transfers: state.transfers.map((t) =>
          t.cid === event.cid && t.path === event.path && t.state === "active" ? { ...t, state: "error", message: event.message } : t,
        ),
        ...appendLine(state, "server", line("error", event.message, {}, now)),
      };
    case "clientConnectionInfo": {
      const { type: _type, ...info } = event;
      return { clientInfo: { ...state.clientInfo, [info.clientId]: info } };
    }
    case "serverConnectionInfo": {
      const { type: _type, ...info } = event;
      return { serverInfo: info };
    }
    case "banList":
      return { bans: event.entries };
    case "complainList":
      return { complaints: event.entries };
    case "serverGroupList":
      return { serverGroups: event.entries };
    case "channelGroupList":
      return { channelGroups: event.entries };
    case "offlineMessageList":
      return { offlineMessages: event.entries };
    case "offlineMessage": {
      const { type: _type, ...message } = event;
      return {
        offlineMessage: message,
        offlineMessages: state.offlineMessages?.map((m) => (m.messageId === message.messageId ? { ...m, isRead: true } : m)) ?? null,
      };
    }
    case "fileList":
      return { files: { cid: event.cid, path: event.path, entries: event.entries } };
    case "fileDownloadChunk": {
      const bytes = Math.floor((event.data.length * 3) / 4) - (event.data.endsWith("==") ? 2 : event.data.endsWith("=") ? 1 : 0);
      return {
        transfers: state.transfers.map((t) =>
          t.kind === "download" && t.cid === event.cid && t.path === event.path && t.state === "active"
            ? { ...t, done: event.offset + bytes, state: event.done ? "done" : "active" }
            : t,
        ),
      };
    }
    case "fileUploadDone":
      return {
        transfers: state.transfers.map((t) =>
          t.kind === "upload" && t.cid === event.cid && t.path === event.path && t.state === "active" ? { ...t, done: t.size, state: "done" } : t,
        ),
      };
    case "audioOut":
      return {};
  }
}
