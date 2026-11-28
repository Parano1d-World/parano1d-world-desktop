#!/bin/sh
# Sign, notarize and staple the Mac builds, then make a signed, notarized .dmg for each (W1). Run on the Mac.
#   sh desktop/release/sign-mac.sh dist-desktop/<version>
# Needs: a "Developer ID Application" certificate in the login keychain, and a notary profile saved once with
#   xcrun notarytool store-credentials parano1d-notary   (you type the Apple ID / app-specific password there).
# Nothing secret is read from or written to this folder.
set -eu
DIR=${1:?usage: sign-mac.sh dist-desktop/<version>}; HERE=$(cd "$(dirname "$0")" && pwd); PROFILE=${P1W_NOTARY_PROFILE:-parano1d-notary}
ID=$(security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -1)
[ -n "$ID" ] || { echo "No Developer ID Application certificate in the keychain."; exit 1; }
echo "Signing as: $ID"
for Z in "$DIR"/Parano1d-World-Wallet-*-mac-*.zip; do
  W=$(mktemp -d); ditto -x -k "$Z" "$W"; A="$W/Parano1d World Wallet.app"
  # Inside out: helpers and frameworks first, then the app, all with the hardened runtime and a secure timestamp.
  find "$A/Contents/Frameworks" \( -name "*.dylib" -o -name "*.so" -o -name "*.node" \) -type f -exec codesign --force --timestamp --options runtime --sign "$ID" {} \;
  # Standalone executables inside the frameworks first (Apple rejects notarization otherwise): crashpad, the app shim, Squirrel's ShipIt.
  find "$A/Contents/Frameworks" -type f \( -name chrome_crashpad_handler -o -name app_shim_loader -o -name ShipIt \) -exec codesign --force --timestamp --options runtime --sign "$ID" {} \;
  for X in "$A"/Contents/Frameworks/*.framework "$A"/Contents/Frameworks/*.app; do codesign --force --timestamp --options runtime --entitlements "$HERE/entitlements.plist" --sign "$ID" "$X"; done
  codesign --force --timestamp --options runtime --entitlements "$HERE/entitlements.plist" --sign "$ID" "$A"
  codesign --verify --deep --strict --verbose=2 "$A"
  B=$(basename "$Z" .zip); DMG="$DIR/$B.dmg"; rm -f "$DMG"
  # Drag-to-install window: the app next to an Applications shortcut.
  S="$W/dmg"; mkdir -p "$S"; ditto "$A" "$S/Parano1d World Wallet.app"; ln -s /Applications "$S/Applications"
  hdiutil create -volname "Parano1d World Wallet" -srcfolder "$S" -ov -format UDZO "$DMG"
  codesign --force --timestamp --sign "$ID" "$DMG"
  xcrun notarytool submit "$DMG" --keychain-profile "$PROFILE" --wait
  xcrun stapler staple "$DMG"; xcrun stapler validate "$DMG"
  spctl -a -t open --context context:primary-signature -v "$DMG"
  rm -f "$Z"; rm -rf "$W"; echo "Ready: $DMG"
done
node "$HERE/package-release.mjs" --sums "$DIR"
