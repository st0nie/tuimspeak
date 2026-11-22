import { Box, Text } from "ink";
import { useStore } from "zustand";
import type { Controller } from "../app/controller.ts";
import type { Session } from "../session/session.ts";
import { findChannelPath } from "../state/tree.ts";
import { plainText } from "./bbcode.ts";
import { Button } from "./Button.tsx";
import { colors, fit } from "./theme.ts";
import { formatBytes, formatDuration } from "./dialogs/kit.tsx";

interface Props {
  controller: Controller;
  session: Session;
  width: number;
  height: number;
}

type Field = { label: string; value: string; color?: string };

function FieldLine({ field, width }: { field: Field; width: number }) {
  return (
    <Text wrap="truncate-end">
      <Text color="gray">{field.label.padEnd(10)}</Text>
      <Text color={field.color}>{fit(field.value, Math.max(0, width - 10))}</Text>
    </Text>
  );
}

/** Details of whatever is selected in the tree, or the server (§9.2). */
export function InfoPanel({ controller, session, width, height }: Props) {
  const selection = useStore(session.store, (s) => s.selection);
  const snapshot = useStore(session.store, (s) => s.snapshot);
  const server = useStore(session.store, (s) => s.server);
  const status = useStore(session.store, (s) => s.status);
  const statusText = useStore(session.store, (s) => s.statusText);
  const clientInfo = useStore(session.store, (s) => s.clientInfo);
  const serverInfo = useStore(session.store, (s) => s.serverInfo);
  const whisperers = useStore(session.store, (s) => s.whisperers);
  const targets = useStore(session.store, (s) => s.whisperTargets);
  const volumes = useStore(controller.store, (s) => s.config.volumes);

  const fields: Field[] = [];
  let title = server?.serverName ?? session.store.getState().label;

  if (selection?.kind === "channel" && snapshot) {
    const ch = snapshot.channels.find((c) => c.id === selection.id);
    if (ch) {
      title = ch.name;
      const clients = snapshot.clients.filter((c) => c.channel === ch.id && !c.isQuery).length;
      fields.push({ label: "Path", value: findChannelPath(snapshot, ch.id).map((c) => c.name).join(" / ") });
      if (ch.topic) fields.push({ label: "Topic", value: plainText(ch.topic) });
      fields.push({ label: "Codec", value: ch.codec });
      fields.push({ label: "Clients", value: `${clients}/${ch.maxClients ?? "∞"}` });
      fields.push({ label: "Password", value: ch.hasPassword ? "yes" : "no" });
      if (targets.channels.includes(ch.id)) fields.push({ label: "Whisper", value: "in your whisper list", color: colors.whisper });
    }
  } else if (selection?.kind === "client" && snapshot) {
    const c = snapshot.clients.find((x) => x.id === selection.id);
    if (c) {
      title = c.name;
      const own = c.id === snapshot.ownClientId;
      const channel = snapshot.channels.find((ch) => ch.id === c.channel);
      fields.push({ label: "Channel", value: channel?.name ?? "?" });
      if (c.country) fields.push({ label: "Country", value: c.country });
      fields.push({ label: "Status", value: c.away ? `away${c.awayMessage ? `: ${c.awayMessage}` : ""}` : "online", color: c.away ? colors.away : undefined });
      const audio = [c.inputMuted ? "mic muted" : "", !c.inputHardwareEnabled ? "mic disabled" : "", c.outputMuted ? "sound muted" : ""].filter(Boolean);
      fields.push({ label: "Audio", value: audio.join(", ") || "ok" });
      if (!own) {
        const volume = volumes[c.uid] ?? 1;
        fields.push({ label: "Volume", value: volume === 0 ? "muted locally" : `${Math.round(volume * 100)}%`, color: volume === 1 ? undefined : colors.accent });
      }
      if (whisperers.includes(c.id)) fields.push({ label: "Whisper", value: "whispering to you", color: colors.whisper });
      else if (targets.clients.includes(c.id)) fields.push({ label: "Whisper", value: "in your whisper list", color: colors.whisper });
      if (!c.hasTalkPower) fields.push({ label: "Talk", value: "no talk power", color: colors.muted });
      const info = clientInfo[c.id];
      if (info) {
        if (info.pingMs !== null) fields.push({ label: "Ping", value: `${Math.round(info.pingMs)} ms` });
        if (info.connectedSecs !== null) fields.push({ label: "Online", value: formatDuration(info.connectedSecs) });
        if (info.ip) fields.push({ label: "Address", value: info.ip });
        fields.push({ label: "Traffic", value: `↑ ${formatBytes(info.bytesSent)}  ↓ ${formatBytes(info.bytesReceived)}` });
        fields.push({ label: "Loss", value: `${info.packetLossPercent.toFixed(1)}%` });
      }
      fields.push({ label: "UID", value: c.uid });
      if (c.isQuery) fields.push({ label: "Type", value: "ServerQuery" });
    }
  } else {
    fields.push({ label: "Status", value: statusText, color: status === "disconnected" ? colors.error : undefined });
    if (server) {
      fields.push({ label: "Version", value: server.serverVersion });
      if (snapshot) {
        fields.push({ label: "Clients", value: `${snapshot.serverClientsOnline}/${snapshot.serverMaxClients || server.serverMaxClients}` });
        fields.push({ label: "Channels", value: String(snapshot.serverChannelsOnline) });
      }
      if (serverInfo) {
        fields.push({ label: "Ping", value: `${Math.round(serverInfo.pingMs)} ms, loss ${serverInfo.packetLossPercent.toFixed(1)}%` });
        fields.push({ label: "Bandwidth", value: `↑ ${formatBytes(serverInfo.bandwidthSentLastSecond)}/s  ↓ ${formatBytes(serverInfo.bandwidthReceivedLastSecond)}/s` });
        fields.push({ label: "Uptime", value: formatDuration(serverInfo.connectedSecs) });
      }
      if (server.welcomeMessage) fields.push({ label: "Welcome", value: plainText(server.welcomeMessage) });
    }
  }

  const room = Math.max(0, height - 1 - (status === "disconnected" ? 1 : 0));
  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden" paddingLeft={1}>
      <Text bold wrap="truncate-end">
        {fit(title, width - 1)}
      </Text>
      {fields.slice(0, room).map((f) => (
        <FieldLine key={f.label} field={f} width={width - 1} />
      ))}
      {status === "disconnected" && <Button label=" Reconnect " color={colors.accent} onClick={() => controller.reconnect(session.id)} />}
    </Box>
  );
}
