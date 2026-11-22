import { createContext, useContext, useEffect, useRef, useState, type RefObject } from "react";
import { Box, Text, useCursor, useInput, usePaste, useWindowSize, type DOMElement } from "ink";
import { useMouseRegion, elementRect } from "../mouse/react.tsx";
import type { Layer } from "../mouse/bus.ts";
import { colors, stringWidth } from "./theme.ts";

/** Updated by positioned containers (such as `Modal`) when their screen origin changes. */
export const LayoutEpochContext = createContext("");

export interface TextInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  focused: boolean;
  onFocusRequest?: () => void;
  placeholder?: string;
  width: number;
  mask?: boolean;
  prompt?: string;
  layer?: Layer;
}

function prevCodePoint(text: string, index: number): number {
  if (index <= 0) return 0;
  const cps = Array.from(text.slice(0, index));
  cps.pop();
  return cps.join("").length;
}

function nextCodePoint(text: string, index: number): number {
  if (index >= text.length) return text.length;
  const first = Array.from(text.slice(index))[0];
  return index + (first ? first.length : 1);
}

function alignCodePoint(text: string, index: number): number {
  const clamped = Math.max(0, Math.min(index, text.length));
  if (clamped === 0 || clamped === text.length) return clamped;
  const code = text.charCodeAt(clamped);
  return code >= 0xdc00 && code <= 0xdfff ? clamped - 1 : clamped;
}

interface CaretSlice {
  visBefore: string;
  caretChar: string;
  afterCaret: string;
  shownUnfocused: string;
  visibleStartUnit: number;
  caretOffsetX: number;
}

function sliceAroundCaret(value: string, pos: number, width: number, promptWidth: number, focused: boolean, mask?: boolean): CaretSlice {
  const displayChar = (ch: string) => (mask ? "•" : ch);
  const beforeCps = Array.from(value.slice(0, pos));
  const afterCps = Array.from(value.slice(pos));
  const caretChar = afterCps.length > 0 ? displayChar(afterCps[0]!) : " ";
  const afterCaret = afterCps.slice(1).map(displayChar).join("");
  const caretWidth = focused ? Math.max(1, stringWidth(caretChar)) : 1;
  const room = Math.max(1, width - promptWidth - caretWidth);

  const beforeDisplay = beforeCps.map(displayChar).join("");
  const scroll = Math.max(0, stringWidth(beforeDisplay) - room);
  let visibleStartUnit = 0;
  let cpSkip = 0;
  if (scroll > 0) {
    let skipped = 0;
    for (const ch of beforeCps) {
      if (skipped >= scroll) break;
      skipped += stringWidth(displayChar(ch));
      visibleStartUnit += ch.length;
      cpSkip++;
    }
  }
  const visBefore = cpSkip > 0 ? beforeCps.slice(cpSkip).map(displayChar).join("") : beforeDisplay;
  return {
    visBefore,
    caretChar,
    afterCaret,
    shownUnfocused: visBefore + afterCps.map(displayChar).join(""),
    visibleStartUnit,
    caretOffsetX: promptWidth + stringWidth(visBefore),
  };
}

function clickUnitOffset(value: string, visibleStartUnit: number, colFromPrompt: number, mask?: boolean): number {
  let col = colFromPrompt;
  let idx = visibleStartUnit;
  for (const ch of Array.from(value.slice(visibleStartUnit))) {
    col -= stringWidth(mask ? "•" : ch);
    if (col < 0) break;
    idx += ch.length;
  }
  return idx;
}

/**
 * Mounted only for the single focused input so unfocused inputs never call
 * `useCursor()` (whose `useInsertionEffect` would clear the active cursor).
 */
