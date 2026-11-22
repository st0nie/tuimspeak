import { useEffect, useRef, useState } from "react";
import { Box, Text, useInput, type DOMElement } from "ink";
import { useStore } from "zustand";
import type { Controller, Dialog, MenuItem } from "../../app/controller.ts";
import { parseAddress } from "../../connector/address.ts";
import { useMouseRegion } from "../../mouse/react.tsx";
import { setHoverTracking } from "../../mouse/terminal.ts";
import { Button } from "../Button.tsx";
import { colors, fit, stringWidth } from "../theme.ts";
import { Form, Hint, Modal, Toggle, innerWidth, type Screen } from "./kit.tsx";

type Props<K extends Dialog["kind"]> = { controller: Controller; dialog: Extract<Dialog, { kind: K }>; screen: Screen };

/** §9.1: connect form plus bookmarks (Connect, Edit, Delete; Save as bookmark). */
export function ConnectDialog({ controller, dialog, screen }: Props<"connect">) {
  const config = useStore(controller.store, (s) => s.config);
  const bookmarks = useStore(controller.store, (s) => s.bookmarks);
  const [save, setSave] = useState(dialog.editBookmark !== undefined);
  const [savePassword, setSavePassword] = useState(false);
  const editing = dialog.editBookmark !== undefined ? bookmarks[dialog.editBookmark] : undefined;
  const close = () => controller.closeDialog();
  const width = 70;
  const inner = innerWidth(width, screen);

  const submit = (v: Record<string, string>) => {
    if (!v.address?.trim()) return;
    const parsed = parseAddress(v.address);
    const nickname = v.nickname?.trim() || parsed.nickname || config.nickname;
    const password = v.password || parsed.serverPassword;
    const defaultChannel = v.channel?.trim() || parsed.defaultChannel;
    if (save) {
      controller.saveBookmark(
        {
          name: v.name?.trim() || parsed.address,
          address: parsed.address,
          nickname: nickname === config.nickname ? undefined : nickname,
          defaultChannel,
          identity: editing?.identity,
          serverPassword: savePassword ? password : undefined,
        },
        dialog.editBookmark,
      );
    }
    close();
    if (dialog.editBookmark !== undefined) return;
    if (nickname !== config.nickname && !parsed.nickname) controller.setConfig({ nickname });
    controller.connect({ ...parsed, label: save ? v.name?.trim() || undefined : undefined, nickname, serverPassword: password, defaultChannel });
    controller.setFocus("tree");
  };

  return (
    <Modal title={editing ? `Edit bookmark ${editing.name}` : "Connect to server"} width={width} screen={screen} onClose={close}>
      {!editing && bookmarks.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="gray">Bookmarks</Text>
          {bookmarks.map((b, i) => (
            <Box key={`${i}:${b.address}`} gap={1}>
              <Button layer="modal" label=" Connect " color={colors.accent} onClick={() => { close(); controller.connectBookmark(b); }} />
              <Button layer="modal" label="Edit" onClick={() => controller.openDialog({ kind: "connect", editBookmark: i })} />
              <Button
                layer="modal"
                label="Delete"
                onClick={() =>
                  controller.openDialog({
                    kind: "confirm",
                    title: "Delete bookmark",
                    message: `Delete the bookmark "${b.name}"?`,
                    confirmLabel: "Delete",
                    onConfirm: () => {
                      controller.deleteBookmark(i);
                      controller.openDialog({ kind: "connect" });
                    },
                  })
                }
              />
              <Text wrap="truncate-end">{fit(` ${b.name}  ${b.address}`, Math.max(0, inner - 30))}</Text>
            </Box>
          ))}
        </Box>
      )}
      <Form
        width={inner}
        submitLabel={editing ? "Save" : "Connect"}
        onCancel={close}
        onSubmit={submit}
        initial={{
          address: editing?.address ?? "",
          nickname: editing?.nickname ?? config.nickname,
          password: editing?.serverPassword ?? "",
          channel: editing?.defaultChannel ?? "",
          name: editing?.name ?? "",
        }}
        fields={[
          { label: "Address", key: "address", placeholder: "host[:port] or ts3server:// link" },
          { label: "Nickname", key: "nickname" },
          { label: "Password", key: "password", mask: true, placeholder: "server password (optional)" },
          { label: "Channel", key: "channel", placeholder: "default channel path (optional)" },
          { label: "Name", key: "name", placeholder: "bookmark name (when saving)" },
        ]}
        extra={
          <Box marginTop={1} gap={3}>
            {!editing && <Toggle label="Save as bookmark" value={save} onChange={setSave} />}
            <Toggle label="Store password in bookmark" value={savePassword} onChange={setSavePassword} />
          </Box>
        }
      />
    </Modal>
  );
}

