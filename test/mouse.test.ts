import { describe, expect, test } from "bun:test";
import { InputSplitter, decodeSgrMouse } from "../src/mouse/sgr.ts";
import { MouseBus, type Rect, type RegionHandlers } from "../src/mouse/bus.ts";
import { ALT_SCREEN_HOME, installAlternateScreenHome, withAlternateScreenHome } from "../src/mouse/terminal.ts";
import type { MouseEvent } from "../src/mouse/sgr.ts";

const press = (x: number, y: number, button: "left" | "right" = "left"): MouseEvent => ({
  kind: "press", button, x, y, shift: false, alt: false, ctrl: false,
});
const release = (x: number, y: number, button: "left" | "right" = "left"): MouseEvent => ({
  kind: "release", button, x, y, shift: false, alt: false, ctrl: false,
});

describe("decodeSgrMouse", () => {
  test("left press/release, 1-based to 0-based", () => {
    expect(decodeSgrMouse(0, 10, 5, "M")).toMatchObject({ kind: "press", button: "left", x: 9, y: 4 });
    expect(decodeSgrMouse(0, 10, 5, "m")).toMatchObject({ kind: "release", button: "left" });
  });
  test("right button with modifiers", () => {
    expect(decodeSgrMouse(2 | 4 | 16, 1, 1, "M")).toMatchObject({ button: "right", shift: true, ctrl: true, alt: false });
  });
  test("wheel and motion", () => {
    expect(decodeSgrMouse(64, 1, 1, "M")).toMatchObject({ kind: "wheel", direction: "up" });
    expect(decodeSgrMouse(65, 1, 1, "M")).toMatchObject({ kind: "wheel", direction: "down" });
    expect(decodeSgrMouse(32, 3, 3, "M")).toMatchObject({ kind: "move", button: "left" });
    expect(decodeSgrMouse(35, 3, 3, "M")).toMatchObject({ kind: "move", button: "none" });
  });
});

describe("InputSplitter", () => {
  test("separates mouse reports from typed text", () => {
    const s = new InputSplitter();
    const r = s.push("ab\x1b[<0;3;4Mcd\x1b[<0;3;4m");
    expect(r.passthrough).toBe("abcd");
    expect(r.events.map((e) => e.type === "mouse" && e.event.kind)).toEqual(["press", "release"]);
  });
  test("reassembles a report split across chunks", () => {
    const s = new InputSplitter();
    const a = s.push("x\x1b[<0;12");
    expect(a.passthrough).toBe("x");
    expect(a.events).toHaveLength(0);
    const b = s.push(";7M");
    expect(b.events[0]).toMatchObject({ type: "mouse", event: { x: 11, y: 6 } });
  });
  test("leaves other escape sequences to Ink", () => {
    const s = new InputSplitter();
    expect(s.push("\x1b[A\x1b[1;5C").passthrough).toBe("\x1b[A\x1b[1;5C");
  });
  test("focus events", () => {
    const s = new InputSplitter();
    expect(s.push("\x1b[O\x1b[I").events).toEqual([
      { type: "focus", focused: false },
      { type: "focus", focused: true },
    ]);
  });
  test("a lone Escape is held, then flushed", () => {
    const s = new InputSplitter();
    expect(s.push("\x1b").passthrough).toBe("");
    expect(s.hasPending()).toBe(true);
    expect(s.flush()).toBe("\x1b");
  });
});

function region(bus: MouseBus, rect: Rect, handlers: RegionHandlers, layer: "base" | "overlay" | "modal" = "base") {
  return bus.register({ getRect: () => rect, handlers: () => handlers, layer });
}

describe("MouseBus", () => {
  test("click needs press and release on the same region", () => {
    const bus = new MouseBus();
    const clicks: string[] = [];
    region(bus, { x: 0, y: 0, width: 10, height: 1 }, { onClick: () => clicks.push("a") });
    region(bus, { x: 0, y: 1, width: 10, height: 1 }, { onClick: () => clicks.push("b") });
    bus.dispatch(press(1, 0));
    bus.dispatch(release(1, 0));
    bus.dispatch(press(1, 0));
    bus.dispatch(release(1, 1));
    expect(clicks).toEqual(["a"]);
  });

  test("innermost region wins, falling back to an outer one with the handler", () => {
    const bus = new MouseBus();
    const got: string[] = [];
    region(bus, { x: 0, y: 0, width: 20, height: 10 }, { onClick: () => got.push("outer"), onWheel: () => got.push("outer-wheel") });
    region(bus, { x: 2, y: 2, width: 3, height: 1 }, { onClick: (e) => got.push(`inner@${e.localX}`) });
    bus.dispatch(press(3, 2));
    bus.dispatch(release(3, 2));
    bus.dispatch({ kind: "wheel", direction: "down", x: 3, y: 2, shift: false, alt: false, ctrl: false });
    expect(got).toEqual(["inner@1", "outer-wheel"]);
  });

  test("double click within the window", () => {
    let t = 1000;
    const bus = new MouseBus(() => t);
    const got: string[] = [];
    region(bus, { x: 0, y: 0, width: 5, height: 1 }, { onClick: () => got.push("click"), onDoubleClick: () => got.push("double") });
    bus.dispatch(press(1, 0)); bus.dispatch(release(1, 0));
    t += 200;
    bus.dispatch(press(1, 0)); bus.dispatch(release(1, 0));
    t += 1000;
    bus.dispatch(press(1, 0)); bus.dispatch(release(1, 0));
    expect(got).toEqual(["click", "double", "click"]);
  });

  test("release is delivered to the pressed region even outside it (push-to-talk)", () => {
    const bus = new MouseBus();
    const got: string[] = [];
    region(bus, { x: 0, y: 0, width: 5, height: 1 }, { onPress: () => got.push("down"), onRelease: () => got.push("up") });
    bus.dispatch(press(2, 0));
    bus.dispatch(release(40, 20));
    expect(got).toEqual(["down", "up"]);
  });

  test("modal blocks lower layers and right-click goes to onRightClick", () => {
    const bus = new MouseBus();
    const got: string[] = [];
    region(bus, { x: 0, y: 0, width: 80, height: 24 }, { onClick: () => got.push("base"), onRightClick: () => got.push("base-right") });
    const close = region(bus, { x: 10, y: 5, width: 20, height: 5 }, { onClick: () => got.push("modal"), onPressOutside: () => got.push("outside") }, "modal");
    bus.dispatch(press(0, 0)); bus.dispatch(release(0, 0));
    bus.dispatch(press(12, 6)); bus.dispatch(release(12, 6));
    close();
    bus.dispatch(press(0, 0, "right")); bus.dispatch(release(0, 0, "right"));
    expect(got).toEqual(["outside", "modal", "base-right"]);
  });
});

