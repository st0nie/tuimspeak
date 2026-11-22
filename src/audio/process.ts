import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import { FrameDecoder, TYPE_EFFECT, TYPE_JSON, TYPE_PCM, encodeFrame } from "./frames.ts";
import { log } from "../log.ts";

export interface AudioDevice {
  id: string;
  name: string;
  isDefault: boolean;
}

export type AudioEvent =
  | { event: "devices"; host: string; inputs: AudioDevice[]; outputs: AudioDevice[] }
  | { event: "outputOpened"; name: string; sampleRate: number; channels: number }
  | { event: "captureStarted"; name: string; sampleRate: number; channels: number }
  | { event: "captureStopped" }
  | { event: "silentInput" }
  | { event: "stats"; underruns: number; overflows: number; bufferedMs: number }
  | { event: "error"; message: string };

export interface AudioProcessEvents {
  /** One capture frame: s16le mono 48 kHz, 960 samples. */
  capture: [Buffer];
  event: [AudioEvent];
  exit: [number | null];
}

/** Wraps the tuim-audio sidecar (one for the whole app). */
export class AudioProcess extends EventEmitter<AudioProcessEvents> {
  private child: ChildProcessWithoutNullStreams | undefined;
  private exited = false;
  private readonly decoder = new FrameDecoder();

  constructor(private readonly binary: string) {
    super();
  }

  start(): void {
    const child = spawn(this.binary, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    child.stdin.on("error", () => {});
    child.on("error", (err) => {
      this.exited = true;
      this.emit("event", { event: "error", message: `Audio helper failed to start: ${err.message}` });
      this.emit("exit", null);
    });
    child.on("exit", (code) => {
      this.exited = true;
      this.emit("exit", code);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      let frames;
      try {
        frames = this.decoder.push(chunk);
      } catch (err) {
        log.error(String(err));
        child.kill();
        return;
      }
      for (const frame of frames) {
        if (frame.kind === TYPE_PCM) this.emit("capture", frame.payload);
        else if (frame.kind === TYPE_JSON) {
          try {
            this.emit("event", JSON.parse(frame.payload.toString("utf8")) as AudioEvent);
          } catch {
            log.error("tuim-audio sent invalid JSON");
          }
        }
      }
    });
    createInterface({ input: child.stderr }).on("line", (line) => log.debug(`[audio] ${line}`));
  }

  private write(kind: number, payload: Uint8Array): void {
    const child = this.child;
    if (!child || this.exited || child.stdin.destroyed) return;
    child.stdin.write(encodeFrame(kind, payload));
  }

  private command(cmd: Record<string, unknown>): void {
    this.write(TYPE_JSON, Buffer.from(JSON.stringify(cmd), "utf8"));
  }

  listDevices(): void {
    this.command({ cmd: "listDevices" });
  }

  open(input = "default", output = "default"): void {
    this.command({ cmd: "open", input, output });
  }

  setCapture(enabled: boolean): void {
    this.command({ cmd: "capture", enabled });
  }

  /** One playback chunk from the connector: s16le stereo 48 kHz, 960 frames. */
  play(pcm: Buffer): void {
    this.write(TYPE_PCM, pcm);
  }

  /** A notification sound: s16le stereo 48 kHz, mixed on top of voice (§4.5). */
  playEffect(pcm: Buffer): void {
    this.write(TYPE_EFFECT, pcm);
  }

  stop(): void {
    if (this.child && !this.exited) {
      this.child.stdin.end();
      this.child.kill();
    }
  }
}
