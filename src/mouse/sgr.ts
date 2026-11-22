/**
 * Splits raw terminal input into mouse reports, focus events, hold keys and
 * everything else (architecture §6.2). Mouse reports are SGR (mode 1006):
 * `ESC [ < Cb ; Cx ; Cy (M|m)`. Focus events (mode 1004) are `ESC [ I` and
 * `ESC [ O`. Kitty keyboard release events are dropped (Ink would hand them
 * to every input handler as key presses), except for configured hold keys.
 *
 * Input arrives in arbitrary chunks, so a sequence can be split across two
 * of them. A trailing fragment that could still become a mouse/focus report
 * is held back until the next chunk, or until `flush()` (called by the tap
 * after a short timeout so a lone Escape key press is not delayed forever).
 */

export type MouseButton = "left" | "middle" | "right" | "none";
export type WheelDirection = "up" | "down" | "left" | "right";

export interface MouseModifiers {
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

export type MouseEvent =
  | ({ kind: "press" | "release" | "move"; button: MouseButton; x: number; y: number } & MouseModifiers)
  | ({ kind: "wheel"; direction: WheelDirection; x: number; y: number } & MouseModifiers);

export type HoldKeyName =
  | "f1" | "f2" | "f3" | "f4" | "f5" | "f6" | "f7" | "f8" | "f9" | "f10" | "f11" | "f12"
  | "ctrl+space" | "alt+space";

export type KeyAction = "press" | "repeat" | "release";

export type TerminalEvent =
  | { type: "mouse"; event: MouseEvent }
  | { type: "focus"; focused: boolean }
  | { type: "key"; key: HoldKeyName; action: KeyAction }
  /** The terminal answered the kitty keyboard query, so key releases will be reported. */
  | { type: "kitty" };

export interface SplitResult {
  /** Bytes that are not mouse/focus reports, in their original order. */
  passthrough: string;
  events: TerminalEvent[];
}

// A complete report, anchored at the current position.
const SGR_MOUSE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/;
const FOCUS = /^\x1b\[([IO])/;
// Kitty keyboard and legacy CSI keys: CSI [code[:alt..]] [; mods[:event]] [; text] final
const CSI_KEY = /^\x1b\[(\d+(?::\d*)*)?(?:;(\d+)(?::(\d+))?)?(?:;[\d:]*)?([u~A-Z])/;
// Answer to the kitty keyboard query `CSI ? u`.
const KITTY_REPLY = /^\x1b\[\?\d+u/;
// Legacy F1-F4: SS3 P/Q/R/S.
const SS3_KEY = /^\x1bO([PQRS])/;
// A fragment that could still grow into one of the above.
const PARTIAL = /^\x1b(?:\[(?:<[\d;]*|\?\d*|[\d:;]*))?$|^\x1bO?$/;

const TILDE_KEYS: Record<string, HoldKeyName> = {
  "11": "f1", "12": "f2", "13": "f3", "14": "f4", "15": "f5", "17": "f6",
  "18": "f7", "19": "f8", "20": "f9", "21": "f10", "23": "f11", "24": "f12",
};
const LETTER_KEYS: Record<string, HoldKeyName> = { P: "f1", Q: "f2", R: "f3", S: "f4" };
/** Modifier bits we ignore: Caps Lock and Num Lock. */
const LOCK_BITS = 64 | 128;

/** Maps one CSI key sequence to a hold key name, if it is one. */
function holdKeyOf(code: string | undefined, mods: number, final: string): HoldKeyName | undefined {
  const bits = (mods - 1) & ~LOCK_BITS;
  if (final === "u" && code?.split(":")[0] === "32") {
    if (bits === 4) return "ctrl+space";
    if (bits === 2) return "alt+space";
    return undefined;
  }
  if (bits !== 0) return undefined;
  if (final === "~") return code ? TILDE_KEYS[code.split(":")[0]!] : undefined;
  // `CSI P` or `CSI 1;mods P` (kitty F1-F4). F3 is never `CSI R` in kitty (that is a cursor report).
  if ((code === undefined || code === "1") && final !== "R") return LETTER_KEYS[final];
  return undefined;
}

function actionOf(event: string | undefined): KeyAction {
  return event === "3" ? "release" : event === "2" ? "repeat" : "press";
}

const BUTTONS: MouseButton[] = ["left", "middle", "right", "none"];
const WHEELS: WheelDirection[] = ["up", "down", "left", "right"];

export function decodeSgrMouse(cb: number, col: number, row: number, final: "M" | "m"): MouseEvent {
  const mods: MouseModifiers = {
    shift: (cb & 4) !== 0,
    alt: (cb & 8) !== 0,
    ctrl: (cb & 16) !== 0,
  };
  // SGR coordinates are 1-based; everything downstream is 0-based.
  const x = col - 1;
  const y = row - 1;
  if (cb & 64) {
    return { kind: "wheel", direction: WHEELS[cb & 3]!, x, y, ...mods };
  }
  const button = BUTTONS[cb & 3]!;
  if (cb & 32) return { kind: "move", button, x, y, ...mods };
  return { kind: final === "M" ? "press" : "release", button, x, y, ...mods };
}

export class InputSplitter {
  private pending = "";
  private holdKeys = new Set<HoldKeyName>();

  /** Keys reported as `key` events instead of being passed to Ink (§8.2). */
  setHoldKeys(keys: Iterable<HoldKeyName>): void {
    this.holdKeys = new Set(keys);
  }

  push(chunk: string): SplitResult {
    const text = this.pending + chunk;
    this.pending = "";
    const events: TerminalEvent[] = [];
    let passthrough = "";
    let i = 0;
    while (i < text.length) {
      const esc = text.indexOf("\x1b", i);
      const plain = esc === -1 ? text.slice(i) : text.slice(i, esc);
      passthrough += this.takeNul(plain, events);
      if (esc === -1) break;
      const rest = text.slice(esc);
      const mouse = SGR_MOUSE.exec(rest);
      if (mouse) {
        events.push({
          type: "mouse",
          event: decodeSgrMouse(Number(mouse[1]), Number(mouse[2]), Number(mouse[3]), mouse[4] as "M" | "m"),
        });
        i = esc + mouse[0].length;
        continue;
      }
      const focus = FOCUS.exec(rest);
      if (focus) {
        events.push({ type: "focus", focused: focus[1] === "I" });
        i = esc + focus[0].length;
        continue;
      }
      if (KITTY_REPLY.test(rest)) {
        // Ink needs the reply to enable the protocol; we only take note.
        const m = KITTY_REPLY.exec(rest)!;
        events.push({ type: "kitty" });
        passthrough += m[0];
        i = esc + m[0].length;
        continue;
      }
      const key = CSI_KEY.exec(rest);
      if (key) {
        const [seq, code, mods, event, final] = key;
        const hold = holdKeyOf(code, mods ? Number(mods) : 1, final!);
        const action = actionOf(event);
        if (hold && this.holdKeys.has(hold)) events.push({ type: "key", key: hold, action });
        else if (action !== "release") passthrough += seq;
        i = esc + seq.length;
        continue;
      }
      const ss3 = SS3_KEY.exec(rest);
      if (ss3) {
        const hold = LETTER_KEYS[ss3[1]!];
        if (hold && this.holdKeys.has(hold)) events.push({ type: "key", key: hold, action: "press" });
        else passthrough += ss3[0];
        i = esc + ss3[0].length;
        continue;
      }
      if (rest.startsWith("\x1b ") && this.holdKeys.has("alt+space")) {
        events.push({ type: "key", key: "alt+space", action: "press" });
        i = esc + 2;
        continue;
      }
      if (PARTIAL.test(rest)) {
        this.pending = rest;
        break;
      }
      // Some other escape sequence (arrow keys, kitty keys, ...): leave it to Ink.
      passthrough += "\x1b";
      i = esc + 1;
    }
    return { passthrough, events };
  }

  /** Legacy terminals send Ctrl+Space as NUL. */
  private takeNul(text: string, events: TerminalEvent[]): string {
    if (!text.includes("\0") || !this.holdKeys.has("ctrl+space")) return text;
    for (const _ of text.matchAll(/\0/g)) events.push({ type: "key", key: "ctrl+space", action: "press" });
    return text.replaceAll("\0", "");
  }

  hasPending(): boolean {
    return this.pending.length > 0;
  }

  /** Gives up on a held-back fragment and returns it as plain input. */
  flush(): string {
    const out = this.pending;
    this.pending = "";
    return out;
  }
}
