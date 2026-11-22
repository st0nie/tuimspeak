import stringWidth from "string-width";
import type { IconSet } from "../config/config.ts";

export interface Icons {
  expanded: string;
  collapsed: string;
  idle: string;
  talking: string;
  away: string;
  micMuted: string;
  speakerMuted: string;
  lock: string;
  commander: string;
  server: string;
  /** Status icon of someone whispering to us (§8.3). */
  whispering: string;
  /** Flag of a whisper target. */
  whisperTarget: string;
  /** Flag of a locally muted client (§8.4). */
  localMute: string;
}

const ICONS: Record<IconSet, Icons> = {
  // `●○▸▾` are East Asian "ambiguous width": switch to "ascii" if they misalign in a CJK locale.
  unicode: { expanded: "▾", collapsed: "▸", idle: "○", talking: "●", away: "◌", micMuted: "m", speakerMuted: "s", lock: "*", commander: "+", server: "≡", whispering: "◆", whisperTarget: "»", localMute: "x" },
  ascii: { expanded: "v", collapsed: ">", idle: "o", talking: "@", away: "~", micMuted: "m", speakerMuted: "s", lock: "*", commander: "+", server: "#", whispering: "w", whisperTarget: ">", localMute: "x" },
  nerdfont: {
    expanded: "",
    collapsed: "",
    idle: "",
    talking: "",
    away: "",
    micMuted: "",
    speakerMuted: "",
    lock: "",
    commander: "",
    server: "",
    whispering: "\uf0e5",
    whisperTarget: "\uf1d8",
    localMute: "\uf6a9",
  },
};

export function icons(set: IconSet): Icons {
  return ICONS[set] ?? ICONS.unicode;
}

export const colors = {
  accent: "cyan",
  talking: "green",
  away: "yellow",
  muted: "red",
  dim: "gray",
  error: "red",
  poke: "magenta",
  whisper: "magenta",
  drop: "blue",
  self: "cyan",
} as const;

/** Pads or truncates to an exact display width (CJK-aware). */
export function fit(text: string, width: number): string {
  if (width <= 0) return "";
  let w = stringWidth(text);
  if (w <= width) return text + " ".repeat(width - w);
  let out = "";
  w = 0;
  for (const ch of text) {
    const cw = stringWidth(ch);
    if (w + cw > width - 1) break;
    out += ch;
    w += cw;
  }
  return `${out}…${" ".repeat(Math.max(0, width - w - 1))}`;
}

export { stringWidth };
