# Rust Inside core template

Copy this directory into a new Rust repository, change the package name in `Cargo.toml`, and run `cargo check`.

- `src/client/` holds code that SDKs run in the client. Add a platform submodule such as `src/client/ios.rs` when you need it.
- `src/server/` holds server logic.
- `src/common/` holds code used on both sides.
- `src/api.rs` exposes the functions named in `rust-inside.json`.

This example uses `exports` to send `format_handle` to the app and web SDKs and `same_handle` to the server SDK. Both functions normalize handles with the same helper. Add your SDK repositories to `repositories` when you are ready to publish.
