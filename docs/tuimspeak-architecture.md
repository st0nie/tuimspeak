# tuimspeak Architecture

**Status:** Draft

**Scope:** Programs and processes, the ts-connector protocol, the tuim-audio sidecar, the main process (sessions, state, controller), mouse input, the terminal UI, voice (talk modes, whisper, per-user volume), server features (moderation, groups, offline messages, files, connection info), notifications, persistence, macOS, Linux and Windows, distribution, installation and updates, limitations

**Rule:** This document changes **before** the code. Every design change is
written here first and then implemented. Section numbers (§) in code comments
and the other documents refer to this file. Settings are described in
[configuration.md](configuration.md), procedures in
[tuimspeak-user-guide.md](tuimspeak-user-guide.md), and building and testing in
[development.md](development.md).

---

## 1. Overview

### 1.1 Goals

- A TeamSpeak client that runs in a terminal on **macOS, Linux and Windows** and
  connects to real TeamSpeak 3, TeamSpeak 6 and TeaSpeak servers.
- Full voice: Opus, voice activation, toggle and hold to talk, whisper,
  per-user volume.
- Everything a regular user and a server moderator does in the native client:
  channel tree, chat, pokes, away, moving and kicking people, bans, groups,
  offline messages, channel files.
- **Mouse-first, keyboard-complete.** Click, double-click, right-click menus,
  scroll wheel, press-and-hold and drag-and-drop all work, and every action
  also has a keyboard path.
- One-line installation (`curl | sh`, PowerShell `irm | iex`) and automatic
  updates (§12).
- Everything in English: code, UI, documentation.

### 1.2 Programs

