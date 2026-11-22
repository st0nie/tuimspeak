import { useMemo, useRef, useState } from "react";
import { Box, Text, useInput, type DOMElement } from "ink";
import { useStore } from "zustand";
import type { Controller } from "../app/controller.ts";
import type { Session } from "../session/session.ts";
import { buildTree, type TreeRow } from "../state/tree.ts";
import type { Selection } from "../state/session.ts";
import { useMouseRegion } from "../mouse/react.tsx";
import { colors, fit, icons, stringWidth, type Icons } from "./theme.ts";
import { TextInput } from "./TextInput.tsx";
import { channelMenu, clientMenu, joinChannel, moveClient, serverMenu } from "./menus.ts";

interface Props {
  controller: Controller;
  session: Session;
  width: number;
  height: number;
  focused: boolean;
}

function rowKeyOf(selection: Selection | null): string | null {
  if (!selection) return null;
  if (selection.kind === "server") return "server";
  return selection.kind === "channel" ? `ch:${selection.id}` : `cl:${selection.id}`;
}

function selectionOf(row: TreeRow): Selection {
  if (row.kind === "server") return { kind: "server" };
  return row.kind === "channel" ? { kind: "channel", id: row.channel.id } : { kind: "client", id: row.client.id };
}

/** Column of the expand/collapse arrow, clickable on its own (§7.5). */
function arrowColumn(row: TreeRow): number {
  return (row.depth - 1) * 2 + 1;
}

function FilterRow({ controller, session, width, focused }: { controller: Controller; session: Session; width: number; focused: boolean }) {
  const filter = useStore(session.store, (s) => s.filter);
  const ref = useRef<DOMElement>(null);
  useMouseRegion(ref, { onClick: () => { if (filter === null) session.setFilter(""); controller.setFocus("filter"); } }, { enabled: filter === null });
  useInput(
    (_input, key) => {
      if (key.escape) {
        session.setFilter(null);
        controller.setFocus("tree");
      } else if (key.downArrow || key.tab) controller.setFocus("tree");
    },
    { isActive: focused },
  );
  if (filter === null) {
    return (
      <Box ref={ref} height={1}>
        <Text color="gray">{fit("/ filter", width)}</Text>
      </Box>
    );
  }
  return (
    <TextInput
      value={filter}
      width={width}
      prompt="/ "
      placeholder="type to filter channels and people"
      focused={focused}
      onFocusRequest={() => controller.setFocus("filter")}
      onChange={(v) => session.setFilter(v)}
      onSubmit={() => controller.setFocus("tree")}
    />
  );
}

