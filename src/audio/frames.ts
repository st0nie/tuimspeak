/**
 * tuim-audio stdio framing (architecture §4.1): [type: u8][len: u32 LE][payload].
 * Mirrors native/tuim-audio/src/frame.rs.
 */

export const TYPE_PCM = 0x01;
export const TYPE_JSON = 0x02;
export const TYPE_EFFECT = 0x03;
const HEADER = 5;
const MAX_PAYLOAD = 1 << 20;

export interface Frame {
  kind: number;
  payload: Buffer;
}

export function encodeFrame(kind: number, payload: Uint8Array): Buffer {
  const out = Buffer.allocUnsafe(HEADER + payload.byteLength);
  out[0] = kind;
  out.writeUInt32LE(payload.byteLength, 1);
  out.set(payload, HEADER);
  return out;
}

/** Incremental decoder for a byte stream that may split frames anywhere. */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Frame[] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const frames: Frame[] = [];
    let offset = 0;
    while (this.buffer.length - offset >= HEADER) {
      const len = this.buffer.readUInt32LE(offset + 1);
      if (len > MAX_PAYLOAD) throw new Error(`tuim-audio frame too large: ${len} bytes`);
      if (this.buffer.length - offset < HEADER + len) break;
      frames.push({
        kind: this.buffer[offset]!,
        // Copy, so a retained frame does not pin the whole read buffer.
        payload: Buffer.from(this.buffer.subarray(offset + HEADER, offset + HEADER + len)),
      });
      offset += HEADER + len;
    }
    this.buffer = this.buffer.subarray(offset);
    return frames;
  }
}