| Program | What it is |
| :--- | :--- |
| `tuimspeak` | The terminal UI (§5). TypeScript, React 19 + Ink 8, run by Bun or compiled to one executable. Spawns the other two. |
| `ts-connector` | One process per server connection (§3). Rust, from [WebSpeak3](https://github.com/WebSpeak3/webspeak3), built on tsclientlib. Speaks the TeamSpeak protocol, encodes and decodes Opus, mixes all speakers. Used **unmodified**. |
| `tuim-audio` | One process for the whole app (§4). Rust, cpal. Microphone capture and speaker playback. |

### 1.3 Process model

```
┌───────────────────────── tuimspeak (Bun + TypeScript) ──────────────────────────┐
│  Ink UI ◀── stores (zustand) ◀── Session per server ◀── ConnectorProcess        │
│     ▲                                  ▲                                         │
│  MouseBus ◀── StdinTap            Controller ── VoiceEngine ── AudioProcess      │
└─────┼───────────────────────────────────┼──────────────────────────┼─────────────┘
      │ terminal stdin/stdout             │ text commands / NDJSON   │ binary frames
      ▼                                   ▼                          ▼
  terminal emulator                 ts-connector ── UDP ──▶ server   tuim-audio ── CoreAudio / PulseAudio / ALSA
```

WebSpeak3 needs a WebSocket gateway between the browser and the connector,
because browsers cannot send UDP. A terminal program can, so tuimspeak spawns
the connector directly and talks to it over stdio.

## 2. Non-Goals

- TeamSpeak 6 screen sharing (Stream/Call) and TeamSpeak 2 servers. The
  connector supports both; tuimspeak does not expose them.
- Editing permissions (§13).
- Avatars and other images.
- Global hotkeys while the terminal is not focused. They need OS-level input
  hooks and permissions (§8.2).
- Localization. The UI is English only.

## 3. ts-connector

The connector lives in the git submodule `native/webspeak3`, pinned to a
commit. Only its `connector/` directory is built (it pulls a tsclientlib fork
through its own nested submodule). tuimspeak never patches it.

### 3.1 Launch

```
ts-connector --address=<host[:port]> --nickname=<nick> [--default-channel=<path>] [--server-type=auto|teamspeak|teaspeak]
```

- Arguments use `--flag=value`, so a value starting with `-` is never read as
  a flag.
- Secrets go through the environment, never argv (visible in `ps`):
  `TS_SERVER_PASSWORD`, `TS_CHANNEL_PASSWORD`, `TS_IDENTITY`,
  `TS_PRIVILEGE_KEY`. The child gets a copy of tuimspeak's environment with
  these four set or removed.
- `RUST_LOG` defaults to `error`; the connector's stderr goes to the log
  file (§10.3).

### 3.2 Commands (stdin)

One command per line. Every free-text field is scrubbed of CR/LF, and the
whole line is scrubbed again before writing, so no field can inject a second
command. Ids must be integers.

| Command | Purpose |
| --- | --- |
| `switch <cid> [b64 password]` | Join a channel |
| `moveclient <clid> <cid> [b64 password]` | Move someone (§9.3) |
| `chat <msg>` / `serverchat <msg>` / `pm <clid> <msg>` | Text messages |
| `poke <clid> <msg>` | Poke |
| `away <msg>` / `unaway` | Away status |
| `muteinput 0\|1` / `muteoutput 0\|1` | Publish mute state (status icons only; muting itself is local, §8) |
| `nickname <name>` | Change nickname |
| `audio <b64>` | One voice frame (§3.4) |
| `whisper <cid,..>;<clid,..>` / `unwhisper` | Whisper targets (§8.3) |
| `whisperpolicy block\|allow;<clid,..>` | Incoming whisper policy with exceptions (§8.3) |
| `clientvolume <clid> <0..2>` | Per-user playback volume, mixed in the connector (§8.4) |
| `clientconninfo <clid>` / `serverconninfo` | Connection statistics (§9.2) |
| `kickchannel <clid> <reason>` / `kickserver <clid> <reason>` | Kick (§9.3) |
| `banclient <clid> <seconds> <reason>` | Ban; 0 seconds = permanent (§9.3) |
| `banlist` / `bandel <id>` / `bandelall` | Ban list (§9.3) |
| `complainlist` / `complaindel <tdb> <fdb>` / `complaindelall <tdb>` | Complaints (§9.3) |
| `servergrouplist` / `addservergroup <sgid> <cldbid>` / `delservergroup <sgid> <cldbid>` | Server groups (§9.4) |
| `channelgrouplist` / `setchannelgroup <cgid> <cid> <cldbid>` | Channel groups (§9.4) |
| `messagelist` / `messageget <id>` / `messageadd <uid>\t<subject>\t<text>` / `messagedel <id>` / `messageupdateflag <id> 1` | Offline messages (§9.5) |
| `serveredit <json>` | Virtual server settings (§9.3) |
| `serverquerylogin <b64 user> <b64 pass>` | ServerQuery admin login (§9.3) |
| `ftlist <cid> <path>` / `ftdownload <cid> <path>` / `ftuploadchunk <cid>\t<offset>\t<total>\t<path>\t<b64>` / `ftmkdir <cid> <path>` / `ftdelete <cid> <path>` / `ftrename <cid>\t<old>\t<new>` | Channel files (§9.6) |
| `disconnect <msg>` | Leave; then stdin is closed, and the process is killed if it has not exited after 3 s |

### 3.3 Events (stdout)

One JSON object per line. Top-level fields are snake_case, list entries
camelCase; the parser accepts both spellings for every field and converts to
camelCase. Unknown event types and unknown `serverLog` kinds are ignored, so
new upstream events never break tuimspeak.

| Event | Use |
| --- | --- |
| `connected` | Server name, version, welcome message, and `identity`, persisted to keep the client UID (§10.2) |
| `channels` | **Full snapshot** of channels, clients and our own clid, re-sent on every change. Replaces the previous one wholesale. `order` is already resolved into a sortable index among siblings |
| `talkers` | Other clients currently talking, sent on change |
| `whisperReceived` | A client started whispering to us (§8.3) |
| `chatMessage` / `serverMessage` / `privateMessage` / `poke` | Text (§7.3) |
| `serverLog` | Join/leave/switch/group/channel/server changes, shown in the server tab |
| `channelPasswordRequired` | Opens the password dialog |
| `reconnecting` / `reconnected` / `disconnected` / `error` | Connection state. The connector reconnects by itself; an `error` with `cid` and `path` is a file transfer error (§9.6) |
| `clientConnectionInfo` / `serverConnectionInfo` | §9.2 |
| `banList` / `complainList` / `serverGroupList` / `channelGroupList` / `offlineMessageList` / `offlineMessage` | §9.3–9.5 |
| `fileList` / `fileDownloadChunk` / `fileUploadDone` | §9.6 |
| `audioOut` | Playback audio (§3.4); never enters the stores |

### 3.4 Audio formats

| Direction | Format |
| --- | --- |
| `audio <b64>` (up) | s16le, mono, 48 kHz, exactly 960 samples (20 ms, 1920 bytes). Frames of another length are dropped by the connector |
| `audioOut.pcm` (down) | s16le, stereo interleaved, 48 kHz, 960 frames (3840 bytes), already mixed over all speakers and per-user volumes. Sent only while someone talks |

### 3.5 Upgrading the submodule

Bump the submodule pointer, rebuild, and run the protocol tests
(`test/connector.test.ts`), which pin the field names this section relies on.

## 4. tuim-audio

Opens the input and output devices, converts sample rate and channel count,
keeps the playback jitter buffer, and mixes notification sounds. It does no
VAD, encoding or speaker mixing.

### 4.1 Framing

Both directions, binary; stderr carries logs.

```
[type: u8][len: u32 LE][payload: len bytes]      len ≤ 1 MiB

0x01 PCM     stdout: capture frame, s16le mono 48 kHz, 960 samples
             stdin:  playback frame, s16le stereo 48 kHz, 960 frames
0x02 JSON    control messages, UTF-8
0x03 EFFECT  stdin:  a notification sound, s16le stereo 48 kHz, any length (§4.5)
```

### 4.2 Control messages

| Direction | Message |
| --- | --- |
| in | `{"cmd":"listDevices"}` |
| in | `{"cmd":"open","input":"<id>\|default","output":"<id>\|default"}`. Reopens the output, and the input if capture was on |
| in | `{"cmd":"capture","enabled":bool}` |
| out | `{"event":"devices","host":..,"inputs":[{id,name,isDefault}],"outputs":[..]}` |
| out | `{"event":"outputOpened",name,sampleRate,channels}` / `{"event":"captureStarted",..}` / `{"event":"captureStopped"}` |
| out | `{"event":"silentInput"}`: capture delivered only zeros for 3 s, usually a denied macOS microphone permission |
| out | `{"event":"stats",underruns,overflows,bufferedMs}` every 5 s when changed |
| out | `{"event":"error","message":..}` |

### 4.3 Playback buffer

The output callback pulls from a ring buffer of device-rate samples. A burst
starts only once 40 ms are buffered (scheduling jitter of the first frames
would crackle). Running dry mid-burst outputs silence and counts an underrun;
running dry exactly at a frame boundary is just the end of a sentence. Above
200 ms the callback skips ahead to 60 ms, so drift between the connector's
20 ms tick and the sound card's clock cannot grow latency without bound.

### 4.4 Capture

Captured audio is downmixed to mono, resampled to 48 kHz (`rubato`, only if
the device is not already 48 kHz) and cut into 960-sample frames. While the
microphone is muted or no server is connected, the input stream is closed, so
the operating system's microphone indicator tells the truth.

### 4.5 Effects

`0x03` frames go to a second ring buffer (2 s) that the output callback adds
on top of the voice stream, clamped to ±1. Notification sounds (§9.7) are
synthesized in TypeScript and sent this way, so they never interleave with
connector frames.

### 4.6 Backends

macOS uses CoreAudio, Windows WASAPI. On Linux, cpal's `pulseaudio` feature (a pure-Rust
client, no libpulse) makes the default host PulseAudio when a server answers
(PipeWire serves the same protocol through `pipewire-pulse`), and ALSA
otherwise. A machine with no device reports an `error` and tuimspeak keeps
working without voice.