export function PromptDialog({ controller, dialog, screen }: Props<"prompt">) {
  const close = () => controller.closeDialog();
  return (
    <Modal title={dialog.title} width={60} screen={screen} onClose={close}>
      <Form
        width={innerWidth(60, screen)}
        submitLabel={dialog.submitLabel}
        onCancel={close}
        onSubmit={(v) => {
          close();
          dialog.onSubmit(v.value ?? "");
        }}
        initial={{ value: dialog.initial ?? "" }}
        fields={[{ label: dialog.label, key: "value", mask: dialog.mask }]}
      />
    </Modal>
  );
}

export function ConfirmDialog({ controller, dialog, screen }: Props<"confirm">) {
  const close = () => controller.closeDialog();
  const confirm = () => {
    close();
    dialog.onConfirm();
  };
  useInput((input, key) => {
    if (key.escape || input === "n") close();
    else if (key.return || input === "y") confirm();
  });
  return (
    <Modal title={dialog.title} width={60} screen={screen} onClose={close}>
      <Text wrap="wrap">{dialog.message}</Text>
      <Box marginTop={1} gap={2}>
        <Button label={` ${dialog.confirmLabel} `} color={colors.error} layer="modal" onClick={confirm} />
        <Button label=" Cancel " layer="modal" onClick={close} />
      </Box>
      <Hint>Enter/y confirm · Esc/n cancel</Hint>
    </Modal>
  );
}

const HELP: [string, string][] = [
  ["Click / ↑↓", "Select channel or client"],
  ["Double-click / Enter", "Join channel, open private chat"],
  ["Right-click / m", "Context menu: whisper, volume, move, kick, files..."],
  ["Click ▸ / ←→", "Collapse / expand channel"],
  ["Drag a person", "Drop on a channel to move them"],
  ["/", "Filter the tree"],
  ["Wheel / PgUp PgDn", "Scroll"],
  ["Tab", "Switch between tree and chat"],
  ["Ctrl+← / Ctrl+→", "Previous / next chat tab"],
  ["Ctrl+W", "Close private chat tab"],
  ["Alt+1..9", "Switch server tab"],
  ["Hold [Hold to talk]", "Push to talk with the mouse"],
  ["Hold [Whisper n]", "Whisper to the list; a short click locks it"],
  ["pttKey / whisperKey", "Hold keys from Settings (F9 / F8 by default)"],
  ["Ctrl+T", "Toggle to talk (toggle and ptt modes)"],
  ["Ctrl+X / Ctrl+D", "Mute microphone / sound"],
  ["F2", "Settings"],
  ["Ctrl+N", "Connect to a server"],
  ["p", "Poke selected client"],
  ["Ctrl+Q", "Quit"],
  ["", ""],
  ["Text selection", "Hold Shift (Linux), Option (iTerm2) or Fn (Terminal.app)"],
];

export function HelpDialog({ controller, screen }: Props<"help">) {
  const close = () => controller.closeDialog();
  useInput((input, key) => {
    if (key.escape || key.return || input === "q" || input === "?") close();
  });
  return (
    <Modal title="tuimspeak help" width={78} screen={screen} onClose={close}>
      {HELP.slice(0, Math.max(4, screen.rows - 7)).map(([k, v], i) => (
        <Text key={i} wrap="truncate-end">
          <Text color={colors.accent}>{k.padEnd(22)}</Text>
          {v}
        </Text>
      ))}
      <Box marginTop={1}>
        <Button label=" Close " layer="modal" onClick={close} />
      </Box>
    </Modal>
  );
}

const AWAY_PRESETS = ["Away from keyboard", "Busy", "Eating", "Back soon"];

