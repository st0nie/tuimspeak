import { describe, expect, test } from "bun:test";
import { createSessionStore, reduce, MAX_LINES } from "../src/state/session.ts";
import { buildTree, parseSpacer } from "../src/state/tree.ts";
import type { ChannelInfo, ClientInfo, Snapshot } from "../src/connector/protocol.ts";

const ch = (id: number, parent: number, order: number, name: string, extra: Partial<ChannelInfo> = {}): ChannelInfo => ({
  id, parent, order, name, topic: "", codec: "OpusVoice", maxClients: null, hasPassword: false, ...extra,
});
const cl = (id: number, channel: number, name: string, extra: Partial<ClientInfo> = {}): ClientInfo => ({
  id, channel, name, inputMuted: false, outputMuted: false, inputHardwareEnabled: true, away: false, awayMessage: "",
  isChannelCommander: false, country: "", uid: "", databaseId: 0, channelGroup: 0, serverGroups: [], hasTalkPower: true,
  isQuery: false, isStreaming: false, avatarHash: "", ...extra,
});

const snapshot: Snapshot = {
  channels: [ch(2, 0, 1, "B"), ch(1, 0, 0, "A"), ch(3, 1, 0, "A1"), ch(4, 0, 2, "[cspacer]Title")],
  clients: [cl(10, 1, "zed"), cl(11, 1, "Amy"), cl(12, 3, "query", { isQuery: true }), cl(13, 2, "me")],
  ownClientId: 13,
  serverMaxClients: 32,
  serverClientsOnline: 3,
  serverChannelsOnline: 4,
};

describe("buildTree", () => {
  test("orders channels by order and clients by name, hides query clients", () => {
    const rows = buildTree(snapshot, { collapsed: {}, showQueryClients: false });
    expect(rows.map((r) => r.key)).toEqual(["server", "ch:1", "cl:11", "cl:10", "ch:3", "ch:2", "cl:13", "ch:4"]);
  });

  test("collapsed channels hide their subtree and report a client count", () => {
    const rows = buildTree(snapshot, { collapsed: { 1: true }, showQueryClients: false });
    expect(rows.map((r) => r.key)).toEqual(["server", "ch:1", "ch:2", "cl:13", "ch:4"]);
    const a = rows[1]!;
    expect(a.kind === "channel" && a.clientCount).toBe(2);
  });

  test("filter keeps matching rows with their parent channels", () => {
    const rows = buildTree(snapshot, { collapsed: { 1: true }, showQueryClients: true, filter: "query" });
    expect(rows.map((r) => r.key)).toEqual(["server", "ch:1", "ch:3", "cl:12"]);
  });

  test("spacers", () => {
    expect(parseSpacer(ch(1, 0, 0, "[cspacer]Title"))).toEqual({ align: "center", text: "Title" });
    expect(parseSpacer(ch(1, 0, 0, "[*spacer3]-"))).toEqual({ align: "repeat", text: "-" });
    expect(parseSpacer(ch(1, 0, 0, "[spacer0]"))).toEqual({ align: "left", text: "" });
    expect(parseSpacer(ch(1, 5, 0, "[cspacer]Nested"))).toBeNull();
    expect(parseSpacer(ch(1, 0, 0, "Lobby"))).toBeNull();
  });
});

