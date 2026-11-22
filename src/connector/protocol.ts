/**
 * The ts-connector stdout protocol: one JSON object per line, snake_case
 * fields. `parseEvent` turns a line into a camelCase `ConnectorEvent`, or
 * `null` for event types we do not handle, so new upstream events never
 * break us. Field names follow native/webspeak3/connector/src/main.rs.
 */

export interface ChannelInfo {
  id: number;
  parent: number;
  /** Already resolved by the connector into a sortable index among siblings. */
  order: number;
  name: string;
  topic: string;
  codec: string;
  maxClients: number | null;
  hasPassword: boolean;
}

export interface ClientInfo {
  id: number;
  channel: number;
  name: string;
  inputMuted: boolean;
  outputMuted: boolean;
  inputHardwareEnabled: boolean;
  away: boolean;
  awayMessage: string;
  isChannelCommander: boolean;
  country: string;
  uid: string;
  databaseId: number;
  channelGroup: number;
  serverGroups: number[];
  hasTalkPower: boolean;
  isQuery: boolean;
  isStreaming: boolean;
  avatarHash: string;
}

export type ServerLogEntry =
  | { kind: "clientJoin"; client: string; channel: string }
  | { kind: "clientLeave"; client: string }
  | { kind: "clientChannelSwitch"; client: string; fromChannel: string; toChannel: string }
  | { kind: "clientChannelGroupAssigned"; client: string; group: string }
  | { kind: "channelCreated"; channel: string }
  | { kind: "channelDeleted"; channel: string }
  | { kind: "channelEdited"; channel: string }
  | { kind: "serverEdited" }
  | { kind: "permissionError"; action: string };

export interface ConnectedInfo {
  welcomeMessage: string;
  serverName: string;
  serverMaxClients: number;
  serverVersion: string;
  serverBannerUrl: string;
  /** Persist this and pass it back as TS_IDENTITY to keep the same client UID. */
  identity: string;
}

export interface Snapshot {
  channels: ChannelInfo[];
  clients: ClientInfo[];
  ownClientId: number;
  serverMaxClients: number;
  serverClientsOnline: number;
  serverChannelsOnline: number;
}

export interface ClientConnectionInfo {
  clientId: number;
  pingMs: number | null;
  connectedSecs: number | null;
  ip: string | null;
  packetsSent: number;
  bytesSent: number;
  packetsReceived: number;
  bytesReceived: number;
  packetLossPercent: number;
}

export interface ServerConnectionInfo {
  pingMs: number;
  connectedSecs: number;
  packetLossPercent: number;
  bytesSentTotal: number;
  bytesReceivedTotal: number;
  bandwidthSentLastSecond: number;
  bandwidthReceivedLastSecond: number;
}

export interface BanEntry {
  banId: number;
  ip: string;
  name: string;
  uid: string;
  lastNickname: string;
  created: string;
  durationSecs: number;
  invokerName: string;
  reason: string;
  enforcements: number;
}

export interface ComplaintEntry {
  targetClientDbId: number;
  targetName: string;
  fromClientDbId: number;
  fromName: string;
  message: string;
  timestamp: string;
}

export interface GroupEntry {
  id: number;
  name: string;
}

export interface OfflineMessageEntry {
  messageId: number;
  clientUid: string;
  subject: string;
  timestamp: string;
  isRead: boolean;
}

export interface FileEntry {
  path: string;
  name: string;
  size: number;
  isFile: boolean;
  timestamp: string;
}

export type ConnectorEvent =
  | ({ type: "connected" } & ConnectedInfo)
  | ({ type: "channels" } & Snapshot)
  | { type: "chatMessage"; from: string; message: string }
  | { type: "serverMessage"; from: string; message: string }
  | { type: "privateMessage"; partnerId: number; partnerName: string; fromSelf: boolean; message: string }
  | { type: "poke"; from: string; message: string }
  /** Base64 s16le stereo interleaved 48 kHz, 960 frames. Only sent while someone talks. */
  | { type: "audioOut"; pcm: string }
  /** Other clients currently talking. */
  | { type: "talkers"; clients: number[] }
  | { type: "whisperReceived"; clientId: number }
  | { type: "disconnected"; reason: string }
  | { type: "reconnecting"; reason: string }
  | { type: "reconnected" }
  | { type: "error"; message: string }
  /** A file transfer failed (an `error` carrying `cid` and `path`), §9.6. */
  | { type: "transferError"; message: string; cid: number; path: string }
  | ({ type: "clientConnectionInfo" } & ClientConnectionInfo)
  | ({ type: "serverConnectionInfo" } & ServerConnectionInfo)
  | { type: "banList"; entries: BanEntry[] }
  | { type: "complainList"; entries: ComplaintEntry[] }
  | { type: "serverGroupList"; entries: GroupEntry[] }
  | { type: "channelGroupList"; entries: GroupEntry[] }
  | { type: "offlineMessageList"; entries: OfflineMessageEntry[] }
  | { type: "offlineMessage"; messageId: number; clientUid: string; subject: string; message: string; timestamp: string }
  | { type: "fileList"; cid: number; path: string; entries: FileEntry[] }
  /** Base64 piece of a download at `offset`; `done` on the last one. */
  | { type: "fileDownloadChunk"; cid: number; path: string; offset: number; data: string; done: boolean }
  | { type: "fileUploadDone"; cid: number; path: string }
  | { type: "channelPasswordRequired"; channelId: number }
  | ({ type: "serverLog" } & ServerLogEntry);

