import type { MouseButton, MouseEvent, MouseModifiers, WheelDirection } from "./sgr.ts";

export type Layer = "base" | "overlay" | "modal";
const LAYER_RANK: Record<Layer, number> = { base: 0, overlay: 1, modal: 2 };

export const DOUBLE_CLICK_MS = 400;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RegionEvent extends MouseModifiers {
  /** Absolute screen cell, 0-based. */
  x: number;
  y: number;
  /** Position relative to the region's top-left corner. */
  localX: number;
  localY: number;
  button: MouseButton;
}

export interface WheelRegionEvent extends RegionEvent {
  direction: WheelDirection;
}

export interface RegionHandlers {
  onClick?: (e: RegionEvent) => void;
  /** Fires on the second click; the first click already fired onClick. */
  onDoubleClick?: (e: RegionEvent) => void;
  onRightClick?: (e: RegionEvent) => void;
  onWheel?: (e: WheelRegionEvent) => void;
  /** Left button went down inside the region. */
  onPress?: (e: RegionEvent) => void;
  /** Left button came up after an onPress here, wherever the pointer is now. */
  onRelease?: (e: RegionEvent) => void;
  /** Pointer moved with the left button held after an onPress here (§6.4). Local coordinates may be outside the region. */
  onDrag?: (e: RegionEvent) => void;
  /** Pointer moved inside the region (needs hover tracking for button-less motion). */
  onHover?: (e: RegionEvent) => void;
  onLeave?: () => void;
  /** Any button went down outside this region (closing menus and popups). */
  onPressOutside?: () => void;
}

export interface Region {
  /** Current absolute rectangle, computed on demand so layout changes never go stale. */
  getRect: () => Rect | undefined;
  handlers: () => RegionHandlers;
  layer: Layer;
}

type ClickKind = "onClick" | "onDoubleClick" | "onRightClick";

interface Hit {
  id: number;
  region: Region;
  rect: Rect;
}

function contains(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

/**
 * Turns raw mouse reports into region-level gestures. Framework-agnostic so
 * it can be unit-tested without rendering anything; the React side only
 * registers regions.
 */
export class MouseBus {
  private nextId = 1;
  private readonly regions = new Map<number, Region>();
  private readonly focusListeners = new Set<(focused: boolean) => void>();
  /** Region that received onPress for the left button, to deliver onRelease. */
  private pressed: number | undefined;
  /** Region a click started on, per button, to require press and release on the same target. */
  private readonly clickStart = new Map<MouseButton, number>();
  private lastClick: { id: number; x: number; y: number; time: number } | undefined;
  private hovered: number | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  register(region: Region): () => void {
    const id = this.nextId++;
    this.regions.set(id, region);
    return () => {
      this.regions.delete(id);
      if (this.pressed === id) this.pressed = undefined;
      if (this.hovered === id) this.hovered = undefined;
    };
  }

  onFocusChange(listener: (focused: boolean) => void): () => void {
    this.focusListeners.add(listener);
    return () => this.focusListeners.delete(listener);
  }

  dispatchFocus(focused: boolean): void {
    for (const listener of this.focusListeners) listener(focused);
  }

  /** Regions under the point, best candidate first: topmost layer, then innermost (smallest). */
  hitTest(x: number, y: number): Hit[] {
    const hits: Hit[] = [];
    let topLayer = 0;
    for (const [id, region] of this.regions) {
      // A modal blocks everything below it, even where it does not cover the screen.
      topLayer = Math.max(topLayer, region.layer === "modal" ? LAYER_RANK.modal : 0);
      const rect = region.getRect();
      if (rect && contains(rect, x, y)) hits.push({ id, region, rect });
    }
    return hits
      .filter((h) => LAYER_RANK[h.region.layer] >= topLayer)
      .sort(
        (a, b) =>
          LAYER_RANK[b.region.layer] - LAYER_RANK[a.region.layer] ||
          a.rect.width * a.rect.height - b.rect.width * b.rect.height,
      );
  }

  private first(hits: Hit[], handler: keyof RegionHandlers): Hit | undefined {
    return hits.find((h) => h.region.handlers()[handler] !== undefined);
  }

  private firstClickable(hits: Hit[], button: MouseButton): Hit | undefined {
    const kinds: ClickKind[] = button === "right" ? ["onRightClick"] : ["onClick", "onDoubleClick"];
    return hits.find((h) => kinds.some((k) => h.region.handlers()[k] !== undefined));
  }

  dispatch(event: MouseEvent): void {
    const hits = this.hitTest(event.x, event.y);
    const toRegionEvent = (hit: Hit | undefined, button: MouseButton): RegionEvent => ({
      x: event.x,
      y: event.y,
      localX: hit ? event.x - hit.rect.x : 0,
      localY: hit ? event.y - hit.rect.y : 0,
      button,
      shift: event.shift,
      alt: event.alt,
      ctrl: event.ctrl,
    });

    switch (event.kind) {
      case "wheel": {
        const hit = this.first(hits, "onWheel");
        hit?.region.handlers().onWheel?.({ ...toRegionEvent(hit, "none"), direction: event.direction });
        return;
      }
      case "press": {
        const hitIds = new Set(hits.map((h) => h.id));
        for (const [id, region] of this.regions) {
          if (!hitIds.has(id)) region.handlers().onPressOutside?.();
        }
        const clickable = this.firstClickable(hits, event.button);
        if (clickable) this.clickStart.set(event.button, clickable.id);
        else this.clickStart.delete(event.button);
        if (event.button === "left") {
          const hit = this.first(hits, "onPress");
          this.pressed = hit?.id;
          hit?.region.handlers().onPress?.(toRegionEvent(hit, "left"));
        }
        return;
      }
      case "release": {
        if (event.button === "left" && this.pressed !== undefined) {
          const region = this.regions.get(this.pressed);
          this.pressed = undefined;
          const rect = region?.getRect();
          region?.handlers().onRelease?.({
            ...toRegionEvent(undefined, "left"),
            localX: rect ? event.x - rect.x : 0,
            localY: rect ? event.y - rect.y : 0,
          });
        }
        const startedOn = this.clickStart.get(event.button);
        this.clickStart.delete(event.button);
        const target = this.firstClickable(hits, event.button);
        if (!target || target.id !== startedOn) return;
        const handlers = target.region.handlers();
        const e = toRegionEvent(target, event.button);
        if (event.button === "right") {
          handlers.onRightClick?.(e);
          return;
        }
        if (event.button !== "left") return;
        const time = this.now();
        const last = this.lastClick;
        if (last && last.id === target.id && last.x === event.x && last.y === event.y && time - last.time <= DOUBLE_CLICK_MS) {
          this.lastClick = undefined;
          handlers.onDoubleClick?.(e);
        } else {
          this.lastClick = { id: target.id, x: event.x, y: event.y, time };
          handlers.onClick?.(e);
        }
        return;
      }
      case "move": {
        if (event.button === "left" && this.pressed !== undefined) {
          const region = this.regions.get(this.pressed);
          const rect = region?.getRect();
          region?.handlers().onDrag?.({
            ...toRegionEvent(undefined, "left"),
            localX: rect ? event.x - rect.x : 0,
            localY: rect ? event.y - rect.y : 0,
          });
          return;
        }
        const hit = this.first(hits, "onHover");
        if (this.hovered !== undefined && this.hovered !== hit?.id) {
          this.regions.get(this.hovered)?.handlers().onLeave?.();
        }
        this.hovered = hit?.id;
        hit?.region.handlers().onHover?.(toRegionEvent(hit, event.button));
        return;
      }
    }
  }
}