## 5. Main process

### 5.1 Modules

| Path | Role |
| --- | --- |
| `src/main.tsx` | Arguments, render options, signal handling (§5.4) |
| `src/connector/` | `ConnectorProcess` (spawn, lines, lifecycle), `protocol.ts` (events, §3.3), `commands.ts` (encoders, §3.2) |
| `src/audio/` | `AudioProcess` (§4), `frames.ts`, `voice.ts` (`VoiceEngine`, §8.2), `sounds.ts` (§9.7) |
| `src/session/` | `Session`: one connector + one store |
| `src/state/` | Session store and reducer, tree building (§7.2) |
| `src/app/` | `Controller` (§5.3), `App.tsx` layout and global keys |
| `src/mouse/` | Input splitting, SGR parsing, `MouseBus`, React hooks (§6) |
| `src/ui/` | Components, panes and dialogs (§7) |
| `src/config/` | Paths and persistence (§10) |
| `src/demo/` | The simulated server behind `--demo` |

### 5.2 Sessions and state

A `Session` owns one connector and one zustand store. Events are reduced into
state by a pure function (`state/session.ts`), so behavior is testable without
a connector. The store holds the latest snapshot, talkers, whisperers, chat
tabs (server, channel, one per private partner, each capped at 1000 lines),
selection, collapsed channels, tree filter, whisper targets, connection info,
the last list answers (bans, groups, offline messages, files), and transfers.

