import { useEffect, useState, type ReactNode } from "react";
import { Box, Text, useInput } from "ink";
import { useStore } from "zustand";
import type { Controller, Dialog } from "../../app/controller.ts";
import { HOLD_KEYS, type HoldKey } from "../../config/config.ts";
import type { AudioDevice } from "../../audio/process.ts";
import { Button } from "../Button.tsx";
import { colors, fit } from "../theme.ts";
import { Choice, Hint, Modal, Slider, Toggle, innerWidth, type Screen } from "./kit.tsx";

type Props<K extends Dialog["kind"]> = { controller: Controller; dialog: Extract<Dialog, { kind: K }>; screen: Screen };

const LABEL = 18;

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box>
      <Box width={LABEL} flexShrink={0}>
        <Text color="gray">{label}</Text>
      </Box>
      {children}
    </Box>
  );
}

/** A button that steps through options: click for the next, right-click is not needed. */
function Cycle<T>({ options, value, label, onChange }: { options: T[]; value: T; label: (v: T) => string; onChange: (v: T) => void }) {
  const index = Math.max(0, options.indexOf(value));
  return <Button layer="modal" label={` ${label(value)} ▸ `} onClick={() => onChange(options[(index + 1) % options.length]!)} />;
}

function deviceLabel(devices: AudioDevice[] | undefined, id: string, width: number): string {
  if (id === "default") return fit("System default", width);
  return fit(devices?.find((d) => d.id === id)?.name ?? id, width);
}

const VAD_MAX = 0.2;

