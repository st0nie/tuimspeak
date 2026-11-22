import type { Controller, MenuItem } from "../app/controller.ts";
import type { Session } from "../session/session.ts";
import type { ChannelInfo, ClientInfo } from "../connector/protocol.ts";
import { copyToClipboard } from "./clipboard.ts";

/** Context menus for the tree (architecture §7.4). */

export function joinChannel(controller: Controller, session: Session, channel: ChannelInfo): void {
  if (channel.hasPassword) {
    controller.openDialog({ kind: "channelPassword", sessionId: session.id, channelId: channel.id, name: channel.name });
  } else {
    session.joinChannel(channel.id);
  }
}

/** Moves someone, asking for the password of a protected channel first (§9.3). */
export function moveClient(controller: Controller, session: Session, clientId: number, channel: ChannelInfo): void {
  if (channel.hasPassword) {
    controller.openDialog({ kind: "channelPassword", sessionId: session.id, channelId: channel.id, name: channel.name, moveClientId: clientId });
  } else {
    session.moveClient(clientId, channel.id);
  }
}

export function serverMenu(controller: Controller, session: Session): MenuItem[] {
  const s = session.store.getState();
  const connected = s.status === "connected";
  return [
    { label: "Server chat", action: () => { session.selectTab("server"); controller.setFocus("chat"); } },
    { label: "Connection info", action: () => session.select({ kind: "server" }) },
    {
      label: "Add to bookmarks",
      action: () => {
        const request = controller.requestOf(session.id);
        if (!request) return;
        controller.saveBookmark({
          name: s.server?.serverName || request.address,
          address: request.address,
          nickname: request.nickname,
          defaultChannel: request.defaultChannel,
          identity: request.identityName,
        });
        controller.notify(`Bookmarked ${s.server?.serverName || request.address}`);
      },
    },
    { label: "Ban list...", disabled: !connected, action: () => { session.requestBans(); controller.openDialog({ kind: "bans", sessionId: session.id }); } },
    { label: "Complaints...", disabled: !connected, action: () => { session.requestComplaints(); controller.openDialog({ kind: "complaints", sessionId: session.id }); } },
    { label: "Offline messages...", disabled: !connected, action: () => { session.requestOfflineMessages(); controller.openDialog({ kind: "offlineMessages", sessionId: session.id }); } },
    { label: "Edit server...", disabled: !connected, action: () => controller.openDialog({ kind: "editServer", sessionId: session.id }) },
    { label: "ServerQuery login...", disabled: !connected, action: () => controller.openDialog({ kind: "queryLogin", sessionId: session.id }) },
    { label: "Reconnect", disabled: s.status !== "disconnected", action: () => controller.reconnect(session.id) },
    { label: "Disconnect", action: () => void controller.closeSession(session.id) },
  ];
}

export function channelMenu(controller: Controller, session: Session, channel: ChannelInfo, hasChildren: boolean, expanded: boolean): MenuItem[] {
  const s = session.store.getState();
  const ownChannel = s.snapshot?.clients.find((c) => c.id === s.snapshot?.ownClientId)?.channel;
  const items: MenuItem[] = [{ label: "Join channel", disabled: channel.id === ownChannel, action: () => joinChannel(controller, session, channel) }];
  if (hasChildren) items.push({ label: expanded ? "Collapse" : "Expand", action: () => session.toggleCollapsed(channel.id) });
  items.push(
    {
      label: "Files...",
      action: () => {
        session.listFiles(channel.id, "/");
        controller.openDialog({ kind: "files", sessionId: session.id, channelId: channel.id });
      },
    },
    {
      label: session.isWhisperTarget("channel", channel.id) ? "Remove from whisper list" : "Whisper to channel",
      action: () => session.toggleWhisperTarget("channel", channel.id),
    },
    { label: "Copy name", action: () => copyToClipboard(channel.name) },
  );
  return items;
}

