import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { App } from "../src/app/App.tsx";
import { Controller } from "../src/app/controller.ts";
import { DEFAULT_CONFIG } from "../src/config/config.ts";
import { createDemoConnector } from "../src/demo/connector.ts";
import { MouseBus } from "../src/mouse/bus.ts";
import { MouseProvider } from "../src/mouse/react.tsx";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mount() {
  const controller = new Controller({ config: { ...DEFAULT_CONFIG, sounds: false }, bookmarks: [], persist: false, connectorFactory: createDemoConnector });
  const bus = new MouseBus();
  const ui = render(
    <MouseProvider bus={bus}>
      <App controller={controller} onQuit={() => {}} />
    </MouseProvider>,
  );
  const click = (x: number, y: number, button: "left" | "right" = "left") => {
    const base = { button, x, y, shift: false, alt: false, ctrl: false } as const;
    bus.dispatch({ kind: "press", ...base });
    bus.dispatch({ kind: "release", ...base });
  };
  const find = (text: string) => {
    const lines = (ui.lastFrame() ?? "").split("\n");
    for (let y = 0; y < lines.length; y++) {
      const x = lines[y]!.indexOf(text);
      if (x >= 0) return { x, y };
    }
    throw new Error(`"${text}" not on screen:\n${ui.lastFrame()}`);
  };
  return { controller, ui, click, find };
}

describe("App with the demo server", () => {
  test("welcome screen, connect dialog, then the tree", async () => {
    const { controller, ui, click, find } = mount();
    expect(ui.lastFrame()).toContain("Connect to a server");
    const button = find("Connect to a server");
    click(button.x + 2, button.y);
    await wait(50);
    expect(ui.lastFrame()).toContain("Connect to server");
    controller.closeDialog();
    controller.connect({ address: "demo", nickname: "tester" });
    await wait(500);
    expect(ui.lastFrame()).toContain("tuimspeak demo");
    expect(ui.lastFrame()).toContain("alice");
    ui.unmount();
    await controller.shutdown();
  });

  test("right-click opens a client menu; double-click joins a channel", async () => {
    const { controller, ui, click, find } = mount();
    controller.connect({ address: "demo", nickname: "tester" });
    await wait(500);
    const bob = find("bob");
    click(bob.x, bob.y, "right");
    await wait(50);
    expect(ui.lastFrame()).toContain("Whisper to");
    controller.closeDialog();
    await wait(50);
    const gaming = find("Gaming");
    click(gaming.x, gaming.y);
    click(gaming.x, gaming.y);
    await wait(300);
    const session = controller.activeSession()!;
    const s = session.store.getState().snapshot!;
    expect(s.clients.find((c) => c.id === s.ownClientId)?.channel).toBe(3);
    ui.unmount();
    await controller.shutdown();
  });
});
