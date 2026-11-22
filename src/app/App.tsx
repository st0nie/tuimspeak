import { useRef } from "react";
import { Box, Text, useInput, useWindowSize, type DOMElement } from "ink";
import { useStore } from "zustand";
import type { Controller } from "./controller.ts";
import { useMouseRegion, useTerminalFocus } from "../mouse/react.tsx";
import { ServerTabs } from "../ui/ServerTabs.tsx";
import { ChannelTree } from "../ui/ChannelTree.tsx";
import { InfoPanel } from "../ui/InfoPanel.tsx";
import { ChatPane } from "../ui/ChatPane.tsx";
import { StatusBar } from "../ui/StatusBar.tsx";
import { DialogLayer } from "../ui/dialogs/index.tsx";
import { Button } from "../ui/Button.tsx";
import { colors, fit, stringWidth } from "../ui/theme.ts";
import type { Session } from "../session/session.ts";

const MIN_COLUMNS = 40;
const MIN_ROWS = 12;
const INFO_PANEL_MIN_COLUMNS = 80;

function Banner({ controller, session, width }: { controller: Controller; session: Session | undefined; width: number }) {
  const notice = useStore(controller.store, (s) => s.notice);
  const poke = useStore(session?.store ?? controller.store, (s) => ("poke" in s ? s.poke : null));
  if (poke && session) {
    const text = ` ${poke.from} poked you${poke.message ? `: ${poke.message}` : ""} `;
    return (
      <Box width={width} height={1}>
        <Text backgroundColor={colors.poke} color="white" bold wrap="truncate-end">
          {fit(text, width - 4)}
        </Text>
        <Button label="x" onClick={() => session.dismissPoke()} />
      </Box>
    );
  }
  if (notice) {
    return (
      <Box width={width} height={1}>
        <Text color={notice.kind === "error" ? colors.error : colors.accent} wrap="truncate-end">
          {fit(` ${notice.text}`, width)}
        </Text>
      </Box>
    );
  }
  return null;
}

function Pane({ title, width, height, focused, onFocus, children }: { title: string; width: number; height: number; focused: boolean; onFocus?: () => void; children: React.ReactNode }) {
  const ref = useRef<DOMElement>(null);
  // Clicking a pane's border or empty area focuses it; inner regions take precedence.
  useMouseRegion(ref, { onClick: onFocus });
  return (
    <Box ref={ref} flexDirection="column" width={width} height={height} borderStyle="round" borderColor={focused ? colors.accent : "gray"}>
      <Box position="absolute" top={-1} left={1}>
        <Text color={focused ? colors.accent : "gray"}>{` ${title} `}</Text>
      </Box>
      {children}
    </Box>
  );
}

/**
 * Centered with whole-cell padding. Flex centering can land on half cells,
 * and Ink 8 then drops nested text (seen with the connect button).
 */
function Welcome({ controller, width, height }: { controller: Controller; width: number; height: number }) {
  const hint = "Ctrl+N connect · F2 settings · ? help · Ctrl+Q quit";
  const button = " Connect to a server ";
  const pad = (w: number) => Math.max(0, Math.floor((width - w) / 2));
  return (
    <Box width={width} height={height} flexDirection="column" paddingTop={Math.max(0, Math.floor((height - 5) / 2))}>
      <Box paddingLeft={pad(9)}>
        <Text bold color={colors.accent}>
          tuimspeak
        </Text>
      </Box>
      <Box paddingLeft={pad(37)}>
        <Text color="gray">A TeamSpeak 3 client for the terminal</Text>
      </Box>
      <Box marginTop={1} paddingLeft={pad(button.length + 2)}>
        <Button label={button} color={colors.accent} onClick={() => controller.openDialog({ kind: "connect" })} />
      </Box>
      <Box paddingLeft={pad(stringWidth(hint))}>
        <Text color="gray">{hint}</Text>
      </Box>
    </Box>
  );
}

