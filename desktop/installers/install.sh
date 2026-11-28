#!/bin/sh
# Parano1d World Desktop Wallet - macOS and Linux installer.
#   Download this file, check its SHA-256 against parano1dworld.com/downloads/desktop/SHA256SUMS, then: sh install.sh
# Downloads the official Electron runtime from GitHub and the wallet app from parano1dworld.com, checks both
# SHA-256 values pinned below, locks the runtime down (Electron fuses), and installs for this user only.
# Updating: run it again. Uninstalling: sh install.sh --uninstall
# The new copy is built and checked first, then swapped in; your wallet
# data is kept. Nothing here needs, asks for or touches a wallet key.
set -eu
EV='__ELECTRON_VERSION__'
SITE='__SITE__'
ASAR_SHA='__APP_ASAR_SHA__'
ICON_SHA='__ICON_SHA__'
APP='Parano1d World Wallet'
say() { printf '  %s\n' "$1"; }
fail() { printf '\n  Installation stopped: %s\n' "$1" >&2; exit 1; }
sha() { if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1; else sha256sum "$1" | cut -d' ' -f1; fi; }
get() { curl -fsSL --proto '=https' --tlsv1.2 -o "$2" "$1" || fail "download failed: $1"; }
need() { command -v "$1" >/dev/null 2>&1 || fail "'$1' is required."; }
# Uninstall: sh install.sh --uninstall
# Removes the app, its menu entry and command. Your encrypted wallet data is kept (add --remove-wallet-data to erase it,
# only after backing up your master key).
if [ "${1:-}" = "--uninstall" ]; then
  if [ "$(uname -s)" = Darwin ]; then
    pkill -f "$HOME/Applications/$APP.app/Contents/MacOS/" 2>/dev/null || true; rm -rf "$HOME/Applications/$APP.app"
    D="$HOME/Library/Application Support/$APP"
  else
    pkill -f "$HOME/.local/opt/parano1d-world-wallet/parano1d-world-wallet" 2>/dev/null || true
    rm -rf "$HOME/.local/opt/parano1d-world-wallet" "$HOME/.local/share/applications/parano1d-world-wallet.desktop" "$HOME/.local/bin/parano1d-world-wallet"
    D="${XDG_CONFIG_HOME:-$HOME/.config}/$APP"
  fi
  if [ "${2:-}" = "--remove-wallet-data" ]; then rm -rf "$D"; say 'Wallet data on this computer removed.'; elif [ -d "$D" ]; then say "Your encrypted wallet data was kept in $D (reinstalling opens it again)."; fi
  say 'Parano1d World Wallet removed.'; exit 0
fi
need curl; need perl; need unzip
OS=$(uname -s); M=$(uname -m)
case "$M" in x86_64|amd64) ARCH=x64 ;; arm64|aarch64) ARCH=arm64 ;; *) fail "unsupported processor: $M" ;; esac
case "$OS-$ARCH" in
  Darwin-arm64) PIN='__SHA_MAC_ARM64__'; PLAT=darwin ;;
  Darwin-x64) PIN='__SHA_MAC_X64__'; PLAT=darwin ;;
  Linux-x64) PIN='__SHA_LINUX_X64__'; PLAT=linux ;;
  Linux-arm64) PIN='__SHA_LINUX_ARM64__'; PLAT=linux ;;
  *) fail "unsupported system: $OS $M (Windows: use the Windows download)" ;;
esac
printf '\n  Parano1d World Desktop Wallet\n\n'
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
say "Downloading the official Electron $EV runtime ($PLAT-$ARCH) from GitHub..."
if [ -n "${P1W_TEST_ELECTRON_ZIP:-}" ]; then cp "$P1W_TEST_ELECTRON_ZIP" "$T/e.zip"; else get "https://github.com/electron/electron/releases/download/v$EV/electron-v$EV-$PLAT-$ARCH.zip" "$T/e.zip"; fi   # test hook: still checked against the pinned SHA-256 below
[ "$(sha "$T/e.zip")" = "$PIN" ] || fail 'the runtime does not match its pinned checksum. Nothing was installed.'
say 'Downloading the wallet app from parano1dworld.com...'
get "$SITE/downloads/desktop/app.asar" "$T/app.asar"; get "$SITE/downloads/desktop/icon.png" "$T/icon.png"
[ "$(sha "$T/app.asar")" = "$ASAR_SHA" ] || fail 'the wallet app does not match its published checksum. Nothing was installed.'
[ "$(sha "$T/icon.png")" = "$ICON_SHA" ] || fail 'the icon does not match its published checksum. Nothing was installed.'

