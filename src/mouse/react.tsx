import { createContext, useContext, useEffect, useRef, type ReactNode, type RefObject } from "react";
import { measureElement, type DOMElement } from "ink";
import { MouseBus, type Layer, type Rect, type RegionHandlers } from "./bus.ts";

const MouseContext = createContext<MouseBus | null>(null);

export function MouseProvider({ bus, children }: { bus: MouseBus; children: ReactNode }) {
  return <MouseContext.Provider value={bus}>{children}</MouseContext.Provider>;
}

export function useMouseBus(): MouseBus | null {
  return useContext(MouseContext);
}

/**
 * Absolute screen rectangle of an Ink element. The app renders full-screen
 * in the alternate screen from (0,0), so layout coordinates are screen
 * coordinates. Scrolled containers are not used for hit-tested content
 * (lists window their rows instead), so no contentOffset correction is needed.
 */
export function elementRect(node: DOMElement | null): Rect | undefined {
  if (!node?.yogaNode) return undefined;
  const { x, y, width, height } = measureElement(node);
  return { x, y, width, height };
}

/**
 * Makes an Ink `<Box ref={ref}>` respond to the mouse. Handlers are read
 * through a ref, so passing a fresh object every render does not re-register.
 */
export function useMouseRegion(
  ref: RefObject<DOMElement | null>,
  handlers: RegionHandlers,
  options: { layer?: Layer; enabled?: boolean } = {},
): void {
  const bus = useMouseBus();
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const layer = options.layer ?? "base";
  const enabled = options.enabled ?? true;
  useEffect(() => {
    if (!bus || !enabled) return;
    return bus.register({
      getRect: () => elementRect(ref.current),
      handlers: () => handlersRef.current,
      layer,
    });
  }, [bus, ref, layer, enabled]);
}

/** Subscribes to terminal focus changes (mode 1004). */
export function useTerminalFocus(listener: (focused: boolean) => void): void {
  const bus = useMouseBus();
  const listenerRef = useRef(listener);
  listenerRef.current = listener;
  useEffect(() => bus?.onFocusChange((focused) => listenerRef.current(focused)), [bus]);
}
