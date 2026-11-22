import { useMemo, useRef, useState } from "react";
import { Box, Text, useInput, type DOMElement } from "ink";
import { useStore } from "zustand";
import type { Controller } from "../app/controller.ts";
import type { Session } from "../session/session.ts";
import type { ChatLine, ChatTab } from "../state/session.ts";
import { useMouseRegion } from "../mouse/react.tsx";
import { TextInput } from "./TextInput.tsx";
import { colors, stringWidth } from "./theme.ts";
import { hyperlink, parseBBCode, plainText } from "./bbcode.ts";
import wrapAnsi from "wrap-ansi";

interface Props {
  controller: Controller;
  session: Session;
  width: number;
  height: number;
  focused: boolean;
}

function time(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function TabButton({ tab, active, onSelect, onClose }: { tab: ChatTab; active: boolean; onSelect: () => void; onClose?: () => void }) {
  const ref = useRef<DOMElement>(null);
  const closeRef = useRef<DOMElement>(null);
  useMouseRegion(ref, { onClick: onSelect });
  useMouseRegion(closeRef, { onClick: () => onClose?.() }, { enabled: Boolean(onClose) });
  const unread = tab.unread > 0 && !active ? ` (${tab.unread})` : "";
  return (
    <Box flexShrink={0} marginRight={1}>
      <Box ref={ref}>
        <Text inverse={active} bold={active} color={!active && tab.unread ? colors.accent : undefined}>
          {" "}
          {tab.title}
          {unread}
          {onClose ? "" : " "}
        </Text>
      </Box>
      {onClose && (
        <Box ref={closeRef}>
          <Text inverse={active} color={active ? undefined : colors.dim}>
            {" ×"}
          </Text>
        </Box>
      )}
    </Box>
  );
}

/** Renders a chat line to one or more pre-wrapped terminal rows. */
function renderLine(line: ChatLine, width: number): string[] {
  const stamp = `\x1b[90m${time(line.time)}\x1b[39m `;
  let body: string;
  if (line.kind === "message") {
    const text = parseBBCode(line.text)
      .map((seg) => {
        let s = seg.url ? hyperlink(seg.text, seg.url) : seg.text;
        if (seg.bold) s = `\x1b[1m${s}\x1b[22m`;
        if (seg.underline || seg.url) s = `\x1b[4m${s}\x1b[24m`;
        if (seg.italic) s = `\x1b[3m${s}\x1b[23m`;
        return s;
      })
      .join("");
    const nameColor = line.self ? "\x1b[36m" : "\x1b[1m";
    body = `${nameColor}<${line.from ?? "?"}>\x1b[0m ${text}`;
  } else if (line.kind === "poke") {
    body = `\x1b[35m* ${line.from} ${plainText(line.text)}\x1b[39m`;
  } else if (line.kind === "error") {
    body = `\x1b[31m! ${plainText(line.text)}\x1b[39m`;
  } else {
    body = `\x1b[90m* ${plainText(line.text)}\x1b[39m`;
  }
  return wrapAnsi(stamp + body, width, { hard: true, trim: false }).split("\n");
}

export function ChatPane({ controller, session, width, height, focused }: Props) {
  const logRef = useRef<DOMElement>(null);
  const tabs = useStore(session.store, (s) => s.tabs);
  const activeTab = useStore(session.store, (s) => s.activeTab);
  const status = useStore(session.store, (s) => s.status);
  const wheelLines = useStore(controller.store, (s) => s.config.wheelLines);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  /** Rows scrolled up from the bottom; 0 follows new messages. */
  const [scrollBack, setScrollBack] = useState(0);
  const tab = tabs.find((t) => t.id === activeTab) ?? tabs[0]!;
  const logHeight = Math.max(1, height - 2);

  const rows = useMemo(() => tab.lines.flatMap((l) => renderLine(l, width)), [tab.lines, width]);
  const maxBack = Math.max(0, rows.length - logHeight);
  const back = Math.min(scrollBack, maxBack);
  const end = rows.length - back;
  const visible = rows.slice(Math.max(0, end - logHeight), end);

  const scroll = (delta: number) => setScrollBack((b) => Math.max(0, Math.min(maxBack, b + delta)));
  useMouseRegion(logRef, {
    onWheel: (e) => scroll(e.direction === "up" ? wheelLines : e.direction === "down" ? -wheelLines : 0),
    onClick: () => controller.setFocus("chat"),
  });

  useInput(
    (_input, key) => {
      if (key.pageUp) scroll(logHeight - 1);
      else if (key.pageDown) scroll(-(logHeight - 1));
    },
    { isActive: focused },
  );

  const draft = drafts[tab.id] ?? "";
  const canSend = status === "connected";
  const placeholder = !canSend
    ? "Not connected"
    : tab.id === "server"
      ? "Message to the whole server"
      : tab.id === "channel"
        ? "Message to the channel"
        : `Private message to ${tab.title}`;

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box height={1} overflow="hidden">
        {tabs.map((t) => (
          <TabButton
            key={t.id}
            tab={t}
            active={t.id === tab.id}
            onSelect={() => {
              session.selectTab(t.id);
              setScrollBack(0);
            }}
            onClose={t.partnerId !== undefined ? () => session.closeTab(t.id) : undefined}
          />
        ))}
      </Box>
      <Box ref={logRef} flexDirection="column" height={logHeight} overflow="hidden">
        {visible.map((row, i) => (
          <Text key={i} wrap="truncate-end">
            {row}
          </Text>
        ))}
      </Box>
      <Box height={1}>
        <TextInput
          value={draft}
          width={width - (back > 0 ? 8 : 0)}
          prompt="> "
          placeholder={placeholder}
          focused={focused}
          onFocusRequest={() => controller.setFocus("chat")}
          onChange={(v) => setDrafts((d) => ({ ...d, [tab.id]: v }))}
          onSubmit={(v) => {
            if (!canSend || !v.trim()) return;
            session.sendText(tab.id, v);
            setDrafts((d) => ({ ...d, [tab.id]: "" }));
            setScrollBack(0);
          }}
        />
        {back > 0 && <Text color="yellow">{` ↓${String(back).padStart(4)}`.slice(0, 8)}</Text>}
      </Box>
    </Box>
  );
}

export { stringWidth };
