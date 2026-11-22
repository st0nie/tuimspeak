import { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { EventEmitter } from "node:events";
import { InputSplitter, type HoldKeyName, type KeyAction, type MouseEvent } from "./sgr.ts";

/** How long a possible start of a mouse report is held before it is passed on as-is. */
const PENDING_FLUSH_MS = 25;

type RawStdin = NodeJS.ReadStream & { setRawMode?: (mode: boolean) => unknown };

export interface TapEvents {
  mouse: [MouseEvent];
  focus: [boolean];
  key: [HoldKeyName, KeyAction];
  kitty: [];
}

/**
 * Sits between the real stdin and Ink. Ink reads its input through the
 * `readable` event, so adding our own `data` listener to process.stdin would
 * steal bytes from it. Instead we own process.stdin, strip mouse and focus
 * reports out, and feed the rest to Ink through `stdin`, a proxy stream that
 * looks like a TTY (Ink only enables raw mode on streams with `isTTY` and
 * `setRawMode`).
 */
export class StdinTap extends EventEmitter<TapEvents> {
  readonly stdin: Readable & { isTTY: boolean; setRawMode: (mode: boolean) => unknown };
  private readonly splitter = new InputSplitter();
  private readonly decoder = new StringDecoder("utf8");
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly onData = (chunk: Buffer | string) => this.handle(typeof chunk === "string" ? chunk : this.decoder.write(chunk));

  constructor(private readonly source: RawStdin = process.stdin) {
    super();
    const proxy = new Readable({ read() {} }) as StdinTap["stdin"];
    proxy.isTTY = Boolean(source.isTTY);
    proxy.setRawMode = (mode: boolean) => {
      source.setRawMode?.(mode);
      return proxy;
    };
    // Ink refs/unrefs stdin around raw mode so an idle app can exit; forward
    // that to the real stream, which is what actually holds the event loop.
    (proxy as unknown as { ref: () => void }).ref = () => source.ref();
    (proxy as unknown as { unref: () => void }).unref = () => source.unref();
    this.stdin = proxy;
    source.on("data", this.onData);
  }

  /** Feeds input as if it came from the terminal (tests, and the real `data` listener). */
  handle(text: string): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    const { passthrough, events } = this.splitter.push(text);
    for (const event of events) {
      if (event.type === "mouse") this.emit("mouse", event.event);
      else if (event.type === "focus") this.emit("focus", event.focused);
      else if (event.type === "key") this.emit("key", event.key, event.action);
      else this.emit("kitty");
    }
    if (passthrough) this.stdin.push(passthrough);
    if (this.splitter.hasPending()) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        const rest = this.splitter.flush();
        if (rest) this.stdin.push(rest);
      }, PENDING_FLUSH_MS);
    }
  }

  setHoldKeys(keys: Iterable<HoldKeyName>): void {
    this.splitter.setHoldKeys(keys);
  }

  dispose(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.source.off("data", this.onData);
  }
}
