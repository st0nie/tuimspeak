import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { App } from "../src/app/App.tsx";
import { Controller } from "../src/app/controller.ts";
import { DEFAULT_CONFIG } from "../src/config/config.ts";
import { createDemoConnector } from "../src/demo/connector.ts";
import { MouseBus } from "../src/mouse/bus.ts";
import { MouseProvider } from "../src/mouse/react.tsx";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mount(options: { bookmarks?: { name: string; address: string }[]; onQuit?: () => void } = {}) {
  const controller = new Controller({
    config: { ...DEFAULT_CONFIG, sounds: false },
    bookmarks: options.bookmarks ?? [],
    persist: false,
    connectorFactory: createDemoConnector,
  });
  const bus = new MouseBus();
  const ui = render(
    <MouseProvider bus={bus}>
      <App controller={controller} onQuit={options.onQuit ?? (() => {})} />
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

  test("welcome screen Enter opens connect dialog and arrows navigate top bar actions", async () => {
    let quitCalled = 0;
    const { controller, ui } = mount({ onQuit: () => quitCalled++ });
    await wait(30);
    ui.stdin.write("\r");
    await wait(50);
    expect(ui.lastFrame()).toContain("Connect to server");
    ui.stdin.write("\x1b");
    await wait(50);
    expect(ui.lastFrame()).not.toContain("Connect to server");

    // Down arrow moves from [ Connect to a server ] to [Settings]; Enter opens Settings.
    ui.stdin.write("\x1b[B");
    await wait(30);
    ui.stdin.write("\r");
    await wait(50);
    expect(ui.lastFrame()).toContain("Talk mode");
    ui.stdin.write("\x1b");
    await wait(50);

    // Right arrow moves from [Settings] to [?]; Enter opens help.
    ui.stdin.write("\x1b[C");
    await wait(30);
    ui.stdin.write("\r");
    await wait(50);
    expect(ui.lastFrame()).toContain("tuimspeak help");
    ui.stdin.write("?");
    await wait(50);

    ui.stdin.write("q");
    await wait(30);
    expect(quitCalled).toBe(1);
    ui.unmount();
    await controller.shutdown();
  });

  test("connect dialog supports full arrow-key traversal through bookmarks, fields, toggles, and buttons", async () => {
    const { controller, ui } = mount({ bookmarks: [{ name: "SavedBox", address: "saved.example.com" }] });
    controller.openDialog({ kind: "connect" });
    await wait(50);

    // Up from Address reaches Bookmark [ Connect ], Right reaches [Edit], Enter opens Edit bookmark.
    ui.stdin.write("\x1b[A");
    await wait(30);
    ui.stdin.write("\x1b[C");
    await wait(30);
    ui.stdin.write("\r");
    await wait(50);
    expect(ui.lastFrame()).toContain("Edit bookmark SavedBox");

    // Reopen fresh Connect dialog; empty submit notifies and stays on Address.
    controller.openDialog({ kind: "connect" });
    await wait(50);
    for (let i = 0; i < 5; i++) {
      ui.stdin.write("\r");
      await wait(20);
    }
    expect(controller.state.notice?.text).toContain("Enter a server address");

    // Type demo into Address, arrow down past Name into Save as bookmark, toggle with Space, then Connect.
    ui.stdin.write("demo");
    await wait(30);
    for (let i = 0; i < 5; i++) {
      ui.stdin.write("\x1b[B");
      await wait(20);
    }
    // Now focused on [ ] Save as bookmark.
    ui.stdin.write(" ");
    await wait(30);
    expect(ui.lastFrame()).toContain("[x] Save as bookmark");

    ui.stdin.write("\x1b[C");
    await wait(20);
    ui.stdin.write(" ");
    await wait(30);
    expect(ui.lastFrame()).toContain("[x] Store password in bookmark");

    // Down to [ Connect ] button and press Enter.
    ui.stdin.write("\x1b[B");
    await wait(20);
    ui.stdin.write("\r");
    await wait(500);
    expect(controller.state.bookmarks.map((b) => b.address)).toContain("demo");
    expect(ui.lastFrame()).toContain("tuimspeak demo");
    ui.unmount();
    await controller.shutdown();
  });

  test("settings and away dialogs work completely with arrows, Space, and Enter", async () => {
    const { controller, ui } = mount();
    controller.connect({ address: "demo", nickname: "tester" });
    await wait(500);

    controller.openDialog({ kind: "settings" });
    await wait(50);
    expect(controller.state.config.talkMode).toBe("vad");
    // Enter on row 0 cycles talkMode without closing Settings.
    ui.stdin.write("\r");
    await wait(30);
    expect(controller.state.config.talkMode).toBe("toggle");
    expect(controller.state.dialog?.kind).toBe("settings");

    // Up from row 0 wraps to [ Close ] (last row), Enter closes Settings.
    ui.stdin.write("\x1b[A");
    await wait(30);
    ui.stdin.write("\r");
    await wait(50);
    expect(controller.state.dialog).toBeNull();

    // Away dialog: Up from Message focuses preset buttons, Right picks Busy, Enter sets away.
    controller.openDialog({ kind: "away" });
    await wait(50);
    ui.stdin.write("\x1b[A");
    await wait(20);
    ui.stdin.write("\x1b[C");
    await wait(20);
    ui.stdin.write("\r");
    await wait(50);
    expect(controller.activeSession()?.store.getState().away).toBe(true);
    expect(controller.activeSession()?.store.getState().awayMessage).toBe("Busy");

    ui.unmount();
    await controller.shutdown();
  });

  test("TextInput preserves caret on Enter field advance and steps by Unicode code points", async () => {
    const { controller, ui } = mount();
    controller.openDialog({ kind: "connect" });
    await wait(50);

    // Type emoji + CJK in Address, step left once (over CJK), backspace (deletes emoji), then Enter advances to Nickname.
    ui.stdin.write("😀中");
    await wait(30);
    ui.stdin.write("\x1b[D");
    await wait(20);
    ui.stdin.write("\x7f");
    await wait(30);
    expect(ui.lastFrame()).toContain("Address  中");

    // Advance to Nickname with Enter, then back Up to Address and type "!" — inserts at preserved caret (before "中").
    ui.stdin.write("\r");
    await wait(30);
    ui.stdin.write("\x1b[A");
    await wait(30);
    ui.stdin.write("!");
    await wait(30);
    expect(ui.lastFrame()).toContain("Address  !中");

    ui.unmount();
    await controller.shutdown();
  });
});
