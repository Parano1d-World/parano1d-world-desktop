# Desktop Wallet: signed releases (W1)

Signed builds replace the "assemble on the user's computer" installers once the signing certificates exist.

1. **Package** (any machine with Node.js): `node desktop/release/package-release.mjs`
   - Assembles each platform from the pinned official Electron download (SHA-256 checked), adds `app.asar` and flips
     the security fuses, then writes `dist-desktop/<version>/`:
     - `Parano1d-World-Wallet-<v>-windows-x64.zip`, `...-windows-arm64.zip` (app folder, exe to be signed)
     - `Parano1d-World-Wallet-<v>-mac-arm64.zip`, `...-mac-x64.zip` (unsigned `.app`, to be signed on the Mac)
     - `parano1d-world-wallet-<v>-linux-x64.tar.gz`, `...-linux-arm64.tar.gz`
   - Fuses are flipped **before** signing (signing afterwards seals them).
2. **Sign on the Mac** (Developer ID Application certificate in the login keychain; notary profile saved once with
   `xcrun notarytool store-credentials parano1d-notary`): `sh desktop/release/sign-mac.sh dist-desktop/<v>`
   - hardened runtime + `entitlements.plist`, notarize (`notarytool submit --wait`), staple, signed + notarized `.dmg`.
3. **Sign for Windows** (Azure Trusted Signing or an OV/EV certificate, on the Windows PC):
   `powershell -File desktop/release/sign-windows.ps1 -Dir dist-desktop/<v>` (signs and timestamps the exe and DLLs).
4. **Checksums:** `node desktop/release/package-release.mjs --sums dist-desktop/<v>` writes `SHA256SUMS` for the final
   signed files. Publish them with the files on the GitHub repo's Releases page and on the download page.

Signing keys and the notary credentials stay in the owner's keychain / password manager. They never go in the repo,
chat, logs or the website build.
