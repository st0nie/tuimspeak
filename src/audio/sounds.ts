/**
 * Notification sounds (architecture §9.7): short synthesized tones, rendered
 * as s16le stereo 48 kHz and played through tuim-audio's effects channel
 * (§4.5), so they mix with voice instead of interleaving with it.
 */

export type SoundName = "poke" | "privateMessage" | "channelMessage" | "join" | "leave" | "connected" | "disconnected";

const RATE = 48_000;

interface Note {
  /** Start and end frequency in Hz (a sweep when they differ). */
  from: number;
  to?: number;
  ms: number;
  /** Silence after the note. */
  gapMs?: number;
}

const SOUNDS: Record<SoundName, Note[]> = {
  poke: [
    { from: 880, ms: 110, gapMs: 30 },
    { from: 660, ms: 140 },
  ],
  privateMessage: [
    { from: 1046, ms: 60, gapMs: 20 },
    { from: 1318, ms: 80 },
  ],
  channelMessage: [{ from: 784, ms: 45 }],
  join: [{ from: 523, to: 784, ms: 140 }],
  leave: [{ from: 784, to: 523, ms: 140 }],
  connected: [
    { from: 523, ms: 70, gapMs: 15 },
    { from: 659, ms: 70, gapMs: 15 },
    { from: 784, ms: 110 },
  ],
  disconnected: [
    { from: 659, ms: 90, gapMs: 15 },
    { from: 440, ms: 150 },
  ],
};

const ATTACK_MS = 5;
const RELEASE_MS = 25;

/** Renders a sound; `volume` is 0..1. */
export function renderSound(name: SoundName, volume: number): Buffer {
  const notes = SOUNDS[name];
  const frames = notes.reduce((n, note) => n + Math.round(((note.ms + (note.gapMs ?? 0)) * RATE) / 1000), 0);
  const out = Buffer.alloc(frames * 4);
  const gain = Math.max(0, Math.min(1, volume)) * 0.35;
  let frame = 0;
  for (const note of notes) {
    const length = Math.round((note.ms * RATE) / 1000);
    const attack = (ATTACK_MS * RATE) / 1000;
    const release = (RELEASE_MS * RATE) / 1000;
    let phase = 0;
    for (let i = 0; i < length; i++) {
      const t = i / length;
      const freq = note.from + ((note.to ?? note.from) - note.from) * t;
      phase += (2 * Math.PI * freq) / RATE;
      const envelope = Math.min(1, i / attack, (length - i) / release);
      const value = Math.round(Math.sin(phase) * envelope * gain * 32767);
      out.writeInt16LE(value, (frame + i) * 4);
      out.writeInt16LE(value, (frame + i) * 4 + 2);
    }
    frame += length + Math.round(((note.gapMs ?? 0) * RATE) / 1000);
  }
  return out;
}