type Raw = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const bool = (v: unknown): boolean => v === true;
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * The connector writes top-level fields in snake_case and list entries in
 * camelCase (§3.3). Read either spelling so a change upstream does not break us.
 */
function field(raw: Raw, snake: string): unknown {
  if (snake in raw) return raw[snake];
  const camel = snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  return raw[camel];
}

function entries<T>(raw: Raw, map: (entry: Raw) => T): T[] {
  return Array.isArray(raw.entries) ? (raw.entries as unknown[]).filter((e): e is Raw => !!e && typeof e === "object").map(map) : [];
}

function parseChannel(c: Raw): ChannelInfo {
  return {
    id: num(c.id),
    parent: num(c.parent),
    order: num(c.order),
    name: str(c.name),
    topic: str(c.topic),
    codec: str(c.codec),
    maxClients: typeof c.max_clients === "number" ? c.max_clients : null,
    hasPassword: bool(c.has_password),
  };
}

function parseClient(c: Raw): ClientInfo {
  return {
    id: num(c.id),
    channel: num(c.channel),
    name: str(c.name),
    inputMuted: bool(c.input_muted),
    outputMuted: bool(c.output_muted),
    inputHardwareEnabled: c.input_hardware_enabled !== false,
    away: bool(c.away),
    awayMessage: str(c.away_message),
    isChannelCommander: bool(c.is_channel_commander),
    country: str(c.country),
    uid: str(c.uid),
    databaseId: num(c.database_id),
    channelGroup: num(c.channel_group),
    serverGroups: Array.isArray(c.server_groups) ? c.server_groups.filter((g): g is number => typeof g === "number") : [],
    hasTalkPower: c.has_talk_power !== false,
    isQuery: bool(c.is_query),
    isStreaming: bool(c.is_streaming),
    avatarHash: str(c.avatar_hash),
  };
}

const SERVER_LOG_KINDS = new Set([
  "clientJoin",
  "clientLeave",
  "clientChannelSwitch",
  "clientChannelGroupAssigned",
  "channelCreated",
  "channelDeleted",
  "channelEdited",
  "serverEdited",
  "permissionError",
]);

