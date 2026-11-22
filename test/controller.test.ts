import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Controller } from "../src/app/controller.ts";
import { DEFAULT_CONFIG, normalizeConfig, type Config } from "../src/config/config.ts";
import { parseAddress } from "../src/connector/address.ts";
import { renderSound } from "../src/audio/sounds.ts";
import { FakeConnector, client, snapshot } from "./fixtures/fake-connector.ts";

function setup(config: Partial<Config> = {}, now = () => 0) {
  const connectors: FakeConnector[] = [];
  const controller = new Controller({
    config: { ...DEFAULT_CONFIG, ...config },
    bookmarks: [],
    persist: false,
    now,
    connectorFactory: () => {
      const c = new FakeConnector();
      connectors.push(c);
      return c;
    },
  });
  const session = controller.connect({ address: "test", nickname: "me" })!;
  const fake = connectors[0]!;
  fake.push({ type: "connected", welcomeMessage: "", serverName: "S", serverMaxClients: 32, serverVersion: "3", serverBannerUrl: "", identity: "" });
  return { controller, session, fake, connectors };
}

describe("volumes (§8.4)", () => {
  test("stored volumes are applied when the person appears, and only once", () => {
    const { session, fake } = setup({ volumes: { "uid-2": 0.5 } });
    fake.take();
    fake.push(snapshot([client(1, 1, "me"), client(2, 1, "bob"), client(3, 1, "amy")]));
    expect(fake.take("clientvolume")).toEqual(["clientvolume 2 0.5"]);
    fake.push(snapshot([client(1, 1, "me"), client(2, 2, "bob"), client(3, 1, "amy")]));
    expect(fake.take("clientvolume")).toEqual([]);
    void session;
  });

  test("setVolume stores by UID, applies, and 1 removes the entry", () => {
    const { controller, fake } = setup();
    fake.push(snapshot([client(1, 1, "me"), client(2, 1, "bob")]));
    fake.take();
    controller.setVolume("uid-2", 0);
    expect(controller.state.config.volumes).toEqual({ "uid-2": 0 });
    expect(fake.take("clientvolume")).toEqual(["clientvolume 2 0"]);
    controller.setVolume("uid-2", 1);
    expect(controller.state.config.volumes).toEqual({});
    expect(fake.take("clientvolume")).toEqual(["clientvolume 2 1"]);
  });
});

describe("whisper (§8.3)", () => {
  test("policy maps exception UIDs to current client ids and is not re-sent unchanged", () => {
    const { controller, fake } = setup({ blockWhispers: true, whisperExceptions: ["uid-3"] });
    fake.take();
    fake.push(snapshot([client(1, 1, "me"), client(2, 1, "bob"), client(3, 1, "amy")]));
    expect(fake.take("whisperpolicy")).toEqual(["whisperpolicy block;3"]);
    fake.push(snapshot([client(1, 1, "me"), client(2, 2, "bob"), client(3, 1, "amy")]));
    expect(fake.take("whisperpolicy")).toEqual([]);
    controller.toggleWhisperException("uid-2");
    expect(fake.take("whisperpolicy")).toEqual(["whisperpolicy block;2,3"]);
  });

  test("holding whispers to the list and unwhispers on release; a short click locks", () => {
    let t = 0;
    const { controller, session, fake } = setup({}, () => t);
    fake.push(snapshot([client(1, 1, "me"), client(2, 1, "bob")]));
    session.toggleWhisperTarget("client", 2);
    session.toggleWhisperTarget("channel", 2);
    fake.take();
    controller.whisperButtonPress();
    t += 1000;
    controller.whisperButtonRelease();
    expect(fake.take()).toEqual(["whisper 2;2", "unwhisper"]);
    controller.whisperButtonPress();
    t += 100;
    controller.whisperButtonRelease();
    expect(session.store.getState().whisperLocked).toBe(true);
    expect(fake.take().at(-1)).toBe("whisper 2;2");
    session.clearWhisperTargets();
    expect(session.store.getState().whisperLocked).toBe(false);
    expect(fake.take()).toEqual(["unwhisper"]);
  });

  test("an empty whisper list does not whisper", () => {
    const { controller, fake } = setup();
    fake.take();
    controller.setWhisperHold("key", true);
    expect(fake.take()).toEqual([]);
    expect(controller.state.notice?.text).toContain("whisper list is empty");
  });
});

