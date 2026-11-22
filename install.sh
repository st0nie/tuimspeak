#!/bin/sh
# tuimspeak installer for macOS and Linux (docs/tuimspeak-architecture.md §12.3).
#
#   curl -fsSL https://raw.githubusercontent.com/st0nie/tuimspeak/main/install.sh | sh
#
# Installs the latest release (or $TUIMSPEAK_VERSION) into
# ${XDG_DATA_HOME:-~/.local/share}/tuimspeak/versions/<version>/ and points
# ~/.local/bin/tuimspeak at it. Running it again updates; tuimspeak also
# updates itself (§12.4). $TUIMSPEAK_REPO selects another repository.
set -eu

REPO="${TUIMSPEAK_REPO:-st0nie/tuimspeak}"
VERSION="${TUIMSPEAK_VERSION:-}"

say() { printf '%s\n' "$*"; }
die() { printf 'tuimspeak install: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required but not installed"; }

need curl
need tar
need uname

os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) die "unsupported system: $os (on Windows, use install.ps1)" ;;
esac
case "$arch" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) die "unsupported CPU: $arch" ;;
esac
# An x86 shell under Rosetta on Apple Silicon still gets the native build.
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  arch=arm64
fi
platform="$os-$arch"
asset="tuimspeak-$platform.tar.gz"

if [ -z "$VERSION" ]; then
  VERSION=$(curl -fsSL -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$REPO/releases/latest" |
    sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)
  [ -n "$VERSION" ] || die "could not find the latest release of $REPO"
fi
VERSION=${VERSION#v}

data="${XDG_DATA_HOME:-$HOME/.local/share}/tuimspeak"
versions="$data/versions"
target="$versions/$VERSION"
bindir="$HOME/.local/bin"
launcher="$bindir/tuimspeak"

if [ -x "$target/tuimspeak" ] && [ "$(readlink "$launcher" 2>/dev/null || true)" = "$target/tuimspeak" ]; then
  say "tuimspeak $VERSION is already installed and current."
  exit 0
fi

url="https://github.com/$REPO/releases/download/v$VERSION/$asset"
tmp=$(mktemp -d "${TMPDIR:-/tmp}/tuimspeak.XXXXXX")
trap 'rm -rf "$tmp"' EXIT INT TERM

say "Downloading tuimspeak $VERSION for $platform..."
curl -fSL --progress-bar -o "$tmp/$asset" "$url"
curl -fsSL -o "$tmp/$asset.sha256" "$url.sha256"

expected=$(cut -d ' ' -f 1 <"$tmp/$asset.sha256" | tr 'A-F' 'a-f')
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp/$asset" | cut -d ' ' -f 1)
else
  actual=$(shasum -a 256 "$tmp/$asset" | cut -d ' ' -f 1)
fi
[ -n "$expected" ] && [ "$expected" = "$actual" ] || die "checksum mismatch for $asset"

mkdir -p "$versions" "$bindir"
# Unpack next to the versions so the final move is a rename on one filesystem.
work="$versions/.tmp-$$"
rm -rf "$work"
mkdir -p "$work"
tar -xzf "$tmp/$asset" -C "$work"
[ -x "$work/tuimspeak-$platform/tuimspeak" ] || die "the archive does not contain tuimspeak"
rm -rf "$target"
mv "$work/tuimspeak-$platform" "$target"
rm -rf "$work"

# Switch the launcher atomically: a new symlink renamed over the old one.
ln -sfn "$target/tuimspeak" "$launcher.tmp-$$"
mv -f "$launcher.tmp-$$" "$launcher"

# Keep only the version just installed (a running older copy keeps working; its files stay open).
for dir in "$versions"/*; do
  [ -d "$dir" ] && [ "$dir" != "$target" ] && rm -rf "$dir"
done

say "Installed tuimspeak $VERSION to $target"
case ":$PATH:" in
  *":$bindir:"*) say "Run: tuimspeak" ;;
  *)
    say ""
    say "$bindir is not on your PATH. Add it, then open a new terminal:"
    case "${SHELL:-}" in
      */zsh) say "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc" ;;
      */fish) say "  fish_add_path ~/.local/bin" ;;
      *) say "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc" ;;
    esac
    ;;
esac
