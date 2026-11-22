import { describe, expect, test } from "bun:test";
import { FrameDecoder, TYPE_JSON, TYPE_PCM, encodeFrame } from "../src/audio/frames.ts";
import { VoiceEngine, frameRms } from "../src/audio/voice.ts";

function tone(amplitude: number): Buffer {
  const b = Buffer.alloc(1920);
  for (let i = 0; i < 960; i++) b.writeInt16LE(Math.round(Math.sin(i / 5) * amplitude * 32767), i * 2);
  return b;
}
const silence = () => Buffer.alloc(1920);

describe("frames", () => {
  test("decodes frames split at arbitrary points", () => {
    const bytes = Buffer.concat([encodeFrame(TYPE_PCM, Buffer.from([1, 2, 3])), encodeFrame(TYPE_JSON, Buffer.from("{}"))]);
    const d = new FrameDecoder();
    const got = [...d.push(bytes.subarray(0, 4)), ...d.push(bytes.subarray(4, 9)), ...d.push(bytes.subarray(9))];
    expect(got.map((f) => [f.kind, [...f.payload]])).toEqual([
      [TYPE_PCM, [1, 2, 3]],
      [TYPE_JSON, [...Buffer.from("{}")]],
    ]);
  });
  test("rejects absurd lengths", () => {
    const d = new FrameDecoder();
    const bad = Buffer.from([1, 0, 0, 0, 0x10]);
    expect(() => d.push(bad)).toThrow();
  });
});

describe("VoiceEngine", () => {
  test("rms of silence and a loud tone", () => {
    expect(frameRms(silence())).toBe(0);
    expect(frameRms(tone(0.5))).toBeGreaterThan(0.3);
  });

  test("VAD opens on loud input and holds for the hangover", () => {
    const sent: number[] = [];
    let i = 0;
    const v = new VoiceEngine({ mode: "vad", threshold: 0.02, hangoverMs: 60, send: () => sent.push(i) });
    const feed = [tone(0.5), silence(), silence(), silence(), silence()];
    for (const f of feed) {
      v.push(f);
      i++;
    }
    // Loud frame + 60 ms hangover = 3 frames of silence still sent (60, 40, 20 ms left), then closed.
    expect(sent).toEqual([0, 1, 2]);
    expect(v.isTalking).toBe(false);
  });

  test("quiet input never opens VAD", () => {
    let sent = 0;
    const v = new VoiceEngine({ mode: "vad", threshold: 0.2, hangoverMs: 300, send: () => sent++ });
    for (let k = 0; k < 10; k++) v.push(tone(0.05));
    expect(sent).toBe(0);
  });

  test("toggle mode sends only while toggled; mute wins", () => {
    let sent = 0;
    const v = new VoiceEngine({ mode: "toggle", threshold: 0.02, hangoverMs: 300, send: () => sent++ });
    v.push(tone(0.5));
    v.toggle();
    v.push(silence());
    v.muted = true;
    v.push(silence());
    expect(sent).toBe(1);
  });

  test("hold works in VAD mode and releaseAll stops it", () => {
    let sent = 0;
    const changes: boolean[] = [];
    const v = new VoiceEngine({ mode: "vad", threshold: 0.9, hangoverMs: 300, send: () => sent++, onTalkingChange: (t) => changes.push(t) });
    v.setHold("mouse", true);
    v.push(silence());
    v.releaseAll();
    v.push(silence());
    expect(sent).toBe(1);
    expect(changes).toEqual([true, false]);
  });
});