A disconnected session keeps its tabs and can be reconnected (§9.1): the
`Session` swaps in a new connector built from the same connect request.

### 5.3 Controller

The `Controller` owns everything that is not React: sessions, the audio
helper, the voice engine, configuration, and app-level UI state (active
session, focus, open dialog, notices). Components read stores and call
controller or session methods; they never talk to processes.

### 5.4 Exit and terminal restore

Every exit path (Ctrl+Q, Ctrl+C, SIGTERM, SIGHUP where the platform has it, uncaught exception) turns
off mouse tracking before anything else, then disconnects every session (each
with the 3 s limit of §3.2) and stops tuim-audio. A terminal left in
mouse-tracking mode prints garbage on every click, so the restore sequence is
also written synchronously from `process.on('exit')`.

## 6. Mouse

Ink has no mouse support. It filters SGR mouse reports out of `useInput`, but
offers no events, so tuimspeak has its own layer.

### 6.1 Terminal modes

| Sequence | Purpose |
| --- | --- |
| `CSI ?1049h` | Alternate screen (Ink's `alternateScreen`) |
| `CSI ?1000h` | Button press and release |
| `CSI ?1002h` | Motion while a button is held (drag, release anywhere) |
| `CSI ?1006h` | SGR coordinates: no 223-column limit, releases name their button |
| `CSI ?1004h` | Focus in and out (§8.2) |
| `CSI ?1003h` | Any motion; only while a menu is open, for hover highlight |

### 6.2 Input splitting

Ink reads stdin through `readable`; a second `data` listener would steal its
bytes. `StdinTap` owns `process.stdin` and hands Ink a proxy stream (with
`isTTY`, `setRawMode`, `ref`, `unref`) carrying everything that is not:

- an SGR mouse report or a focus event (to `MouseBus`),
- a kitty keyboard **release** event (`CSI …:3u|~|A-Z`). Ink forwards
  releases to every `useInput` handler, which would make text inputs type
  every character twice. Releases matter only for hold keys (§8.2),
- a configured hold key (§8.2), which the tap turns into press/release calls.

A trailing fragment that could still become one of these is held back up to
25 ms for the next chunk.

### 6.3 Hit testing

- The UI renders full-screen from (0,0) in the alternate screen, so Ink layout
  coordinates are screen coordinates.
- `useMouseRegion(ref, handlers, {layer})` registers a box. Rectangles are
  computed on every event (`measureElement`), never cached, so resizes need no
  re-registration.
- Layers: `base` < `overlay` (menus) < `modal` (dialogs). The topmost layer
  wins; while a modal is open, nothing below it receives events. Within a
  layer the smallest (innermost) region wins, falling back to enclosing
  regions that handle the event.
- Long lists (tree, chat log, dialog lists) render only visible rows and
  register one region; the row is `localY + scrollTop`.

### 6.4 Gestures

| Gesture | Rule |
| --- | --- |
| Click | Press and release of one button on the same region |
| Double-click | Two clicks on the same cell within 400 ms |
| Right-click | Right button released; opens a menu |
| Wheel | Codes 64/65; `wheelLines` rows per notch |
| Hold | `onPress` on press, `onRelease` on release **wherever it happens** |
| Drag | After `onPress`, motion with the button held goes to the pressed region's `onDrag`; `onRelease` ends it |
| Press outside | `onPressOutside` closes menus and dialogs |

### 6.5 Known limitations

With mouse tracking on, the terminal's own text selection needs a modifier
(Shift on most Linux terminals and Windows Terminal, Option in iTerm2, Fn in
Terminal.app). tmux needs `set -g mouse on`. Links are OSC 8 hyperlinks and
need the terminal's link modifier. On Windows, Windows Terminal (ConPTY)
passes SGR mouse and focus reports; the legacy console host does not, so
tuimspeak there is keyboard-only.

## 7. User interface

### 7.1 Layout

```
┌ tuimspeak [● Server A] [● Server B] [+]               ping 32ms loss 0% [Settings] [?] ┐
│ Channels  [/ filter]                │ Info                                             │
│ ≡ Server A (12/32)                  │ alice                                            │
│ ▾ Lobby                             │ Channel   Lobby       Ping   24 ms               │
│     ● alice +                       │ Volume    80%         Idle   12:01               │
│     ○ bob  m        [away: lunch]   │                                                  │
├─────────────────────────────────────┴──────────────────────────────────────────────────┤
│ Chat  [Server] [Lobby] [alice ×]                                                       │
│ 12:01 <alice> evening                                                                  │
│ > _                                                                                    │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ [Mic on] [Sound on] [Hold to talk] VAD ▮▮▯┊▯▯ │ [Whisper 2] │ [Away] │ device name      │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

Below 80 columns the info pane is hidden; below 40×12 a "too small" notice
replaces everything. A poke or notice takes one row above the status bar.

### 7.2 Channel tree

- Channels sort by `(parent, order)`, clients by name. ServerQuery clients
  are hidden unless `showQueryClients`.
- Top-level `[spacer]`, `[cspacer]`, `[rspacer]` and `[*spacer]` channels are
  drawn as left/centered/right/repeated decoration.
- Client icon: talking, whispering to us (§8.3), away, or idle. Flags: channel
  commander, mic muted or disabled, sound muted, locally muted or volume
  changed (§8.4), whisper target (§8.3).
- Icon sets `unicode`, `ascii`, `nerdfont` (§10.1). Some unicode icons are
  East Asian ambiguous width and misalign in CJK locales; `ascii` fixes that.
- **Filter:** `/` or a click on `[/ filter]` opens a filter field; matching
  channels and clients stay visible with their parents, everything matching
  is expanded. Esc clears it.
- **Drag and drop:** drag a client onto a channel to move them (§9.3; your own
  client means switching channel). The drop target is highlighted while
  dragging.

### 7.3 Chat

Tabs: Server (server chat, server log, pokes, errors), Channel (titled with
our channel's name), and one per private partner, opened by a message or a
double-click and closable with `×` or Ctrl+W. Unread counts show on inactive
tabs. BBCode `[b] [i] [u] [s] [color] [url]` is rendered; links are OSC 8.
The input places the real terminal cursor at the caret so IME composition
appears in place. PgUp/PgDn and the wheel scroll; new messages follow the
bottom unless scrolled up.

### 7.4 Menus and dialogs

Right-click (or `m`) opens a context menu for the row under the pointer:

| Target | Items |
| --- | --- |
| Server | Server chat, Connection info, Add to bookmarks, Ban list, Complaints, Offline messages, Edit server, ServerQuery login, Reconnect, Disconnect |
| Channel | Join, Expand/Collapse, Files, Whisper to channel (toggle), Copy name |
| Other client | Private chat, Poke, Volume, Mute locally, Whisper to (toggle), Allow/Block whispers, Move to my channel, Move to…, Kick from channel, Kick from server, Ban, Server groups, Channel group, Send offline message, Copy nickname |
| Own client | Change nickname, Set away / Clear away, Mute microphone, Copy nickname |

Dialogs are modal (§6.3), close on Esc or a click outside, and move between
fields with Tab or a click. Lists inside dialogs scroll with the wheel and
PgUp/PgDn.

### 7.5 Interactions

| Action | Mouse | Keyboard |
| --- | --- | --- |
| Focus tree / chat | Click the pane | Tab |
| Select | Click | ↑ ↓ PgUp PgDn Home End |
| Expand / collapse | Click `▸`/`▾` | ← → |
| Join channel / private chat | Double-click | Enter |
| Context menu | Right-click | `m` |
| Poke | Menu | `p` |
| Filter tree | Click `[/ filter]` | `/` |
| Move someone | Drag onto a channel | Menu → Move to… |
| Chat tabs | Click | Ctrl+← Ctrl+→, Ctrl+W closes |
| Server tabs | Click | Alt+1…9 |
| Scroll | Wheel | PgUp PgDn |
| Mute mic / sound | Status bar | Ctrl+X / Ctrl+D |
| Talk | Hold `[Hold to talk]` | Ctrl+T (toggle mode), `pttKey` (hold, §8.2) |
| Whisper | Hold `[Whisper n]`; click locks | `whisperKey` (hold) |
| Settings | `[Settings]` | F2 |
| Connect | `[+]` | Ctrl+N |
| Help | `[?]` | F1 or `?` |
| Quit | | Ctrl+Q (or `q` in the tree) |

Legacy terminals send the same byte for Ctrl+M and Enter, Ctrl+I and Tab,
Ctrl+H and Backspace, so those are never used as shortcuts. While the chat
input has focus, printable keys go to the input.

## 8. Voice

### 8.1 Data flow

```
mic → tuim-audio ─PCM→ VoiceEngine ─[gate open]→ active session's connector: audio / whisper
connector audioOut → [sound not muted, session active] → tuim-audio → speakers
sounds.ts ─EFFECT→ tuim-audio (mixed on top)
```

Only the **active** server tab sends and plays voice. Audio never passes
through React; only the level (throttled to ~15 updates/s) and "talking"
reach the stores.

### 8.2 Talk modes

| Mode (`talkMode`) | Gate |
| --- | --- |
| `vad` (default) | Frame RMS ≥ `vadThreshold`, plus `vadHangoverMs` after it drops |
| `toggle` | Ctrl+T flips transmission on and off |
| `ptt` | Hold `pttKey` |

In every mode, holding `[Hold to talk]` with the mouse transmits.

**Hold keys** (`pttKey`, `whisperKey`) are function keys `f1`–`f12` or
`ctrl+space` / `alt+space`. True holding needs the kitty keyboard protocol
with event types (kitty, WezTerm, Ghostty, foot, Alacritty, recent iTerm2).
tuimspeak requests it at startup; where the terminal does not answer, a hold
key acts as a toggle (press once to start, again to stop), and the status bar
says so.

Mic mute closes the gate in every mode. Losing terminal focus (`CSI O`)
releases every hold and toggle, so nobody gets stuck transmitting.

### 8.3 Whisper

Each session keeps a **whisper list** of channels and clients, edited from
the context menus and shown on the status bar as `[Whisper n]`.

- **Hold** `[Whisper n]` (or `whisperKey`): send `whisper <list>`, open the
  gate, and on release send `unwhisper`.
- **Click** `[Whisper n]` (press shorter than 300 ms): lock whisper on. Voice
  then follows the normal talk mode but goes only to the list. Click again to
  unlock. A locked whisper is shown in color.
- Right-click `[Whisper n]` lists the targets, to remove one or clear all.

Incoming: `whisperReceived` marks the client as whispering to us (its own icon
and color) until it leaves `talkers`; the first whisper from someone in a
minute is also logged in the server tab. `blockWhispers` makes the policy
`block` by default; per-user exceptions (`whisperExceptions`, by UID) are
toggled from the menu ("Allow whispers from" / "Block whispers from"). The
policy is re-sent whenever the snapshot changes, mapping UIDs to current
client ids.

### 8.4 Per-user volume

"Volume" opens a slider, 0–200% in 10% steps (drag or click the bar, wheel,
← →). "Mute locally" sets the volume to 0 and back. Volumes are stored by UID
(`volumes`), so they follow people across sessions and servers, and are
applied with `clientvolume` as soon as the person appears in a snapshot.

### 8.5 Multiple servers

Several sessions run at once, one tab each. Switching tabs releases holds and
moves voice and playback to the new tab; the others stay connected.

## 9. Server features

### 9.1 Connecting

The connect dialog takes an address (`host`, `host:port` or a
`ts3server://host?port=&nickname=&password=&channel=&token=` link), nickname,
password and default channel, and lists bookmarks with Connect, Edit and
Delete. "Save as bookmark" stores the entry. A session that ends
(`disconnected`, connector exit) shows `Reconnect` in its server menu and info
pane.

### 9.2 Connection info

While a client is selected, `clientconninfo` is requested on selection and
every 3 s; the info pane shows ping, connected time, address, packets, bytes
and loss. For the active session `serverconninfo` runs every 5 s; ping and
loss appear in the top bar and the server info pane shows bandwidth. Both
need server permissions; after the first `permissionError` for one of them
(connector labels `Connection info` and `Server connection info`), that
session stops polling it until it reconnects, so the denial is logged once.

### 9.3 Moderation

The server decides what is allowed; a denied action comes back as `error` or
`serverLog permissionError` and is shown in the server tab.

- **Move:** drag and drop (§7.2), "Move to my channel", or "Move to…" with a
  channel picker. Moving into a password channel asks for the password.
- **Kick** from channel or server, with a reason.
- **Ban** with a reason and a duration (10 min, 1 h, 1 day, 1 week,
  permanent).
- **Ban list:** list, delete one, delete all. **Complaints:** list, delete.
- **Edit server:** name, welcome message, password, max clients.
- **ServerQuery login:** user and password, sent base64-encoded.

### 9.4 Groups

"Server groups" lists the server's groups with a checkbox each (checked = the
client is a member); toggling adds or removes. "Channel group" lists the
channel groups and sets one for the client's current channel. Both lists are
requested when the dialog opens.

