/**
 * Decides which captured frames are sent. Voice activation follows
 * webspeak3's web/src/voice.ts: transmit while the frame RMS is at or above
 * the threshold, plus a hangover so word endings are not clipped.
 *
 * Gate (§8.2), in order:
 * - any hold source (mouse on the talk button, a held pttKey/whisperKey) opens it
 * - "toggle", and "ptt" in terminals without key-release events: the toggle state
 * - "vad": level at or above the threshold, plus the hangover
 */

export type TalkMode = "vad" | "toggle" | "ptt";

export const FRAME_MS = 20;

export interface VoiceEngineOptions {
  mode: TalkMode;
  threshold: number;
  hangoverMs: number;
  /** Called with each frame that should go out. */
  send: (frame: Buffer) => void;
  /** Called when the "am I talking" state flips. */
  onTalkingChange?: (talking: boolean) => void;
}

/** RMS of an s16le frame, 0..1. */
export function frameRms(frame: Buffer): number {
  const samples = frame.length >> 1;
  if (samples === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const s = frame.readInt16LE(i * 2) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / samples);
}

export class VoiceEngine {
  mode: TalkMode;
  threshold: number;
  hangoverMs: number;
  /** Mic muted: nothing is sent, whatever the mode. */
  muted = false;
  private toggled = false;
  private holds = new Set<string>();
  /** Milliseconds of audio left in the VAD hangover. */
  private hangoverLeft = 0;
  private talking = false;
  /** Latest input level, for the meter. */
  level = 0;

  constructor(private readonly options: VoiceEngineOptions) {
    this.mode = options.mode;
    this.threshold = options.threshold;
    this.hangoverMs = options.hangoverMs;
  }

  /** Flip toggle-to-talk (also the ptt fallback without key releases). No effect on the VAD gate. */
  toggle(): boolean {
    this.toggled = !this.toggled;
    return this.toggled;
  }

  get isToggled(): boolean {
    return this.toggled;
  }

  /** Start/stop a hold-to-talk source ("mouse", "key"); works in every mode. */
  setHold(source: string, held: boolean): void {
    if (held) this.holds.add(source);
    else this.holds.delete(source);
  }

  /** Terminal lost focus: drop everything that could leave us stuck talking. */
  releaseAll(): void {
    this.holds.clear();
    this.toggled = false;
    this.setTalking(false);
  }

  get isTalking(): boolean {
    return this.talking;
  }

  /** Feed one captured 20 ms frame. Frame-count based, so it is deterministic in tests. */
  push(frame: Buffer): void {
    this.level = frameRms(frame);
    let open: boolean;
    if (this.holds.size > 0) {
      open = true;
    } else if (this.mode === "toggle" || this.mode === "ptt") {
      open = this.toggled;
    } else {
      if (this.level >= this.threshold) this.hangoverLeft = this.hangoverMs;
      else this.hangoverLeft = Math.max(0, this.hangoverLeft - FRAME_MS);
      open = this.level >= this.threshold || this.hangoverLeft > 0;
    }
    open &&= !this.muted;
    this.setTalking(open);
    if (open) this.options.send(frame);
  }

  private setTalking(talking: boolean): void {
    if (talking === this.talking) return;
    this.talking = talking;
    if (!talking) this.hangoverLeft = 0;
    this.options.onTalkingChange?.(talking);
  }
}