function FocusedCursor({ boxRef, offsetX }: { boxRef: RefObject<DOMElement | null>; offsetX: number }) {
  const { setCursorPosition } = useCursor();
  const epoch = useContext(LayoutEpochContext);
  const { columns, rows } = useWindowSize();
  const [origin, setOrigin] = useState<{ x: number; y: number } | undefined>(() => {
    const r = elementRect(boxRef.current);
    return r ? { x: r.x, y: r.y } : undefined;
  });

  useEffect(() => {
    const r = elementRect(boxRef.current);
    if (r && (r.x !== origin?.x || r.y !== origin?.y)) setOrigin({ x: r.x, y: r.y });
  }, [boxRef, offsetX, epoch, columns, rows, origin?.x, origin?.y]);

  const live = elementRect(boxRef.current) ?? origin;
  if (live) setCursorPosition({ x: live.x + offsetX, y: live.y });
  return null;
}

function PlaceholderWithCaret({ placeholder }: { placeholder?: string }) {
  const cps = Array.from(placeholder ?? "");
  const first = cps[0] ?? " ";
  const rest = cps.slice(1).join("");
  return (
    <>
      <Text inverse color={colors.accent}>
        {first}
      </Text>
      {rest ? <Text color="gray">{rest}</Text> : null}
    </>
  );
}

/**
 * Single-line input. Draws an inline inverted caret so focus is always visible
 * and places the real terminal cursor at the caret so IME composition (e.g.
 * Chinese input) appears in the right spot.
 */
export function TextInput({ value, onChange, onSubmit, focused, onFocusRequest, placeholder, width, mask, prompt = "", layer }: TextInputProps) {
  const ref = useRef<DOMElement>(null);
  const [caret, setCaret] = useState(value.length);
  const pos = alignCodePoint(value, caret);

  useEffect(() => {
    if (caret > value.length) setCaret(value.length);
  }, [caret, value.length]);

  const promptWidth = stringWidth(prompt);
  const slice = sliceAroundCaret(value, pos, width, promptWidth, focused, mask);

  useMouseRegion(
    ref,
    {
      onClick: (e) => {
        onFocusRequest?.();
        setCaret(clickUnitOffset(value, slice.visibleStartUnit, e.localX - promptWidth, mask));
      },
    },
    { layer },
  );

  const insert = (text: string) => {
    const clean = text.replace(/[\r\n]+/g, " ");
    onChange(value.slice(0, pos) + clean + value.slice(pos));
    setCaret(pos + clean.length);
  };

  useInput(
    (input, key) => {
      if (key.return) return onSubmit?.(value);
      if (key.leftArrow) return setCaret(prevCodePoint(value, pos));
      if (key.rightArrow) return setCaret(nextCodePoint(value, pos));
      if (key.home || (key.ctrl && input === "a")) return setCaret(0);
      if (key.end || (key.ctrl && input === "e")) return setCaret(value.length);
      if (key.backspace) {
        if (pos === 0) return;
        const prev = prevCodePoint(value, pos);
        onChange(value.slice(0, prev) + value.slice(pos));
        return setCaret(prev);
      }
      if (key.delete) {
        if (pos >= value.length) return;
        onChange(value.slice(0, pos) + value.slice(nextCodePoint(value, pos)));
        return;
      }
      if (key.ctrl && input === "u") {
        onChange(value.slice(pos));
        return setCaret(0);
      }
      if (key.ctrl && input === "k") return onChange(value.slice(0, pos));
      if (key.ctrl || key.meta || key.escape || key.tab || key.upArrow || key.downArrow || key.pageUp || key.pageDown) return;
      if (input) insert(input);
    },
    { isActive: focused },
  );
  usePaste(insert, { isActive: focused });

  return (
    <Box ref={ref} width={width} height={1} overflow="hidden">
      {focused && <FocusedCursor boxRef={ref} offsetX={slice.caretOffsetX} />}
      <Text wrap="truncate-end">
        <Text color={colors.accent}>{prompt}</Text>
        {focused ? (
          value ? (
            <>
              {slice.visBefore}
              <Text inverse color={colors.accent}>
                {slice.caretChar}
              </Text>
              {slice.afterCaret}
            </>
          ) : (
            <PlaceholderWithCaret placeholder={placeholder} />
          )
        ) : value ? (
          slice.shownUnfocused
        ) : (
          <Text color="gray">{placeholder ?? ""}</Text>
        )}
      </Text>
    </Box>
  );
}