describe("hold keys (§8.2)", () => {
  test("without key releases, a press toggles; with kitty, press and release hold", () => {
    const { controller, fake } = setup({ talkMode: "ptt" });
    fake.push(snapshot([client(1, 1, "me"), client(2, 1, "bob")]));
    controller.activeSession()!.toggleWhisperTarget("client", 2);
    fake.take();
    controller.holdKey("f8", "press");
    expect(fake.take()).toEqual(["whisper ;2"]);
    controller.holdKey("f8", "release");
    expect(fake.take()).toEqual([]);
    controller.holdKey("f8", "press");
    expect(fake.take()).toEqual(["unwhisper"]);
    controller.kittyDetected();
    controller.holdKey("f8", "press");
    controller.holdKey("f8", "repeat");
    controller.holdKey("f8", "release");
    expect(fake.take()).toEqual(["whisper ;2", "unwhisper"]);
  });

  test("F1 and F2 open help and settings", () => {
    const { controller } = setup();
    controller.holdKey("f2", "press");
    expect(controller.state.dialog?.kind).toBe("settings");
    controller.closeDialog();
    controller.holdKey("f1", "press");
    expect(controller.state.dialog?.kind).toBe("help");
  });

  test("losing focus releases holds and latches", () => {
    const { controller, fake } = setup();
    fake.push(snapshot([client(1, 1, "me"), client(2, 1, "bob")]));
    controller.activeSession()!.toggleWhisperTarget("client", 2);
    controller.holdKey("f8", "press");
    fake.take();
    controller.terminalFocus(false);
    expect(fake.take()).toEqual(["unwhisper"]);
    expect(controller.state.whisperHeld).toBe(false);
  });
});

describe("connection info polling (§9.2)", () => {
  test("polls the selected client and the server, and stops after a permission error", () => {
    let t = 10_000;
    const { controller, session, fake } = setup({}, () => t);
    fake.push(snapshot([client(1, 1, "me"), client(2, 1, "bob")]));
    session.select({ kind: "client", id: 2 });
    fake.take();
    controller.poll();
    expect(fake.take()).toEqual(["clientconninfo 2", "serverconninfo"]);
    t += 1000;
    controller.poll();
    expect(fake.take()).toEqual([]);
    fake.push({ type: "serverLog", kind: "permissionError", action: "Server connection info" });
    fake.push({ type: "serverLog", kind: "permissionError", action: "Connection info" });
    t += 10_000;
    controller.poll();
    expect(fake.take()).toEqual([]);
  });
});

describe("files (§9.6)", () => {
  test("a download is written chunk by chunk under a unique name", () => {
    const dir = mkdtempSync(join(tmpdir(), "tuim-dl-"));
    writeFileSync(join(dir, "a.txt"), "old");
    const { controller, session, fake } = setup({ downloadDir: dir });
    controller.download(session.id, 2, { path: "/docs", name: "a.txt", size: 6, isFile: true, timestamp: "" });
    expect(fake.take("ftdownload")).toEqual(["ftdownload 2 /docs/a.txt"]);
    fake.push({ type: "fileDownloadChunk", cid: 2, path: "/docs/a.txt", offset: 0, data: Buffer.from("abc").toString("base64"), done: false });
    fake.push({ type: "fileDownloadChunk", cid: 2, path: "/docs/a.txt", offset: 3, data: Buffer.from("def").toString("base64"), done: true });
    expect(readFileSync(join(dir, "a (1).txt"), "utf8")).toBe("abcdef");
    expect(session.store.getState().transfers[0]).toMatchObject({ state: "done", done: 6 });
  });

  test("uploads are cut into ordered pieces and oversized files are refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "tuim-up-"));
    const file = join(dir, "big.bin");
    writeFileSync(file, Buffer.alloc((192 << 10) + 5, 1));
    const { controller, session, fake } = setup();
    controller.upload(session.id, 2, "/", file);
    const pieces = fake.take("ftuploadchunk").map((l) => l.split("\t").slice(1, 4));
    expect(pieces).toEqual([
      ["0", String((192 << 10) + 5), "/big.bin"],
      [String(192 << 10), String((192 << 10) + 5), "/big.bin"],
    ]);
  });
});

describe("misc", () => {
  test("ts3server links", () => {
    expect(parseAddress("ts3server://voice.example.com?port=9988&nickname=al&password=pw&channel=Lobby/Sub")).toEqual({
      address: "voice.example.com:9988", nickname: "al", serverPassword: "pw", defaultChannel: "Lobby/Sub", privilegeKey: undefined,
    });
    expect(parseAddress(" host:1 ")).toEqual({ address: "host:1" });
  });

  test("config repair falls back to defaults for bad values", () => {
    const c = normalizeConfig({ talkMode: "shout" as never, vadThreshold: 7, pttKey: "f99" as never, volumes: { a: 3, b: "x" as never }, wheelLines: 0 });
    expect(c).toMatchObject({ talkMode: "vad", vadThreshold: 1, pttKey: "f9", volumes: { a: 2 }, wheelLines: 1 });
  });

  test("sounds are stereo s16 within range and silent at volume 0", () => {
    const pcm = renderSound("poke", 1);
    expect(pcm.length % 4).toBe(0);
    let peak = 0;
    for (let i = 0; i < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
    expect(peak).toBeGreaterThan(5000);
    expect(peak).toBeLessThan(32767);
    expect(renderSound("poke", 0).every((b) => b === 0)).toBe(true);
  });
});
