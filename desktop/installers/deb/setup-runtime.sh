#!/bin/sh
# Parano1d World Desktop Wallet (.deb): puts the official Electron runtime in place, as root, from the package's postinst.
# Downloads Electron __ELECTRON_VERSION__ from GitHub, checks the SHA-256 pinned below, adds the wallet app shipped in this
# package (checked again here), locks the runtime down (Electron fuses) and sets up Chromium's sandbox helper.
# The new copy is built and checked first, then swapped in; if anything fails the previous copy stays.
# Repair or re-run by hand: sudo /usr/lib/parano1d-world-wallet/setup-runtime.sh
# Nothing here needs, asks for or touches a wallet key.
set -eu
EV='__ELECTRON_VERSION__'
ASAR_SHA='__APP_ASAR_SHA__'
ICON_SHA='__ICON_SHA__'
LIB=/usr/lib/parano1d-world-wallet
DEST=/opt/parano1d-world-wallet
say() { printf '  %s\n' "$1"; }
fail() { printf '\n  Parano1d World Wallet setup stopped: %s\n  Connect to the internet and run: sudo dpkg --configure -a\n' "$1" >&2; exit 1; }
sha() { sha256sum "$1" | cut -d' ' -f1; }
case "$(dpkg --print-architecture 2>/dev/null || uname -m)" in
  amd64|x86_64) PIN='__SHA_LINUX_X64__'; ARCH=x64 ;;
  arm64|aarch64) PIN='__SHA_LINUX_ARM64__'; ARCH=arm64 ;;
  *) fail 'this computer type is not supported (x64 and ARM64 only).' ;;
esac
[ "$(sha "$LIB/app.asar")" = "$ASAR_SHA" ] || fail 'the wallet app does not match its checksum.'
[ "$(sha "$LIB/icon.png")" = "$ICON_SHA" ] || fail 'the icon does not match its checksum.'
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
say "Downloading the official Electron $EV runtime (linux-$ARCH) from GitHub..."
if [ -n "${P1W_TEST_ELECTRON_ZIP:-}" ]; then cp "$P1W_TEST_ELECTRON_ZIP" "$T/e.zip"; else curl -fsSL --proto '=https' --tlsv1.2 -o "$T/e.zip" "https://github.com/electron/electron/releases/download/v$EV/electron-v$EV-linux-$ARCH.zip" || fail 'the runtime could not be downloaded.'; fi
[ "$(sha "$T/e.zip")" = "$PIN" ] || fail 'the runtime does not match its pinned checksum. Nothing was installed.'
__FUSES__
unzip -q "$T/e.zip" -d "$T/x"
rm -f "$T/x/resources/default_app.asar"; cp "$LIB/app.asar" "$T/x/resources/app.asar"; cp "$LIB/icon.png" "$T/x/icon.png"
mv "$T/x/electron" "$T/x/parano1d-world-wallet"
fuses "$T/x/parano1d-world-wallet" 0
chown -R root:root "$T/x"; chmod -R go-w "$T/x"; chmod 4755 "$T/x/chrome-sandbox"
mkdir -p /opt; rm -rf "$DEST.new"; mv "$T/x" "$DEST.new"
[ -d "$DEST" ] && mv "$DEST" "$DEST.old"
if ! mv "$DEST.new" "$DEST"; then [ -d "$DEST.old" ] && mv "$DEST.old" "$DEST"; fail 'could not put the new version in place; the previous one was kept.'; fi
rm -rf "$DEST.old"
say 'Parano1d World Wallet is installed. Open it from your applications menu.'
