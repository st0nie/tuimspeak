import { useEffect, useRef, useState, type ReactNode } from "react";
import { Box, Text, useBoxMetrics, useInput, type DOMElement, type Key } from "ink";
import { useMouseRegion } from "../../mouse/react.tsx";
import { Button } from "../Button.tsx";
import { LayoutEpochContext, TextInput } from "../TextInput.tsx";
import { colors, fit, stringWidth } from "../theme.ts";

/** Building blocks shared by the dialogs (architecture §7.4). */

export interface Screen {
  columns: number;
  rows: number;
}

/**
 * A centered dialog box. It is placed at whole-cell coordinates from its
 * measured height: flex centering can land on half cells, where Ink 8 drops
 * nested text. Publishes its coordinates via `LayoutEpochContext` so focused
 * inputs reposition the real terminal cursor once centered.
 */
export function Modal({ title, width, screen, onClose, children }: { title: string; width: number; screen: Screen; onClose: () => void; children: ReactNode }) {
  const ref = useRef<DOMElement>(null);
  // Swallow clicks inside so they never reach the UI underneath; a press outside closes.
  useMouseRegion(ref, { onPressOutside: onClose, onClick: () => {} }, { layer: "modal" });
  const { height, hasMeasured } = useBoxMetrics(ref);
  const w = Math.min(width, screen.columns - 2);
  const left = Math.max(0, Math.floor((screen.columns - w) / 2));
  const top = hasMeasured ? Math.max(0, Math.floor((screen.rows - height) / 2)) : Math.floor(screen.rows / 4);
  const epoch = `${left},${top},${w},${height},${hasMeasured ? 1 : 0}`;
  return (
    <LayoutEpochContext.Provider value={epoch}>
      <Box ref={ref} position="absolute" left={left} top={top} flexDirection="column" width={w} borderStyle="round" borderColor={colors.accent} backgroundColor="black" paddingX={1}>
        <Text bold color={colors.accent} wrap="truncate-end">
          {title}
        </Text>
        {children}
      </Box>
    </LayoutEpochContext.Provider>
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

export interface FormItem {
  key: string;
  render: (focused: boolean) => ReactNode;
  onActivate: () => void;
  onSpace?: () => void;
}

export interface FormRow {
  key: string;
  label?: string;
  gap?: number;
  marginTop?: number;
  marginBottom?: number;
  trailing?: ReactNode;
  onStep?: (delta: -1 | 1) => void;
  items: FormItem[];
}

function stepFormFocus(
  row: number,
  col: number,
  rowLengths: number[],
  key: Key,
  isFieldRow: boolean,
  rowStep?: (delta: -1 | 1) => void,
): [number, number] | null {
  const total = rowLengths.length;
  if (total === 0) return null;
  if (key.upArrow) return [(row + total - 1) % total, 0];
  if (key.downArrow) return [(row + 1) % total, 0];
  if (key.tab) {
    const items = rowLengths[row] ?? 1;
    if (key.shift) {
      if (col > 0) return [row, col - 1];
      const prevRow = (row + total - 1) % total;
      return [prevRow, Math.max(0, (rowLengths[prevRow] ?? 1) - 1)];
    }
    if (col + 1 < items) return [row, col + 1];
    return [(row + 1) % total, 0];
  }
  if (!isFieldRow && (key.leftArrow || key.rightArrow)) {
    const delta = key.leftArrow ? -1 : 1;
    if (rowStep) {
      rowStep(delta);
      return null;
    }
    const items = rowLengths[row] ?? 1;
    if (items > 1) return [row, (col + delta + items) % items];
  }
  return null;
}

function FormExtraRow({ row, focusedRow, focusedCol, labelWidth }: { row: FormRow; focusedRow: boolean; focusedCol: number; labelWidth: number }) {
  return (
    <Box marginTop={row.marginTop} marginBottom={row.marginBottom} columnGap={row.gap ?? 1} flexWrap="wrap">
      {row.label !== undefined && <Text color={focusedRow ? colors.accent : "gray"}>{row.label.padEnd(labelWidth)}</Text>}
      {row.items.map((item, c) => (
        <Box key={item.key}>{item.render(focusedRow && c === focusedCol)}</Box>
      ))}
      {row.trailing}
    </Box>
  );
}

/**
 * Form with optional interactive rows before/after text fields and a Submit/Cancel
 * action row: ↑/↓/Tab/Shift+Tab move between rows, ←/→ moves across items on a row,
 * Space/Enter toggles or activates controls, Esc cancels.
 */
export function Form({
  fields,
  initial,
  width,
  submitLabel,
  onSubmit,
  onCancel,
  header,
  beforeRows = [],
  afterRows = [],
  extra,
  active = true,
}: {
  fields: Field[];
  initial: Record<string, string>;
  width: number;
  submitLabel: string;
  /** Return a field key to move focus back to that field instead of closing. */
  onSubmit: (values: Record<string, string>) => string | void;
  onCancel: () => void;
  header?: ReactNode;
  beforeRows?: FormRow[];
  afterRows?: FormRow[];
  extra?: ReactNode;
  active?: boolean;
}) {
  const [values, setValues] = useState(initial);
  const fieldOffset = beforeRows.length;
  const afterOffset = fieldOffset + fields.length;
  const actionRowIndex = afterOffset + afterRows.length;
  const [pos, setPos] = useState<[number, number]>([fields.length > 0 ? fieldOffset : 0, 0]);

  const rowLengths = [...beforeRows.map((r) => Math.max(1, r.items.length)), ...fields.map(() => 1), ...afterRows.map((r) => Math.max(1, r.items.length)), 2];
  const totalRows = rowLengths.length;
  const row = Math.min(pos[0], totalRows - 1);
  const col = Math.min(pos[1], (rowLengths[row] ?? 1) - 1);
  const isFieldRow = row >= fieldOffset && row < afterOffset;

  const allLabels = [
    ...beforeRows.flatMap((r) => (r.label ? [r.label] : [])),
    ...fields.map((f) => f.label),
    ...afterRows.flatMap((r) => (r.label ? [r.label] : [])),
  ];
  const labelWidth = (allLabels.length > 0 ? Math.max(...allLabels.map((l) => stringWidth(l))) : 0) + 1;

  const triggerSubmit = () => {
    const targetField = onSubmit(values);
    if (typeof targetField === "string") {
      const idx = fields.findIndex((f) => f.key === targetField);
      if (idx >= 0) setPos([fieldOffset + idx, 0]);
    }
  };

  const activeExtraRow = row < fieldOffset ? beforeRows[row] : row >= afterOffset && row < actionRowIndex ? afterRows[row - afterOffset] : undefined;

  useInput(
    (input, key) => {
      if (key.escape) return onCancel();
      const stepped = stepFormFocus(row, col, rowLengths, key, isFieldRow, activeExtraRow?.onStep);
      if (stepped) return setPos(stepped);
      if (isFieldRow) return;
      if (row === actionRowIndex && (key.return || input === " ")) {
        if (col === 0) triggerSubmit();
        else onCancel();
        return;
      }
      const item = activeExtraRow?.items[col];
      if (!item) return;
      if (key.return) item.onActivate();
      else if (input === " ") (item.onSpace ?? item.onActivate)();
    },
    { isActive: active },
  );

  return (
    <Box flexDirection="column">
      {header}
      {beforeRows.map((r, i) => (
        <FormExtraRow key={r.key} row={r} focusedRow={active && row === i} focusedCol={col} labelWidth={labelWidth} />
      ))}
      {fields.map((f, i) => {
        const r = fieldOffset + i;
        const focused = active && row === r;
        return (
          <Box key={f.key}>
            <Text color={focused ? colors.accent : "gray"}>{f.label.padEnd(labelWidth)}</Text>
            <TextInput
              value={values[f.key] ?? ""}
              width={Math.max(4, width - labelWidth)}
              focused={focused}
              mask={f.mask}
              placeholder={f.placeholder}
              layer="modal"
              onFocusRequest={() => setPos([r, 0])}
              onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))}
              onSubmit={() => (i < fields.length - 1 ? setPos([r + 1, 0]) : triggerSubmit())}
            />
          </Box>
        );
      })}
      {afterRows.map((r, i) => {
        const idx = afterOffset + i;
        return <FormExtraRow key={r.key} row={r} focusedRow={active && row === idx} focusedCol={col} labelWidth={labelWidth} />;
      })}
      {extra}
      <Box marginTop={1} gap={2}>
        <Button label={` ${submitLabel} `} color={colors.accent} focused={active && row === actionRowIndex && col === 0} layer="modal" onClick={triggerSubmit} />
        <Button label=" Cancel " focused={active && row === actionRowIndex && col === 1} layer="modal" onClick={onCancel} />
      </Box>
    </Box>
  );
}

