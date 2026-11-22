# Configuration reference

This page describes every setting tuimspeak has: where it lives, what it does,
its default, and how to change it. Section numbers (§8.3) refer to
[tuimspeak-architecture.md](tuimspeak-architecture.md). Step-by-step
procedures are in [tuimspeak-user-guide.md](tuimspeak-user-guide.md).

- [Overview](#overview): where settings live
- [Command line](#command-line): flags and environment variables
- [config.json](#configjson): preferences
- [bookmarks.json](#bookmarksjson): saved servers
- [identities/](#identities): your TeamSpeak identities
- [Files tuimspeak writes](#files-tuimspeak-writes)
- [Recipes](#recipes)

## Overview

| | Command line | `config.json` | `bookmarks.json` | `identities/` |
| --- | --- | --- | --- | --- |
| **Holds** | One run: server, nickname, debug | Preferences: talk mode, devices, keys, notifications, per-user volumes | Saved servers | Client identities (your UID) |
| **Changed with** | Flags, env vars | The Settings dialog (F2), menus, or an editor while tuimspeak is closed | The connect dialog | tuimspeak itself on first connect |
| **Takes effect** | That run | Immediately when changed in the UI; at start when edited by hand | Next connect | Next connect |

All files live in `~/.config/tuimspeak/`, or `$XDG_CONFIG_HOME/tuimspeak/`
when that is set, on macOS and Linux alike, and in `%APPDATA%\tuimspeak\` on
Windows (§10.1). tuimspeak
rewrites `config.json` when you change a setting in the UI, so edit it by hand
only while tuimspeak is not running.

### Where to put a setting

| You want to… | Put it in |
| --- | --- |
| Connect somewhere once | `tuimspeak host[:port]` or a `ts3server://` link |
| Keep a server | A bookmark (connect dialog → Save as bookmark) |
| Push to talk instead of voice activation | `talkMode: "ptt"` and `pttKey`, or Settings |
| Make voice activation more or less sensitive | `vadThreshold`, or the slider in Settings |
| Use another microphone or speaker | `inputDevice` / `outputDevice` (ids from `--list-devices`), or Settings |
| Turn someone down for good | Their menu → Volume (stored in `volumes`) |
| Stop strangers from whispering to you | `blockWhispers: true`, plus exceptions from the menu |
| Fix misaligned icons in a CJK locale | `icons: "ascii"` |
| Quieter or no notification sounds | `soundVolume`, `sounds` |
| Save downloads elsewhere | `downloadDir` |
| Debug a problem | `--debug`, then read the log (see [Files](#files-tuimspeak-writes)) |
| Stop automatic updates | `autoUpdate: false` (still told about new releases), or `TUIMSPEAK_NO_UPDATE=1` (no check at all) |

## Command line

```text
tuimspeak [address | ts3server://link] [options]
tuimspeak update                Install the latest release (§12.4)

  -a, --address <host[:port]>   Server to connect to (same as the positional argument)
  -n, --nickname <name>         Nickname for this connection
  -c, --channel <path>          Channel to join, e.g. "Lobby/Sub"
      --demo                    Simulated server; no network or audio
      --list-devices            Print audio devices with their ids and exit
      --debug                   Verbose log, including connector and audio stderr
  -v, --version                 Print the version
  -h, --help                    Help
```

| Environment variable | Meaning |
| --- | --- |
| `TS_SERVER_PASSWORD` | Server password for the connection started from the command line. Passwords are never flags, because flags are visible in `ps` (§3.1) |
| `TUIMSPEAK_CONNECTOR_BIN` | Path of `ts-connector` (§12) |
| `TUIMSPEAK_AUDIO_BIN` | Path of `tuim-audio` (§12) |
| `XDG_CONFIG_HOME` / `XDG_STATE_HOME` / `XDG_DATA_HOME` | Base directories for configuration, the log, and installed versions (macOS, Linux) |
| `TUIMSPEAK_NO_UPDATE` | `1` skips the startup update check (§12.4) |
| `TUIMSPEAK_REPO` | GitHub repository for updates and the install scripts (default `st0nie/tuimspeak`) |
| `TUIMSPEAK_VERSION` | Install scripts only: install this version instead of the latest |
| `RUST_LOG` | Log filter for `ts-connector` (default `error`) |

A `ts3server://` link may carry `port`, `nickname`, `password`, `channel` and
`token` (a privilege key) as query parameters.

## config.json

Every key is optional; a missing key takes its default.

| Key | Default | Meaning |
| --- | --- | --- |
| `nickname` | your login name | Nickname for new connections. Updated when you change it in the UI |
| `talkMode` | `"vad"` | `"vad"` voice activation, `"toggle"` (Ctrl+T), `"ptt"` hold `pttKey` (§8.2) |
| `pttKey` | `"f9"` | Hold-to-talk key: `"f1"`…`"f12"`, `"ctrl+space"`, `"alt+space"` |
| `whisperKey` | `"f8"` | Hold-to-whisper key, same choices (§8.3) |
| `vadThreshold` | `0.02` | Voice activation level, linear RMS 0–1. Lower is more sensitive |
| `vadHangoverMs` | `300` | How long transmission continues after the level drops |
| `inputDevice` | `"default"` | Microphone id from `--list-devices` |
| `outputDevice` | `"default"` | Speaker id from `--list-devices` |
| `icons` | `"unicode"` | Tree icons: `"unicode"`, `"ascii"`, `"nerdfont"` (needs a Nerd Font) |
| `showQueryClients` | `false` | Show ServerQuery clients in the tree |
| `wheelLines` | `3` | Rows scrolled per wheel notch |
| `sounds` | `true` | Notification sounds (§9.7) |
| `soundVolume` | `0.5` | Notification sound volume, 0–1 |
| `desktopNotifications` | `"unfocused"` | `"off"`, `"unfocused"` (only when the terminal is not focused), `"always"` |
| `blockWhispers` | `false` | Block incoming whispers except from `whisperExceptions`; when `false`, allow all except `whisperExceptions` |
| `whisperExceptions` | `[]` | UIDs that get the opposite of `blockWhispers`. Edited from the client menu |
| `volumes` | `{}` | Per-user playback volume by UID, `0`–`2` (`1` = unchanged, `0` = muted locally) |
| `downloadDir` | `"~/Downloads"` | Where channel file downloads go (§9.6) |
| `autoUpdate` | `true` | Install new releases in the background when tuimspeak was installed by a script; otherwise only say that one is available (§12.4) |

Example:

```json
{
  "nickname": "alice",
  "talkMode": "ptt",
  "pttKey": "f9",
  "icons": "ascii",
  "volumes": { "u5oDn8s1QKcbw0I0ZcHLLT8v2Tc=": 0.6 }
}
```

## bookmarks.json

A JSON array. The connect dialog adds, edits and deletes entries.

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Label in the dialog and the server tab |
| `address` | yes | `host` or `host:port` |
| `nickname` | no | Overrides `config.json`'s `nickname` |
| `defaultChannel` | no | Channel path to join, e.g. `"Gaming/Squad A"` |
| `serverPassword` | no | Stored in plain text (file mode 0600); only saved when you tick the box |
| `identity` | no | Name of the identity file to use (default `default`) |

## identities/

One file per identity, `identities/<name>.ini`, mode 0600, holding the
connector's identity string (§10.2). `default.ini` is created on your first
connection. The identity **is** your TeamSpeak UID and any server permissions
granted to it: back it up, and never share it. To start fresh on a server,
point a bookmark at a new `identity` name.

## Files tuimspeak writes

| macOS, Linux | Windows | What |
| --- | --- | --- |
| `~/.config/tuimspeak/config.json` | `%APPDATA%\tuimspeak\config.json` | Preferences (0600) |
| `~/.config/tuimspeak/bookmarks.json` | `%APPDATA%\tuimspeak\bookmarks.json` | Bookmarks (0600) |
| `~/.config/tuimspeak/identities/*.ini` | `%APPDATA%\tuimspeak\identities\*.ini` | Identities (0600) |
| `~/.local/state/tuimspeak/tuimspeak.log` | `%LOCALAPPDATA%\tuimspeak\tuimspeak.log` | Log (§10.3) |
| `~/.local/state/tuimspeak/update.json` | `%LOCALAPPDATA%\tuimspeak\update.json` | Time of the last update check |
| `~/.local/share/tuimspeak/versions/` | `%LOCALAPPDATA%\tuimspeak\versions\` | Installed versions (§12.2) |
| `~/.local/bin/tuimspeak` | `%LOCALAPPDATA%\tuimspeak\bin\tuimspeak.cmd` | Launcher |
| `downloadDir` | `downloadDir` | Channel file downloads |

## Recipes

### Push to talk on F9

```json
{ "talkMode": "ptt", "pttKey": "f9" }
```

Needs a terminal with the kitty keyboard protocol for true holding (kitty,
WezTerm, Ghostty, foot, Alacritty). Elsewhere F9 toggles; holding the
`[Hold to talk]` button with the mouse works in every terminal.

### A bookmark with a separate identity

```json
[
  { "name": "Work", "address": "ts.example.com", "nickname": "Alice (work)", "identity": "work" }
]
```

### Only friends may whisper

Set `"blockWhispers": true`, then use **Allow whispers from** in each friend's
menu. Their UIDs are added to `whisperExceptions`.
