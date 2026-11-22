# tuimspeak User Guide

**Status:** Draft
**Companion to:** tuimspeak Architecture (`tuimspeak-architecture.md`). Section numbers such as "§8.3" refer to that document; numbers without `§`, such as "section 2.4", refer to this guide. Settings are described in [configuration.md](configuration.md).

The guide has three chapters: [Installing](#chapter-1-installing) (getting tuimspeak running), [Daily use](#chapter-2-daily-use) (talking, chatting, moderating) and [Trouble](#chapter-3-trouble) (when something goes wrong). A new machine starts with section 1.1.

---

## Before you start

### The programs

| Program | What it is |
| --- | --- |
| `tuimspeak` | The terminal UI you run |
| `ts-connector` | Talks to the TeamSpeak server; started by tuimspeak, one per server |
| `tuim-audio` | Microphone and speakers; started by tuimspeak |

Keep the three files in one directory (the install scripts do), or set
`TUIMSPEAK_CONNECTOR_BIN` and `TUIMSPEAK_AUDIO_BIN`. On Windows they end in
`.exe`.

### Mouse and keyboard

Everything works with the mouse: click to select, double-click to join or
open a chat, right-click for a menu, drag a person onto a channel to move
them, and the wheel to scroll. Everything also has a key:

| Key | Does |
| --- | --- |
| Tab | Switch between the channel tree and the chat |
| ↑ ↓ / PgUp PgDn / Home End | Move in the tree |
| ← → | Collapse / expand, or jump to the parent |
| Enter | Join the channel, or open a private chat |
| m | Context menu of the selected row |
| p | Poke the selected person |
| / | Filter the tree; Esc clears |
| Ctrl+← / Ctrl+→ | Previous / next chat tab |
| Ctrl+W | Close a private chat tab |
| Alt+1 … Alt+9 | Switch server tab |
| Ctrl+T | Toggle to talk (toggle and push-to-talk modes) |
| F9 / F8 | Hold to talk / hold to whisper (configurable) |
| Ctrl+X / Ctrl+D | Mute microphone / mute sound |
| Ctrl+N | Connect to a server |
| F2 | Settings |
| F1 or ? | Help |
| Ctrl+Q | Quit (`q` also works in the tree) |

While mouse tracking is on, select text in the terminal by holding Shift (most
Linux terminals, Windows Terminal), Option (iTerm2) or Fn (Terminal.app). On
Windows, use Windows Terminal; the old console window has no mouse support.

---

# Chapter 1: Installing

## 1.1 One-line install

macOS and Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/st0nie/tuimspeak/main/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/st0nie/tuimspeak/main/install.ps1 | iex
```

The script downloads the latest release for your system, checks its SHA-256,
and installs it (§12.2):

| | Program | Command on `PATH` |
| --- | --- | --- |
| macOS, Linux | `~/.local/share/tuimspeak/versions/<version>/` | `~/.local/bin/tuimspeak` |
| Windows | `%LOCALAPPDATA%\tuimspeak\versions\<version>\` | `%LOCALAPPDATA%\tuimspeak\bin\tuimspeak.cmd` |

If `~/.local/bin` is not on your `PATH`, the script prints the line to add.
On Windows it adds its folder to your user `PATH`; open a new terminal
afterwards. To install a particular version, set `TUIMSPEAK_VERSION=0.1.0`
first.

### Updates

tuimspeak checks for a new release once a day when it starts. If it was
installed by the script, it installs the update in the background and tells
you to restart; otherwise it tells you a new version exists. Run
`tuimspeak update` to update right away, `tuimspeak --version` to see what
you have. Turn automatic installs off in Settings (F2) → Updates, or set
`TUIMSPEAK_NO_UPDATE=1` to skip the check. Running the install script again
also updates.

### Uninstall

Delete the version folder and the launcher from the table above. Your
settings, bookmarks and identities are in the configuration folder
([configuration.md](configuration.md#files-tuimspeak-writes)); keep the
identities if you want the same TeamSpeak UID later.

## 1.1a From a release archive by hand

Download `tuimspeak-<platform>.tar.gz` (`linux-x64`, `linux-arm64`,
`darwin-arm64`, `darwin-x64`) or `tuimspeak-windows-x64.zip` from the
releases page, check it against the `.sha256` file, and unpack the three
programs into one directory on your `PATH`. Archives downloaded with a
browser are quarantined on macOS (`xattr -d com.apple.quarantine tuimspeak
ts-connector tuim-audio`) and may trigger SmartScreen on Windows; copies
installed this way only announce updates.

## 1.2 From source

Follow "Building" in [development.md](development.md). In short:

```sh
git clone --recursive <repository>
cd tuimspeak
bun install
bun run build:native
bun run build        # dist/tuimspeak; copy native/target/release/{ts-connector,tuim-audio} next to it
```

## 1.3 First start

```sh
tuimspeak --demo                 # look around without a server
tuimspeak --list-devices         # check that your microphone and speakers are seen
tuimspeak voice.example.com      # or start without an address and use the connect dialog
```

On macOS the first voice session asks for microphone access **for your
terminal app**. Allow it. On Windows, allow desktop apps to use the
microphone under Settings → Privacy & security → Microphone.

---

# Chapter 2: Daily use

## 2.1 Connect

Press Ctrl+N or click `[+]`. Enter an address (`host`, `host:port` or a
`ts3server://` link), your nickname, and the server password if there is one.
Tick **Save as bookmark** to keep the server; bookmarks appear at the top of
the dialog with Connect, Edit and Delete. Passwords are only stored in a
bookmark when you tick **Store password in bookmark**.

Several servers can be connected at once; each gets a tab at the top. Only
the active tab sends and plays voice (§8.5).

If the connection drops, the connector retries by itself. A connection that
has ended shows **Reconnect** in the info pane and the server menu
(right-click the server row or its tab).

## 2.2 Talk

Open Settings (F2) and pick a talk mode:

- **Voice activation** (default): you transmit while you speak. Speak
  normally and watch the bar under **Activation level**; put the dot just
  above your background noise.
- **Toggle**: Ctrl+T starts and stops transmitting.
- **Push to talk**: hold F9 (or the key you chose). This needs a terminal
  that reports key releases (kitty, WezTerm, Ghostty, foot, Alacritty).
  Settings tells you whether yours does; elsewhere the key toggles.

In every mode you can hold the **[Hold to talk]** button on the status bar
with the mouse. **[Mic on]** and **[Sound on]** mute your microphone and your
speakers (Ctrl+X, Ctrl+D); others see your mute icons.

## 2.3 Whisper

Whispering sends your voice only to chosen people and channels:

1. Right-click a person and choose **Whisper to**, or right-click a channel
   and choose **Whisper to channel**. They get a `»` mark and the status bar
   shows **[Whisper n]**.
2. Hold **[Whisper n]** (or F8) and speak.
3. A short click on **[Whisper n]** locks whispering on until you click
   again. Right-click it to see the list, remove entries or clear it.

When someone whispers to you, their icon turns into a magenta diamond and the
server tab notes it. To refuse whispers from strangers, tick **Block incoming
whispers** in Settings and use **Allow whispers from** in each friend's menu.

## 2.4 Turn someone up or down

Right-click a person → **Volume**: drag or click the bar (0–200%), use the
wheel or ← →. **Mute locally** silences them only for you. Volumes are
remembered per person (by identity), on every server.

## 2.5 Chat

The chat pane has a **Server** tab (server chat, events, pokes, errors), a
tab named after your channel, and one tab per private chat. Double-click a
person to chat privately. Unread counts show on tabs you're not looking at.
Pokes ring the terminal bell, play a sound and show a banner (Esc or `x`
dismisses it). Links can be opened with your terminal's link modifier.

## 2.6 Files

Right-click a channel → **Files**. Double-click folders to open them; `..`
goes up. **Download** saves to `~/Downloads` (change it in Settings);
**Upload** asks for a local path. Files are limited to 25 MiB down and
24 MiB up.

## 2.7 Moderate

What you may do is decided by the server; refused actions appear in the
server tab.

| Task | How |
| --- | --- |
| Move someone | Drag them onto a channel, or menu → Move to my channel / Move to… |
| Kick | Menu → Kick from channel / Kick from server |
| Ban | Menu → Ban, with a duration and a reason |
| Bans and complaints | Server menu → Ban list / Complaints |
| Groups | Menu → Server groups (checkboxes) / Channel group |
| Offline messages | Server menu → Offline messages; a person's menu → Send offline message |
| Server settings | Server menu → Edit server |
| Admin login | Server menu → ServerQuery login |

---

# Chapter 3: Trouble

## 3.1 No sound or no microphone

- The status bar says **No audio device**: run `tuimspeak --list-devices`. If
  nothing is listed, the system has no sound device that tuimspeak can open
  (on Linux, check that PulseAudio or PipeWire with `pipewire-pulse` runs).
- A notice says **The microphone delivers only silence**: on macOS, allow
  your terminal app under System Settings → Privacy & Security → Microphone,
  then restart the terminal.
- Wrong device: pick it in Settings (F2) → Microphone / Speakers.
- Others don't hear you in voice activation mode: lower the activation level
  until the bar crosses the dot when you speak.

## 3.2 Push to talk only toggles

Your terminal does not report key releases (§8.2). Use a terminal with the
kitty keyboard protocol, hold the mouse button on **[Hold to talk]**, or use
voice activation.

## 3.3 Clicks print garbage after a crash

The terminal was left in mouse-tracking mode. Run `reset`, or
`printf '\e[?1000l\e[?1002l\e[?1006l\e[?1004l'`. Please report the crash with
the log (`~/.local/state/tuimspeak/tuimspeak.log`, run with `--debug`).

## 3.4 The update did not happen

Updates are checked at most once a day, and installed automatically only for
copies installed by the script with `autoUpdate` on. Run `tuimspeak update`
to see what happens; failures are also in the log. Behind a proxy, set
`HTTPS_PROXY`. Running the install script again always works.

## 3.5 Icons look misaligned

Some icons are "ambiguous width" in CJK locales. Set Icons to ASCII in
Settings, or `"icons": "ascii"` in `config.json`.

## 3.6 "Insufficient permissions"

The server refused an action. For connection info this is logged once and
tuimspeak stops asking (§9.2). Ask a server admin for the permission, or log
in with ServerQuery credentials (section 2.7).
