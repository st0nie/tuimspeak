import { useEffect, useRef, useState } from "react";
import { Box, Text, useCursor, useInput, usePaste, type DOMElement } from "ink";
import { useMouseRegion, elementRect } from "../mouse/react.tsx";
import type { Layer } from "../mouse/bus.ts";
import { stringWidth } from "./theme.ts";

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

/**
 * Single-line input. Places the real terminal cursor at the caret so IME
 * composition (e.g. Chinese input) appears in the right spot.
 */
export function TextInput({ value, onChange, onSubmit, focused, onFocusRequest, placeholder, width, mask, prompt = "", layer }: TextInputProps) {
  const ref = useRef<DOMElement>(null);
  const [caret, setCaret] = useState(value.length);
  const pos = Math.min(caret, value.length);
  const { setCursorPosition } = useCursor();
  // Hide the terminal cursor again once this input loses focus.
  useEffect(() => {
    if (!focused) return;
    return () => setCursorPosition(undefined);
  }, [focused, setCursorPosition]);

  useMouseRegion(
    ref,
    {
      onClick: (e) => {
        onFocusRequest?.();
        // Move the caret to the clicked column.
        let col = e.localX - stringWidth(prompt) + scroll;
        let i = 0;
        for (const ch of shown) {
          col -= stringWidth(ch);
          if (col < 0) break;
          i += ch.length;
        }
        setCaret(i);
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
      if (key.return) {
        onSubmit?.(value);
        setCaret(0);
        return;
      }
      if (key.leftArrow) return setCaret(Math.max(0, pos - 1));
      if (key.rightArrow) return setCaret(Math.min(value.length, pos + 1));
      if (key.home || (key.ctrl && input === "a")) return setCaret(0);
      if (key.end || (key.ctrl && input === "e")) return setCaret(value.length);
      if (key.backspace) {
        if (pos === 0) return;
        onChange(value.slice(0, pos - 1) + value.slice(pos));
        return setCaret(pos - 1);
      }
      if (key.delete) {
        onChange(value.slice(0, pos) + value.slice(pos + 1));
        return;
      }
      if (key.ctrl && input === "u") {
        onChange(value.slice(pos));
        return setCaret(0);
      }
      if (key.ctrl && input === "k") {
        onChange(value.slice(0, pos));
        return;
      }
      if (key.ctrl || key.meta || key.escape || key.tab || key.upArrow || key.downArrow || key.pageUp || key.pageDown) return;
      if (input) insert(input);
    },
    { isActive: focused },
  );
  usePaste(insert, { isActive: focused });

  const display = mask ? "•".repeat(value.length) : value;
  const promptWidth = stringWidth(prompt);
  const room = Math.max(1, width - promptWidth - 1);
  // Horizontal scroll so the caret stays visible.
  const beforeCaret = display.slice(0, pos);
  const beforeWidth = stringWidth(beforeCaret);
  const scroll = Math.max(0, beforeWidth - room);
  let shown = display;
  if (scroll > 0) {
    let skipped = 0;
    let start = 0;
    for (const ch of display) {
      if (skipped >= scroll) break;
      skipped += stringWidth(ch);
      start += ch.length;
    }
    shown = display.slice(start);
  }

  if (focused) {
    const rect = elementRect(ref.current);
    if (rect) setCursorPosition({ x: rect.x + promptWidth + beforeWidth - scroll, y: rect.y });
  }

  return (
    <Box ref={ref} width={width} height={1} overflow="hidden">
      <Text wrap="truncate-end">
        <Text color="cyan">{prompt}</Text>
        {value ? shown : <Text color="gray">{placeholder}</Text>}
      </Text>
    </Box>
  );
}
