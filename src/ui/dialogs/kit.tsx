import { useRef, useState, type ReactNode } from "react";
import { Box, Text, useBoxMetrics, useInput, type DOMElement } from "ink";
import { useMouseRegion } from "../../mouse/react.tsx";
import { Button } from "../Button.tsx";
import { TextInput } from "../TextInput.tsx";
import { colors, fit, stringWidth } from "../theme.ts";

/** Building blocks shared by the dialogs (architecture §7.4). */

export interface Screen {
  columns: number;
  rows: number;
}

/**
 * A centered dialog box. It is placed at whole-cell coordinates from its
 * measured height: flex centering can land on half cells, where Ink 8 drops
 * nested text.
 */
export function Modal({ title, width, screen, onClose, children }: { title: string; width: number; screen: Screen; onClose: () => void; children: ReactNode }) {
  const ref = useRef<DOMElement>(null);
  // Swallow clicks inside so they never reach the UI underneath; a press outside closes.
  useMouseRegion(ref, { onPressOutside: onClose, onClick: () => {} }, { layer: "modal" });
  const { height, hasMeasured } = useBoxMetrics(ref);
  const w = Math.min(width, screen.columns - 2);
  const left = Math.max(0, Math.floor((screen.columns - w) / 2));
  const top = hasMeasured ? Math.max(0, Math.floor((screen.rows - height) / 2)) : Math.floor(screen.rows / 4);
  return (
    <Box ref={ref} position="absolute" left={left} top={top} flexDirection="column" width={w} borderStyle="round" borderColor={colors.accent} backgroundColor="black" paddingX={1}>
      <Text bold color={colors.accent} wrap="truncate-end">
        {title}
      </Text>
      {children}
    </Box>
  );
}

/** Inner width of a modal of `width` columns (border and padding). */
export const innerWidth = (width: number, screen: Screen) => Math.min(width, screen.columns - 2) - 4;

export function Hint({ children }: { children: string }) {
  return (
    <Text color="gray" wrap="truncate-end">
      {children}
    </Text>
  );
}

export interface Field {
  label: string;
  key: string;
  mask?: boolean;
  placeholder?: string;
}

/** Text fields; Tab/↑↓ or a click move between them, Enter on the last submits, Esc cancels. */
export function Form({
  fields,
  initial,
  width,
  submitLabel,
  onSubmit,
  onCancel,
  extra,
  active = true,
}: {
  fields: Field[];
  initial: Record<string, string>;
  width: number;
  submitLabel: string;
  onSubmit: (values: Record<string, string>) => void;
  onCancel: () => void;
  extra?: ReactNode;
  active?: boolean;
}) {
  const [values, setValues] = useState(initial);
  const [focus, setFocus] = useState(0);
  const labelWidth = Math.max(...fields.map((f) => stringWidth(f.label))) + 1;
  useInput(
    (_input, key) => {
      if (key.escape) onCancel();
      else if (key.tab || key.downArrow) setFocus((f) => (key.shift ? (f + fields.length - 1) % fields.length : (f + 1) % fields.length));
      else if (key.upArrow) setFocus((f) => (f + fields.length - 1) % fields.length);
    },
    { isActive: active },
  );
  return (
    <Box flexDirection="column">
      {fields.map((f, i) => (
        <Box key={f.key}>
          <Text color={i === focus ? colors.accent : "gray"}>{f.label.padEnd(labelWidth)}</Text>
          <TextInput
            value={values[f.key] ?? ""}
            width={Math.max(4, width - labelWidth)}
            focused={active && i === focus}
            mask={f.mask}
            placeholder={f.placeholder}
            layer="modal"
            onFocusRequest={() => setFocus(i)}
            onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))}
            onSubmit={() => (i < fields.length - 1 ? setFocus(i + 1) : onSubmit(values))}
          />
        </Box>
      ))}
      {extra}
      <Box marginTop={1} gap={2}>
        <Button label={` ${submitLabel} `} color={colors.accent} layer="modal" onClick={() => onSubmit(values)} />
        <Button label=" Cancel " layer="modal" onClick={onCancel} />
      </Box>
    </Box>
  );
}

/**
 * A scrolling, selectable list: one mouse region (§6.3), click selects,
 * double-click or Enter activates, wheel and PgUp/PgDn scroll.
 */