export interface ActionItem {
  label: string;
  color?: string;
  disabled?: boolean;
  onTrigger: () => void;
}

/** Keyboard-navigable row of modal buttons (←/→ moves across enabled buttons, Enter/Space activates). */
export function ActionBar({ actions, focused, gap = 2, marginTop = 1 }: { actions: ActionItem[]; focused: boolean; gap?: number; marginTop?: number }) {
  const firstEnabled = Math.max(0, actions.findIndex((a) => !a.disabled));
  const [col, setCol] = useState(firstEnabled);
  const current = !actions[col] || actions[col]!.disabled ? firstEnabled : col;

  useEffect(() => {
    if (actions[col]?.disabled) setCol(firstEnabled);
  }, [actions, col, firstEnabled]);

  useInput(
    (input, key) => {
      if (actions.length === 0) return;
      if (key.leftArrow || key.rightArrow) {
        const d = key.leftArrow ? -1 : 1;
        let next = current;
        for (let n = 0; n < actions.length; n++) {
          next = (next + d + actions.length) % actions.length;
          if (!actions[next]!.disabled) break;
        }
        setCol(next);
      } else if (key.return || input === " ") {
        const item = actions[current];
        if (item && !item.disabled) item.onTrigger();
      }
    },
    { isActive: focused },
  );

  return (
    <Box marginTop={marginTop} columnGap={gap} flexWrap="wrap">
      {actions.map((a, i) => (
        <Button key={a.label} layer="modal" label={a.label} color={a.color} disabled={a.disabled} focused={focused && i === current && !a.disabled} onClick={a.onTrigger} />
      ))}
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
        <Text color={focused ? colors.accent : undefined} bold={focused}>
          {cells}
        </Text>
      </Box>
      <Text color={focused ? colors.accent : undefined}> {label.padStart(6)}</Text>
    </Box>
  );
}

export function Toggle({ label, value, focused, onChange }: { label: string; value: boolean; focused?: boolean; onChange: (value: boolean) => void }) {
  const ref = useRef<DOMElement>(null);
  useMouseRegion(ref, { onClick: () => onChange(!value) }, { layer: "modal" });
  return (
    <Box ref={ref} flexShrink={0}>
      <Text inverse={Boolean(focused)} bold={Boolean(focused)} color={focused ? colors.accent : undefined}>
        [<Text color={colors.accent}>{value ? "x" : " "}</Text>] {label}
      </Text>
    </Box>
  );
}

/** One of several options, as a row of buttons. */
export function Choice<T extends string>({
  options,
  value,
  focused,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  focused?: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <Box columnGap={1} flexWrap="wrap">
      {options.map((o) => (
        <Button key={o.value} layer="modal" label={` ${o.label} `} active={o.value === value} focused={Boolean(focused && o.value === value)} onClick={() => onChange(o.value)} />
      ))}
    </Box>
  );
}

export function stepOption<T>(options: readonly T[], current: T, delta: -1 | 1): T {
  if (options.length === 0) return current;
  const idx = Math.max(0, options.indexOf(current));
  return options[(idx + delta + options.length) % options.length]!;
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
