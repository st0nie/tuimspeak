import { EventEmitter } from "node:events";
import type { ConnectRequest } from "../app/controller.ts";
import type { ConnectorLike } from "../connector/process.ts";
import type { BanEntry, ChannelInfo, ClientInfo, ConnectorEvent, GroupEntry, OfflineMessageEntry } from "../connector/protocol.ts";

interface DemoFile {
  dir: string;
  name: string;
  isFile: boolean;
  data: Buffer;
}

const SERVER_GROUPS: GroupEntry[] = [
  { id: 6, name: "Server Admin" },
  { id: 7, name: "Normal" },
  { id: 8, name: "Guest" },
  { id: 9, name: "Moderator" },
];
const CHANNEL_GROUPS: GroupEntry[] = [
  { id: 5, name: "Channel Admin" },
  { id: 6, name: "Operator" },
  { id: 8, name: "Guest" },
];
const DEMO_CHUNK = 192 << 10;

const CHANNELS: Array<[id: number, parent: number, name: string, extra?: Partial<ChannelInfo>]> = [
  [1, 0, "[cspacer]Welcome"],
  [2, 0, "Lobby", { topic: "Say hi!" }],
  [3, 0, "Gaming"],
  [4, 3, "Squad A"],
  [5, 3, "Squad B", { maxClients: 4 }],
  [6, 0, "Music", { topic: "[b]Now playing:[/b] lo-fi beats" }],
  [7, 0, "Private", { hasPassword: true }],
  [8, 0, "[*spacer]─"],
  [9, 0, "AFK"],
];

const PEOPLE: Array<[id: number, channel: number, name: string, extra?: Partial<ClientInfo>]> = [
  [2, 2, "alice", { isChannelCommander: true, country: "DE" }],
  [3, 2, "bob", { country: "US" }],
  [4, 4, "carol"],
  [5, 4, "dave", { inputMuted: true }],
  [6, 5, "erin"],
  [7, 6, "MusicBot", { outputMuted: true }],
  [8, 9, "frank", { away: true, awayMessage: "lunch" }],
  [9, 2, "小明", { country: "CN" }],
];

const CHATTER = ["anyone up for a round?", "brb", "lol", "check [url]https://example.com[/url]", "[b]gg[/b]", "我马上回来"];

function channel(id: number, parent: number, name: string, extra: Partial<ChannelInfo> = {}, order = 0): ChannelInfo {
  return { id, parent, order, name, topic: "", codec: "OpusVoice", maxClients: null, hasPassword: false, ...extra };
}

function client(id: number, ch: number, name: string, extra: Partial<ClientInfo> = {}): ClientInfo {
  return {
    id, channel: ch, name, inputMuted: false, outputMuted: false, inputHardwareEnabled: true, away: false, awayMessage: "",
    isChannelCommander: false, country: "", uid: `demo-${id}=`, databaseId: id, channelGroup: 8, serverGroups: [8],
    hasTalkPower: true, isQuery: false, isStreaming: false, avatarHash: "", ...extra,
  };
}

/** A fake server for `--demo`: plausible events, and reactions to our commands. */
class DemoConnector extends EventEmitter implements ConnectorLike {
  private readonly own = 1;
  private channels: ChannelInfo[];
  private clients: ClientInfo[];
  private timers: ReturnType<typeof setInterval | typeof setTimeout>[] = [];
  private closed = false;
  private bans: BanEntry[] = [
    { banId: 1, ip: "203.0.113.7", name: "", uid: "", lastNickname: "spammer", created: "2026-11-01 12:00", durationSecs: 0, invokerName: "alice", reason: "spam", enforcements: 3 },
    { banId: 2, ip: "", name: "", uid: "x9Kd=", lastNickname: "troll", created: "2026-11-20 18:30", durationSecs: 86_400, invokerName: "alice", reason: "trolling", enforcements: 0 },
  ];
  private messages: (OfflineMessageEntry & { message: string })[] = [
    { messageId: 1, clientUid: "demo-2=", subject: "Welcome", timestamp: "2026-11-21 09:00", isRead: false, message: "This is an offline message from alice." },
  ];
  private files = new Map<number, DemoFile[]>([
    [2, [
      { dir: "/", name: "rules.txt", isFile: true, data: Buffer.from("Be nice.\n") },
      { dir: "/", name: "maps", isFile: false, data: Buffer.alloc(0) },
      { dir: "/maps", name: "de_dust2.txt", isFile: true, data: Buffer.alloc(300_000, 65) },
    ]],
  ]);
  private uploads = new Map<string, Buffer[]>();

