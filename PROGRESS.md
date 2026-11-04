# Cluster Terminal Public — progress

## Built (2026-10-29), from the private Cluster Terminal as of commit 5d340c0
- Portable: finds Claude Code (native installer or npm, including npm's Windows `.cmd` shim), Node.js (falls back to Electron's built-in Node) and Git Bash on Windows, Mac and Linux. On Mac/Linux it borrows the login shell's PATH. Stopping agents works on all three systems.
- Settings (`config.json`, created with defaults on first run) and sessions live in the app-data folder. The default project folder is `Documents/Cluster Terminal Projects`.
- First-run help in the chat: WELCOME, or SETUP NEEDED naming what's missing (Claude Code, or Git on Windows) with download links. It checks again on each send, so no restart is needed after installing.
- New chat commands: `/help`, `/settings` (opens config.json). The second clock shows the computer's own time zone instead of Central time.
- One copy at a time (opening it again focuses the running window). Mac gets an Edit menu for copy/paste and native window buttons. Links open in the browser. Startup errors show a message box instead of a hidden stuck app.
- Icon redrawn at 512 px (`icon.png` for Mac/Linux, `icon.ico` for Windows).
- Windows installer (`Cluster-Terminal-1.0.0-win-x64.exe`, about 80 MB, unsigned, with a choice of install folder and desktop/Start-menu shortcuts). GitHub Actions workflow builds Windows, Mac (.dmg, Apple-chip and Intel) and Linux (.AppImage, .deb) on version tags.
- README (requirements, install per system including the unsigned-app warnings, commands, cooperation features, usage/permission cautions, settings table, run from source), MIT LICENSE, demo screenshots with a made-up project path.
- Tested 2026-10-29: packaged app's screen in demo mode; real Haiku agent from the packaged app (task list, write, a guard block on a claimed file), both with Node.js and with the Electron-Node fallback; the setup-needed message when Claude Code is missing.

- Released 2026-10-29 as v1.0.0 (repo still private until the user makes it public): GitHub Actions built all five installers (Windows .exe, Mac .dmg for Apple chip and Intel, Linux .AppImage and .deb) and attached them to the release.

- v1.0.1 (2026-10-29), ported from the private copy (commits b9a694b, dff7870, 482c41e): operator messages interrupt the current turn; the shell guard matches a file name to its folder, so a same-named file elsewhere no longer blocks; each new message starts an empty task list. Guard tests (12) pass; task-list reset live-tested with Haiku. Code pushed; the `v1.0.1` tag (which builds the installers) is not made yet, so the release page still has 1.0.0.

- v1.1.0 (2026-10-29), orch mode ported from the private project (without its remote control point): `/orch` (alias `/focus`) replaces focus mode; ORCH agent with assign / rule / ledger / ownership tools, fresh worker sessions per job, owned-files-only editing, worker-to-worker messages and tickets; `/clearall`; agent boxes show code. Public's own behaviour kept (messages interrupt, folder-aware shell guard, fresh task list per message; ORCH keeps its list through hub notices). New settings `orchModel`, `orchResetAtTokens`. `node test-orch.js` 14/14 pass; demo screenshots of both modes checked; README screenshot now shows orch mode. Pushed; no `v1.1.0` tag yet.

- v1.2.0 (2026-11-04), brought up to date with the private Cluster Terminal (commits c756923 to 6d5c3dc) by a three-way merge that keeps Public's portable parts: load board and clean handoffs, work queue with task cards and plan check, timed critical path (est_minutes, longest chain first, early splits), live task list (propose_work, offer_split, mark_ready), stop tool, shared check queue (`checks.js`), HTTP guard hook, PDF-to-text (pdftotext from Git for Windows / poppler, Python pypdf fallback), lean agents and model tiers (`workerModel` sonnet), batched quiet ORCH, final integration check, `metrics.json`, `/stats`, windowed size that fits the screen and snaps (F11 full screen; still opens windowed, not full screen like the private copy). New settings are in DEFAULTS. `node test-orch.js` 36/36 pass; orch demo screenshot checked. Pushed; no `v1.2.0` tag yet (no installers built).

## Not tested yet
- Running the Mac and Linux builds (no Mac or Linux machine here). They build successfully but nobody has opened them yet.
