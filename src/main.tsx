#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { render } from "ink";
import { App } from "./app/App.tsx";
import { Controller } from "./app/controller.ts";
import { loadBookmarks, loadConfig } from "./config/config.ts";
import { MouseBus } from "./mouse/bus.ts";
import { MouseProvider } from "./mouse/react.tsx";
import { StdinTap } from "./mouse/tap.ts";
import { disableMouse, enableMouse, installAlternateScreenHome, installTerminalRestore } from "./mouse/terminal.ts";
import { audioBinary, connectorBinary } from "./native.ts";
import { parseAddress } from "./connector/address.ts";
import { createDemoConnector } from "./demo/connector.ts";
import { AudioProcess } from "./audio/process.ts";
import { log } from "./log.ts";
import { paths } from "./config/paths.ts";
import { VERSION } from "./version.ts";
import { startupUpdateCheck, updateCommand } from "./update.ts";

const USAGE = `Usage: tuimspeak [address | ts3server://link] [options]
       tuimspeak update              Install the latest release

Options:
  -a, --address <host[:port]>   Server to connect to
  -n, --nickname <name>         Nickname (default: from config, then your user name)
  -c, --channel <path>          Channel to join, e.g. "Lobby/Sub"
      --demo                    Simulated server, no network or audio needed
      --list-devices            Print audio devices with their ids and exit
      --debug                   Verbose log, including connector and audio stderr (${paths.logFile})
  -v, --version                 Print the version
  -h, --help                    Show this help

Environment: TS_SERVER_PASSWORD (server password), TUIMSPEAK_CONNECTOR_BIN, TUIMSPEAK_AUDIO_BIN.
See docs/configuration.md.
`;

function parse() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        address: { type: "string", short: "a" },
        nickname: { type: "string", short: "n" },
        channel: { type: "string", short: "c" },
        demo: { type: "boolean" },
        "list-devices": { type: "boolean" },
        debug: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }
}

async function listDevices(): Promise<void> {
  const binary = audioBinary();
  if (!binary) {
    process.stderr.write("tuim-audio not found. Run `bun run build:native`.\n");
    process.exit(1);
  }
  const audio = new AudioProcess(binary);
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 3000);
    audio.on("event", (e) => {
      if (e.event === "devices") {
        process.stdout.write(`Host: ${e.host}\n\nInputs:\n`);
        for (const d of e.inputs) process.stdout.write(`  ${d.isDefault ? "*" : " "} ${d.name}\n      id: ${d.id}\n`);
        process.stdout.write("\nOutputs:\n");
        for (const d of e.outputs) process.stdout.write(`  ${d.isDefault ? "*" : " "} ${d.name}\n      id: ${d.id}\n`);
        clearTimeout(timer);
        resolve();
      } else if (e.event === "error") {
        process.stderr.write(`error: ${e.message}\n`);
      }
    });
    audio.start();
    audio.listDevices();
  });
  audio.stop();
}

async function main(): Promise<void> {
  const { values, positionals } = parse();
  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (values.version) {
    process.stdout.write(`tuimspeak ${VERSION}\n`);
    return;
  }
  if (positionals[0] === "update") {
    process.exit(await updateCommand((line) => process.stdout.write(`${line}\n`)));
  }
  log.setDebug(Boolean(values.debug));
  if (values["list-devices"]) return listDevices();
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write("tuimspeak needs an interactive terminal.\n");
    process.exit(1);
  }

  const config = loadConfig();
  const demo = Boolean(values.demo);
  const controller = new Controller({
    config,
    bookmarks: loadBookmarks(),
    connectorBinary: connectorBinary(),
    audioBinary: demo ? undefined : audioBinary(),
    connectorFactory: demo ? createDemoConnector : undefined,
    persist: !demo,
  });
  if (demo) controller.store.setState({ audio: { state: "unavailable", message: "demo mode" } });

  const bus = new MouseBus();
  const tap = new StdinTap();
  tap.on("mouse", (e) => bus.dispatch(e));
  tap.on("focus", (focused) => bus.dispatchFocus(focused));
  // Hold keys and F1/F2 (§6.2, §8.2); follow config changes.
  tap.on("key", (key, action) => controller.holdKey(key, action));
  tap.on("kitty", () => controller.kittyDetected());
  tap.setHoldKeys(controller.holdKeys());
  controller.store.subscribe((state, prev) => {
    if (state.config.pttKey !== prev.config.pttKey || state.config.whisperKey !== prev.config.whisperKey) tap.setHoldKeys(controller.holdKeys());
  });

  installAlternateScreenHome();
  installTerminalRestore();
  let quitting = false;
  const quit = async () => {
    if (quitting) return;
    quitting = true;
    instance.unmount();
    disableMouse();
    await controller.shutdown();
    tap.dispose();
    process.exit(0);
  };
  for (const signal of ["SIGTERM", "SIGHUP"] as const) process.on(signal, () => void quit());
  process.on("uncaughtException", (err) => {
    log.error(`uncaught: ${err.stack ?? err}`);
    disableMouse();
    process.stderr.write(`tuimspeak crashed: ${err.message}\nSee ${paths.logFile}\n`);
    process.exit(1);
  });

  const instance = render(
    <MouseProvider bus={bus}>
      <App controller={controller} onQuit={() => void quit()} />
    </MouseProvider>,
    {
      stdin: tap.stdin as unknown as NodeJS.ReadStream,
      exitOnCtrlC: false,
      alternateScreen: true,
      incrementalRendering: true,
      patchConsole: true,
      // Key release events make hold keys work (§8.2); the tap strips them before Ink sees them.
      kittyKeyboard: { mode: "auto", flags: ["disambiguateEscapeCodes", "reportEventTypes"] },
    },
  );
  enableMouse();
  controller.startAudio();

  // §12.4: once a day, in the background; failures only go to the log.
  if (!demo) {
    startupUpdateCheck(config.autoUpdate)
      .then((outcome) => {
        if (outcome.kind === "installed") controller.notify(`Updated to ${outcome.version}; restart tuimspeak to use it`);
        else if (outcome.kind === "available") controller.notify(`tuimspeak ${outcome.version} is available: run \`tuimspeak update\``);
      })
      .catch((err: Error) => log.info(`update check failed: ${err.message}`));
  }

  const target = values.address ?? positionals[0] ?? (demo ? "demo.tuimspeak.invalid" : undefined);
  if (target) {
    const parsed = parseAddress(target);
    controller.connect({
      ...parsed,
      nickname: values.nickname ?? parsed.nickname ?? config.nickname,
      defaultChannel: values.channel ?? parsed.defaultChannel,
      serverPassword: parsed.serverPassword ?? process.env.TS_SERVER_PASSWORD,
    });
  }
}

void main();
