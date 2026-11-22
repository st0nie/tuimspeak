import { useEffect, useState, type ReactNode } from "react";
import { Box, Text, useInput } from "ink";
import { useStore } from "zustand";
import type { Controller, Dialog } from "../../app/controller.ts";
import { HOLD_KEYS, type Config, type HoldKey, type IconSet, type TalkMode } from "../../config/config.ts";
import type { AudioDevice } from "../../audio/process.ts";
import { Button } from "../Button.tsx";
import { colors, fit } from "../theme.ts";
import { ActionBar, Choice, Hint, Modal, Slider, Toggle, innerWidth, stepOption, type Screen } from "./kit.tsx";

type Props<K extends Dialog["kind"]> = { controller: Controller; dialog: Extract<Dialog, { kind: K }>; screen: Screen };

const LABEL = 18;
const TALK_MODES: readonly TalkMode[] = ["vad", "toggle", "ptt"];
const DESKTOP_MODES: readonly Config["desktopNotifications"][] = ["off", "unfocused", "always"];
const ICON_SETS: readonly IconSet[] = ["unicode", "ascii", "nerdfont"];

function Line({ label, focused, children }: { label: string; focused?: boolean; children: ReactNode }) {
  return (
    <Box>
      <Box width={LABEL} flexShrink={0}>
        <Text color={focused ? colors.accent : "gray"}>{label}</Text>
      </Box>
      {children}
    </Box>
  );
}

/** A button that steps through options: click or Space/Enter for the next. */
function Cycle<T>({
  options,
  value,
  focused,
  label,
  onChange,
}: {
  options: readonly T[];
  value: T;
  focused?: boolean;
  label: (v: T) => string;
  onChange: (v: T) => void;
}) {
  return <Button layer="modal" focused={focused} label={` ${label(value)} ▸ `} onClick={() => onChange(stepOption(options, value, 1))} />;
}

function deviceLabel(devices: AudioDevice[] | undefined, id: string, width: number): string {
  if (id === "default") return fit("System default", width);
  return fit(devices?.find((d) => d.id === id)?.name ?? id, width);
}

const VAD_MAX = 0.2;

interface SettingRowSpec {
  cols?: number;
  onStep?: (delta: -1 | 1) => void;
  onActivate?: (col: number) => void;
}

