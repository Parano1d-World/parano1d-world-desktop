# Desktop on-device verifier (not bundled yet)

The desktop wallet can run the phones' native node program (`paramo1d`) for "Verify on this device"
(`desktop/main.js` → `p1w://wallet/local/verifier/*`). Until a signed build is placed here the route reports
`available: false` and the app keeps the node-checked labels.

To finish it (on the Windows rig and on the Mac):
1. Take `Vendor/paramo1d` from the pinned iOS source and apply `paramo1d-api.patch` (adds the `api` command:
   sync_once, transaction_status, receipt_check, peer_wallet_probe, payment_context (coins, empty slots, epoch anchor
   and fees from this device's verified view, address only) and broadcast_send (an already signed payment). Nothing in
   it sees a key or signs: the wallet plans, checks and signs in the window).
2. `cargo build --locked --release --bin paramo1d` (Rust 1.96+; Windows needs the MSVC build tools for libmdbx).
3. `python3 scripts/fetch-android-artifacts.py --output artifacts` (pinned mainnet parameters, SHA-256 checked).
4. Live-test against mainnet: `echo {"op":"sync_once",...} | paramo1d api`, then a known transaction and balance.
5. Sign the binary (W1), then bundle `paramo1d(.exe)` + `artifacts/` as `resources/verifier/` with SHA-256 pins in
   the installers.
