import { writeSync } from "node:fs";

/**
 * Copies via OSC 52, which most modern terminals (and tmux with
 * `set-clipboard on`) support, locally and over SSH alike.
 */
export function copyToClipboard(text: string): void {
  const data = Buffer.from(text, "utf8").toString("base64");
  try {
    writeSync(1, `\x1b]52;c;${data}\x07`);
  } catch {
    // No terminal to copy through.
  }
}
