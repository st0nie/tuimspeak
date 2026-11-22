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
export const MOUSE_OFF = "\x1b[?1004l\x1b[?1006l\x1b[?1002l\x1b[?1000l";
/** Motion with no button held; only enabled while hover matters (menus). */
export const HOVER_ON = "\x1b[?1003h";
export const HOVER_OFF = "\x1b[?1003l";

let enabled = false;
let hover = false;

function write(sequence: string): void {
  // Synchronous on purpose: this also runs from process 'exit', where
  // asynchronous stream writes are dropped.
  try {
    writeSync(1, sequence);
  } catch {
    // stdout already gone; nothing left to restore.
  }
}

export function enableMouse(): void {
  if (enabled) return;
  enabled = true;
  write(MOUSE_ON);
}

export function setHoverTracking(on: boolean): void {
  if (!enabled || hover === on) return;
  hover = on;
  write(on ? HOVER_ON : HOVER_OFF);
}

export function disableMouse(): void {
  if (!enabled) return;
  if (hover) write(HOVER_OFF);
  hover = false;
  enabled = false;
  write(MOUSE_OFF);
}

/**
 * A terminal left in mouse-tracking mode prints garbage on every click, so
 * the restore sequence is written on every way out of the process.
 */
export function installTerminalRestore(): void {
  process.on("exit", disableMouse);
}
