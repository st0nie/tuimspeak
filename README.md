# tuimspeak

A TeamSpeak client for the terminal, with full mouse support. Runs on macOS, Linux and Windows, connects to TeamSpeak 3, TeamSpeak 6 and TeaSpeak servers.

It talks to servers through the `ts-connector` from [WebSpeak3](https://github.com/WebSpeak3/webspeak3) (built on [tsclientlib](https://github.com/ReSpeak/tsclientlib)) and drives your microphone and speakers through a small Rust helper, `tuim-audio`. The UI is React 19 + Ink 8 on Bun.

## Features

- Channel tree with talking, whispering, away and mute icons; filter with `/`; double-click to join; drag a person onto a channel to move them
- Server, channel and private chat tabs, server log, BBCode, clickable links
- Voice: voice activation with a live level meter, toggle to talk, push to talk (mouse button or a held key), whisper lists (hold or lock), per-person volume and local mute
- Right-click menus for everything; dialogs you can click through
- Moderation: move, kick, ban, ban list, complaints, server and channel groups, offline messages, server settings, ServerQuery login
- Channel file browser: download, upload, folders, rename, delete
- Connection info (ping, loss, traffic), notification sounds, desktop notifications
- Bookmarks, several servers at once, persistent identity
- `--demo` mode with a simulated server

## Install

macOS and Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/st0nie/tuimspeak/main/install.sh | sh
```

Windows (PowerShell, then use Windows Terminal):

```powershell
irm https://raw.githubusercontent.com/st0nie/tuimspeak/main/install.ps1 | iex
```

tuimspeak checks for updates once a day and installs them in the background; `tuimspeak update` updates right away.

## From source

```sh
git clone --recursive <this repo> && cd tuimspeak
bun install
bun run build:native      # needs Rust, cmake, clang (and ALSA headers on Linux)
bun run dev --demo        # try it without a server
bun run dev voice.example.com -n alice
```

Release archives for linux-x64, linux-arm64, darwin-arm64, darwin-x64 and windows-x64 are built by CI.

## Documentation

- [User guide](docs/tuimspeak-user-guide.md): installing, talking, whispering, chat, files, moderation, troubleshooting
- [Configuration reference](docs/configuration.md): command line, `config.json`, bookmarks, identities
- [Architecture](docs/tuimspeak-architecture.md): how it works; changes start here
- [Development](docs/development.md): building, testing, conventions

## License

MIT. `native/webspeak3` is WebSpeak3 (MIT); tsclientlib is MIT OR Apache-2.0. Release archives include all three licenses.
