# Cluster Terminal

Six [Claude Code](https://claude.com/claude-code) agents, **C1–C6**, working side by side in one retro terminal window.

![Cluster Terminal in individual mode](docs/screenshot.png)

Give each agent its own job, or switch to **focus mode** and let C1 lead: it splits one big task into pieces, hands them to C2–C6 at the same time, then puts the results together. You can watch all of it live: every agent's task list and progress, the commands and code it's running, who's talking to whom, and how many tokens the cluster is using.

![Focus mode: C1 leading the other five](docs/screenshot-focus.png)

## What you need

1. **A Claude plan that includes Claude Code** (Pro, Max, Team or Enterprise), or an Anthropic API key.
2. **Claude Code**, installed and signed in. Follow the steps at <https://claude.com/claude-code>, then open a terminal, type `claude` and sign in once. After that you can close it.
3. **Windows only: [Git for Windows](https://git-scm.com/download/win).** Claude Code needs it on Windows.

Node.js is *not* required to use the installer.

## Install

Download the installer for your computer from the [Releases page](../../releases/latest):

| Computer | File | Notes |
|---|---|---|
| Windows 10/11 | `Cluster-Terminal-…-win-x64.exe` | Windows may say **"Windows protected your PC"** because the app isn't signed with a paid certificate. Click **More info → Run anyway**. |
| Mac (Apple chip) | `Cluster-Terminal-…-mac-arm64.dmg` | Open the .dmg and drag the app to Applications. The first time, **right-click the app → Open → Open**. If macOS says the app "is damaged", open Terminal and run `xattr -cr "/Applications/Cluster Terminal.app"`, then try again. |
| Mac (Intel) | `Cluster-Terminal-…-mac-x64.dmg` | Same as above. |
| Linux | `.AppImage` or `.deb` | AppImage: make it executable (`chmod +x`) and run it. Debian/Ubuntu: `sudo apt install ./Cluster-Terminal-…-linux-amd64.deb`. |

When it opens, the chat panel says either **WELCOME** (you're ready) or **SETUP NEEDED** with what's missing and where to get it.

> Windows is tested. The Mac and Linux builds are made automatically and should work, but they haven't been tested much yet. Please [open an issue](../../issues) if something's wrong.

## Using it

- **Pick an agent** by clicking its box, or press **Tab** / **Shift+Tab**. Type a task and press **Enter**.
- **Choose the project folder** the agents work in by clicking the `PROJECT ▸` line at the top. All six share it. The default is `Documents/Cluster Terminal Projects`.
- **Send a message any time.** If the agent is busy, it stops what it was doing and answers your new message right away (like pressing Esc in Claude Code).
- **HALT** stops the selected agent. Your next message picks up where it left off.
- Sessions, chat and task lists are saved, so they come back the next time you open the app.

### Commands (type them in the chat box)

| Command | What it does |
|---|---|
| `/help` | Show commands and keys |
| `/focus` | Focus mode: you talk only to C1, which splits the work across C2–C6 |
| `/individual` | Individual mode: each agent works on its own task |
| `/clear` | Give the selected agent a fresh session |
| `/demo` | Turn demo mode on/off (fake agents that use no Claude usage) |
| `/settings` | Open the settings file |

Switching modes clears every agent's session.

### How the agents cooperate

Each agent is a real Claude Code session with a few extra "cluster" tools:

- **Task lists**: agents post their plan and tick items off. That's what the progress bars show. Each new message starts a fresh list.
- **Asking for help**: an agent can hand part of its work to an idle agent and wait for the answer. The line between them lights up on the network map.
- **File claims**: when an agent edits a file, it's reserved until that agent's turn ends. Other agents' edits to it are refused, so two agents can't overwrite each other.
- **Watchdog**: when an agent's memory (context) gets full, it's compacted automatically between turns.

## Things to know before you use it

- **Six agents use your plan's limits about six times as fast as one.** Start small. A quick way to try it without using anything is `/demo`.
- **The agents act without asking.** By default they run in Claude Code's `auto` permission mode: they edit files and run commands in the project folder without stopping to ask you, and Claude Code's own safety checks still apply. Point them at a project folder you're happy for them to change, ideally one tracked with git so you can undo changes. You can change this in `/settings` (see below).
- **File claims are a safety net, not a guarantee.** They block edits through Claude Code's edit tools, plus shell commands that obviously write to a claimed file. A shell command that changes a file without naming it can slip through.

## Settings

`/settings` opens `config.json`. Restart the app after you save it.

| Setting | Default | Meaning |
|---|---|---|
| `model` | `""` | Claude model for all agents, e.g. `"sonnet"`, `"opus"` or `"haiku"`. Empty uses Claude Code's default. `"haiku"` is cheapest for trying things out. |
| `permissionMode` | `"auto"` | Claude Code permission mode. `"acceptEdits"` lets agents edit files but refuses shell commands. `"bypassPermissions"` allows everything with no checks (use only in a sandbox). If agents stop right away with an error about the permission mode, your plan may not offer `auto`: use `"acceptEdits"`. |
| `auth` | `"subscription"` | `"subscription"` uses your claude.ai sign-in and ignores any `ANTHROPIC_API_KEY` on the computer. `"api"` lets agents use the API key, billed per use. |
| `workspace` | `""` | Project folder. Easier to set by clicking `PROJECT ▸`. |
| `compactAtTokens` | `120000` | Context size at which the watchdog compacts an agent. |
| `maxHelpers` | `1` | How many helpers an agent may have at once. |
| `maxHelpersWhenInstructed` | `3` | Same, when you've explicitly told it to use more. |
| `maxChainDepth` | `3` | How long a chain of "A asks B asks C…" may get. |
| `helpTimeoutMinutes` | `60` | How long an agent waits for a helper's answer. |
| `theme` | `"cluster"` | Screen theme. Others are in `renderer/themes/` (`amber`, `green`, `severance`…). |

The settings file and saved sessions are kept in:
- Windows: `%APPDATA%\Cluster Terminal`
- Mac: `~/Library/Application Support/Cluster Terminal`
- Linux: `~/.config/Cluster Terminal`

## Run from source

You need [Node.js](https://nodejs.org) 20 or newer.

```sh
git clone https://github.com/coltonr100/Cluster-Terminal-Public.git
cd Cluster-Terminal-Public
npm install
npm start
```

Build an installer for your own computer with `npm run dist`. It goes into `dist/`. Pushing a tag such as `v1.0.1` makes GitHub Actions build all three platforms and attach them to a release.

For testing the screen without any usage: `CT_SNAP=shot.png npx electron .` starts demo mode, saves a screenshot and quits (add `CT_SNAP_FOCUS=1` for focus mode).

### Files

| File | What it is |
|---|---|
| `main.js` | The window |
| `orchestrator.js` | Runs the six Claude Code processes, the hub their tools talk to, file claims, the watchdog and the modes |
| `mcp-bridge.js` | The agents' cluster tools (a small MCP server) |
| `hook-guard.js` | The hook that refuses edits to files another agent has claimed |
| `demo.js` | Demo mode's fake agents |
| `renderer/` | The screen |

## License

[MIT](LICENSE). Not made by or affiliated with Anthropic. "Claude" and "Claude Code" are Anthropic's trademarks.
