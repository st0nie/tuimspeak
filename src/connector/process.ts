import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import { parseEvent, type ConnectorEvent } from "./protocol.ts";
import { commands } from "./commands.ts";
import { log } from "../log.ts";

export type ServerType = "auto" | "teamspeak" | "teaspeak";

export interface ConnectOptions {
  address: string;
  nickname: string;
  serverPassword?: string;
  channelPassword?: string;
  defaultChannel?: string;
  identity?: string;
  privilegeKey?: string;
  serverType?: ServerType;
}

/** Anything that behaves like a connector: the real process or the demo simulator. */
export interface ConnectorLike {
  on(event: "event", listener: (event: ConnectorEvent) => void): this;
  on(event: "exit", listener: (code: number | null) => void): this;
  send(line: string): void;
  disconnect(message?: string): Promise<void>;
}

const EXIT_TIMEOUT_MS = 3000;

/**
 * Wraps one ts-connector child process (one per server connection).
 * Lifecycle handling follows webspeak3's gateway/src/ts3/connection.ts.
 */
export class ConnectorProcess extends EventEmitter implements ConnectorLike {
  private child: ChildProcessWithoutNullStreams | undefined;
  private exited = false;

  constructor(
    private readonly binary: string,
    private readonly options: ConnectOptions,
  ) {
    super();
  }

  start(): void {
    // "--flag=value" so a value starting with "-" is never parsed as a flag.
    // Secrets go through the environment, not argv (readable via `ps`).
    const args = [`--address=${this.options.address}`, `--nickname=${this.options.nickname}`];
    if (this.options.defaultChannel) args.push(`--default-channel=${this.options.defaultChannel}`);
    if (this.options.serverType) args.push(`--server-type=${this.options.serverType}`);
    const env: NodeJS.ProcessEnv = { ...process.env, RUST_LOG: process.env.RUST_LOG ?? "error" };
    const secret = (key: string, value: string | undefined) => {
      if (value) env[key] = value;
      else delete env[key];
    };
    secret("TS_SERVER_PASSWORD", this.options.serverPassword);
    secret("TS_CHANNEL_PASSWORD", this.options.channelPassword);
    secret("TS_IDENTITY", this.options.identity);
    secret("TS_PRIVILEGE_KEY", this.options.privilegeKey);

    const child = spawn(this.binary, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    // The connector can exit on its own and close stdin; a later write would
    // raise EPIPE as an unhandled error and crash the whole app.
    child.stdin.on("error", () => {});
    child.on("error", (err) => {
      this.exited = true;
      this.emit("event", { type: "error", message: `Connector failed to start: ${err.message}` } satisfies ConnectorEvent);
      this.emit("exit", null);
    });
    child.on("exit", (code) => {
      this.exited = true;
      this.emit("exit", code);
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      const event = parseEvent(line);
      if (event) this.emit("event", event);
    });
    createInterface({ input: child.stderr }).on("line", (line) => log.debug(`[connector] ${line}`));
  }

  send(line: string): void {
    const child = this.child;
    if (!child || this.exited || child.stdin.destroyed) return;
    child.stdin.write(`${line.replace(/[\r\n]+/g, " ")}\n`);
  }

  async disconnect(message = ""): Promise<void> {
    const child = this.child;
    if (!child || this.exited) return;
    this.send(commands.disconnect(message));
    child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, EXIT_TIMEOUT_MS);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Synchronous last resort for process exit. */
  kill(): void {
    if (this.child && !this.exited) this.child.kill();
  }
}