/** §8.2, §9.7, §10.1: everything in config.json that is not edited from a menu. */
export function SettingsDialog({ controller, screen }: Props<"settings">) {
  const config = useStore(controller.store, (s) => s.config);
  const audio = useStore(controller.store, (s) => s.audio);
  const level = useStore(controller.store, (s) => s.level);
  const kitty = useStore(controller.store, (s) => s.kittyKeys);
  const [[row, col], setPos] = useState<[number, number]>([0, 0]);
  const close = () => controller.closeDialog();
  const width = 80;
  const inner = innerWidth(width, screen);
  const sliderWidth = Math.max(10, inner - LABEL);
  const compact = screen.rows < 28;

  useEffect(() => controller.refreshDevices(), [controller]);

  const inputs = ["default", ...(audio.inputs ?? []).map((d) => d.id)];
  const outputs = ["default", ...(audio.outputs ?? []).map((d) => d.id)];
  const keyName = (k: HoldKey) => k.toUpperCase();

  const editDownloadDir = () =>
    controller.openDialog({
      kind: "prompt",
      title: "Download folder",
      label: "Folder",
      initial: config.downloadDir,
      submitLabel: "Save",
      onSubmit: (v) => {
        if (v.trim()) controller.setConfig({ downloadDir: v.trim() });
        controller.openDialog({ kind: "settings" });
      },
    });

  const rows: SettingRowSpec[] = [
    {
      onStep: (d) => controller.setConfig({ talkMode: stepOption(TALK_MODES, config.talkMode, d) }),
      onActivate: () => controller.setConfig({ talkMode: stepOption(TALK_MODES, config.talkMode, 1) }),
    },
    {
      cols: 2,
      onActivate: (c) =>
        c === 0
          ? controller.setConfig({ pttKey: stepOption(HOLD_KEYS, config.pttKey, 1) })
          : controller.setConfig({ whisperKey: stepOption(HOLD_KEYS, config.whisperKey, 1) }),
    },
    {}, // Activation level slider
    {}, // Hangover slider
    {
      onStep: (d) => controller.setDevices(stepOption(inputs, config.inputDevice, d), config.outputDevice),
      onActivate: () => controller.setDevices(stepOption(inputs, config.inputDevice, 1), config.outputDevice),
    },
    {
      onStep: (d) => controller.setDevices(config.inputDevice, stepOption(outputs, config.outputDevice, d)),
      onActivate: () => controller.setDevices(config.inputDevice, stepOption(outputs, config.outputDevice, 1)),
    },
    {
      cols: 2,
      onActivate: (c) => (c === 0 ? controller.setConfig({ sounds: !config.sounds }) : controller.playSound("poke")),
    },
    {}, // Sound volume slider
    {
      onStep: (d) => controller.setConfig({ desktopNotifications: stepOption(DESKTOP_MODES, config.desktopNotifications, d) }),
      onActivate: () => controller.setConfig({ desktopNotifications: stepOption(DESKTOP_MODES, config.desktopNotifications, 1) }),
    },
    { onActivate: () => controller.setBlockWhispers(!config.blockWhispers) },
    {
      onStep: (d) => controller.setConfig({ icons: stepOption(ICON_SETS, config.icons, d) }),
      onActivate: () => controller.setConfig({ icons: stepOption(ICON_SETS, config.icons, 1) }),
    },
    { onActivate: () => controller.setConfig({ showQueryClients: !config.showQueryClients }) },
    { onActivate: () => controller.setConfig({ autoUpdate: !config.autoUpdate }) },
    { onActivate: editDownloadDir },
    { onActivate: close },
  ];

  useInput((input, key) => {
    if (key.escape) return close();
    const spec = rows[row]!;
    const cols = spec.cols ?? 1;
    if (key.upArrow) return setPos([(row + rows.length - 1) % rows.length, 0]);
    if (key.downArrow) return setPos([(row + 1) % rows.length, 0]);
    if (key.tab) {
      if (key.shift) {
        if (col > 0) return setPos([row, col - 1]);
        const prev = (row + rows.length - 1) % rows.length;
        return setPos([prev, (rows[prev]!.cols ?? 1) - 1]);
      }
      if (col + 1 < cols) return setPos([row, col + 1]);
      return setPos([(row + 1) % rows.length, 0]);
    }
    if (key.leftArrow || key.rightArrow) {
      const d = key.leftArrow ? -1 : 1;
      if (cols > 1) return setPos([row, (col + d + cols) % cols]);
      spec.onStep?.(d);
      return;
    }
    if (key.return || input === " ") spec.onActivate?.(col);
  });

  return (
    <Modal title="Settings" width={width} screen={screen} onClose={close}>
      <Text bold>Voice</Text>
      <Line label="Talk mode" focused={row === 0}>
        <Choice
          value={config.talkMode}
          focused={row === 0}
          onChange={(talkMode) => controller.setConfig({ talkMode })}
          options={[
            { value: "vad", label: "Voice activation" },
            { value: "toggle", label: "Toggle (Ctrl+T)" },
            { value: "ptt", label: "Push to talk" },
          ]}
        />
      </Line>
      <Line label="Push-to-talk key" focused={row === 1}>
        <Cycle options={HOLD_KEYS} value={config.pttKey} focused={row === 1 && col === 0} label={keyName} onChange={(pttKey) => controller.setConfig({ pttKey })} />
        <Text color="gray"> whisper key </Text>
        <Cycle options={HOLD_KEYS} value={config.whisperKey} focused={row === 1 && col === 1} label={keyName} onChange={(whisperKey) => controller.setConfig({ whisperKey })} />
      </Line>
      {screen.rows >= 23 && (
        <Line label="">
          <Text color={kitty ? colors.talking : colors.away} wrap="truncate-end">
            {kitty ? "This terminal reports key releases: hold keys really hold." : "No key releases from this terminal: hold keys toggle."}
          </Text>
        </Line>
      )}
      <Line label="Activation level" focused={row === 2}>
        <Slider
          value={Math.min(VAD_MAX, config.vadThreshold)}
          min={0.002}
          max={VAD_MAX}
          step={0.002}
          width={sliderWidth}
          marker={level / VAD_MAX}
          focused={row === 2}
          format={(v) => v.toFixed(3)}
          onChange={(vadThreshold) => controller.setConfig({ vadThreshold })}
        />
      </Line>
      <Line label="Hangover" focused={row === 3}>
        <Slider
          value={config.vadHangoverMs}
          min={0}
          max={1500}
          step={50}
          width={sliderWidth}
          focused={row === 3}
          format={(v) => `${v} ms`}
          onChange={(vadHangoverMs) => controller.setConfig({ vadHangoverMs })}
        />
      </Line>
      <Line label="Microphone" focused={row === 4}>
        <Cycle
          options={inputs}
          value={config.inputDevice}
          focused={row === 4}
          label={(id) => deviceLabel(audio.inputs, id, inner - LABEL - 6)}
          onChange={(id) => controller.setDevices(id, config.outputDevice)}
        />
      </Line>
      <Line label="Speakers" focused={row === 5}>
        <Cycle
          options={outputs}
          value={config.outputDevice}
          focused={row === 5}
          label={(id) => deviceLabel(audio.outputs, id, inner - LABEL - 6)}
          onChange={(id) => controller.setDevices(config.inputDevice, id)}
        />
      </Line>
      {screen.rows >= 24 && (
        <Line label="">
          <Text color="gray" wrap="truncate-end">
            {audio.state === "ready" ? `Audio via ${audio.host ?? "system"}; the bar under the slider is your live level.` : `Audio: ${audio.message || audio.state}`}
          </Text>
        </Line>
      )}
      <Box marginTop={compact ? 0 : 1}>
        <Text bold>Notifications</Text>
      </Box>
      <Line label="Sounds" focused={row === 6}>
        <Toggle label="On" value={config.sounds} focused={row === 6 && col === 0} onChange={(sounds) => controller.setConfig({ sounds })} />
        <Text> </Text>
        <Button layer="modal" focused={row === 6 && col === 1} label=" Test " onClick={() => controller.playSound("poke")} />
      </Line>
      <Line label="Sound volume" focused={row === 7}>
        <Slider
          value={config.soundVolume}
          min={0}
          max={1}
          step={0.05}
          width={sliderWidth}
          focused={row === 7}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(soundVolume) => controller.setConfig({ soundVolume })}
        />
      </Line>
      <Line label="Desktop" focused={row === 8}>
        <Choice
          value={config.desktopNotifications}
          focused={row === 8}
          onChange={(desktopNotifications) => controller.setConfig({ desktopNotifications })}
          options={[
            { value: "off", label: "Off" },
            { value: "unfocused", label: "When unfocused" },
            { value: "always", label: "Always" },
          ]}
        />
      </Line>
      <Box marginTop={compact ? 0 : 1}>
        <Text bold>Other</Text>
      </Box>
      <Line label="Whispers" focused={row === 9}>
        <Toggle label="Block incoming whispers (except people you allow)" value={config.blockWhispers} focused={row === 9} onChange={(b) => controller.setBlockWhispers(b)} />
      </Line>
      <Line label="Icons" focused={row === 10}>
        <Choice
          value={config.icons}
          focused={row === 10}
          onChange={(icons) => controller.setConfig({ icons })}
          options={[
            { value: "unicode", label: "Unicode" },
            { value: "ascii", label: "ASCII" },
            { value: "nerdfont", label: "Nerd Font" },
          ]}
        />
      </Line>
      <Line label="Tree" focused={row === 11}>
        <Toggle label="Show ServerQuery clients" value={config.showQueryClients} focused={row === 11} onChange={(showQueryClients) => controller.setConfig({ showQueryClients })} />
      </Line>
      <Line label="Updates" focused={row === 12}>
        <Toggle label="Install new releases automatically" value={config.autoUpdate} focused={row === 12} onChange={(autoUpdate) => controller.setConfig({ autoUpdate })} />
      </Line>
      <Line label="Downloads" focused={row === 13}>
        <Button layer="modal" focused={row === 13} label=" Change " onClick={editDownloadDir} />
        <Text wrap="truncate-end"> {config.downloadDir}</Text>
      </Line>
      <Box marginTop={compact ? 0 : 1} gap={2}>
        <Button label=" Close " focused={row === 14} color={colors.accent} layer="modal" onClick={close} />
        <Hint>↑↓/Tab move · ←→/Space change · Esc close · saved automatically</Hint>
      </Box>
    </Modal>
  );
}