export function parseEvent(line: string): ConnectorEvent | null {
  let raw: Raw;
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== "object") return null;
    raw = parsed as Raw;
  } catch {
    return null;
  }
  switch (raw.type) {
    case "connected":
      return {
        type: "connected",
        welcomeMessage: str(raw.welcome_message),
        serverName: str(raw.server_name),
        serverMaxClients: num(raw.server_max_clients),
        serverVersion: str(raw.server_version),
        serverBannerUrl: str(raw.server_banner_url),
        identity: str(raw.identity),
      };
    case "channels": {
      const channels = Array.isArray(raw.channels) ? (raw.channels as Raw[]).map(parseChannel) : [];
      const clients = Array.isArray(raw.clients) ? (raw.clients as Raw[]).map(parseClient) : [];
      return {
        type: "channels",
        channels,
        clients,
        ownClientId: num(raw.own_client_id),
        serverMaxClients: num(raw.server_max_clients),
        serverClientsOnline: num(raw.server_clients_online, clients.length),
        serverChannelsOnline: num(raw.server_channels_online, channels.length),
      };
    }
    case "chatMessage":
    case "serverMessage":
    case "poke":
      return { type: raw.type, from: str(raw.from), message: str(raw.message) };
    case "privateMessage":
      return {
        type: "privateMessage",
        partnerId: num(raw.partner_id),
        partnerName: str(raw.partner_name),
        fromSelf: bool(raw.from_self),
        message: str(raw.message),
      };
    case "audioOut":
      return { type: "audioOut", pcm: str(raw.pcm) };
    case "talkers":
      return { type: "talkers", clients: Array.isArray(raw.clients) ? raw.clients.filter((c): c is number => typeof c === "number") : [] };
    case "whisperReceived":
      return { type: "whisperReceived", clientId: num(raw.clientId ?? raw.client_id) };
    case "disconnected":
    case "reconnecting":
      return { type: raw.type, reason: str(raw.reason) };
    case "reconnected":
      return { type: "reconnected" };
    case "error":
      if (raw.cid !== undefined && raw.path !== undefined) {
        return { type: "transferError", message: str(raw.message), cid: num(raw.cid), path: str(raw.path) };
      }
      return { type: "error", message: str(raw.message) };
    case "clientConnectionInfo":
      return {
        type: "clientConnectionInfo",
        clientId: num(field(raw, "client_id")),
        pingMs: numOrNull(field(raw, "ping_ms")),
        connectedSecs: numOrNull(field(raw, "connected_secs")),
        ip: typeof field(raw, "ip") === "string" ? str(field(raw, "ip")) : null,
        packetsSent: num(field(raw, "packets_sent")),
        bytesSent: num(field(raw, "bytes_sent")),
        packetsReceived: num(field(raw, "packets_received")),
        bytesReceived: num(field(raw, "bytes_received")),
        packetLossPercent: num(field(raw, "packet_loss_percent")),
      };
    case "serverConnectionInfo":
      return {
        type: "serverConnectionInfo",
        pingMs: num(field(raw, "ping_ms")),
        connectedSecs: num(field(raw, "connected_secs")),
        packetLossPercent: num(field(raw, "packet_loss_percent")),
        bytesSentTotal: num(field(raw, "bytes_sent_total")),
        bytesReceivedTotal: num(field(raw, "bytes_received_total")),
        bandwidthSentLastSecond: num(field(raw, "bandwidth_sent_last_second")),
        bandwidthReceivedLastSecond: num(field(raw, "bandwidth_received_last_second")),
      };
    case "banList":
      return {
        type: "banList",
        entries: entries(raw, (e) => ({
          banId: num(field(e, "ban_id")),
          ip: str(field(e, "ip")),
          name: str(field(e, "name")),
          uid: str(field(e, "uid")),
          lastNickname: str(field(e, "last_nickname")),
          created: str(field(e, "created")),
          durationSecs: num(field(e, "duration_secs")),
          invokerName: str(field(e, "invoker_name")),
          reason: str(field(e, "reason")),
          enforcements: num(field(e, "enforcements")),
        })),
      };
    case "complainList":
      return {
        type: "complainList",
        entries: entries(raw, (e) => ({
          targetClientDbId: num(field(e, "target_client_db_id")),
          targetName: str(field(e, "target_name")),
          fromClientDbId: num(field(e, "from_client_db_id")),
          fromName: str(field(e, "from_name")),
          message: str(field(e, "message")),
          timestamp: str(field(e, "timestamp")),
        })),
      };
    case "serverGroupList":
    case "channelGroupList":
      return { type: raw.type, entries: entries(raw, (e) => ({ id: num(field(e, "id")), name: str(field(e, "name")) })) };
    case "offlineMessageList":
      return {
        type: "offlineMessageList",
        entries: entries(raw, (e) => ({
          messageId: num(field(e, "message_id")),
          clientUid: str(field(e, "client_uid")),
          subject: str(field(e, "subject")),
          timestamp: str(field(e, "timestamp")),
          isRead: bool(field(e, "is_read")),
        })),
      };
    case "offlineMessage":
      return {
        type: "offlineMessage",
        messageId: num(field(raw, "message_id")),
        clientUid: str(field(raw, "client_uid")),
        subject: str(field(raw, "subject")),
        message: str(field(raw, "message")),
        timestamp: str(field(raw, "timestamp")),
      };
    case "fileList":
      return {
        type: "fileList",
        cid: num(raw.cid),
        path: str(raw.path),
        entries: entries(raw, (e) => ({
          path: str(field(e, "path")),
          name: str(field(e, "name")),
          size: num(field(e, "size")),
          isFile: bool(field(e, "is_file")),
          timestamp: str(field(e, "timestamp")),
        })),
      };
    case "fileDownloadChunk":
      return { type: "fileDownloadChunk", cid: num(raw.cid), path: str(raw.path), offset: num(raw.offset), data: str(raw.data), done: bool(raw.done) };
    case "fileUploadDone":
      return { type: "fileUploadDone", cid: num(raw.cid), path: str(raw.path) };
    case "channelPasswordRequired":
      return { type: "channelPasswordRequired", channelId: num(raw.channel_id) };
    case "serverLog": {
      const kind = str(raw.kind);
      if (!SERVER_LOG_KINDS.has(kind)) return null;
      const { type: _type, ...rest } = raw;
      return { type: "serverLog", ...(rest as unknown as ServerLogEntry) };
    }
    default:
      return null;
  }
}
