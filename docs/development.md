# Developing tuimspeak

This page covers how the code is organized, how to build and test it, and the
conventions and pitfalls that aren't obvious from the code. The design itself
is in [tuimspeak-architecture.md](tuimspeak-architecture.md); section numbers
(§) in code comments refer to it.

## The rule: architecture first

Every change starts by editing
[tuimspeak-architecture.md](tuimspeak-architecture.md) (and
[configuration.md](configuration.md) or the user guide if users see the
change). The code follows the document, never the other way round. A commit
that changes behavior without touching the document is incomplete.

Everything in the repository is written in English: code, comments, UI text,
documentation and commit messages.

## Layout

| Path | What |
| --- | --- |
| `src/` | The TypeScript app (§5.1 lists the modules) |
| `test/` | `bun test` suites; `test/fixtures/fake-connector.ts` records commands and plays connector events |
| `native/webspeak3/` | Git submodule: WebSpeak3, pinned. Only `connector/` is built. Never patched (§3) |
| `native/tuim-audio/` | The audio sidecar, a Rust crate (§4) |
| `native/target/` | Cargo output for both native programs (git-ignored) |
| `scripts/build-native.ts` | Builds `ts-connector` and `tuim-audio` |
| `scripts/build.ts` | Compiles the single `tuimspeak` executable (§12) |
| `install.sh`, `install.ps1` | One-line installers (§12.3) |
| `src/update.ts` | Update check and self-update (§12.4) |
| `scripts/pty-drive.py` | Runs the real app in a pseudo-terminal and prints its screen ([below](#end-to-end-in-a-pseudo-terminal)) |
| `.github/workflows/release.yml` | CI ([below](#continuous-integration)) |

Bun 1.4, React 19, Ink 8, TypeScript 7 (`tsc --noEmit` only; Bun runs the
sources directly). Rust stable, edition 2021 for `tuim-audio`.

## Building

```sh
git submodule update --init --recursive
bun install --frozen-lockfile
bun run build:native        # cargo build --release for ts-connector and tuim-audio
bun run dev --demo          # simulated server, no network or audio
bun run dev host[:port]     # a real server; TS_SERVER_PASSWORD for a password
bun run build               # dist/tuimspeak for this machine
bun scripts/build.ts --target bun-darwin-arm64 --outfile dist/tuimspeak-mac
```

System packages: Linux needs cmake, clang/libclang (bindgen) and the ALSA
headers (Debian `libasound2-dev`, Arch `alsa-lib`); macOS needs the Xcode
Command Line Tools and cmake; Windows needs the Visual Studio Build Tools
(C++), cmake and LLVM, with `LIBCLANG_PATH` pointing at LLVM's `bin`. `audiopus_sys` builds opus from a bundled
CMakeLists that newer CMake rejects, so `build:native` sets
`CMAKE_POLICY_VERSION_MINIMUM=3.5`.

The binaries are found through `TUIMSPEAK_CONNECTOR_BIN` /
`TUIMSPEAK_AUDIO_BIN`, next to the executable, or in
`native/target/release/` (§12).

## Checks before committing

```sh
bun run typecheck
bun test
(cd native/tuim-audio && cargo fmt -- --check \
  && CARGO_TARGET_DIR=../target cargo clippy --release --all-targets -- -D warnings \
  && CARGO_TARGET_DIR=../target cargo test --release)
```

## Tests

### Unit tests

`bun test` covers the SGR and kitty key parser (split chunks, release
stripping, hold keys in kitty and legacy encodings), the mouse bus (click,
double-click, hold, drag, layers, press outside), protocol parsing (both
field spellings, unknown events, transfer errors) and command encoding
(newline and tab scrubbing), the session reducer (snapshots, tabs, unread,
whisper logging, transfers), tree building (ordering, spacers, filter),
`VoiceEngine` gating, tuim-audio framing, and the controller against
`FakeConnector`: per-UID volumes, whisper policy, whisper hold and lock, hold
keys with and without key releases, connection-info polling and its stop on
permission errors, downloads and uploads.

### App tests

`test/app.test.tsx` renders the whole `App` with ink-testing-library and the
demo connector, finds text on the screen and sends mouse events through
`MouseBus`: the welcome screen, the connect dialog, a client menu, and
double-click to join.

### tuim-audio

`cargo test` covers framing, the resampler and the playback buffer policy
(pre-buffer, skip-ahead, underrun). Capture and playback on real devices are
checked by hand: run tuimspeak, open Settings (F2), watch the level bar while
speaking, and press Test for a sound.

### End-to-end in a pseudo-terminal

`scripts/pty-drive.py` starts a command in a pty, renders it with the pyte VT
emulator, replays clicks, drags, wheel and keys, and prints the screen. It
reports which mouse modes were enabled and whether tracking was turned off at
exit (§5.4):

```sh
uv run --with pyte scripts/pty-drive.py 110 32 "bun run src/main.tsx --demo" -- \
  "wait 0.5" "rclick 10 7" "dump menu" "key \x1b" "press 12 13" "key \x1b[<32;8;15M" "release 8 14" "dump moved"
```

Coordinates are 0-based cells. A double-click must be sent as one action
(`dclick`), because a wait between the clicks exceeds the 400 ms window.

### Against a real server

Use a dev nickname, keep sessions short, and don't post into channels where
people are. Some servers refuse `serverconninfo`; that shows once as
"Insufficient permissions" and polling stops (§9.2).

## Conventions and pitfalls

- **Never center with flex.** `justifyContent`/`alignItems="center"` can put a
  box on a half cell, and Ink 8 then drops nested text. Center with
  whole-cell padding or absolute `left`/`top` (see `Welcome` and `Modal`).
- **zustand selectors must return stable values.** A selector that builds a
  new object or array on every call re-renders forever. Select fields
  separately.
- **Hit testing:** wrap interactive things in `<Box ref>` and
  `useMouseRegion`. Lists register one region and compute the row from
  `localY` (§6.3). Dialog regions use the `modal` layer, menus `overlay`.
- **Keyboard:** Ink calls every active `useInput` handler. Give each one an
  `isActive` that matches focus, and remember the global handler in
  `App.tsx` also sees the key. Don't bind Ctrl+M, Ctrl+I, Ctrl+H or Ctrl+J;
  legacy terminals send them as Enter, Tab, Backspace and newline.
- **Function keys** never reach `useInput`. Hold keys and F1/F2 come from the
  stdin tap (`controller.holdKeys()`, §6.2).
- **New connector command:** add the encoder to `connector/commands.ts`
  (scrub free text with `oneLine`, tab-separated fields with `noTabs`), a
  `Session` method, the event to `connector/protocol.ts` using `field()` so
  both spellings parse, the reducer case, a demo response in
  `src/demo/connector.ts`, and tests. Document it in §3.2/§3.3 first.
- **New setting:** add it to `Config`, `DEFAULT_CONFIG` and
  `normalizeConfig` in `config/config.ts`, to the Settings dialog if it is
  not edited elsewhere, and to configuration.md.
- **Secrets** (server passwords, privilege keys, identities) go to the
  connector through the environment, never argv (§3.1). Files holding them
  are written 0600.
- **stdout is the UI.** Log with `log.ts`; anything printed with
  `console.log` while Ink runs corrupts the screen.
- **The demo server** should answer every command the UI sends, so new
  dialogs can be tried without a server or admin rights.

## Continuous integration

`.github/workflows/release.yml` runs on pushes, tags and pull requests, for
linux-x64, linux-arm64, darwin-arm64 and windows-x64 (no free Intel macOS
runner exists any more): TypeScript
typecheck and tests, `cargo fmt`/`clippy -D warnings`/`test` for tuim-audio,
the native builds, the single executable for the matching Bun target, a smoke
run of `tuimspeak --version`, and a `.tar.gz` (`.zip` on Windows, with all
licenses) plus its SHA-256 as an artifact.

## Releasing

1. Bump `version` in `package.json` and commit.
2. Tag and push: `git tag v0.2.0 && git push origin v0.2.0`.
3. CI builds every platform and the `release` job publishes a GitHub release
   with all archives and checksums. It refuses a tag that does not match
   `package.json`.

The install scripts and the self-updater read `releases/latest` (§12.3,
§12.4), so a published release reaches users on their next start. Test the
scripts against a temporary `HOME` to keep your own install untouched:

```sh
HOME=$(mktemp -d) sh install.sh
```