/** §8.2, §9.7, §10.1: everything in config.json that is not edited from a menu. */
export function SettingsDialog({ controller, screen }: Props<"settings">) {
  const config = useStore(controller.store, (s) => s.config);
  const audio = useStore(controller.store, (s) => s.audio);
  const level = useStore(controller.store, (s) => s.level);
  const kitty = useStore(controller.store, (s) => s.kittyKeys);
  const [focus, setFocus] = useState(0);
  const close = () => controller.closeDialog();
  const width = 76;
  const inner = innerWidth(width, screen);
  const sliderWidth = Math.max(10, inner - LABEL);
  useEffect(() => controller.refreshDevices(), [controller]);
  useInput((_input, key) => {
    if (key.escape || key.return) close();
    else if (key.tab) setFocus((f) => (f + (key.shift ? 2 : 1)) % 3);
  });
  const inputs = ["default", ...(audio.inputs ?? []).map((d) => d.id)];
  const outputs = ["default", ...(audio.outputs ?? []).map((d) => d.id)];
  const keyName = (k: HoldKey) => k.toUpperCase().replace("+", "+");

  return (
    <Modal title="Settings" width={width} screen={screen} onClose={close}>
      <Text bold>Voice</Text>
      <Line label="Talk mode">
        <Choice
          value={config.talkMode}
          onChange={(talkMode) => controller.setConfig({ talkMode })}
          options={[
            { value: "vad", label: "Voice activation" },
            { value: "toggle", label: "Toggle (Ctrl+T)" },
            { value: "ptt", label: "Push to talk" },
          ]}
        />
      </Line>
      <Line label="Push-to-talk key">
        <Cycle options={[...HOLD_KEYS]} value={config.pttKey} label={keyName} onChange={(pttKey) => controller.setConfig({ pttKey })} />
        <Text color="gray"> whisper key </Text>
        <Cycle options={[...HOLD_KEYS]} value={config.whisperKey} label={keyName} onChange={(whisperKey) => controller.setConfig({ whisperKey })} />
      </Line>
      <Line label="">
        <Text color={kitty ? colors.talking : colors.away} wrap="truncate-end">
          {kitty ? "This terminal reports key releases: hold keys really hold." : "No key releases from this terminal: hold keys toggle."}
        </Text>
      </Line>
      <Line label="Activation level">
        <Slider
          value={Math.min(VAD_MAX, config.vadThreshold)}
          min={0.002}
          max={VAD_MAX}
          step={0.002}
          width={sliderWidth}
          marker={level / VAD_MAX}
          focused={focus === 0}
          format={(v) => v.toFixed(3)}
          onChange={(vadThreshold) => controller.setConfig({ vadThreshold })}
        />
      </Line>
      <Line label="Hangover">
        <Slider
          value={config.vadHangoverMs}
          min={0}
          max={1500}
          step={50}
          width={sliderWidth}
          focused={focus === 1}
          format={(v) => `${v} ms`}
          onChange={(vadHangoverMs) => controller.setConfig({ vadHangoverMs })}
        />
      </Line>
      <Line label="Microphone">
        <Cycle options={inputs} value={config.inputDevice} label={(id) => deviceLabel(audio.inputs, id, inner - LABEL - 6)} onChange={(id) => controller.setDevices(id, config.outputDevice)} />
      </Line>
      <Line label="Speakers">
        <Cycle options={outputs} value={config.outputDevice} label={(id) => deviceLabel(audio.outputs, id, inner - LABEL - 6)} onChange={(id) => controller.setDevices(config.inputDevice, id)} />
      </Line>
      <Line label="">
        <Text color="gray" wrap="truncate-end">
          {audio.state === "ready" ? `Audio via ${audio.host ?? "system"}; the bar under the slider is your live level.` : `Audio: ${audio.message || audio.state}`}
        </Text>
      </Line>
      <Box marginTop={1}>
        <Text bold>Notifications</Text>
      </Box>
      <Line label="Sounds">
        <Toggle label="On" value={config.sounds} onChange={(sounds) => controller.setConfig({ sounds })} />
        <Text> </Text>
        <Button layer="modal" label=" Test " onClick={() => controller.playSound("poke")} />
      </Line>
      <Line label="Sound volume">
        <Slider
          value={config.soundVolume}
          min={0}
          max={1}
          step={0.05}
          width={sliderWidth}
          focused={focus === 2}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(soundVolume) => controller.setConfig({ soundVolume })}
        />
      </Line>
      <Line label="Desktop">
        <Choice
          value={config.desktopNotifications}
          onChange={(desktopNotifications) => controller.setConfig({ desktopNotifications })}
          options={[
            { value: "off", label: "Off" },
            { value: "unfocused", label: "When unfocused" },
            { value: "always", label: "Always" },
          ]}
        />
      </Line>
      <Box marginTop={1}>
        <Text bold>Other</Text>
      </Box>
      <Line label="Whispers">
        <Toggle label="Block incoming whispers (except people you allow)" value={config.blockWhispers} onChange={(b) => controller.setBlockWhispers(b)} />
      </Line>
      <Line label="Icons">
        <Choice
          value={config.icons}
          onChange={(icons) => controller.setConfig({ icons })}
          options={[
            { value: "unicode", label: "Unicode" },
            { value: "ascii", label: "ASCII" },
            { value: "nerdfont", label: "Nerd Font" },
          ]}
        />
      </Line>
      <Line label="Tree">
        <Toggle label="Show ServerQuery clients" value={config.showQueryClients} onChange={(showQueryClients) => controller.setConfig({ showQueryClients })} />
      </Line>
      <Line label="Updates">
        <Toggle label="Install new releases automatically" value={config.autoUpdate} onChange={(autoUpdate) => controller.setConfig({ autoUpdate })} />
      </Line>
      <Line label="Downloads">
        <Button
          layer="modal"
          label=" Change "
          onClick={() =>
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
            })
          }
        />
        <Text wrap="truncate-end"> {config.downloadDir}</Text>
      </Line>
      <Box marginTop={1} gap={2}>
        <Button label=" Close " color={colors.accent} layer="modal" onClick={close} />
        <Hint>Tab: next slider · ←→ adjust · Esc close · saved as you change</Hint>
      </Box>
    </Modal>
  );
}

/** §8.4: 0-200% in 10% steps; stored by UID. */
export function VolumeDialog({ controller, dialog, screen }: Props<"volume">) {
  const session = controller.session(dialog.sessionId);
  const client = useStore(session?.store ?? controller.store, (s) => ("snapshot" in s ? s.snapshot?.clients.find((c) => c.id === dialog.clientId) : undefined));
  useStore(controller.store, (s) => s.config.volumes);
  const close = () => controller.closeDialog();
  useInput((_input, key) => {
    if (key.escape || key.return) close();
  });
  if (!client) {
    return (
      <Modal title="Volume" width={50} screen={screen} onClose={close}>
        <Text color="gray">That person has left.</Text>
        <Button label=" Close " layer="modal" onClick={close} />
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
        focused
        format={(v) => (v === 0 ? "muted" : `${Math.round(v * 100)}%`)}
        onChange={(v) => controller.setVolume(client.uid, v)}
      />
      <Box marginTop={1} gap={2}>
        <Button layer="modal" label={volume === 0 ? " Unmute " : " Mute locally "} onClick={() => controller.setVolume(client.uid, volume === 0 ? 1 : 0)} />
        <Button layer="modal" label=" 100% " onClick={() => controller.setVolume(client.uid, 1)} />
        <Button layer="modal" label=" Close " color={colors.accent} onClick={close} />
      </Box>
      <Hint>Click or drag the bar · wheel · ←→ · remembered for this person on every server</Hint>
    </Modal>
  );
}