export function ChannelTree({ controller, session, width, height, focused }: Props) {
  const ref = useRef<DOMElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [drag, setDrag] = useState<{ clientId: number; target: number | null } | null>(null);
  const justDragged = useRef(false);
  const snapshot = useStore(session.store, (s) => s.snapshot);
  const collapsed = useStore(session.store, (s) => s.collapsed);
  const selection = useStore(session.store, (s) => s.selection);
  const talkers = useStore(session.store, (s) => s.talkers);
  const whisperers = useStore(session.store, (s) => s.whisperers);
  const targets = useStore(session.store, (s) => s.whisperTargets);
  const selfTalking = useStore(session.store, (s) => s.selfTalking);
  const server = useStore(session.store, (s) => s.server);
  const label = useStore(session.store, (s) => s.label);
  const filter = useStore(session.store, (s) => s.filter);
  const focus = useStore(controller.store, (s) => s.focus);
  const config = useStore(controller.store, (s) => s.config);
  const ic = icons(config.icons);
  const listHeight = Math.max(1, height - 1);

  const rows = useMemo(
    () => (snapshot ? buildTree(snapshot, { collapsed, showQueryClients: config.showQueryClients, filter: filter ?? undefined }) : []),
    [snapshot, collapsed, config.showQueryClients, filter],
  );
  const selectedKey = rowKeyOf(selection) ?? "server";
  const selectedIndex = Math.max(0, rows.findIndex((r) => r.key === selectedKey));
  const maxScroll = Math.max(0, rows.length - listHeight);
  const top = Math.min(scrollTop, maxScroll);

  const scrollTo = (index: number) => {
    if (index < top) setScrollTop(index);
    else if (index >= top + listHeight) setScrollTop(index - listHeight + 1);
  };
  const selectIndex = (index: number) => {
    const clamped = Math.max(0, Math.min(rows.length - 1, index));
    const row = rows[clamped];
    if (!row) return;
    session.select(selectionOf(row));
    scrollTo(clamped);
  };

  const ownId = snapshot?.ownClientId;
  const ownChannel = snapshot?.clients.find((c) => c.id === ownId)?.channel;

  const activate = (row: TreeRow) => {
    if (row.kind === "server") {
      if (session.store.getState().status === "disconnected") controller.reconnect(session.id);
    } else if (row.kind === "channel" && row.channel.id !== ownChannel) joinChannel(controller, session, row.channel);
    else if (row.kind === "client" && row.client.id !== ownId) {
      session.openPrivateChat(row.client.id);
      controller.setFocus("chat");
    }
  };

  const openMenu = (row: TreeRow, x: number, y: number) => {
    if (row.kind === "server") controller.openDialog({ kind: "menu", x, y, title: server?.serverName ?? label, items: serverMenu(controller, session) });
    else if (row.kind === "channel") {
      controller.openDialog({ kind: "menu", x, y, title: row.channel.name, items: channelMenu(controller, session, row.channel, row.hasChildren, row.expanded) });
    } else controller.openDialog({ kind: "menu", x, y, title: row.client.name, items: clientMenu(controller, session, row.client) });
  };

  const rowAt = (localY: number) => (localY >= 0 && localY < listHeight ? rows[top + localY] : undefined);

  useMouseRegion(ref, {
    onClick: (e) => {
      if (justDragged.current) {
        justDragged.current = false;
        return;
      }
      controller.setFocus("tree");
      const row = rowAt(e.localY);
      if (!row) return;
      if (row.kind === "channel" && row.hasChildren && e.localX === arrowColumn(row)) session.toggleCollapsed(row.channel.id);
      session.select(selectionOf(row));
    },
    onDoubleClick: (e) => {
      const row = rowAt(e.localY);
      if (row && !(row.kind === "channel" && e.localX === arrowColumn(row))) activate(row);
    },
    onRightClick: (e) => {
      const row = rowAt(e.localY);
      if (!row) return;
      controller.setFocus("tree");
      session.select(selectionOf(row));
      openMenu(row, e.x, e.y);
    },
    onWheel: (e) => {
      const step = config.wheelLines * (e.direction === "up" ? -1 : e.direction === "down" ? 1 : 0);
      setScrollTop(Math.max(0, Math.min(maxScroll, top + step)));
    },
    // Drag a client onto a channel to move them (§7.2).
    onPress: (e) => {
      const row = rowAt(e.localY);
      setDrag(row?.kind === "client" ? { clientId: row.client.id, target: null } : null);
    },
    onDrag: (e) => {
      if (!drag) return;
      const row = rowAt(e.localY);
      const target = row?.kind === "channel" && !row.spacer ? row.channel.id : null;
      if (target !== drag.target) setDrag({ ...drag, target });
    },
    onRelease: () => {
      if (!drag) return;
      setDrag(null);
      if (drag.target === null) return;
      justDragged.current = true;
      const client = snapshot?.clients.find((c) => c.id === drag.clientId);
      const channel = snapshot?.channels.find((c) => c.id === drag.target);
      if (client && channel && client.channel !== channel.id) moveClient(controller, session, client.id, channel);
    },
  });

  useInput(
    (input, key) => {
      const row = rows[selectedIndex];
      if (key.upArrow) selectIndex(selectedIndex - 1);
      else if (key.downArrow) selectIndex(selectedIndex + 1);
      else if (key.pageUp) selectIndex(selectedIndex - listHeight);
      else if (key.pageDown) selectIndex(selectedIndex + listHeight);
      else if (key.home) selectIndex(0);
      else if (key.end) selectIndex(rows.length - 1);
      else if (input === "/") {
        if (filter === null) session.setFilter("");
        controller.setFocus("filter");
      } else if (!row) return;
      else if (key.leftArrow) {
        if (row.kind === "channel" && row.hasChildren && row.expanded) session.toggleCollapsed(row.channel.id, true);
        else {
          for (let i = selectedIndex - 1; i >= 0; i--) {
            if (rows[i]!.depth < row.depth) {
              selectIndex(i);
              break;
            }
          }
        }
      } else if (key.rightArrow) {
        if (row.kind === "channel" && row.hasChildren && !row.expanded) session.toggleCollapsed(row.channel.id, false);
        else if (row.kind !== "client") selectIndex(selectedIndex + 1);
      } else if (key.return) activate(row);
      else if (input === "m") openMenu(row, 2 + arrowColumn(row), 3 + selectedIndex - top);
      else if (input === "p" && row.kind === "client" && row.client.id !== ownId) {
        controller.openDialog({
          kind: "prompt",
          title: `Poke ${row.client.name}`,
          label: "Message",
          submitLabel: "Poke",
          onSubmit: (v) => session.poke(row.client.id, v),
        });
      }
    },
    { isActive: focused },
  );

  const visible = rows.slice(top, top + listHeight);
  return (
    <Box flexDirection="column" width={width} height={height}>
      <FilterRow controller={controller} session={session} width={width} focused={focus === "filter" && !controller.state.dialog} />
      <Box ref={ref} flexDirection="column" width={width} height={listHeight} overflow="hidden">
        {visible.map((row) => (
          <TreeLine
            key={row.key}
            row={row}
            width={width}
            ic={ic}
            selected={row.key === selectedKey}
            focused={focused}
            dropTarget={drag !== null && row.kind === "channel" && row.channel.id === drag.target}
            talking={row.kind === "client" && (talkers.includes(row.client.id) || (row.client.id === ownId && selfTalking))}
            whispering={row.kind === "client" && whisperers.includes(row.client.id)}
            whisperTarget={
              (row.kind === "client" && targets.clients.includes(row.client.id)) || (row.kind === "channel" && targets.channels.includes(row.channel.id))
            }
            volume={row.kind === "client" ? (config.volumes[row.client.uid] ?? 1) : 1}
            own={row.kind === "client" && row.client.id === ownId}
            ownChannel={row.kind === "channel" && row.channel.id === ownChannel}
            serverTitle={`${server?.serverName ?? label} (${snapshot?.serverClientsOnline ?? 0}/${snapshot?.serverMaxClients || server?.serverMaxClients || "?"})`}
          />
        ))}
        {rows.length === 0 && <Text color="gray">{fit(" Waiting for the channel list...", width)}</Text>}
        {rows.length === 1 && filter && <Text color="gray">{fit(" Nothing matches", width)}</Text>}
      </Box>
    </Box>
  );
}

