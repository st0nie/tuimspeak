/**
 * Minimal BBCode handling for TeamSpeak chat: [b], [i], [u], [s], [color]
 * and [url] become styled segments; anything else is dropped as a tag and
 * its text kept.
 */

export interface Segment {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  color?: string;
  url?: string;
}

const TAG = /\[(\/?)([a-z*]+)(?:=([^\]]*))?\]/gi;

export function parseBBCode(input: string): Segment[] {
  const segments: Segment[] = [];
  const style: Omit<Segment, "text"> = {};
  const colors: string[] = [];
  const urls: (string | undefined)[] = [];
  let last = 0;
  const push = (text: string) => {
    if (text) segments.push({ text, ...style });
  };
  for (const m of input.matchAll(TAG)) {
    push(input.slice(last, m.index));
    last = m.index! + m[0].length;
    const closing = m[1] === "/";
    const tag = m[2]!.toLowerCase();
    const arg = m[3];
    switch (tag) {
      case "b":
        style.bold = !closing || undefined;
        break;
      case "i":
        style.italic = !closing || undefined;
        break;
      case "u":
        style.underline = !closing || undefined;
        break;
      case "s":
        style.strikethrough = !closing || undefined;
        break;
      case "color":
        if (closing) colors.pop();
        else if (arg) colors.push(arg.replace(/^"|"$/g, ""));
        style.color = colors[colors.length - 1];
        break;
      case "url":
        if (closing) urls.pop();
        else urls.push(arg?.replace(/^"|"$/g, ""));
        style.url = urls[urls.length - 1];
        // [url]https://x[/url] has no argument: the text is the link.
        if (!closing && !arg) style.url = "";
        break;
      default:
        break;
    }
  }
  push(input.slice(last));
  return segments
    .map((s) => (s.url === "" ? { ...s, url: s.text } : s))
    .map((s) => (s.url === undefined ? withoutUndefined(s) : s));
}

function withoutUndefined(s: Segment): Segment {
  return Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined)) as unknown as Segment;
}

export function plainText(input: string): string {
  return parseBBCode(input)
    .map((s) => s.text)
    .join("");
}

/** OSC 8 hyperlink; terminals make it clickable (with a modifier while mouse tracking is on). */
export function hyperlink(text: string, url: string): string {
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}