export function AwayDialog({ controller, screen }: Props<"away">) {
  const close = () => controller.closeDialog();
  const set = (message: string) => {
    close();
    controller.activeSession()?.setAway(message);
  };
  return (
    <Modal title="Set away" width={60} screen={screen} onClose={close}>
      <Box gap={1} flexWrap="wrap" marginBottom={1}>
        {AWAY_PRESETS.map((p) => (
          <Button key={p} layer="modal" label={` ${p} `} onClick={() => set(p)} />
        ))}
      </Box>
      <Form width={innerWidth(60, screen)} submitLabel="Away" onCancel={close} onSubmit={(v) => set(v.value ?? "")} initial={{ value: "" }} fields={[{ label: "Message", key: "value", placeholder: "custom message" }]} />
    </Modal>
  );
}

export function ChannelPasswordDialog({ controller, dialog, screen }: Props<"channelPassword">) {
  const close = () => controller.closeDialog();
  return (
    <Modal title={`${dialog.moveClientId !== undefined ? "Move into" : "Join"} ${dialog.name || "channel"}`} width={56} screen={screen} onClose={close}>
      <Form
        width={innerWidth(56, screen)}
        submitLabel={dialog.moveClientId !== undefined ? "Move" : "Join"}
        onCancel={close}
        onSubmit={(v) => {
          controller.store.setState({ dialog: null });
          const session = controller.session(dialog.sessionId);
          if (dialog.moveClientId !== undefined) session?.moveClient(dialog.moveClientId, dialog.channelId, v.value);
          else session?.joinChannel(dialog.channelId, v.value);
        }}
        initial={{ value: "" }}
        fields={[{ label: "Password", key: "value", mask: true }]}
      />
    </Modal>
  );
}

function MenuEntry({ item, width, active, onHover, onPick }: { item: MenuItem; width: number; active: boolean; onHover: () => void; onPick: () => void }) {
  const ref = useRef<DOMElement>(null);
  useMouseRegion(ref, { onClick: item.disabled ? undefined : onPick, onHover }, { layer: "overlay" });
  return (
    <Box ref={ref}>
      <Text inverse={active && !item.disabled} color={item.disabled ? "gray" : undefined}>
        {fit(` ${item.label}`, width)}
      </Text>
    </Box>
  );
}

export function ContextMenu({ controller, dialog, screen }: Props<"menu">) {
  const ref = useRef<DOMElement>(null);
  const [active, setActive] = useState(() => Math.max(0, dialog.items.findIndex((i) => !i.disabled)));
  const close = () => controller.closeDialog();
  const pick = (item: MenuItem) => {
    close();
    item.action();
  };
  useMouseRegion(ref, { onPressOutside: close }, { layer: "overlay" });
  useEffect(() => {
    setHoverTracking(true);
    return () => setHoverTracking(false);
  }, []);
  useInput((_input, key) => {
    const step = (d: number) => {
      let i = active;
      for (let n = 0; n < dialog.items.length; n++) {
        i = (i + d + dialog.items.length) % dialog.items.length;
        if (!dialog.items[i]!.disabled) break;
      }
      setActive(i);
    };
    if (key.escape) close();
    else if (key.upArrow) step(-1);
    else if (key.downArrow) step(1);
    else if (key.return) {
      const item = dialog.items[active];
      if (item && !item.disabled) pick(item);
    }
  });
  const width = Math.min(screen.columns - 2, Math.max(stringWidth(dialog.title) + 2, ...dialog.items.map((i) => stringWidth(i.label) + 3)));
  const height = dialog.items.length + 3;
  const left = Math.max(0, Math.min(dialog.x, screen.columns - width - 2));
  const top = Math.max(0, Math.min(dialog.y, screen.rows - height));
  return (
    <Box ref={ref} position="absolute" left={left} top={top} flexDirection="column" borderStyle="single" borderColor={colors.accent} backgroundColor="black">
      <Text bold color={colors.accent}>
        {fit(` ${dialog.title}`, width)}
      </Text>
      {dialog.items.map((item, i) => (
        <MenuEntry key={`${i}:${item.label}`} item={item} width={width} active={i === active} onHover={() => setActive(i)} onPick={() => pick(item)} />
      ))}
    </Box>
  );
}
