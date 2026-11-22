import { describe, expect, test } from "bun:test";
import { parseEvent } from "../src/connector/protocol.ts";
import { commands } from "../src/connector/commands.ts";

// Shapes recorded from ts-connector against a TS3 3.13 server, with names and ids made up.
const CHANNELS_LINE = JSON.stringify({
  type: "channels",
  channels: [
    { id: 1, parent: 0, order: 0, name: "Lobby", topic: "hi", codec: "OpusVoice", max_clients: null, has_password: false },
    { id: 2, parent: 1, order: 1, name: "Sub", topic: "", codec: "OpusVoice", max_clients: 5, has_password: true },
  ],
  clients: [
    {
      id: 7, channel: 1, name: "alice", input_muted: false, output_muted: true, input_hardware_enabled: true,
      away: false, away_message: "", is_channel_commander: true, country: "DE", uid: "abc=", database_id: 3,
      channel_group: 8, server_groups: [6], has_talk_power: true, is_query: false, is_streaming: false, avatar_hash: "",
    },
  ],
  own_client_id: 7,
  server_max_clients: 32,
  server_clients_online: 1,
  server_channels_online: 2,
});

describe("parseEvent", () => {
  test("channels snapshot is converted to camelCase", () => {
    const e = parseEvent(CHANNELS_LINE);
    expect(e?.type).toBe("channels");
    if (e?.type !== "channels") return;
    expect(e.channels[1]).toEqual({ id: 2, parent: 1, order: 1, name: "Sub", topic: "", codec: "OpusVoice", maxClients: 5, hasPassword: true });
    expect(e.clients[0]).toMatchObject({ id: 7, outputMuted: true, isChannelCommander: true, serverGroups: [6] });
    expect(e.ownClientId).toBe(7);
  });

  test("connected keeps the identity", () => {
    const e = parseEvent(JSON.stringify({ type: "connected", welcome_message: "w", server_name: "S", server_max_clients: 32, server_version: "3.13.8", server_license: "", server_banner_url: "", identity: "ID" }));
    expect(e).toMatchObject({ type: "connected", serverName: "S", identity: "ID" });
  });

  test("private message and server log", () => {
    expect(parseEvent('{"type":"privateMessage","partner_id":4,"partner_name":"bob","from_self":false,"message":"yo"}')).toEqual({
      type: "privateMessage", partnerId: 4, partnerName: "bob", fromSelf: false, message: "yo",
    });
    expect(parseEvent('{"type":"serverLog","kind":"clientJoin","client":"bob","channel":"Lobby"}')).toEqual({
      type: "serverLog", kind: "clientJoin", client: "bob", channel: "Lobby",
    });
  });

  test("unknown events, unknown log kinds and garbage are ignored", () => {
    expect(parseEvent('{"type":"streamEvent","name":"x","args":{}}')).toBeNull();
    expect(parseEvent('{"type":"serverLog","kind":"somethingNew"}')).toBeNull();
    expect(parseEvent("not json")).toBeNull();
    expect(parseEvent("null")).toBeNull();
  });
});

describe("commands", () => {
  test("text is scrubbed of newlines so it cannot inject a second command", () => {
    expect(commands.chat("hi\nswitch 5")).toBe("chat hi switch 5");
    expect(commands.privateMessage(3, "a\r\nb")).toBe("pm 3 a b");
  });

  test("channel password travels base64-encoded", () => {
    expect(commands.switchChannel(4)).toBe("switch 4");
    expect(commands.switchChannel(4, "p w")).toBe(`switch 4 ${Buffer.from("p w").toString("base64")}`);
  });

  test("ids must be integers", () => {
    expect(() => commands.poke(1.5, "x")).toThrow();
  });

  test("whisper with no targets clears whisper mode", () => {
    expect(commands.whisper([], [])).toBe("unwhisper");
    expect(commands.whisper([1, 2], [9])).toBe("whisper 1,2;9");
  });

  test("audio frame is base64 of the raw bytes", () => {
    const frame = new Uint8Array(1920).fill(1);
    expect(commands.audio(frame)).toBe(`audio ${Buffer.from(frame).toString("base64")}`);
  });
});