  constructor(private readonly request: ConnectRequest) {
    super();
    this.channels = CHANNELS.map(([id, parent, name, extra], i) => channel(id, parent, name, extra, i));
    this.clients = [client(this.own, 2, request.nickname), ...PEOPLE.map(([id, ch, name, extra]) => client(id, ch, name, extra))];
    this.later(300, () => {
      this.emitEvent({
        type: "connected",
        welcomeMessage: "Welcome to the [b]tuimspeak demo[/b] server. Nothing here is real.",
        serverName: "tuimspeak demo",
        serverMaxClients: 32,
        serverVersion: "3.13.8 (simulated)",
        serverBannerUrl: "",
        identity: "",
      });
      this.snapshot();
    });
    this.every(1700, () => {
      const speakers = this.clients.filter((c) => c.id !== this.own && !c.inputMuted && !c.away);
      const talking = speakers.filter(() => Math.random() < 0.3).map((c) => c.id);
      this.emitEvent({ type: "talkers", clients: talking });
    });
    this.every(6000, () => {
      const others = this.clients.filter((c) => c.id !== this.own && c.channel === this.ownChannel());
      const who = others[Math.floor(Math.random() * others.length)];
      if (who) this.emitEvent({ type: "chatMessage", from: who.name, message: CHATTER[Math.floor(Math.random() * CHATTER.length)]! });
    });
    this.every(15000, () => {
      const erin = this.clients.find((c) => c.id === 6);
      if (!erin) return;
      const from = this.channels.find((c) => c.id === erin.channel)!.name;
      erin.channel = erin.channel === 5 ? 4 : 5;
      const to = this.channels.find((c) => c.id === erin.channel)!.name;
      this.emitEvent({ type: "serverLog", kind: "clientChannelSwitch", client: erin.name, fromChannel: from, toChannel: to });
      this.snapshot();
    });
    this.later(9000, () => this.emitEvent({ type: "privateMessage", partnerId: 2, partnerName: "alice", fromSelf: false, message: "hey, welcome to the demo!" }));
    // bob whispers now and then (§8.3).
    this.every(20000, () => {
      this.emitEvent({ type: "talkers", clients: [3] });
      this.emitEvent({ type: "whisperReceived", clientId: 3 });
      this.later(1500, () => this.emitEvent({ type: "talkers", clients: [] }));
    });
  }

  private later(ms: number, fn: () => void) {
    this.timers.push(setTimeout(fn, ms));
  }

  private every(ms: number, fn: () => void) {
    this.timers.push(setInterval(fn, ms));
  }

  private emitEvent(event: ConnectorEvent) {
    if (!this.closed) this.emit("event", event);
  }

  private ownChannel(): number {
    return this.clients.find((c) => c.id === this.own)!.channel;
  }

  private me(): ClientInfo {
    return this.clients.find((c) => c.id === this.own)!;
  }

  private snapshot() {
    this.emitEvent({
      type: "channels",
      channels: this.channels,
      clients: this.clients.map((c) => ({ ...c })),
      ownClientId: this.own,
      serverMaxClients: 32,
      serverClientsOnline: this.clients.length,
      serverChannelsOnline: this.channels.length,
    });
  }

  send(line: string): void {
    const [cmd, ...rest] = line.split(/[ \t]/);
    const arg = rest.join(" ");
    const me = this.me();
    switch (cmd) {
      case "switch": {
        const [id, password] = rest;
        const target = this.channels.find((c) => c.id === Number(id));
        if (!target) return;
        if (target.hasPassword && Buffer.from(password ?? "", "base64").toString() !== "demo") {
          this.emitEvent({ type: "error", message: "Invalid channel password (the demo password is \"demo\")" });
          return;
        }
        const from = this.channels.find((c) => c.id === me.channel)!.name;
        me.channel = target.id;
        this.emitEvent({ type: "serverLog", kind: "clientChannelSwitch", client: me.name, fromChannel: from, toChannel: target.name });
        this.snapshot();
        break;
      }
      case "chat":
        this.emitEvent({ type: "chatMessage", from: me.name, message: arg });
        break;
      case "serverchat":
        this.emitEvent({ type: "serverMessage", from: me.name, message: arg });
        break;
      case "pm": {
        const [id, ...msg] = rest;
        const partner = this.clients.find((c) => c.id === Number(id));
        if (!partner) return;
        this.emitEvent({ type: "privateMessage", partnerId: partner.id, partnerName: partner.name, fromSelf: true, message: msg.join(" ") });
        this.later(1200, () => this.emitEvent({ type: "privateMessage", partnerId: partner.id, partnerName: partner.name, fromSelf: false, message: "(this is a simulated reply)" }));
        break;
      }
      case "poke": {
        const partner = this.clients.find((c) => c.id === Number(rest[0]));
        if (partner) this.later(1500, () => this.emitEvent({ type: "poke", from: partner.name, message: "poke back!" }));
        break;
      }
      case "away":
        me.away = true;
        me.awayMessage = arg;
        this.snapshot();
        break;
      case "unaway":
        me.away = false;
        me.awayMessage = "";
        this.snapshot();
        break;
      case "nickname":
        me.name = arg;
        this.snapshot();
        break;
      case "muteinput":
        me.inputMuted = arg === "1";
        this.snapshot();
        break;
      case "muteoutput":
        me.outputMuted = arg === "1";
        this.snapshot();
        break;
      default:
        this.admin(cmd ?? "", rest, line);
    }
  }