# Flip the runtime's security fuses: no Node.js mode, ignore NODE_OPTIONS and --inspect, load only app.asar,
# encrypted cookies, no extra file:// privileges (and on macOS, verify app.asar's integrity at start).
fuses() { perl -e '
  my ($f, $asarCheck) = @ARGV; open(my $h, "+<:raw", $f) or die "open"; local $/; my $d = <$h>;
  my $i = index($d, "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX"); die "no fuse wire\n" if $i < 0;
  my $w = $i + 32; die "bad fuse version\n" if ord(substr($d, $w, 1)) != 1; my $n = ord(substr($d, $w + 1, 1));
  my %set = (0 => "0", 1 => "1", 2 => "0", 3 => "0", 5 => "1", 7 => "0"); $set{4} = "1" if $asarCheck;
  for my $k (keys %set) { next if $k >= $n; next if substr($d, $w + 2 + $k, 1) eq "r"; substr($d, $w + 2 + $k, 1) = $set{$k}; }
  seek($h, 0, 0); print $h $d; close $h;' "$1" "$2" || fail 'could not lock the runtime down. Nothing was installed.'; }

if [ "$PLAT" = darwin ]; then
  need ditto; need codesign; need plutil
  ditto -x -k "$T/e.zip" "$T/x"
  A="$T/x/$APP.app"; mv "$T/x/Electron.app" "$A"
  R="$A/Contents/Resources"; rm -f "$R/default_app.asar"; cp "$T/app.asar" "$R/app.asar"
  get "$SITE/downloads/desktop/icon.icns" "$R/electron.icns"
  [ "$(sha "$R/electron.icns")" = '__ICNS_SHA__' ] || fail 'the app icon does not match its checksum.'
  P="$A/Contents/Info.plist"
  plutil -replace CFBundleName -string "$APP" "$P"; plutil -replace CFBundleDisplayName -string "$APP" "$P"
  plutil -replace CFBundleIdentifier -string 'com.parano1dworld.wallet' "$P"; plutil -replace CFBundleShortVersionString -string '__APP_VERSION__' "$P"
  plutil -replace ElectronAsarIntegrity -json '{"Resources/app.asar":{"algorithm":"SHA256","hash":"__ASAR_HEADER_SHA__"}}' "$P"
  fuses "$A/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework" 1
  codesign --force --deep --sign - "$A" >/dev/null 2>&1 || fail 'could not sign the app on this Mac.'
  DEST="$HOME/Applications"; mkdir -p "$DEST"
  pkill -f "$DEST/$APP.app/Contents/MacOS/" 2>/dev/null || true
  [ -d "$DEST/$APP.app" ] && mv "$DEST/$APP.app" "$T/previous.app"
  if ! mv "$A" "$DEST/$APP.app"; then [ -d "$T/previous.app" ] && mv "$T/previous.app" "$DEST/$APP.app"; fail 'could not put the new version in place; the previous one was restored.'; fi
  say "Installed in $DEST. Open \"$APP\" from Launchpad or that folder."
  open "$DEST/$APP.app" 2>/dev/null || true
else
  unzip -q "$T/e.zip" -d "$T/x"
  rm -f "$T/x/resources/default_app.asar"; cp "$T/app.asar" "$T/x/resources/app.asar"; cp "$T/icon.png" "$T/x/icon.png"
  mv "$T/x/electron" "$T/x/parano1d-world-wallet"
  fuses "$T/x/parano1d-world-wallet" 0
  DEST="$HOME/.local/opt/parano1d-world-wallet"; mkdir -p "$HOME/.local/opt" "$HOME/.local/share/applications" "$HOME/.local/bin"
  pkill -f "$DEST/parano1d-world-wallet" 2>/dev/null || true
  [ -d "$DEST" ] && mv "$DEST" "$T/previous"
  if ! mv "$T/x" "$DEST"; then [ -d "$T/previous" ] && mv "$T/previous" "$DEST"; fail 'could not put the new version in place; the previous one was restored.'; fi
  # Chromium's sandbox needs unprivileged user namespaces, or a root-owned setuid helper.
  if ! unshare -Ur true 2>/dev/null; then
    say 'This system blocks unprivileged sandboxing; setting up the sandbox helper needs your password once (sudo).'
    sudo chown root:root "$DEST/chrome-sandbox" && sudo chmod 4755 "$DEST/chrome-sandbox" || fail 'the sandbox helper could not be set up.'
  fi
  cat > "$HOME/.local/share/applications/parano1d-world-wallet.desktop" <<DESK
[Desktop Entry]
Type=Application
Name=$APP
Comment=Parano1d World Desktop Wallet
Exec="$DEST/parano1d-world-wallet" %U
Icon=$DEST/icon.png
Terminal=false
Categories=Finance;Network;
StartupWMClass=Parano1d World Wallet
DESK
  ln -sf "$DEST/parano1d-world-wallet" "$HOME/.local/bin/parano1d-world-wallet"
  say "Installed. Open \"$APP\" from your applications menu (or run parano1d-world-wallet)."
fi
say 'Your wallet stays on this computer, encrypted with your password. Back up your master key.'