export function clientMenu(controller: Controller, session: Session, client: ClientInfo): MenuItem[] {
  const s = session.store.getState();
  const own = client.id === s.snapshot?.ownClientId;
  if (own) {
    return [
      {
        label: "Change nickname...",
        action: () =>
          controller.openDialog({
            kind: "prompt",
            title: "Change nickname",
            label: "Nickname",
            initial: client.name,
            submitLabel: "Change",
            onSubmit: (v) => {
              if (!v.trim()) return;
              session.setNickname(v);
              controller.setConfig({ nickname: v.trim() });
            },
          }),
      },
      s.away ? { label: "Clear away", action: () => session.setAway(null) } : { label: "Set away...", action: () => controller.openDialog({ kind: "away" }) },
      { label: controller.state.micMuted ? "Unmute microphone" : "Mute microphone", action: () => controller.toggleMic() },
      { label: "Copy nickname", action: () => copyToClipboard(client.name) },
    ];
  }
  const ownChannel = s.snapshot?.clients.find((c) => c.id === s.snapshot?.ownClientId)?.channel;
  const volume = controller.volumeOf(client.uid);
  const exception = controller.isWhisperException(client.uid);
  const blocking = controller.state.config.blockWhispers;
  return [
    { label: "Private chat", action: () => { session.openPrivateChat(client.id); controller.setFocus("chat"); } },
    {
      label: "Poke...",
      action: () =>
        controller.openDialog({
          kind: "prompt",
          title: `Poke ${client.name}`,
          label: "Message",
          submitLabel: "Poke",
          onSubmit: (v) => session.poke(client.id, v),
        }),
    },
    { label: `Volume... (${Math.round(volume * 100)}%)`, action: () => controller.openDialog({ kind: "volume", sessionId: session.id, clientId: client.id }) },
    { label: volume === 0 ? "Unmute locally" : "Mute locally", action: () => controller.setVolume(client.uid, volume === 0 ? 1 : 0) },
    {
      label: session.isWhisperTarget("client", client.id) ? "Remove from whisper list" : "Whisper to",
      action: () => session.toggleWhisperTarget("client", client.id),
    },
    {
      // With blocking on, an exception allows; with blocking off, it blocks.
      label: blocking ? (exception ? "Block whispers from" : "Allow whispers from") : exception ? "Allow whispers from" : "Block whispers from",
      action: () => controller.toggleWhisperException(client.uid),
    },
    {
      label: "Move to my channel",
      disabled: ownChannel === undefined || client.channel === ownChannel,
      action: () => {
        const channel = s.snapshot?.channels.find((c) => c.id === ownChannel);
        if (channel) moveClient(controller, session, client.id, channel);
      },
    },
    { label: "Move to...", action: () => controller.openDialog({ kind: "movePicker", sessionId: session.id, clientId: client.id }) },
    { label: "Kick from channel...", action: () => controller.openDialog({ kind: "kick", sessionId: session.id, clientId: client.id, from: "channel" }) },
    { label: "Kick from server...", action: () => controller.openDialog({ kind: "kick", sessionId: session.id, clientId: client.id, from: "server" }) },
    { label: "Ban...", action: () => controller.openDialog({ kind: "ban", sessionId: session.id, clientId: client.id }) },
    {
      label: "Server groups...",
      disabled: client.databaseId === 0,
      action: () => { session.requestServerGroups(); controller.openDialog({ kind: "serverGroups", sessionId: session.id, clientId: client.id }); },
    },
    {
      label: "Channel group...",
      disabled: client.databaseId === 0,
      action: () => { session.requestChannelGroups(); controller.openDialog({ kind: "channelGroup", sessionId: session.id, clientId: client.id }); },
    },
    {
      label: "Send offline message...",
      disabled: !client.uid,
      action: () => controller.openDialog({ kind: "sendOfflineMessage", sessionId: session.id, uid: client.uid, name: client.name }),
    },
    { label: "Copy nickname", action: () => copyToClipboard(client.name) },
  ];
}

/** Right-click on `[Whisper n]`: the list, to remove entries or clear it (§8.3). */
export function whisperListMenu(controller: Controller, session: Session): MenuItem[] {
  const s = session.store.getState();
  const items: MenuItem[] = [];
  for (const id of s.whisperTargets.channels) {
    const name = s.snapshot?.channels.find((c) => c.id === id)?.name ?? `#${id}`;
    items.push({ label: `Remove channel ${name}`, action: () => session.toggleWhisperTarget("channel", id) });
  }
  for (const id of s.whisperTargets.clients) {
    const name = s.snapshot?.clients.find((c) => c.id === id)?.name ?? `#${id}`;
    items.push({ label: `Remove ${name}`, action: () => session.toggleWhisperTarget("client", id) });
  }
  if (items.length === 0) items.push({ label: "Empty: add people or channels from their menu", disabled: true, action: () => {} });
  else {
    items.push({ label: s.whisperLocked ? "Unlock whisper" : "Lock whisper on", action: () => session.setWhisperLocked(!s.whisperLocked) });
    items.push({ label: "Clear list", action: () => session.clearWhisperTargets() });
  }
  void controller;
  return items;
}