  private client(id: number | string | undefined): ClientInfo | undefined {
    return this.clients.find((c) => c.id === Number(id));
  }

  private filesOf(cid: number): DemoFile[] {
    let list = this.files.get(cid);
    if (!list) this.files.set(cid, (list = []));
    return list;
  }

  private listFiles(cid: number, dir: string) {
    const entries = this.filesOf(cid)
      .filter((f) => f.dir === dir)
      .map((f) => ({ path: dir, name: f.name, size: f.data.length, isFile: f.isFile, timestamp: "2026-11-22 10:00" }));
    this.emitEvent({ type: "fileList", cid, path: dir, entries });
  }

  /** Moderation, groups, messages, files and info commands (§9). */
  private admin(cmd: string, rest: string[], line: string) {
    const split = (path: string) => {
      const i = path.lastIndexOf("/");
      return { dir: i <= 0 ? "/" : path.slice(0, i), name: path.slice(i + 1) };
    };
    switch (cmd) {
      case "clientconninfo": {
        const c = this.client(rest[0]);
        if (!c) return;
        this.later(80, () =>
          this.emitEvent({
            type: "clientConnectionInfo", clientId: c.id, pingMs: 20 + c.id * 7, connectedSecs: 600 * c.id, ip: `198.51.100.${c.id}`,
            packetsSent: 1000 * c.id, bytesSent: 90_000 * c.id, packetsReceived: 1100 * c.id, bytesReceived: 120_000 * c.id, packetLossPercent: c.id % 3,
          }),
        );
        break;
      }
      case "serverconninfo":
        this.later(80, () =>
          this.emitEvent({
            type: "serverConnectionInfo", pingMs: 24 + Math.random() * 6, connectedSecs: 86_400 * 3, packetLossPercent: 0.2,
            bytesSentTotal: 5_000_000, bytesReceivedTotal: 9_000_000, bandwidthSentLastSecond: 2400, bandwidthReceivedLastSecond: 5100,
          }),
        );
        break;
      case "moveclient": {
        const c = this.client(rest[0]);
        const target = this.channels.find((ch) => ch.id === Number(rest[1]));
        if (!c || !target) return;
        const from = this.channels.find((ch) => ch.id === c.channel)!.name;
        c.channel = target.id;
        this.emitEvent({ type: "serverLog", kind: "clientChannelSwitch", client: c.name, fromChannel: from, toChannel: target.name });
        this.snapshot();
        break;
      }
      case "kickchannel":
      case "kickserver":
      case "banclient": {
        const c = this.client(rest[0]);
        if (!c) return;
        if (cmd === "kickchannel") c.channel = 2;
        else this.clients = this.clients.filter((x) => x.id !== c.id);
        if (cmd === "banclient") {
          this.bans.push({ banId: this.bans.length + 10, ip: "", name: "", uid: c.uid, lastNickname: c.name, created: "now", durationSecs: Number(rest[1]), invokerName: this.me().name, reason: rest.slice(2).join(" "), enforcements: 0 });
        }
        this.emitEvent(cmd === "kickchannel" ? { type: "serverLog", kind: "clientChannelSwitch", client: c.name, fromChannel: "?", toChannel: "Lobby" } : { type: "serverLog", kind: "clientLeave", client: c.name });
        this.snapshot();
        break;
      }
      case "banlist":
        this.later(80, () => this.emitEvent({ type: "banList", entries: [...this.bans] }));
        break;
      case "bandel":
        this.bans = this.bans.filter((b) => b.banId !== Number(rest[0]));
        break;
      case "bandelall":
        this.bans = [];
        break;
      case "complainlist":
        this.later(80, () =>
          this.emitEvent({ type: "complainList", entries: [{ targetClientDbId: 8, targetName: "frank", fromClientDbId: 3, fromName: "bob", message: "always AFK", timestamp: "2026-11-21 20:00" }] }),
        );
        break;
      case "servergrouplist":
        this.later(80, () => this.emitEvent({ type: "serverGroupList", entries: SERVER_GROUPS }));
        break;
      case "channelgrouplist":
        this.later(80, () => this.emitEvent({ type: "channelGroupList", entries: CHANNEL_GROUPS }));
        break;
      case "addservergroup":
      case "delservergroup": {
        const c = this.clients.find((x) => x.databaseId === Number(rest[1]));
        if (!c) return;
        const gid = Number(rest[0]);
        c.serverGroups = cmd === "addservergroup" ? [...new Set([...c.serverGroups, gid])] : c.serverGroups.filter((g) => g !== gid);
        this.snapshot();
        break;
      }
      case "setchannelgroup": {
        const c = this.clients.find((x) => x.databaseId === Number(rest[2]));
        if (!c) return;
        c.channelGroup = Number(rest[0]);
        this.snapshot();
        break;
      }
      case "messagelist":
        this.later(80, () => this.emitEvent({ type: "offlineMessageList", entries: this.messages.map(({ message: _m, ...m }) => m) }));
        break;
      case "messageget": {
        const m = this.messages.find((x) => x.messageId === Number(rest[0]));
        if (m) {
          m.isRead = true;
          this.later(80, () => this.emitEvent({ type: "offlineMessage", messageId: m.messageId, clientUid: m.clientUid, subject: m.subject, message: m.message, timestamp: m.timestamp }));
        }
        break;
      }
      case "messagedel":
        this.messages = this.messages.filter((m) => m.messageId !== Number(rest[0]));
        break;
      case "serveredit": {
        try {
          const changes = JSON.parse(rest.join(" ")) as { name?: string };
          if (changes.name) this.emitEvent({ type: "serverLog", kind: "serverEdited" });
        } catch {
          // ignore
        }
        break;
      }
      case "serverquerylogin":
        this.emitEvent({ type: "error", message: "ServerQuery login is not simulated in demo mode" });
        break;
      case "ftlist":
        this.later(60, () => this.listFiles(Number(rest[0]), rest.slice(1).join(" ") || "/"));
        break;
      case "ftmkdir": {
        const { dir, name } = split(rest.slice(1).join(" "));
        this.filesOf(Number(rest[0])).push({ dir, name, isFile: false, data: Buffer.alloc(0) });
        break;
      }
      case "ftdelete": {
        const cid = Number(rest[0]);
        const path = rest.slice(1).join(" ");
        const { dir, name } = split(path);
        this.files.set(cid, this.filesOf(cid).filter((f) => !(f.dir === dir && f.name === name) && !f.dir.startsWith(path)));
        break;
      }
      case "ftrename": {
        const [cid, from, to] = line.slice("ftrename ".length).split("\t");
        const a = split(from ?? "");
        const b = split(to ?? "");
        const f = this.filesOf(Number(cid)).find((x) => x.dir === a.dir && x.name === a.name);
        if (f) Object.assign(f, b);
        break;
      }
      case "ftdownload": {
        const cid = Number(rest[0]);
        const path = rest.slice(1).join(" ");
        const { dir, name } = split(path);
        const f = this.filesOf(cid).find((x) => x.dir === dir && x.name === name && x.isFile);
        if (!f) {
          this.emitEvent({ type: "transferError", message: "Download failed: file not found", cid, path });
          return;
        }
        for (let offset = 0, n = 0; offset < f.data.length || offset === 0; offset += DEMO_CHUNK, n++) {
          const piece = f.data.subarray(offset, offset + DEMO_CHUNK);
          const done = offset + DEMO_CHUNK >= f.data.length;
          this.later(150 * (n + 1), () => this.emitEvent({ type: "fileDownloadChunk", cid, path, offset, data: piece.toString("base64"), done }));
          if (done) break;
        }
        break;
      }
      case "ftuploadchunk": {
        const [cid, offset, total, path, data] = line.slice("ftuploadchunk ".length).split("\t");
        const key = `${cid}:${path}`;
        const pieces = this.uploads.get(key) ?? [];
        if (Number(offset) === 0) pieces.length = 0;
        pieces.push(Buffer.from(data ?? "", "base64"));
        this.uploads.set(key, pieces);
        const buf = Buffer.concat(pieces);
        if (buf.length >= Number(total)) {
          this.uploads.delete(key);
          const { dir, name } = split(path ?? "");
          this.filesOf(Number(cid)).push({ dir, name, isFile: true, data: buf });
          this.later(200, () => this.emitEvent({ type: "fileUploadDone", cid: Number(cid), path: path ?? "" }));
        }
        break;
      }
      default:
        // whisper, unwhisper, whisperpolicy, clientvolume: nothing visible to simulate.
        break;
    }
  }

  async disconnect(): Promise<void> {
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.emit("exit", 0);
  }
}

export function createDemoConnector(request: ConnectRequest): ConnectorLike {
  return new DemoConnector(request);
}
