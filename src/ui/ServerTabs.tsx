import { useRef } from "react";
import { Box, Text, type DOMElement } from "ink";
import { useStore } from "zustand";
import type { Controller } from "../app/controller.ts";
import type { Session } from "../session/session.ts";
import { useMouseRegion } from "../mouse/react.tsx";
import { Button } from "./Button.tsx";
import { colors } from "./theme.ts";
import { serverMenu } from "./menus.ts";

function SessionTab({ controller, session, active, index }: { controller: Controller; session: Session; active: boolean; index: number }) {
  const ref = useRef<DOMElement>(null);
  const label = useStore(session.store, (s) => s.label);
  const status = useStore(session.store, (s) => s.status);
  useMouseRegion(ref, {
    onClick: () => controller.setActive(session.id),
    onRightClick: (e) => controller.openDialog({ kind: "menu", x: e.x, y: e.y + 1, title: label, items: serverMenu(controller, session) }),
  });
  const dot = status === "connected" ? colors.talking : status === "disconnected" ? colors.error : colors.away;
  return (
    <Box ref={ref} flexShrink={0} marginRight={1}>
      <Text inverse={active}>
        {index < 9 ? <Text color="gray">{`${index + 1} `}</Text> : null}
        <Text color={dot}>●</Text> {label}{" "}
      </Text>
    </Box>
  );
}

/** Ping and loss of the active server (§9.2). */
function Ping({ session }: { session: Session }) {
  const info = useStore(session.store, (s) => s.serverInfo);
  const status = useStore(session.store, (s) => s.status);
  if (!info || status !== "connected") return null;
  const loss = info.packetLossPercent;
  return (
    <Text color={info.pingMs > 150 || loss > 5 ? colors.away : "gray"}>
      {` ping ${Math.round(info.pingMs)}ms loss ${loss.toFixed(loss < 10 ? 1 : 0)}% `}
    </Text>
  );
}

export function ServerTabs({ controller, width }: { controller: Controller; width: number }) {
  const ids = useStore(controller.store, (s) => s.sessionIds);
  const activeId = useStore(controller.store, (s) => s.activeId);
  const active = controller.session(activeId);
  return (
    <Box width={width} height={1} overflow="hidden">
      <Text bold color={colors.accent}>
        {" tuimspeak "}
      </Text>
      {ids.map((id, i) => {
        const session = controller.session(id);
        return session ? <SessionTab key={id} controller={controller} session={session} active={id === activeId} index={i} /> : null;
      })}
      <Button label="+" onClick={() => controller.openDialog({ kind: "connect" })} />
      <Box flexGrow={1} />
      {active && <Ping key={active.id} session={active} />}
      <Button label="Settings" onClick={() => controller.openDialog({ kind: "settings" })} />
      <Text> </Text>
      <Button label="?" onClick={() => controller.openDialog({ kind: "help" })} />
    </Box>
  );
}
