# Cluster Terminal Public — project rules

- The public, anyone-can-use version of the private Cluster Terminal project (started 2026-10-29). Same app; it must work on any computer: no personal names, paths or details anywhere, including screenshots.
- GitHub: `coltonr100/Cluster-Terminal-Public` (branch `main`), linked by git. Sync with git commit/push. Don't change the private project or its repo from here; the user decides what moves between them.
- Settings and saved sessions live in the app-data folder (`%APPDATA%\Cluster Terminal`), not the app folder. Defaults are in `orchestrator.js` `DEFAULTS`. `CT_DATA=<folder>` points a test run at a scratch folder: always use it when testing so the user's own settings aren't touched.
- `mcp-bridge.js` and `hook-guard.js` are run by outside programs, so they're unpacked from app.asar (`asarUnpack` in package.json). Keep it that way if adding files they load.
- Build the Windows installer: `npm run dist:win` → `dist/`. Mac and Linux are built by GitHub Actions (`.github/workflows/release.yml`) when a `v*` tag is pushed, and attached to a release.
- On Windows without admin rights or Developer Mode, electron-builder's `winCodeSign` download fails to unpack (it contains Mac symlinks). Fix: extract the downloaded .7z yourself, skipping `*.dylib`, into `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0`.
- Look and controls follow the private project's rules: `renderer/themes/cluster.css`, no glows, gradients, icons or extra font sizes, chat commands instead of buttons.
- `dist/`, `node_modules/`, `runtime/`, `workspace/` are not uploaded.