interface LineProps {
  row: TreeRow;
  width: number;
  ic: Icons;
  selected: boolean;
  focused: boolean;
  dropTarget: boolean;
  talking: boolean;
  whispering: boolean;
  whisperTarget: boolean;
  volume: number;
  own: boolean;
  ownChannel: boolean;
  serverTitle: string;
}

function spacerText(text: string, align: "left" | "center" | "right" | "repeat", width: number): string {
  if (!text) return "";
  if (align === "repeat") {
    const w = Math.max(1, stringWidth(text));
    return text.repeat(Math.ceil(width / w));
  }
  const pad = Math.max(0, width - stringWidth(text));
  if (align === "center") return " ".repeat(Math.floor(pad / 2)) + text;
  if (align === "right") return " ".repeat(pad) + text;
  return text;
}

function TreeLine({ row, width, ic, selected, focused, dropTarget, talking, whispering, whisperTarget, volume, own, ownChannel, serverTitle }: LineProps) {
  const highlight = dropTarget
    ? { backgroundColor: colors.drop }
    : selected
      ? { inverse: focused, backgroundColor: focused ? undefined : "gray" }
      : {};
  if (row.kind === "server") {
    return (
      <Text bold {...highlight} wrap="truncate-end">
        {fit(`${ic.server} ${serverTitle}`, width)}
      </Text>
    );
  }
  const indent = " ".repeat((row.depth - 1) * 2);
  if (row.kind === "channel") {
    if (row.spacer) {
      return <Text color="gray" {...highlight}>{fit(spacerText(row.spacer.text, row.spacer.align, width), width)}</Text>;
    }
    const arrow = row.hasChildren ? (row.expanded ? ic.expanded : ic.collapsed) : " ";
    const count = !row.expanded && row.clientCount > 0 ? ` (${row.clientCount})` : "";
    const lock = row.channel.hasPassword ? ` ${ic.lock}` : "";
    const whisper = whisperTarget ? ` ${ic.whisperTarget}` : "";
    return (
      <Text bold={ownChannel} {...highlight} wrap="truncate-end">
        {fit(`${indent} ${arrow} ${row.channel.name}${count}${lock}${whisper}`, width)}
      </Text>
    );
  }
  const c = row.client;
  const status = whispering ? ic.whispering : talking ? ic.talking : c.away ? ic.away : ic.idle;
  const statusColor = whispering
    ? colors.whisper
    : talking
      ? colors.talking
      : c.away
        ? colors.away
        : c.inputMuted || c.outputMuted
          ? colors.muted
          : colors.dim;
  const flags = [
    c.isChannelCommander ? ic.commander : "",
    c.inputMuted || !c.inputHardwareEnabled ? ic.micMuted : "",
    c.outputMuted ? ic.speakerMuted : "",
    whisperTarget ? ic.whisperTarget : "",
    volume === 0 ? ic.localMute : "",
  ].join("");
  const vol = volume !== 1 && volume !== 0 ? ` ${Math.round(volume * 100)}%` : "";
  const away = c.away ? ` [away${c.awayMessage ? `: ${c.awayMessage}` : ""}]` : "";
  const prefix = `${indent}   `;
  const nameWidth = Math.max(0, width - stringWidth(prefix) - 2);
  return (
    <Text {...highlight} wrap="truncate-end">
      {prefix}
      <Text color={statusColor}>{status}</Text>{" "}
      <Text bold={own} color={own ? colors.self : undefined}>
        {fit(`${c.name}${flags ? ` ${flags}` : ""}${vol}${away}`, nameWidth)}
      </Text>
    </Text>
  );
}
