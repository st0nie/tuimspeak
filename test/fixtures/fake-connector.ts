import { EventEmitter } from "node:events";
import type { ConnectorLike } from "../../src/connector/process.ts";
import type { ChannelInfo, ClientInfo, ConnectorEvent, Snapshot } from "../../src/connector/protocol.ts";

/** Records every command and lets a test push connector events (§3). */
export class FakeConnector extends EventEmitter implements ConnectorLike {
  sent: string[] = [];
  disconnected = false;

  send(line: string): void {
    this.sent.push(line);
  }

  async disconnect(): Promise<void> {
    this.disconnected = true;
  }

  push(event: ConnectorEvent): void {
    this.emit("event", event);
  }

  /** Commands starting with `prefix`, then forgets everything recorded. */
  take(prefix?: string): string[] {
    const out = prefix ? this.sent.filter((l) => l.startsWith(prefix)) : this.sent;
    this.sent = [];
    return out;
  }
}

export const channel = (id: number, parent: number, order: number, name: string, extra: Partial<ChannelInfo> = {}): ChannelInfo => ({
  id, parent, order, name, topic: "", codec: "OpusVoice", maxClients: null, hasPassword: false, ...extra,
});

export const client = (id: number, ch: number, name: string, extra: Partial<ClientInfo> = {}): ClientInfo => ({
  id, channel: ch, name, inputMuted: false, outputMuted: false, inputHardwareEnabled: true, away: false, awayMessage: "",
  isChannelCommander: false, country: "", uid: `uid-${id}`, databaseId: id * 10, channelGroup: 8, serverGroups: [7],
  hasTalkPower: true, isQuery: false, isStreaming: false, avatarHash: "", ...extra,
});

export function snapshot(clients: ClientInfo[], ownClientId = 1): { type: "channels" } & Snapshot {
  return {
    type: "channels",
    channels: [channel(1, 0, 0, "Lobby"), channel(2, 0, 1, "Gaming"), channel(3, 0, 2, "Secret", { hasPassword: true })],
    clients,
    ownClientId,
    serverMaxClients: 32,
    serverClientsOnline: clients.length,
    serverChannelsOnline: 3,
  };
}