describe("InputSplitter keys (§6.2)", () => {
  test("kitty release events are dropped, presses and repeats pass", () => {
    const s = new InputSplitter();
    const r = s.push("\x1b[97;1:1u\x1b[97;1:2u\x1b[97;1:3u\x1b[1;1:3A");
    expect(r.passthrough).toBe("\x1b[97;1:1u\x1b[97;1:2u");
  });

  test("configured hold keys become events in kitty and legacy encodings", () => {
    const s = new InputSplitter();
    s.setHoldKeys(["f9", "f1", "ctrl+space"]);
    expect(s.push("\x1b[20;1:1~\x1b[20;1:3~").events).toEqual([
      { type: "key", key: "f9", action: "press" },
      { type: "key", key: "f9", action: "release" },
    ]);
    expect(s.push("\x1b[20~").events).toEqual([{ type: "key", key: "f9", action: "press" }]);
    expect(s.push("\x1bOP").events).toEqual([{ type: "key", key: "f1", action: "press" }]);
    expect(s.push("\x1b[32;5u").events).toEqual([{ type: "key", key: "ctrl+space", action: "press" }]);
    const nul = s.push("a\0b");
    expect(nul.passthrough).toBe("ab");
    expect(nul.events).toEqual([{ type: "key", key: "ctrl+space", action: "press" }]);
  });

  test("unconfigured function keys and modified keys pass through", () => {
    const s = new InputSplitter();
    s.setHoldKeys(["f9"]);
    expect(s.push("\x1b[21~\x1b[20;5~\x1b[1;5C").passthrough).toBe("\x1b[21~\x1b[20;5~\x1b[1;5C");
  });

  test("the kitty query reply is noted and still passed to Ink", () => {
    const s = new InputSplitter();
    const r = s.push("\x1b[?0u");
    expect(r.events).toEqual([{ type: "kitty" }]);
    expect(r.passthrough).toBe("\x1b[?0u");
  });

  test("a kitty key split across chunks is reassembled", () => {
    const s = new InputSplitter();
    s.setHoldKeys(["f9"]);
    expect(s.push("\x1b[20;1").events).toHaveLength(0);
    expect(s.push(":3~").events).toEqual([{ type: "key", key: "f9", action: "release" }]);
  });
});

describe("MouseBus drag (§6.4)", () => {
  test("motion with the button held goes to the pressed region, with local coordinates", () => {
    const bus = new MouseBus();
    const got: string[] = [];
    region(bus, { x: 2, y: 2, width: 10, height: 5 }, {
      onPress: (e) => got.push(`press ${e.localY}`),
      onDrag: (e) => got.push(`drag ${e.localY}`),
      onRelease: (e) => got.push(`release ${e.localY}`),
    });
    bus.dispatch(press(3, 3));
    bus.dispatch({ kind: "move", button: "left", x: 3, y: 9, shift: false, alt: false, ctrl: false });
    bus.dispatch(release(3, 9));
    expect(got).toEqual(["press 1", "drag 7", "release 7"]);
  });
});

describe("installAlternateScreenHome (§6.1)", () => {
  test("clears and homes the alternate screen after ?1049h for string and binary writes", () => {
    expect(withAlternateScreenHome("\x1b[?1049h\x1b[?25l")).toBe(`${ALT_SCREEN_HOME}\x1b[?25l`);
    expect(withAlternateScreenHome(`${ALT_SCREEN_HOME}\x1b[?25l`)).toBe(`${ALT_SCREEN_HOME}\x1b[?25l`);
    expect(withAlternateScreenHome("plain text")).toBe("plain text");
    const buf = withAlternateScreenHome(Buffer.from("\x1b[?1049h"));
    expect(Buffer.from(buf as Uint8Array).toString("utf8")).toBe(ALT_SCREEN_HOME);

    const written: string[] = [];
    const fakeStdout = {
      write(chunk: string | Uint8Array) {
        written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
        return true;
      },
    } as Pick<NodeJS.WriteStream, "write">;
    const restore = installAlternateScreenHome(fakeStdout);
    fakeStdout.write("\x1b[?1049h");
    restore();
    fakeStdout.write("\x1b[?1049h");
    expect(written).toEqual([ALT_SCREEN_HOME, "\x1b[?1049h"]);
  });
});