export function ListBox<T>({
  items,
  height,
  width,
  render,
  selected,
  onSelect,
  onActivate,
  focused = true,
  empty = "Nothing here",
  wheelLines = 3,
}: {
  items: T[];
  height: number;
  width: number;
  render: (item: T, selected: boolean, width: number) => ReactNode;
  selected: number;
  onSelect: (index: number) => void;
  onActivate?: (index: number) => void;
  focused?: boolean;
  empty?: string;
  wheelLines?: number;
}) {
  const ref = useRef<DOMElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const maxScroll = Math.max(0, items.length - height);
  let top = Math.min(scrollTop, maxScroll);
  if (selected < top) top = selected;
  else if (selected >= top + height) top = selected - height + 1;
  const pick = (i: number) => {
    const clamped = Math.max(0, Math.min(items.length - 1, i));
    onSelect(clamped);
    if (clamped < top) setScrollTop(clamped);
    else if (clamped >= top + height) setScrollTop(clamped - height + 1);
    else setScrollTop(top);
  };
  useMouseRegion(
    ref,
    {
      onClick: (e) => {
        const i = top + e.localY;
        if (i < items.length) pick(i);
      },
      onDoubleClick: (e) => {
        const i = top + e.localY;
        if (i < items.length) onActivate?.(i);
      },
      onWheel: (e) => setScrollTop(Math.max(0, Math.min(maxScroll, top + (e.direction === "up" ? -wheelLines : e.direction === "down" ? wheelLines : 0)))),
    },
    { layer: "modal" },
  );
  useInput(
    (_input, key) => {
      if (items.length === 0) return;
      if (key.upArrow) pick(selected - 1);
      else if (key.downArrow) pick(selected + 1);
      else if (key.pageUp) pick(selected - height);
      else if (key.pageDown) pick(selected + height);
      else if (key.home) pick(0);
      else if (key.end) pick(items.length - 1);
      else if (key.return) onActivate?.(selected);
    },
    { isActive: focused },
  );
  return (
    <Box ref={ref} flexDirection="column" height={height} width={width} overflow="hidden">
      {items.length === 0 ? <Text color="gray">{fit(empty, width)}</Text> : items.slice(top, top + height).map((item, i) => <Box key={top + i}>{render(item, top + i === selected, width)}</Box>)}
    </Box>
  );
}

/** A row's text with selection highlight, padded to the list width. */
export function Row({ text, selected, color, dim }: { text: string; selected: boolean; color?: string; dim?: boolean }) {
  return (
    <Text inverse={selected} color={color} dimColor={dim} wrap="truncate-end">
      {text}
    </Text>
  );
}

/** A horizontal slider: click or drag on the bar, wheel, ← →. */
export function Slider({
  value,
  min,
  max,
  step,
  width,
  onChange,
  format,
  marker,
  focused,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  width: number;
  onChange: (value: number) => void;
  format: (value: number) => string;
  /** Optional live level drawn under the bar, 0..1 of the range (the VAD meter). */
  marker?: number;
  focused: boolean;
}) {
  const ref = useRef<DOMElement>(null);
  const label = format(value);
  const barWidth = Math.max(4, width - 8);
  const snap = (v: number) => Math.max(min, Math.min(max, Math.round(v / step) * step));
  const fromX = (x: number) => snap(min + ((max - min) * Math.max(0, Math.min(barWidth - 1, x))) / (barWidth - 1));
  useMouseRegion(
    ref,
    {
      onPress: (e) => onChange(fromX(e.localX)),
      onDrag: (e) => onChange(fromX(e.localX)),
      onWheel: (e) => onChange(snap(value + (e.direction === "up" ? step : e.direction === "down" ? -step : 0))),
    },
    { layer: "modal" },
  );
  useInput(
    (_input, key) => {
      if (key.leftArrow) onChange(snap(value - step));
      else if (key.rightArrow) onChange(snap(value + step));
    },
    { isActive: focused },
  );
  const pos = Math.round(((value - min) / (max - min)) * (barWidth - 1));
  const level = marker === undefined ? -1 : Math.round(Math.max(0, Math.min(1, marker)) * (barWidth - 1));
  const cells = Array.from({ length: barWidth }, (_, i) => (i === pos ? "●" : i <= level ? "▬" : "─")).join("");
  return (
    <Box>
      <Box ref={ref}>
        <Text color={focused ? colors.accent : undefined}>{cells}</Text>
      </Box>
      <Text> {label.padStart(6)}</Text>
    </Box>
  );
}

export function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (value: boolean) => void }) {
  const ref = useRef<DOMElement>(null);
  useMouseRegion(ref, { onClick: () => onChange(!value) }, { layer: "modal" });
  return (
    <Box ref={ref} flexShrink={0}>
      <Text>
        [<Text color={colors.accent}>{value ? "x" : " "}</Text>] {label}
      </Text>
    </Box>
  );
}

/** One of several options, as a row of buttons. */
export function Choice<T extends string>({ options, value, onChange }: { options: { value: T; label: string }[]; value: T; onChange: (value: T) => void }) {
  return (
    <Box gap={1} flexWrap="wrap">
      {options.map((o) => (
        <Button key={o.value} layer="modal" label={` ${o.label} `} active={o.value === value} onClick={() => onChange(o.value)} />
      ))}
    </Box>
  );
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GiB`;
}

export function formatDuration(secs: number): string {
  if (secs < 60) return `${Math.floor(secs)}s`;
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m}m ${Math.floor(secs % 60)}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
