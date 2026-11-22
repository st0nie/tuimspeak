import { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { useStore } from "zustand";
import type { Controller, Dialog } from "../../app/controller.ts";
import type { Session } from "../../session/session.ts";
import type { SessionState } from "../../state/session.ts";
import { buildTree } from "../../state/tree.ts";
import { Button } from "../Button.tsx";
import { colors, fit } from "../theme.ts";
import { moveClient } from "../menus.ts";
import { ActionBar, Choice, Form, Hint, ListBox, Modal, Row, innerWidth, formatDuration, stepOption, type Screen } from "./kit.tsx";
import { TextInput } from "../TextInput.tsx";

type Props<K extends Dialog["kind"]> = { controller: Controller; dialog: Extract<Dialog, { kind: K }>; screen: Screen };

/** Reads a session's store, or nothing if the session is gone. */
function useSession<T>(controller: Controller, sessionId: string, select: (s: SessionState) => T): [Session | undefined, T | undefined] {
  const session = controller.session(sessionId);
  const value = useStore(session?.store ?? controller.store, (s) => (session ? select(s as SessionState) : undefined));
  return [session, value];
}

function Gone({ controller, screen, title }: { controller: Controller; screen: Screen; title: string }) {
  const close = () => controller.closeDialog();
  useInput((input, key) => {
    if (key.escape || key.return || input === " ") close();
  });
  return (
    <Modal title={title} width={50} screen={screen} onClose={close}>
      <Text color="gray">Not available any more.</Text>
      <Box marginTop={1}>
        <Button label=" Close " focused color={colors.accent} layer="modal" onClick={close} />
      </Box>
    </Modal>
  );
}

const listHeight = (screen: Screen, reserved: number) => Math.max(3, Math.min(14, screen.rows - reserved));

export function KickDialog({ controller, dialog, screen }: Props<"kick">) {
  const [session, client] = useSession(controller, dialog.sessionId, (s) => s.snapshot?.clients.find((c) => c.id === dialog.clientId));
  const close = () => controller.closeDialog();
  if (!session || !client) return <Gone controller={controller} screen={screen} title="Kick" />;
  return (
    <Modal title={`Kick ${client.name} from the ${dialog.from}`} width={60} screen={screen} onClose={close}>
      <Form
        width={innerWidth(60, screen)}
        submitLabel="Kick"
        onCancel={close}
        initial={{ reason: "" }}
        fields={[{ label: "Reason", key: "reason", placeholder: "optional" }]}
        onSubmit={(v) => {
          close();
          if (dialog.from === "channel") session.kickFromChannel(client.id, v.reason ?? "");
          else session.kickFromServer(client.id, v.reason ?? "");
        }}
      />
    </Modal>
  );
}

const BAN_DURATIONS: { value: string; label: string; secs: number }[] = [
  { value: "600", label: "10 min", secs: 600 },
  { value: "3600", label: "1 hour", secs: 3600 },
  { value: "86400", label: "1 day", secs: 86_400 },
  { value: "604800", label: "1 week", secs: 604_800 },
  { value: "0", label: "Permanent", secs: 0 },
];

const BAN_DURATION_VALUES = BAN_DURATIONS.map((d) => d.value);

export function BanDialog({ controller, dialog, screen }: Props<"ban">) {
  const [session, client] = useSession(controller, dialog.sessionId, (s) => s.snapshot?.clients.find((c) => c.id === dialog.clientId));
  const [duration, setDuration] = useState("3600");
  const close = () => controller.closeDialog();
  if (!session || !client) return <Gone controller={controller} screen={screen} title="Ban" />;
  return (
    <Modal title={`Ban ${client.name}`} width={64} screen={screen} onClose={close}>
      <Form
        width={innerWidth(64, screen)}
        submitLabel="Ban"
        onCancel={close}
        beforeRows={[
          {
            key: "duration",
            label: "Duration",
            marginBottom: 1,
            onStep: (d) => setDuration(stepOption(BAN_DURATION_VALUES, duration, d)),
            items: [
              {
                key: "choice",
                render: (f) => <Choice options={BAN_DURATIONS} value={duration} focused={f} onChange={setDuration} />,
                onActivate: () => setDuration(stepOption(BAN_DURATION_VALUES, duration, 1)),
              },
            ],
          },
        ]}
        initial={{ reason: "" }}
        fields={[{ label: "Reason", key: "reason", placeholder: "optional" }]}
        onSubmit={(v) => {
          close();
          session.ban(client.id, Number(duration), v.reason ?? "");
        }}
      />
    </Modal>
  );
}

export function BansDialog({ controller, dialog, screen }: Props<"bans">) {
  const [session, bans] = useSession(controller, dialog.sessionId, (s) => s.bans);
  const [selected, setSelected] = useState(0);
  const [barFocused, setBarFocused] = useState(false);
  const close = () => controller.closeDialog();
  const width = 90;
  const inner = innerWidth(width, screen);
  const list = bans ?? [];
  const current = list[Math.min(selected, list.length - 1)];
  const remove = () => current && session?.deleteBan(current.banId);
  useInput((input, key) => {
    if (key.escape) close();
    else if (key.tab) setBarFocused((b) => !b);
    else if (key.delete || input === "d") remove();
    else if (input === "r") session?.requestBans();
  });
  if (!session) return <Gone controller={controller} screen={screen} title="Ban list" />;
  return (
    <Modal title="Ban list" width={width} screen={screen} onClose={close}>
      <Text color="gray" wrap="truncate-end">
        {fit(`${"Target".padEnd(28)}${"Reason".padEnd(26)}${"Expires".padEnd(14)}By`, inner)}
      </Text>
      <ListBox
        items={list}
        selected={Math.min(selected, Math.max(0, list.length - 1))}
        onSelect={setSelected}
        focused={!barFocused}
        height={listHeight(screen, 12)}
        width={inner}
        empty={bans === null ? "Loading..." : "No bans"}
        render={(b, sel, w) => {
          const target = b.name || b.lastNickname || b.uid || b.ip;
          const expires = b.durationSecs === 0 ? "never" : formatDuration(b.durationSecs);
          return <Row selected={sel} text={fit(`${fit(target, 27)} ${fit(b.reason || "-", 25)} ${fit(expires, 13)} ${b.invokerName}`, w)} />;
        }}
      />
      <ActionBar
        focused={barFocused}
        actions={[
          { label: " Delete ", disabled: !current, onTrigger: () => remove() },
          {
            label: " Delete all ",
            color: colors.error,
            disabled: list.length === 0,
            onTrigger: () =>
              controller.openDialog({
                kind: "confirm",
                title: "Delete all bans",
                message: `Delete all ${list.length} bans on this server?`,
                confirmLabel: "Delete all",
                onConfirm: () => {
                  session.deleteAllBans();
                  controller.openDialog({ kind: "bans", sessionId: session.id });
                },
              }),
          },
          { label: " Refresh ", onTrigger: () => session.requestBans() },
          { label: " Close ", color: colors.accent, onTrigger: close },
        ]}
      />
      <Hint>Tab buttons · d/Del delete · r refresh · Esc close</Hint>
    </Modal>
  );
}

export function ComplaintsDialog({ controller, dialog, screen }: Props<"complaints">) {
  const [session, complaints] = useSession(controller, dialog.sessionId, (s) => s.complaints);
  const [selected, setSelected] = useState(0);
  const [barFocused, setBarFocused] = useState(false);
  const close = () => controller.closeDialog();
  const width = 90;
  const inner = innerWidth(width, screen);
  const list = complaints ?? [];
  const current = list[Math.min(selected, list.length - 1)];
  const remove = () => current && session?.deleteComplaint(current.targetClientDbId, current.fromClientDbId);
  useInput((input, key) => {
    if (key.escape) close();
    else if (key.tab) setBarFocused((b) => !b);
    else if (key.delete || input === "d") remove();
  });
  if (!session) return <Gone controller={controller} screen={screen} title="Complaints" />;
  return (
    <Modal title="Complaints" width={width} screen={screen} onClose={close}>
      <ListBox
        items={list}
        selected={Math.min(selected, Math.max(0, list.length - 1))}
        onSelect={setSelected}
        focused={!barFocused}
        height={listHeight(screen, 11)}
        width={inner}
        empty={complaints === null ? "Loading..." : "No complaints"}
        render={(c, sel, w) => <Row selected={sel} text={fit(`${fit(c.targetName, 20)} ← ${fit(c.fromName, 18)} ${c.message}`, w)} />}
      />
      <ActionBar
        focused={barFocused}
        actions={[
          { label: " Delete ", disabled: !current, onTrigger: () => remove() },
          { label: " Close ", color: colors.accent, onTrigger: close },
        ]}
      />
      <Hint>Tab buttons · d/Del delete · Esc close</Hint>
    </Modal>
  );
}

/** §9.4: a checkbox per server group. */
export function ServerGroupsDialog({ controller, dialog, screen }: Props<"serverGroups">) {
  // Two selectors: one returning a fresh object would re-render forever.
  const [session, serverGroups] = useSession(controller, dialog.sessionId, (s) => s.serverGroups);
  const [, client] = useSession(controller, dialog.sessionId, (s) => s.snapshot?.clients.find((c) => c.id === dialog.clientId));
  const [selected, setSelected] = useState(0);
  const [barFocused, setBarFocused] = useState(false);
  const close = () => controller.closeDialog();
  const width = 60;
  const groups = serverGroups ?? [];
  const toggle = (i: number) => {
    const g = groups[i];
    if (!g || !client || !session) return;
    session.setServerGroup(g.id, client.databaseId, !client.serverGroups.includes(g.id));
  };
  useInput((input, key) => {
    if (key.escape) close();
    else if (key.tab) setBarFocused((b) => !b);
    else if (!barFocused && input === " ") toggle(selected);
  });
  if (!session || !client) return <Gone controller={controller} screen={screen} title="Server groups" />;
  return (
    <Modal title={`Server groups of ${client.name}`} width={width} screen={screen} onClose={close}>
      <ListBox
        items={groups}
        selected={Math.min(selected, Math.max(0, groups.length - 1))}
        onSelect={setSelected}
        onActivate={toggle}
        focused={!barFocused}
        height={listHeight(screen, 10)}
        width={innerWidth(width, screen)}
        empty={serverGroups === null ? "Loading..." : "No groups"}
        render={(g, sel, w) => <Row selected={sel} text={fit(`[${client.serverGroups.includes(g.id) ? "x" : " "}] ${g.name}`, w)} />}
      />
      <ActionBar
        focused={barFocused}
        actions={[
          { label: " Toggle ", disabled: groups.length === 0, onTrigger: () => toggle(selected) },
          { label: " Close ", color: colors.accent, onTrigger: close },
        ]}
      />
      <Hint>Enter/Space toggles membership · Tab buttons · Esc close</Hint>
    </Modal>
  );
}

export function ChannelGroupDialog({ controller, dialog, screen }: Props<"channelGroup">) {
  const [session, channelGroups] = useSession(controller, dialog.sessionId, (s) => s.channelGroups);
  const [, client] = useSession(controller, dialog.sessionId, (s) => s.snapshot?.clients.find((c) => c.id === dialog.clientId));
  const [selected, setSelected] = useState(0);
  const [barFocused, setBarFocused] = useState(false);
  const close = () => controller.closeDialog();
  const width = 60;
  const groups = channelGroups ?? [];
  const choose = (i: number) => {
    const g = groups[i];
    if (!g || !client || !session) return;
    session.setChannelGroup(g.id, client.channel, client.databaseId);
  };
  useInput((input, key) => {
    if (key.escape) close();
    else if (key.tab) setBarFocused((b) => !b);
    else if (!barFocused && input === " ") choose(selected);
  });
  if (!session || !client) return <Gone controller={controller} screen={screen} title="Channel group" />;
  return (
    <Modal title={`Channel group of ${client.name}`} width={width} screen={screen} onClose={close}>
      <ListBox
        items={groups}
        selected={Math.min(selected, Math.max(0, groups.length - 1))}
        onSelect={setSelected}
        onActivate={choose}
        focused={!barFocused}
        height={listHeight(screen, 10)}
        width={innerWidth(width, screen)}
        empty={channelGroups === null ? "Loading..." : "No groups"}
        render={(g, sel, w) => <Row selected={sel} text={fit(`(${client.channelGroup === g.id ? "•" : " "}) ${g.name}`, w)} />}
      />
      <ActionBar
        focused={barFocused}
        actions={[
          { label: " Set ", disabled: groups.length === 0, onTrigger: () => choose(selected) },
          { label: " Close ", color: colors.accent, onTrigger: close },
        ]}
      />
      <Hint>{`Enter/Space sets group for ${client.name}'s channel · Tab buttons · Esc close`}</Hint>
    </Modal>
  );
}

/** §9.5 */
export function OfflineMessagesDialog({ controller, dialog, screen }: Props<"offlineMessages">) {
  const [session, messages] = useSession(controller, dialog.sessionId, (s) => s.offlineMessages);
  const [, open] = useSession(controller, dialog.sessionId, (s) => s.offlineMessage);
  const [selected, setSelected] = useState(0);
  const [barFocused, setBarFocused] = useState(false);
  const close = () => controller.closeDialog();
  const width = 90;
  const inner = innerWidth(width, screen);
  const list = messages ?? [];
  const current = list[Math.min(selected, list.length - 1)];
  useInput((input, key) => {
    if (key.escape) {
      if (open) session?.closeOfflineMessage();
      else close();
    } else if (open && key.backspace) {
      session?.closeOfflineMessage();
    } else if (!open && key.tab) {
      setBarFocused((b) => !b);
    } else if (key.delete || input === "d") {
      const id = open?.messageId ?? current?.messageId;
      if (id !== undefined) session?.deleteOfflineMessage(id);
    } else if (!open && input === "r") {
      session?.requestOfflineMessages();
    }
  });
  if (!session) return <Gone controller={controller} screen={screen} title="Offline messages" />;
  if (open) {
    return (
      <Modal title={open.subject || "(no subject)"} width={width} screen={screen} onClose={close}>
        <Text color="gray" wrap="truncate-end">
          From {open.clientUid} · {open.timestamp}
        </Text>
        <Box marginY={1}>
          <Text wrap="wrap">{open.message}</Text>
        </Box>
        <ActionBar
          focused
          marginTop={0}
          actions={[
            { label: " Back ", color: colors.accent, onTrigger: () => session.closeOfflineMessage() },
            { label: " Delete ", color: colors.error, onTrigger: () => session.deleteOfflineMessage(open.messageId) },
          ]}
        />
        <Hint>←→ select · Enter/Backspace back · d/Del delete · Esc back</Hint>
      </Modal>
    );
  }
  return (
    <Modal title="Offline messages" width={width} screen={screen} onClose={close}>
      <ListBox
        items={list}
        selected={Math.min(selected, Math.max(0, list.length - 1))}
        onSelect={setSelected}
        onActivate={(i) => list[i] && session.readOfflineMessage(list[i]!.messageId)}
        focused={!barFocused}
        height={listHeight(screen, 11)}
        width={inner}
        empty={messages === null ? "Loading..." : "No offline messages"}
        render={(m, sel, w) => <Row selected={sel} dim={m.isRead} text={fit(`${m.isRead ? " " : "●"} ${fit(m.subject || "(no subject)", 40)} ${fit(m.timestamp, 20)} ${m.clientUid}`, w)} />}
      />
      <ActionBar
        focused={barFocused}
        actions={[
          { label: " Open ", disabled: !current, onTrigger: () => current && session.readOfflineMessage(current.messageId) },
          { label: " Delete ", disabled: !current, onTrigger: () => current && session.deleteOfflineMessage(current.messageId) },
          { label: " Refresh ", onTrigger: () => session.requestOfflineMessages() },
          { label: " Close ", color: colors.accent, onTrigger: close },
        ]}
      />
      <Hint>Enter opens · Tab buttons · d/Del delete · r refresh · Esc close</Hint>
    </Modal>
  );
}

export function SendOfflineMessageDialog({ controller, dialog, screen }: Props<"sendOfflineMessage">) {
  const session = controller.session(dialog.sessionId);
  const close = () => controller.closeDialog();
  if (!session) return <Gone controller={controller} screen={screen} title="Offline message" />;
  return (
    <Modal title={`Offline message to ${dialog.name}`} width={70} screen={screen} onClose={close}>
      <Form
        width={innerWidth(70, screen)}
        submitLabel="Send"
        onCancel={close}
        initial={{ subject: "", text: "" }}
        fields={[
          { label: "Subject", key: "subject" },
          { label: "Message", key: "text" },
        ]}
        onSubmit={(v) => {
          if (!v.subject?.trim() && !v.text?.trim()) return;
          close();
          session.sendOfflineMessage(dialog.uid, v.subject ?? "", v.text ?? "");
        }}
      />
    </Modal>
  );
}

export function EditServerDialog({ controller, dialog, screen }: Props<"editServer">) {
  const [session, server] = useSession(controller, dialog.sessionId, (s) => s.server);
  const close = () => controller.closeDialog();
  if (!session || !server) return <Gone controller={controller} screen={screen} title="Edit server" />;
  return (
    <Modal title="Edit server" width={74} screen={screen} onClose={close}>
      <Form
        width={innerWidth(74, screen)}
        submitLabel="Save"
        onCancel={close}
        initial={{ name: server.serverName, welcome: server.welcomeMessage, password: "", max: String(server.serverMaxClients || "") }}
        fields={[
          { label: "Name", key: "name" },
          { label: "Welcome", key: "welcome" },
          { label: "Password", key: "password", mask: true, placeholder: "leave empty to keep" },
          { label: "Max clients", key: "max" },
        ]}
        onSubmit={(v) => {
          const changes: { name?: string; welcomeMessage?: string; password?: string; maxClients?: number } = {};
          if (v.name !== undefined && v.name !== server.serverName) changes.name = v.name;
          if (v.welcome !== undefined && v.welcome !== server.welcomeMessage) changes.welcomeMessage = v.welcome;
          if (v.password) changes.password = v.password;
          const max = Number(v.max);
          if (Number.isInteger(max) && max > 0 && max !== server.serverMaxClients) changes.maxClients = max;
          close();
          if (Object.keys(changes).length > 0) session.editServer(changes);
        }}
      />
      <Hint>Only changed fields are sent. Needs the matching server permissions.</Hint>
    </Modal>
  );
}

export function QueryLoginDialog({ controller, dialog, screen }: Props<"queryLogin">) {
  const session = controller.session(dialog.sessionId);
  const close = () => controller.closeDialog();
  if (!session) return <Gone controller={controller} screen={screen} title="ServerQuery login" />;
  return (
    <Modal title="ServerQuery login" width={60} screen={screen} onClose={close}>
      <Form
        width={innerWidth(60, screen)}
        submitLabel="Log in"
        onCancel={close}
        initial={{ user: "", password: "" }}
        fields={[
          { label: "User", key: "user" },
          { label: "Password", key: "password", mask: true },
        ]}
        onSubmit={(v) => {
          close();
          session.serverQueryLogin(v.user ?? "", v.password ?? "");
        }}
      />
    </Modal>
  );
}

/** "Move to...": pick a channel from a filterable list (§9.3). */
export function MovePickerDialog({ controller, dialog, screen }: Props<"movePicker">) {
  const [session, snapshot] = useSession(controller, dialog.sessionId, (s) => s.snapshot);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState(0);
  const close = () => controller.closeDialog();
  const width = 70;
  const inner = innerWidth(width, screen);
  const channels = useMemo(() => {
    if (!snapshot) return [];
    return buildTree(snapshot, { collapsed: {}, showQueryClients: false, filter: filter || undefined })
      .filter((r) => r.kind === "channel" && !r.spacer)
      .map((r) => (r.kind === "channel" ? { channel: r.channel, depth: r.depth } : null))
      .filter((x) => x !== null);
  }, [snapshot, filter]);
  const client = snapshot?.clients.find((c) => c.id === dialog.clientId);
  const choose = (i: number) => {
    const entry = channels[i];
    if (!entry || !session || !client) return;
    close();
    moveClient(controller, session, client.id, entry.channel);
  };
  // The filter field has the keyboard; arrows move the selection here, Enter is the field's submit.
  useInput((_input, key) => {
    if (key.escape) close();
    else if (key.upArrow) setSelected((i) => Math.max(0, i - 1));
    else if (key.downArrow) setSelected((i) => Math.min(channels.length - 1, i + 1));
  });
  if (!session || !client) return <Gone controller={controller} screen={screen} title="Move" />;
  return (
    <Modal title={`Move ${client.name} to...`} width={width} screen={screen} onClose={close}>
      <TextInput value={filter} onChange={(v) => { setFilter(v); setSelected(0); }} focused prompt="/ " placeholder="filter" width={inner} layer="modal" onSubmit={() => choose(selected)} />
      <ListBox
        items={channels}
        selected={Math.min(selected, Math.max(0, channels.length - 1))}
        onSelect={setSelected}
        onActivate={choose}
        focused={false}
        height={listHeight(screen, 9)}
        width={inner}
        render={(e, sel, w) => <Row selected={sel} dim={e.channel.id === client.channel} text={fit(`${" ".repeat((e.depth - 1) * 2)}${e.channel.name}${e.channel.hasPassword ? " *" : ""}`, w)} />}
      />
      <Hint>Type to filter · ↑↓ · Enter or double-click moves · Esc cancel</Hint>
    </Modal>
  );
}
