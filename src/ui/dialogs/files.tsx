import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { useStore } from "zustand";
import { joinRemote, type Controller, type Dialog } from "../../app/controller.ts";
import type { FileEntry } from "../../connector/protocol.ts";
import type { SessionState } from "../../state/session.ts";
import { Button } from "../Button.tsx";
import { colors, fit } from "../theme.ts";
import { ActionBar, Hint, ListBox, Modal, Row, formatBytes, innerWidth, type Screen } from "./kit.tsx";

type Props = { controller: Controller; dialog: Extract<Dialog, { kind: "files" }>; screen: Screen };

type Item = { kind: "up" } | { kind: "entry"; entry: FileEntry };

const REFRESH_AFTER_CHANGE_MS = 400;

function parentOf(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i <= 0 ? "/" : trimmed.slice(0, i);
}

/** §9.6: browse a channel's files, download, upload, mkdir, rename, delete. */
export function FilesDialog({ controller, dialog, screen }: Props) {
  const session = controller.session(dialog.sessionId);
  const files = useStore(session?.store ?? controller.store, (s) => (session ? (s as SessionState).files : null));
  const transfers = useStore(session?.store ?? controller.store, (s) => (session ? (s as SessionState).transfers : undefined));
  const channelName = useStore(session?.store ?? controller.store, (s) =>
    session ? (s as SessionState).snapshot?.channels.find((c) => c.id === dialog.channelId)?.name : undefined,
  );
  const [selected, setSelected] = useState(0);
  const [barFocused, setBarFocused] = useState(false);
  const close = () => controller.closeDialog();
  const width = 96;
  const inner = innerWidth(width, screen);
  const path = files?.cid === dialog.channelId ? files.path : "/";
  const loaded = files?.cid === dialog.channelId;

  const entries = loaded ? [...files.entries].sort((a, b) => Number(a.isFile) - Number(b.isFile) || a.name.localeCompare(b.name)) : [];
  const items: Item[] = [...(path !== "/" ? [{ kind: "up" } as Item] : []), ...entries.map((entry) => ({ kind: "entry", entry }) as Item)];
  const index = Math.min(selected, Math.max(0, items.length - 1));
  const current = items[index];
  const currentEntry = current?.kind === "entry" ? current.entry : undefined;

  const list = (p: string) => {
    setSelected(0);
    session?.listFiles(dialog.channelId, p);
  };
  const refreshSoon = () => setTimeout(() => session?.listFiles(dialog.channelId, path), REFRESH_AFTER_CHANGE_MS);
  const remotePath = (e: FileEntry) => joinRemote(path, e.name);
  const reopen = () => controller.openDialog({ kind: "files", sessionId: dialog.sessionId, channelId: dialog.channelId });

  const activate = (i: number) => {
    const item = items[i];
    if (!item) return;
    if (item.kind === "up") list(parentOf(path));
    else if (!item.entry.isFile) list(remotePath(item.entry));
    else download(item.entry);
  };
  const download = (e: FileEntry) => controller.download(dialog.sessionId, dialog.channelId, { ...e, path });
  const upload = () =>
    controller.openDialog({
      kind: "prompt",
      title: `Upload to ${path}`,
      label: "Local file",
      submitLabel: "Upload",
      onSubmit: (local) => {
        reopen();
        if (local.trim()) controller.upload(dialog.sessionId, dialog.channelId, path, local);
      },
    });
  const mkdir = () =>
    controller.openDialog({
      kind: "prompt",
      title: `New folder in ${path}`,
      label: "Name",
      submitLabel: "Create",
      onSubmit: (name) => {
        reopen();
        if (!name.trim()) return;
        session?.makeDirectory(dialog.channelId, joinRemote(path, name.trim()));
        refreshSoon();
      },
    });
  const rename = (e: FileEntry) =>
    controller.openDialog({
      kind: "prompt",
      title: `Rename ${e.name}`,
      label: "New name",
      initial: e.name,
      submitLabel: "Rename",
      onSubmit: (name) => {
        reopen();
        if (!name.trim() || name.trim() === e.name) return;
        session?.renameFile(dialog.channelId, remotePath(e), joinRemote(path, name.trim()));
        refreshSoon();
      },
    });
  const remove = (e: FileEntry) =>
    controller.openDialog({
      kind: "confirm",
      title: "Delete",
      message: `Delete ${e.isFile ? "the file" : "the folder"} ${remotePath(e)}?`,
      confirmLabel: "Delete",
      onConfirm: () => {
        reopen();
        session?.deleteFile(dialog.channelId, remotePath(e));
        refreshSoon();
      },
    });

  useInput((input, key) => {
    if (key.escape || (!session && (key.return || input === " "))) close();
    else if (key.tab) setBarFocused((b) => !b);
    else if (key.backspace) path !== "/" && list(parentOf(path));
    else if (input === "u") upload();
    else if (input === "n") mkdir();
    else if (input === "r") list(path);
    else if (currentEntry && input === "d" && currentEntry.isFile) download(currentEntry);
    else if (currentEntry && key.delete) remove(currentEntry);
    else if (currentEntry && input === "e") rename(currentEntry);
  });

  if (!session) {
    return (
      <Modal title="Files" width={50} screen={screen} onClose={close}>
        <Text color="gray">The connection is gone.</Text>
        <Box marginTop={1}>
          <Button label=" Close " focused color={colors.accent} layer="modal" onClick={close} />
        </Box>
      </Modal>
    );
  }

  const recent = (transfers ?? []).filter((t) => t.cid === dialog.channelId).slice(-3);
  const nameWidth = Math.max(10, inner - 34);
  return (
    <Modal title={`Files of ${channelName ?? "channel"}`} width={width} screen={screen} onClose={close}>
      <Text color={colors.accent} wrap="truncate-end">
        {path}
      </Text>
      <ListBox
        items={items}
        selected={index}
        onSelect={setSelected}
        onActivate={activate}
        focused={!barFocused}
        height={Math.max(3, Math.min(16, screen.rows - 14))}
        width={inner}
        empty={loaded ? "Empty folder" : "Loading..."}
        render={(item, sel, w) => {
          if (item.kind === "up") return <Row selected={sel} text={fit("  ..", w)} />;
          const e = item.entry;
          const size = e.isFile ? formatBytes(e.size) : "";
          return <Row selected={sel} color={e.isFile ? undefined : colors.accent} text={fit(`${e.isFile ? "  " : "▸ "}${fit(e.name, nameWidth)} ${size.padStart(10)}  ${fit(e.timestamp, 18)}`, w)} />;
        }}
      />
      <ActionBar
        focused={barFocused}
        gap={1}
        actions={[
          { label: " Download ", disabled: !currentEntry?.isFile, onTrigger: () => currentEntry && download(currentEntry) },
          { label: " Upload... ", onTrigger: upload },
          { label: " New folder ", onTrigger: mkdir },
          { label: " Rename ", disabled: !currentEntry, onTrigger: () => currentEntry && rename(currentEntry) },
          { label: " Delete ", disabled: !currentEntry, onTrigger: () => currentEntry && remove(currentEntry) },
          { label: " Refresh ", onTrigger: () => list(path) },
          { label: " Close ", color: colors.accent, onTrigger: close },
        ]}
      />
      {recent.map((t) => {
        const pct = t.size > 0 ? Math.min(100, Math.floor((t.done / t.size) * 100)) : t.state === "done" ? 100 : 0;
        const status = t.state === "error" ? `failed: ${t.message ?? ""}` : t.state === "done" ? "done" : `${pct}%`;
        return (
          <Text key={t.id} color={t.state === "error" ? colors.error : t.state === "done" ? colors.talking : undefined} wrap="truncate-end">
            {t.kind === "download" ? "↓" : "↑"} {t.path} {formatBytes(t.size)} · {status}
            {t.kind === "download" && t.state === "done" ? ` → ${t.localPath}` : ""}
          </Text>
        );
      })}
      <Hint>Enter/double-click opens or downloads · Backspace up · d download · u upload · n folder · e rename · Del delete</Hint>
    </Modal>
  );
}