### 9.5 Offline messages

Server menu → Offline messages: list (subject, sender UID, time, read), open
one (`messageget`, then marked read), delete. Client menu → Send offline
message (subject and text to the client's UID).

### 9.6 Channel files

Channel menu → Files: a browser rooted at `/` with a breadcrumb, directories
first, size and date. Double-click or Enter opens a directory; `..` goes up.
Buttons: Download (to `downloadDir`, default `~/Downloads`; an existing name
gets a ` (n)` suffix), Upload (a local path), New folder, Rename, Delete (with
confirmation). Downloads arrive in chunks and are written as they come;
uploads are sent in 192 KiB pieces (a multiple of 3 bytes so base64 pieces
concatenate). The connector caps downloads at 25 MiB and uploads at 24 MiB;
larger files are refused before sending. Progress shows in the dialog and in
the status of each transfer.

### 9.7 Notifications

- **Sounds** (`sounds`, `soundVolume`): short synthesized tones for poke,
  private message, channel message, someone joining or leaving our channel,
  connected and disconnected, mixed in via §4.5.
- **Terminal bell** on poke.
- **Desktop notifications** (`desktopNotifications`: `off`, `unfocused`
  (default), `always`) for pokes and private messages: `osascript` on macOS,
  `notify-send` on Linux when installed, a PowerShell tray balloon on
  Windows. Text is passed as arguments (macOS, Linux) or environment
  variables (Windows), never spliced into a script or shell command.
- Pokes also show a banner until dismissed (Esc or `x`).

## 10. Persistence

### 10.1 Configuration

`~/.config/tuimspeak/` (`$XDG_CONFIG_HOME`), on macOS too; on Windows
`%APPDATA%\tuimspeak\`. Keys are listed in
[configuration.md](configuration.md). Files with secrets or identities are
written mode 0600 in a 0700 directory.

### 10.2 Identity

The first connection omits `TS_IDENTITY`; the connector generates one and
reports it in `connected`; tuimspeak saves it under `identities/<name>.ini`.
Later connections pass it, so the server sees the same UID.

### 10.3 Logs

stdout belongs to the UI; logs go to `$XDG_STATE_HOME/tuimspeak/tuimspeak.log`
(`~/.local/state/...`), on Windows `%LOCALAPPDATA%\tuimspeak\tuimspeak.log`. `--debug` adds connector and audio stderr and audio
statistics.

## 11. macOS, Linux and Windows

| Aspect | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Audio | CoreAudio | PulseAudio protocol (PipeWire via `pipewire-pulse`), else ALSA | WASAPI |
| Microphone permission | Belongs to the terminal app; denial shows as `silentInput` (§4.2) | None | Settings → Privacy → Microphone → desktop apps |
| Sample rate | Often 44.1 kHz, resampled | Usually 48 kHz | Device mix format, resampled if not 48 kHz |
| Terminal | Any modern terminal | Any modern terminal | Windows Terminal (mouse needs ConPTY) |
| Desktop notifications | `osascript` | `notify-send` | PowerShell tray balloon |
| Configuration | `~/.config/tuimspeak` | `~/.config/tuimspeak` | `%APPDATA%\tuimspeak` |
| Executables | `tuimspeak`, `ts-connector`, `tuim-audio` | same | same with `.exe` |
| Build dependencies | Xcode Command Line Tools, Rust, cmake | Rust, cmake, clang, ALSA headers | Visual Studio Build Tools, Rust, cmake, LLVM (libclang for bindgen) |

## 12. Distribution, installation and updates

### 12.1 Builds and releases

`bun run build` compiles `tuimspeak` into one executable with Bun's official
runtime for the target (`--target bun-darwin-arm64`, `bun-linux-x64-baseline`,
`bun-windows-x64`, …). Ink's optional `react-devtools-core` import is replaced
by an empty module in `scripts/build.ts`, because the bundler hoists it to
startup. The version is `package.json`'s, compiled in.

CI builds five platforms: `linux-x64`, `linux-arm64`, `darwin-arm64`,
`darwin-x64`, `windows-x64`. Each release asset is
`tuimspeak-<platform>.tar.gz` (`.zip` on Windows) plus `<asset>.sha256`,
holding `tuimspeak`, `ts-connector`, `tuim-audio` (`.exe` on Windows),
`README.md` and `licenses/` (tuimspeak MIT, WebSpeak3 MIT, tsclientlib MIT OR
Apache-2.0). Pushing a tag `vX.Y.Z` that matches `package.json` publishes a
GitHub release with all of them.

tuimspeak looks for the helpers in `TUIMSPEAK_CONNECTOR_BIN` /
`TUIMSPEAK_AUDIO_BIN`, next to its executable, then in
`native/target/release/`.

### 12.2 Install layout

| | macOS, Linux | Windows |
| --- | --- | --- |
| Versions | `${XDG_DATA_HOME:-~/.local/share}/tuimspeak/versions/<version>/` | `%LOCALAPPDATA%\tuimspeak\versions\<version>\` |
| Launcher on `PATH` | `~/.local/bin/tuimspeak`, a symlink to the current version's executable | `%LOCALAPPDATA%\tuimspeak\bin\tuimspeak.cmd`, which runs the current version's `tuimspeak.exe` |

Every version lives in its own directory and the launcher is switched
atomically (a renamed symlink, or a rewritten `.cmd`), so a running tuimspeak
is never overwritten and an interrupted update leaves the old version
working. After a switch, versions other than the new one and the running one
are removed.

### 12.3 Install scripts

- `install.sh`, for `curl -fsSL <raw url>/install.sh | sh` on macOS and
  Linux: detects OS and CPU, asks the GitHub API for the latest release (or
  `TUIMSPEAK_VERSION`), downloads the archive and its `.sha256`, verifies the
  checksum, unpacks into the version directory, points the launcher at it,
  and says how to add `~/.local/bin` to `PATH` if it is missing.
- `install.ps1`, for `irm <raw url>/install.ps1 | iex` in PowerShell: the
  same with `.zip`, `Get-FileHash`, and the user `PATH` updated to include
  `%LOCALAPPDATA%\tuimspeak\bin`.

Both are idempotent: running one again installs the latest version, or does
nothing if it is already current. `TUIMSPEAK_REPO` overrides the repository
(forks).

### 12.4 Updates

At startup, at most once every 24 hours (time stored in the state directory
as `update.json`), tuimspeak asks the GitHub API for the latest release, with
a 5 s timeout and never blocking the UI.

- **Installed by a script** (the executable runs from a version directory,
  §12.2) and `autoUpdate` on (default): the new version is downloaded,
  verified against its `.sha256`, unpacked with the system `tar` (bsdtar on
  Windows reads `.zip`), and the launcher switched. A notice says
  "Updated to vX.Y.Z; restart tuimspeak to use it".
- **Otherwise** (built from source, a package manager, `autoUpdate` off): a
  notice says that vX.Y.Z is available.

`tuimspeak update` does the same in the foreground and prints what happens;
`tuimspeak --version` prints the version. `TUIMSPEAK_NO_UPDATE=1` disables
the startup check. A failed check or update is logged, never shown as an
error over the UI.

## 13. Limitations

- **Permissions** can't be viewed or edited (§2). Use the native client or
  ServerQuery.
- **Hold keys** need the kitty keyboard protocol; elsewhere they toggle
  (§8.2). The mouse hold button works everywhere.
- **Files** above 25 MiB (download) or 24 MiB (upload) are refused by the
  connector.
- **No sound hardware** means no voice; everything else works.
- **Ambiguous-width characters** may misalign in CJK locales; use the `ascii`
  icon set.
- **Windows** needs Windows Terminal for the mouse; the legacy console host
  is keyboard-only (§6.5). Windows Terminal does not report key releases,
  so hold keys toggle there.
- **Releases are unsigned.** macOS Gatekeeper and Windows SmartScreen may
  warn on first start; the install scripts verify checksums but not
  signatures.