export function App({ controller, onQuit }: { controller: Controller; onQuit: () => void }) {
  const { columns, rows } = useWindowSize();
  const activeId = useStore(controller.store, (s) => s.activeId);
  const focus = useStore(controller.store, (s) => s.focus);
  const dialog = useStore(controller.store, (s) => s.dialog);
  const notice = useStore(controller.store, (s) => s.notice);
  const session = controller.session(activeId);
  const poke = useStore(session?.store ?? controller.store, (s) => ("poke" in s ? s.poke : null));

  useTerminalFocus((focused) => controller.terminalFocus(focused));

  useInput((input, key) => {
    if (key.ctrl && (input === "q" || input === "c")) return onQuit();
    if (dialog) return;
    if (key.ctrl && input === "n") return controller.openDialog({ kind: "connect" });
    if (key.ctrl && input === "t") return controller.toggleTalk();
    if (key.ctrl && input === "x") return controller.toggleMic();
    if (key.ctrl && input === "d") return controller.toggleSpeaker();
    if (key.tab) return controller.setFocus(focus === "tree" ? "chat" : "tree");
    if (key.escape) {
      if (session?.store.getState().poke) return session.dismissPoke();
      return controller.setFocus("tree");
    }
    if (session && key.ctrl && (key.leftArrow || key.rightArrow)) {
      const { tabs, activeTab } = session.store.getState();
      const i = tabs.findIndex((t) => t.id === activeTab);
      const next = tabs[(i + (key.rightArrow ? 1 : -1) + tabs.length) % tabs.length];
      if (next) session.selectTab(next.id);
      return;
    }
    if (session && key.ctrl && input === "w") return session.closeTab(session.store.getState().activeTab);
    if (key.meta && /^[1-9]$/.test(input)) {
      const id = controller.state.sessionIds[Number(input) - 1];
      if (id) controller.setActive(id);
      return;
    }
    if (focus === "tree" && !key.ctrl && !key.meta) {
      if (input === "q") return onQuit();
      if (input === "?") return controller.openDialog({ kind: "help" });
    }
  });

  if (columns < MIN_COLUMNS || rows < MIN_ROWS) {
    return (
      <Box width={columns} height={rows} paddingTop={Math.floor(rows / 2)}>
        <Text color="yellow" wrap="truncate-end">
          Terminal too small ({columns}x{rows}), need {MIN_COLUMNS}x{MIN_ROWS}
        </Text>
      </Box>
    );
  }

  const bannerRows = (poke && session) || notice ? 1 : 0;
  const middle = rows - 2 - bannerRows;
  const upper = Math.max(6, Math.floor(middle * 0.58));
  const lower = middle - upper;
  const showInfo = columns >= INFO_PANEL_MIN_COLUMNS;
  const treeWidth = showInfo ? Math.floor(columns * 0.55) : columns;
  const infoWidth = columns - treeWidth;

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <ServerTabs controller={controller} width={columns} />
      {session ? (
        <>
          <Box height={upper}>
            <Pane title="Channels" width={treeWidth} height={upper} focused={(focus === "tree" || focus === "filter") && !dialog} onFocus={() => controller.setFocus("tree")}>
              <ChannelTree key={session.id} controller={controller} session={session} width={treeWidth - 2} height={upper - 2} focused={focus === "tree" && !dialog} />
            </Pane>
            {showInfo && (
              <Pane title="Info" width={infoWidth} height={upper} focused={false}>
                <InfoPanel controller={controller} session={session} width={infoWidth - 2} height={upper - 2} />
              </Pane>
            )}
          </Box>
          <Pane title="Chat" width={columns} height={lower} focused={focus === "chat" && !dialog} onFocus={() => controller.setFocus("chat")}>
            <ChatPane key={session.id} controller={controller} session={session} width={columns - 2} height={lower - 2} focused={focus === "chat" && !dialog} />
          </Pane>
        </>
      ) : (
        <Welcome controller={controller} width={columns} height={middle} />
      )}
      <Banner controller={controller} session={session} width={columns} />
      <StatusBar controller={controller} width={columns} />
      <DialogLayer controller={controller} screen={{ columns, rows }} />
    </Box>
  );
}
