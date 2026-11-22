import { useStore } from "zustand";
import type { Controller } from "../../app/controller.ts";
import type { Screen } from "./kit.tsx";
import { AwayDialog, ChannelPasswordDialog, ConfirmDialog, ConnectDialog, ContextMenu, HelpDialog, PromptDialog } from "./basic.tsx";
import { SettingsDialog, VolumeDialog } from "./voice.tsx";
import {
  BanDialog,
  BansDialog,
  ChannelGroupDialog,
  ComplaintsDialog,
  EditServerDialog,
  KickDialog,
  MovePickerDialog,
  OfflineMessagesDialog,
  QueryLoginDialog,
  SendOfflineMessageDialog,
  ServerGroupsDialog,
} from "./admin.tsx";
import { FilesDialog } from "./files.tsx";

/** Renders the open dialog, if any, above everything else (§7.4). */
export function DialogLayer({ controller, screen }: { controller: Controller; screen: Screen }) {
  const dialog = useStore(controller.store, (s) => s.dialog);
  if (!dialog) return null;
  const p = { controller, screen };
  switch (dialog.kind) {
    case "connect":
      return <ConnectDialog key={`connect:${dialog.editBookmark ?? ""}`} {...p} dialog={dialog} />;
    case "help":
      return <HelpDialog {...p} dialog={dialog} />;
    case "settings":
      return <SettingsDialog {...p} dialog={dialog} />;
    case "menu":
      return <ContextMenu {...p} dialog={dialog} />;
    case "confirm":
      return <ConfirmDialog {...p} dialog={dialog} />;
    case "prompt":
      return <PromptDialog key={dialog.title} {...p} dialog={dialog} />;
    case "away":
      return <AwayDialog {...p} dialog={dialog} />;
    case "channelPassword":
      return <ChannelPasswordDialog {...p} dialog={dialog} />;
    case "volume":
      return <VolumeDialog {...p} dialog={dialog} />;
    case "kick":
      return <KickDialog {...p} dialog={dialog} />;
    case "ban":
      return <BanDialog {...p} dialog={dialog} />;
    case "bans":
      return <BansDialog {...p} dialog={dialog} />;
    case "complaints":
      return <ComplaintsDialog {...p} dialog={dialog} />;
    case "serverGroups":
      return <ServerGroupsDialog {...p} dialog={dialog} />;
    case "channelGroup":
      return <ChannelGroupDialog {...p} dialog={dialog} />;
    case "offlineMessages":
      return <OfflineMessagesDialog {...p} dialog={dialog} />;
    case "sendOfflineMessage":
      return <SendOfflineMessageDialog {...p} dialog={dialog} />;
    case "editServer":
      return <EditServerDialog {...p} dialog={dialog} />;
    case "queryLogin":
      return <QueryLoginDialog {...p} dialog={dialog} />;
    case "files":
      return <FilesDialog {...p} dialog={dialog} />;
    case "movePicker":
      return <MovePickerDialog {...p} dialog={dialog} />;
  }
}
