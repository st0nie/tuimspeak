import { writeSync } from "node:fs";

/**
 * Terminal modes for mouse input. The alternate screen itself is handled by
 * Ink (`alternateScreen: true`).
 *
 *   1000  report button press/release
 *   1002  report motion while a button is held (drag, release detection)
 *   1006  SGR coordinates: no 223-column limit, releases name their button
 *   1004  focus in/out events
 */
export const MOUSE_ON = "\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?1004h";
export const MOUSE_OFF = "\x1b[?1003l\x1b[?1004l\x1b[?1006l\x1b[?1002l\x1b[?1000l";
/**
 * Motion with no button held; only enabled while hover matters (menus).
 * Modes 1000/1002/1003 share one slot in xterm/Ghostty, so leaving 1003 must
 * re-enable 1000+1002 or mouse tracking turns off completely (§6.1).
 */
export const HOVER_ON = "\x1b[?1003h";
export const HOVER_OFF = "\x1b[?1003l\x1b[?1000h\x1b[?1002h";
/** Ink emits `?1049h` without homing the cursor; strict terminals keep the shell prompt's column (§6.1). */
export const ALT_SCREEN_ON = "\x1b[?1049h";
export const CLEAR_AND_HOME = "\x1b[2J\x1b[H";
export const ALT_SCREEN_HOME = `${ALT_SCREEN_ON}${CLEAR_AND_HOME}`;
let enabled = false;
let hover = false;

function defaultWrite(sequence: string): void {
  // Synchronous on purpose: this also runs from process 'exit', where
  // asynchronous stream writes are dropped.
  try {
    writeSync(1, sequence);
  } catch {
    // stdout already gone; nothing left to restore.
  }
}

export function enableMouse(out: (seq: string) => void = defaultWrite): void {
  if (enabled) return;
  enabled = true;
  out(MOUSE_ON);
}

export function setHoverTracking(on: boolean, out: (seq: string) => void = defaultWrite): void {
  if (!enabled || hover === on) return;
  hover = on;
  out(on ? HOVER_ON : HOVER_OFF);
}

export function disableMouse(out: (seq: string) => void = defaultWrite): void {
  if (!enabled) return;
  hover = false;
  enabled = false;
  out(MOUSE_OFF);
}

/**
 * A terminal left in mouse-tracking mode prints garbage on every click, so
 * the restore sequence is written on every way out of the process.
 */
export function withAlternateScreenHome(chunk: string | Uint8Array): string | Uint8Array {
  if (chunk instanceof Uint8Array) {
    const text = Buffer.from(chunk).toString("utf8");
    if (!text.includes(ALT_SCREEN_ON) || text.includes(ALT_SCREEN_HOME)) return chunk;
    return Buffer.from(text.replaceAll(ALT_SCREEN_ON, ALT_SCREEN_HOME), "utf8");
  }
  return chunk.includes(ALT_SCREEN_ON) && !chunk.includes(ALT_SCREEN_HOME) ? chunk.replaceAll(ALT_SCREEN_ON, ALT_SCREEN_HOME) : chunk;
}

/**
 * Ensures entering `?1049h` and painting the first frame both clear and home
 * the alternate screen while preserving the saved main-screen cursor.
 */
export function installAlternateScreenHome(stdout: Pick<NodeJS.WriteStream, "write"> = process.stdout): () => void {
  const original = stdout.write.bind(stdout);
  let awaitingFirstFrame = false;
  stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    const isBytes = chunk instanceof Uint8Array;
    let text = isBytes ? Buffer.from(chunk).toString("utf8") : chunk;
    let changed = false;
    if (text.includes(ALT_SCREEN_ON)) {
      awaitingFirstFrame = true;
      if (!text.includes(ALT_SCREEN_HOME)) {
        text = text.replaceAll(ALT_SCREEN_ON, ALT_SCREEN_HOME);
        changed = true;
      }
    }
    if (awaitingFirstFrame && text.includes("\n")) {
      awaitingFirstFrame = false;
      if (!text.startsWith(CLEAR_AND_HOME) && !text.includes(ALT_SCREEN_HOME)) {
        text = `${CLEAR_AND_HOME}${text}`;
        changed = true;
      }
    }
    let out: string | Uint8Array = chunk;
    if (changed) out = isBytes ? Buffer.from(text, "utf8") : text;
    return (original as (...args: unknown[]) => boolean)(out, ...rest);
  }) as typeof stdout.write;
  return () => {
    stdout.write = original;
  };
}

export function installTerminalRestore(): void {
  process.on("exit", () => {
    disableMouse();
    if (process.stdin.isTTY) process.stdin.setRawMode?.(false);
  });
}
