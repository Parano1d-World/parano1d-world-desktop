# Parano1d World Desktop Wallet

The Parano1d World wallet as a desktop app for Windows, macOS and Linux. Published by KoAjent LLC for review and audit.

## How it is locked down
- **No remote code.** The app runs the same tested website build, bundled inside it, from a private `p1w://wallet`
  address. Only `/api/*` requests go out, to parano1dworld.com, through the app itself (with the
  `x-p1w-client: parano1d-world-desktop` header).
- **Sandboxed window:** context isolation, no Node.js, no direct network access, no navigation away, no new windows,
  downloads, web views or device permissions (`desktop/main.js`).
- **Locked runtime:** the official Electron build, checked against pinned SHA-256 values, with its fuses set: no
  "run as Node", no `NODE_OPTIONS` or `--inspect`, app.asar only, encrypted cookies, no extra file:// rights
  (and asar integrity checking on macOS). Debugging switches are refused.
- **Safe updates:** the new copy is checked first and swapped in; if anything fails, the previous one is restored.
  Wallet data is kept.

## Layout
| Path | What |
|---|---|
| `desktop/main.js`, `desktop/package.json` | The app: protocol handler, API proxy, window and permission lockdown |
| `desktop/installers/` | `Install.cmd` / `Install.ps1` / `Uninstall.ps1` (Windows) and `install.sh` (macOS, Linux) |
| `desktop/release/` | Signed release packaging: fuses before signing, macOS notarization, Windows Authenticode, SHA256SUMS |
| `tools/build-desktop.mjs` | Builds the app package and installers from the website release |
| `tests/desktop.e2e.mjs` | End-to-end test of the real app and its locked-down installed form (runs inside the full website build, which provides the site and a test node) |

Downloads and checksums: https://parano1dworld.com/desktop-wallet. Security: see `SECURITY.md`.