describe("parseEvent: admin, files, info (§3.3)", () => {
  test("list entries are read in camelCase and snake_case", () => {
    const camel = parseEvent('{"type":"banList","entries":[{"banId":3,"ip":"1.2.3.4","name":"","uid":"","lastNickname":"x","created":"c","durationSecs":0,"invokerName":"a","reason":"r","enforcements":1}]}');
    const snake = parseEvent('{"type":"banList","entries":[{"ban_id":3,"ip":"1.2.3.4","name":"","uid":"","last_nickname":"x","created":"c","duration_secs":0,"invoker_name":"a","reason":"r","enforcements":1}]}');
    expect(camel).toEqual(snake);
    expect(camel).toMatchObject({ type: "banList", entries: [{ banId: 3, lastNickname: "x", invokerName: "a" }] });
  });

  test("connection info", () => {
    expect(parseEvent('{"type":"clientConnectionInfo","client_id":4,"ping_ms":12.5,"connected_secs":null,"ip":null,"packets_sent":1,"bytes_sent":2,"packets_received":3,"bytes_received":4,"packet_loss_percent":0.5}')).toEqual({
      type: "clientConnectionInfo", clientId: 4, pingMs: 12.5, connectedSecs: null, ip: null, packetsSent: 1, bytesSent: 2, packetsReceived: 3, bytesReceived: 4, packetLossPercent: 0.5,
    });
    expect(parseEvent('{"type":"serverConnectionInfo","ping_ms":30,"connected_secs":100,"packet_loss_percent":1,"bytes_sent_total":5,"bytes_received_total":6,"bandwidth_sent_last_second":7,"bandwidth_received_last_second":8}')).toMatchObject({
      type: "serverConnectionInfo", pingMs: 30, bandwidthReceivedLastSecond: 8,
    });
  });

  test("an error with cid and path is a transfer error", () => {
    expect(parseEvent('{"type":"error","message":"Download failed","cid":2,"path":"/a"}')).toEqual({ type: "transferError", message: "Download failed", cid: 2, path: "/a" });
  });

  test("files, groups, offline messages", () => {
    expect(parseEvent('{"type":"fileList","cid":2,"path":"/","entries":[{"path":"/","name":"a","size":3,"isFile":true,"timestamp":"t"}]}')).toMatchObject({ entries: [{ name: "a", isFile: true }] });
    expect(parseEvent('{"type":"fileDownloadChunk","cid":2,"path":"/a","offset":0,"data":"AAA=","done":true}')).toMatchObject({ done: true, offset: 0 });
    expect(parseEvent('{"type":"serverGroupList","entries":[{"id":6,"name":"Admin","iconId":0}]}')).toEqual({ type: "serverGroupList", entries: [{ id: 6, name: "Admin" }] });
    expect(parseEvent('{"type":"offlineMessage","message_id":1,"client_uid":"u","subject":"s","message":"m","timestamp":"t"}')).toMatchObject({ messageId: 1, clientUid: "u" });
    expect(parseEvent('{"type":"whisperReceived","clientId":9}')).toEqual({ type: "whisperReceived", clientId: 9 });
  });
});

describe("commands: admin and files (§3.2)", () => {
  test("tab-separated commands scrub tabs and newlines inside fields", () => {
    expect(commands.messageAdd("u=", "hi\tthere", "a\nb")).toBe("messageadd u=\thi there\ta b");
    expect(commands.fileRename(2, "/a\tb", "/c")).toBe("ftrename 2\t/a b\t/c");
  });
  test("upload pieces carry offset and total", () => {
    expect(commands.fileUploadChunk(2, "/x.txt", 0, 3, new Uint8Array([1, 2, 3]))).toBe(`ftuploadchunk 2\t0\t3\t/x.txt\t${Buffer.from([1, 2, 3]).toString("base64")}`);
  });
  test("moderation", () => {
    expect(commands.moveClient(5, 7)).toBe("moveclient 5 7");
    expect(commands.ban(5, 3600.7, "bye")).toBe("banclient 5 3600 bye");
    expect(commands.kickFromServer(5, "")).toBe("kickserver 5");
    expect(commands.whisperPolicy(true, [3, 4])).toBe("whisperpolicy block;3,4");
    expect(commands.serverEdit({ name: "x" })).toBe('serveredit {"name":"x"}');
  });
});