describe("reduce", () => {
  test("connected sets status and logs the welcome message", () => {
    const s = createSessionStore("s1", "host", "host").getState();
    const next = reduce(s, { type: "connected", welcomeMessage: "hi", serverName: "Srv", serverMaxClients: 32, serverVersion: "3.13", serverBannerUrl: "", identity: "secret" }, 0);
    expect(next.status).toBe("connected");
    expect(next.label).toBe("Srv");
    expect(next.server).not.toHaveProperty("identity");
    expect(next.tabs?.[0]?.lines.map((l) => l.text)).toEqual(["Connected to Srv (3.13)", "hi"]);
  });

  test("channel tab title follows our channel; private tabs open on message and count unread", () => {
    const store = createSessionStore("s1", "h", "h");
    store.setState(reduce(store.getState(), { type: "channels", ...snapshot }));
    expect(store.getState().tabs.find((t) => t.id === "channel")?.title).toBe("B");
    store.setState(reduce(store.getState(), { type: "privateMessage", partnerId: 10, partnerName: "zed", fromSelf: false, message: "yo" }));
    const pm = store.getState().tabs.find((t) => t.id === "pm:10");
    expect(pm).toMatchObject({ title: "zed", unread: 1, partnerId: 10 });
    expect(pm?.lines[0]).toMatchObject({ from: "zed", text: "yo" });
  });

  test("own private messages are attributed to us and not counted unread", () => {
    const store = createSessionStore("s1", "h", "h");
    store.setState(reduce(store.getState(), { type: "channels", ...snapshot }));
    store.setState(reduce(store.getState(), { type: "privateMessage", partnerId: 10, partnerName: "zed", fromSelf: true, message: "hi" }));
    const pm = store.getState().tabs.find((t) => t.id === "pm:10");
    expect(pm).toMatchObject({ unread: 0 });
    expect(pm?.lines[0]).toMatchObject({ from: "me", self: true });
  });

  test("chat history is capped", () => {
    const store = createSessionStore("s1", "h", "h");
    for (let i = 0; i < MAX_LINES + 5; i++) store.setState(reduce(store.getState(), { type: "chatMessage", from: "a", message: String(i) }));
    const lines = store.getState().tabs.find((t) => t.id === "channel")!.lines;
    expect(lines).toHaveLength(MAX_LINES);
    expect(lines[0]!.text).toBe("5");
  });

  test("disconnect clears talkers and poke sets a banner", () => {
    const store = createSessionStore("s1", "h", "h");
    store.setState({ talkers: [1, 2] });
    store.setState(reduce(store.getState(), { type: "poke", from: "amy", message: "hey" }, 5));
    expect(store.getState().poke).toEqual({ from: "amy", message: "hey", time: 5 });
    store.setState(reduce(store.getState(), { type: "disconnected", reason: "kicked" }));
    expect(store.getState()).toMatchObject({ status: "disconnected", talkers: [] });
  });
});

describe("reduce: whisper, files (§8.3, §9.6)", () => {
  test("a whisper is logged once a minute per person and ends when they stop talking", () => {
    const store = createSessionStore("s1", "h", "h");
    store.setState(reduce(store.getState(), { type: "channels", ...snapshot }));
    store.setState(reduce(store.getState(), { type: "whisperReceived", clientId: 10 }, 1000));
    store.setState(reduce(store.getState(), { type: "whisperReceived", clientId: 10 }, 2000));
    const server = () => store.getState().tabs.find((t) => t.id === "server")!.lines.map((l) => l.text);
    expect(server()).toEqual(["zed is whispering to you"]);
    expect(store.getState().whisperers).toEqual([10]);
    store.setState(reduce(store.getState(), { type: "talkers", clients: [11] }));
    expect(store.getState().whisperers).toEqual([]);
    store.setState(reduce(store.getState(), { type: "whisperReceived", clientId: 10 }, 70_000));
    expect(server()).toHaveLength(2);
  });

  test("whisper targets that left are dropped", () => {
    const store = createSessionStore("s1", "h", "h");
    store.setState({ whisperTargets: { channels: [1, 99], clients: [10, 98] } });
    store.setState(reduce(store.getState(), { type: "channels", ...snapshot }));
    expect(store.getState().whisperTargets).toEqual({ channels: [1], clients: [10] });
  });

  test("download progress and transfer errors", () => {
    const store = createSessionStore("s1", "h", "h");
    store.setState({ transfers: [{ id: 1, kind: "download", cid: 2, path: "/a", localPath: "/tmp/a", size: 6, done: 0, state: "active" }] });
    store.setState(reduce(store.getState(), { type: "fileDownloadChunk", cid: 2, path: "/a", offset: 0, data: "YWJj", done: false }));
    expect(store.getState().transfers[0]).toMatchObject({ done: 3, state: "active" });
    store.setState(reduce(store.getState(), { type: "transferError", message: "gone", cid: 2, path: "/a" }));
    expect(store.getState().transfers[0]).toMatchObject({ state: "error", message: "gone" });
  });
});