/** §8.4: 0-200% in 10% steps; stored by UID. */
export function VolumeDialog({ controller, dialog, screen }: Props<"volume">) {
  const session = controller.session(dialog.sessionId);
  const client = useStore(session?.store ?? controller.store, (s) => ("snapshot" in s ? s.snapshot?.clients.find((c) => c.id === dialog.clientId) : undefined));
  useStore(controller.store, (s) => s.config.volumes);
  const [barFocused, setBarFocused] = useState(false);
  const close = () => controller.closeDialog();
  useInput((input, key) => {
    if (key.escape) close();
    else if (!client && (key.return || input === " ")) close();
    else if (client && (key.tab || key.upArrow || key.downArrow)) setBarFocused((b) => !b);
    else if (client && !barFocused && key.return) close();
    else if (client && input === "m") {
      const v = controller.volumeOf(client.uid);
      controller.setVolume(client.uid, v === 0 ? 1 : 0);
    }
  });
  if (!client) {
    return (
      <Modal title="Volume" width={50} screen={screen} onClose={close}>
        <Text color="gray">That person has left.</Text>
        <Box marginTop={1}>
          <Button label=" Close " focused color={colors.accent} layer="modal" onClick={close} />
        </Box>
      </Modal>
    );
  }
  const volume = controller.volumeOf(client.uid);
  const width = 60;
  return (
    <Modal title={`Volume of ${client.name}`} width={width} screen={screen} onClose={close}>
      <Slider
        value={volume}
        min={0}
        max={2}
        step={0.1}
        width={innerWidth(width, screen)}
        focused={!barFocused}
        format={(v) => (v === 0 ? "muted" : `${Math.round(v * 100)}%`)}
        onChange={(v) => controller.setVolume(client.uid, v)}
      />
      <ActionBar
        focused={barFocused}
        actions={[
          { label: volume === 0 ? " Unmute " : " Mute locally ", onTrigger: () => controller.setVolume(client.uid, volume === 0 ? 1 : 0) },
          { label: " 100% ", onTrigger: () => controller.setVolume(client.uid, 1) },
          { label: " Close ", color: colors.accent, onTrigger: close },
        ]}
      />
      <Hint>←→ adjust · ↑↓/Tab buttons · m mute · Esc close</Hint>
    </Modal>
  );
}
