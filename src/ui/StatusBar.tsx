import { Box, Text } from "ink";
import { useStore } from "zustand";
import type { Controller } from "../app/controller.ts";
import type { Session } from "../session/session.ts";
import { Button } from "./Button.tsx";
import { colors } from "./theme.ts";
import { whisperListMenu } from "./menus.ts";

const METER_CELLS = 8;

/** Square-root scale so quiet speech still moves the meter; 0.3 RMS fills it. */
const meterPos = (rms: number) => (Math.sqrt(rms) / Math.sqrt(0.3)) * METER_CELLS;

function Meter({ level, threshold, talking, ascii }: { level: number; threshold: number; talking: boolean; ascii: boolean }) {
  const filled = Math.min(METER_CELLS, Math.round(meterPos(level)));
  const mark = Math.min(METER_CELLS - 1, Math.round(meterPos(threshold)));
  const on = ascii ? "#" : "▮";
  const line = ascii ? "|" : "┊";
  const off = ascii ? "-" : "▯";
  const cells = Array.from({ length: METER_CELLS }, (_, i) => (i < filled ? on : i === mark ? line : off)).join("");
  return <Text color={talking ? colors.talking : colors.dim}>{cells}</Text>;
}

function AwayButton({ controller, session }: { controller: Controller; session: Session }) {
  const away = useStore(session.store, (st) => st.away);
  return (
    <Button
      label={away ? "Back" : "Away"}
      color={away ? colors.away : undefined}
      onClick={() => (away ? session.setAway(null) : controller.openDialog({ kind: "away" }))}
    />
  );
}

/** `[Whisper n]`: hold to whisper, click to lock, right-click for the list (§8.3). */
function WhisperButton({ controller, session }: { controller: Controller; session: Session }) {
  const targets = useStore(session.store, (st) => st.whisperTargets);
  const locked = useStore(session.store, (st) => st.whisperLocked);
  const held = useStore(controller.store, (st) => st.whisperHeld);
  const count = targets.channels.length + targets.clients.length;
  return (
    <Button
      label={locked ? `Whisper ${count} locked` : `Whisper ${count}`}
      active={held || locked}
      color={held || locked ? colors.whisper : count === 0 ? "gray" : undefined}
      onPress={() => controller.whisperButtonPress()}
      onRelease={() => controller.whisperButtonRelease()}
      onRightClick={(e) => controller.openDialog({ kind: "menu", x: e.x, y: Math.max(0, e.y - count - 5), title: "Whisper list", items: whisperListMenu(controller, session) })}
    />
  );
}

export function StatusBar({ controller, width }: { controller: Controller; width: number }) {
  const s = useStore(controller.store);
  const session = controller.activeSession();
  const audioReady = s.audio.state === "ready";
  const key = s.config.pttKey.toUpperCase();
  const audioText = audioReady
    ? (s.audio.output ?? "audio ok")
    : s.audio.state === "error"
      ? "No audio device (see log)"
      : s.audio.state === "starting"
        ? "Starting audio..."
        : `Audio: ${s.audio.message || "unavailable"}`;
  const ascii = s.config.icons === "ascii";
  const sep = ascii ? " | " : " │ ";
  return (
    <Box width={width} height={1} overflow="hidden">
      <Box flexShrink={0}>
        <Button label={s.micMuted ? "Mic off" : "Mic on"} color={s.micMuted ? colors.muted : undefined} onClick={() => controller.toggleMic()} />
        <Text> </Text>
        <Button
          label={s.speakerMuted ? "Sound off" : "Sound on"}
          color={s.speakerMuted ? colors.muted : undefined}
          onClick={() => controller.toggleSpeaker()}
        />
        <Text> </Text>
        <Button
          label={s.talking ? "  Talking   " : "Hold to talk"}
          active={s.talking}
          color={s.talking ? colors.talking : undefined}
          disabled={!audioReady || s.micMuted}
          onPress={() => controller.setHold("mouse", true)}
          onRelease={() => controller.setHold("mouse", false)}
        />
        <Text> </Text>
        {s.config.talkMode === "vad" ? (
          <>
            <Text color="gray">VAD </Text>
            <Meter level={s.level} threshold={s.config.vadThreshold} talking={s.talking} ascii={ascii} />
          </>
        ) : s.config.talkMode === "ptt" ? (
          <Text color={s.talking ? colors.talking : "gray"}>{s.kittyKeys ? `PTT: hold ${key}` : `PTT: ${key} toggles`}</Text>
        ) : (
          <Text color={s.toggled ? colors.talking : "gray"}>{s.toggled ? "TX on (^T)" : "TX off (^T)"}</Text>
        )}
        {session && (
          <>
            <Text color="gray">{sep}</Text>
            <WhisperButton key={`w${session.id}`} controller={controller} session={session} />
            <Text> </Text>
            <AwayButton key={session.id} controller={controller} session={session} />
          </>
        )}
        <Text color="gray">{sep}</Text>
      </Box>
      <Box flexShrink={1} flexGrow={1} overflow="hidden">
        <Text color={audioReady ? "gray" : colors.error} wrap="truncate-end">
          {audioText}
        </Text>
      </Box>
    </Box>
  );
}
