---
sidebar_position: 3
title: "Allr App"
description: "The Allr app — one Tauri codebase for Linux, macOS, Windows, Android and iOS. Chat, files, artifacts, terminal, git review, voice, profiles and settings, against a local or remote Allr gateway."
---

# Allr App

The Allr app is the graphical front end for the **same** agent you get from the CLI and the gateway — same config, same API keys, same sessions, same skills, same memory. It is not a separate product or a lightweight clone; it drives the Allr core through a purpose-built UI. If you have used `allr` in a terminal, everything you set up there is already here, and anything you do here shows up there.

It is built with **Tauri v2** from one codebase and ships for **Linux, macOS, Windows, Android and iOS** (`apps/hermes-universal/` in the repo).

:::tip Which interface is which?
Allr has several front ends that all talk to the same agent:

- **Allr app** (this page) — the native application, on desktop and phone.
- **CLI** (`allr`) and **[TUI](./tui.md)** (`allr --tui`) — terminal interfaces.
- **[Web Dashboard](./features/web-dashboard.md)** (`allr dashboard`) — a browser admin panel; its optional **Chat** tab embeds the TUI through a pseudo-terminal.

Pick whichever fits the moment. They share state, so you can start a session in one and resume it in another.
:::

## Install

Follow the [installation instructions](../getting-started/installation.md) for your platform. On a phone the app is the only front end — a phone cannot host a gateway, so it always connects to one somewhere else (see [Connecting to a gateway](#connecting-to-a-gateway)).

To run it from a checkout instead, see [Building from source](#building-from-source).

## What's in the app

The app is organized as a chat-first window with a left sidebar for navigation. It's built to allow managing multiple simultaneous agent conversations, configuring messaging providers, creating artifacts, browsing projects' folder structures, and working on multiple projects at once.

### Chat

The center of the app. You get:

- **Streaming responses** with live tool activity and structured tool-call summaries as the agent works.
- **The same conversation history** as every other Allr surface — sessions started here resume in the CLI/TUI and vice versa.
- **Drag-and-drop files** anywhere in the chat area to attach them to your next message.
- **A right-hand preview rail** — render web pages, files, and tool outputs side by side while you keep chatting.
- **Composer history and queue editing** — press the up/down arrow keys in an empty composer to recall and reuse previous prompts, and edit messages you've queued up before they're sent. Pressing Stop (or Esc) while turns are queued pauses the queue and expands it above the composer; resume it from there, or send, edit, and delete individual entries.
- **A conversation timeline rail** — long chats get a slim rail of markers along the edge of the transcript, one per prompt. Hover it to pop open the list of prompts, click one to jump straight to that point in the conversation. (It appears once the chat has a handful of turns.)
- **Find in page** — press **Cmd/Ctrl+F** to open a find bar that searches the rendered chat transcript. Enter / Shift+Enter (or Cmd/Ctrl+G / Cmd/Ctrl+Shift+G while the bar is open) step through matches; Esc closes it.

#### Status bar

The bar along the bottom of the chat shows live session state and exposes quick controls without opening Settings:

- **Per-session YOLO toggle** — flip YOLO on or off for just this session (matching the TUI). YOLO bypasses the dangerous-command approval prompts, so know what you're turning off — see [Security → YOLO Mode](./security.md#yolo-mode).
- **Context-usage meter** — a live "% full" meter of the session's context window. Click it to open the **Context Usage** popover with a token breakdown by category (system prompt, tool definitions, skills, memory, rules, MCP, subagent definitions, and the conversation itself) so you can see exactly what's eating the window before compression kicks in.
- **Customizable items** — right-click the status bar (**Show in status bar**) to choose what appears: the context meter, workspace, model, approvals, turn/session timers, terminal, Command Center, backend version, and more — or hide the bar entirely (**Cmd/Ctrl+Shift+S** toggles it).

Chatting against an Allr gateway on another machine? See [Connecting to a gateway](#connecting-to-a-gateway) below — and for the full picture of how the remote-hosted dashboard connection works (the auth gate, the `/api/ws` chat socket, and WebSocket close-code triage), see [Web Dashboard → Connecting Allr Desktop to a remote backend](./features/web-dashboard.md#connecting-allr-desktop-to-a-remote-backend).

#### Repository discovery

Allr discovers local Git repositories for the Projects sidebar by scanning your home directory to a bounded depth. You can change this per profile in **Settings → Workspace**, or in `config.yaml`:

```yaml
desktop:
  repo_scan_enabled: true
  repo_scan_roots: []
  repo_scan_exclude_paths: []
```

- Set `repo_scan_enabled: false` to stop the filesystem scan completely. Existing disk-discovery cache rows for that profile are cleared; explicit projects and repositories inferred from intentional Allr sessions remain available.
- Set `repo_scan_roots` to a list of folders to restrict scanning. An empty list preserves the default home-directory scan.
- Set `repo_scan_exclude_paths` to folders whose complete subtrees should be skipped.

Changing any of these values invalidates only that profile's disk-discovery cache and starts a policy-compliant refresh. **Hide from sidebar** remains a separate per-item curation action.

#### Choosing a model

The model picker lives in the **composer**, just left of the microphone. Click it to switch the model, reasoning effort, and fast mode from one dropdown.

- **The composer picker is sticky UI state and never touches your default.** It's remembered locally (per device) and **follows** across new chats and restarts instead of snapping back to the default — pick a model once and the next `Cmd/Ctrl+N` opens on it. With a live chat, switching models scopes the change to that **current chat**; either way the selection rides along when the session is created/switched and is **never** written to the profile default. (Switching [profiles](#sessions--profiles) reseeds to that profile's own default.)
- **Set the default in Settings → Model.** That "main" model is your **per-profile global default** — it's what new chats, crons, subagents, and auxiliary tasks start from, and it's the only place that writes it. Each [profile](#sessions--profiles) keeps its own default.
- **Per-model effort/fast presets.** Each model remembers its own reasoning effort and fast-mode choice in the app, re-applied to the session whenever you pick that model. These presets are an app convenience and don't change crons or subagents.
- **Mid-chat switches reset the prompt cache.** Switching the model inside a live chat means the next message re-reads the whole conversation at full input price (provider prompt caches are keyed to the model). Fine occasionally; on a long chat, a fresh chat on the new model is often cheaper than bouncing back and forth.

### File browser

Explore and preview the working directory without leaving the app — useful for following along as the agent reads, writes, and edits files. Pick the project a session runs in from the Projects list in the left sidebar.

### Artifacts

The **Artifacts** view collects what your sessions generate — **images, files, and links** — into one searchable, browsable gallery. Open it from the sidebar, the command palette (**Artifacts — Browse generated outputs**), or a `nav.artifacts` shortcut you bind yourself. It indexes recent session outputs automatically; every artifact shows which session produced it with a jump back to that chat, and images and files open in a preview with download / open-in-browser / copy actions.

### Windows, tabs & panes

The app is built for working on several things at once:

- **Tabs** — **Cmd/Ctrl+T** opens a new session tab; **Ctrl+Tab** / **Ctrl+Shift+Tab** cycle sessions. **Cmd/Ctrl+W** closes the focused tab and **Cmd/Ctrl+Shift+T** reopens the last closed one.
- **Multiple windows** — **Cmd/Ctrl+Shift+N** opens a new window, and any session can be popped out via its context menu (**New window**) or from the command palette. A popped-out window renders that single chat without the global sidebar — handy for parking a long-running session on another monitor. Live agent output streams into every window showing the session.
- **Panes** — **Cmd/Ctrl+B** toggles the left sidebar, **Cmd/Ctrl+J** the right one, and **Cmd/Ctrl+\\** swaps which side the sidebars sit on.

### Terminal

A real terminal lives in the right sidebar, next to the file browser:

- **Ctrl+`** shows the terminal (opening one if none exist); **Ctrl+Shift+`** spawns an additional one. Multiple terminals stack in a tab rail — **Ctrl+Shift+↓/↑** walk between them, **Ctrl+Shift+W** closes the active one.

### Git review & worktrees

For sessions running inside a Git repository, the app has a built-in source-control surface:

- **Review pane** — **Cmd/Ctrl+G** toggles the working-tree review pane: branch and ahead/behind status, changed files (list or tree view), and working-tree diffs. Stage/unstage files, revert changes, write a commit message (or **Generate commit message**), then **Commit** or **Commit & Push** — and **Create PR**, which the gateway opens for you, or hand the whole thing to the agent with **Ask Allr to open PR**. You can also create and switch branches from here.
- **Worktrees** — **Cmd/Ctrl+Shift+B** (or **New worktree** on a project in the sidebar) creates a Git worktree on a new branch so an agent can work on a parallel copy of the repo without touching your checkout. Worktrees show up as their own lanes under the project; removing one offers to delete the worktree directory (the branch stays) or just hide the lane and leave it on disk, with a force option when it has uncommitted changes.

### Memory Graph

The **Memory Graph** (command palette → *Memory Graph*, or the status-bar item) is an interactive map of what Allr has learned for you — skills and memories laid out as a zoomable node graph with a timeline, filterable by **All / Used / Learned**. A share control exports the map layout as a compact code you can paste to someone else (layout only — none of your memory or skill text is included) and imports codes the same way.

### Quick Entry

Quick Entry is a small always-available composer summoned by a **global hotkey from anywhere on your system** — fire off a prompt without switching to (or even opening) the main window. Enable it in **Settings → Advanced → Quick Entry**. It ships with no shortcut bound, so pick your own chord there (it needs at least one modifier); if another app already owns it, the settings row tells you so you can pick a different one.

### Voice

Talk to Allr and hear it back, the same [voice mode](./features/voice-mode.md) available elsewhere. On macOS the OS will prompt once for microphone access.

### Settings & onboarding

Manage providers, models, tools, and credentials from a real UI instead of editing YAML. First-run onboarding gets you to your first message in seconds. The settings panes cover providers/keys, model selection, toolset configuration, MCP servers, the gateway, and session management.

- **Providers settings pane** — a dedicated place to manage inference providers, with an Accounts / API-keys UX for signing in and storing credentials per provider.
- **Every provider and model in the menus** — the GUI surfaces the full provider list and every model that `allr model` knows about, so you pick from the same catalog the CLI sees rather than a curated subset.
- **xAI Grok OAuth** — Grok is a first-class OAuth provider in the launcher; sign in through the browser flow like the other OAuth providers.
- **Tool-backend installs from the GUI** — run a tool backend's post-setup install steps directly from the app instead of dropping to a terminal.
- **Terminal font picker** — choose an installed font in **Settings → Appearance**. Nerd Fonts such as `MesloLGS NF` render Powerlevel10k separators and icons in both interactive and agent terminals; the setting is saved per profile.
- **Auxiliary-model warning** — if you switch the main model to a new provider while auxiliary tasks (titling, summarization, and similar helpers) are still pinned to another provider, the app warns you so you don't unknowingly split work across two providers.
- **VS Code Marketplace themes** — beyond the built-in theme presets, the appearance settings include a live VS Code Marketplace search: pick any color theme and the app downloads, converts, and installs it as a desktop theme. The same importer is available from the command palette (*Install theme*), and imported themes can be removed again from the appearance settings.
- **Keep computer awake** — **Settings → Advanced → Keep computer awake** stops the machine from sleeping so long or overnight agent runs keep going (the display can still dim). This is a per-computer setting.

First-run onboarding has been redesigned on a unified overlay design system, and you can pick **Choose provider later** to skip provider setup and get into the app first.

### Management panes

The app also surfaces the broader Allr management surface so you don't have to drop to a terminal:

- **Skills** — browse, install, and manage [skills](./features/skills.md).
- **Memory graph (Star Map)** — type `/journey` (aliases `/learning`, `/memory-graph`) in chat to open an interactive constellation of learned skills and memories over time, with a playback scrubber. Nodes can be edited or deleted right from the panel (skills are archived, memories removed). See [Learning Journey](./features/memory.md#learning-journey-journey).
- **Cron** — view and manage [scheduled jobs](../reference/cli-commands.md#allr-cron).
- **Profiles** — switch between [Allr profiles](./profiles.md) (isolated config/skills/sessions).
- **Messaging** — set up gateway channels.
- **Agents** and **Command Center** — orchestration surfaces for multi-agent work.

### Keyboard & navigation

- **Command palette** — press **Cmd+K** or **Cmd+P** (Ctrl+K / Ctrl+P on Windows/Linux) to jump to actions and navigate the app from the keyboard: open any page or settings section, jump to a session by title or id, switch model/theme/color mode, spawn a terminal, restart the gateway, update Allr, and more.
- **Rebindable shortcuts** — **Settings → Keyboard Shortcuts** (or **Cmd/Ctrl+/**) opens the shortcuts panel where you can remap almost every binding — profile switching, session navigation, view toggles, and any shortcuts contributed by plugins. Duplicate assignments are flagged as conflicts. A few defaults worth knowing: **Cmd/Ctrl+N** new session, **Cmd/Ctrl+.** Command Center, **Cmd/Ctrl+,** Settings, **Cmd/Ctrl+Shift+F** search sessions, **Cmd/Ctrl+1–9** switch profiles, **Shift+X** toggle light/dark.
- **Custom zoom shortcuts** — zoom the interface in half-step increments for finer control over text size.
- **UI language switcher** — change the app's interface language in-app, including Simplified Chinese (zh-Hans).

### Sessions & profiles

- **Session-list overhaul** — a reworked session list with archiving and general session hygiene to keep the list manageable as it grows.
- **Search sessions by id** — find a specific session directly by its id.
- **Concurrent multi-profile sessions** — run sessions across multiple [profiles](./profiles.md) at the same time, and reference a session in another profile with cross-profile `@session` links.

## Connecting to a gateway

The app is a client: everything it shows comes from an Allr **gateway** (`allr serve`). **Settings → Gateway** (and the first-run **Connect to Allr** screen, which is the same panel) offers four connection modes:

| Mode | What it does | Where it works |
|------|--------------|----------------|
| **Local** | Spawns and manages a gateway on this machine. | Desktop only — a phone can't spawn one. |
| **Remote** | You enter the base URL of an `allr serve` backend you run yourself, and sign in. | Everywhere |
| **Allr Cloud** | Sign in once through the portal and pick from the agents on your account; no URL to paste. Under the hood it's a remote connection whose URL was discovered for you. | Everywhere |
| **SSH** | Allr opens an SSH tunnel, starts (or reattaches to) `allr serve` on the remote host, and forwards a loopback port to it — so it behaves like Local, not like Remote. | Everywhere, phones included (the SSH client is built in) |

Connection modes are configured **per profile**, so one profile can point at a remote or cloud backend while others stay local.

### Signing in

A gateway bound to a non-loopback address engages its auth gate, and the app adapts to whichever provider the backend advertises on `/api/status`:

- **No auth** — a loopback gateway you started yourself; nothing to sign in to.
- **Username / password** — the app shows a credential form. Good for a trusted LAN or a VPN (e.g. Tailscale); not for the open internet.
- **OAuth** — the app shows *Sign in with `<provider>`* and runs the browser flow. Preferred for anything reachable beyond your own machine.

The OAuth flow prefers RFC 8252 native PKCE: the app opens your system browser, catches the redirect on a loopback listener, and holds a bearer token. On backends that don't advertise it, the app falls back to the legacy webview-cookie flow. On phones there is no second window to open, so sign-in navigates the app's own webview to the provider and back.

Tokens, SSH keys and passphrases are stored in the OS keyring — Keychain on macOS/iOS, Credential Manager on Windows, Secret Service on Linux, and the Keystore-backed store on Android — never in plain files.

For the full backend-side setup (auth providers, env vars, close-code triage), see [Web Dashboard → Connecting Allr Desktop to a remote backend](./features/web-dashboard.md#connecting-allr-desktop-to-a-remote-backend) and [Environment Variables → Web Dashboard & Allr Desktop](../reference/environment-variables.md#web-dashboard--allr-desktop).

### Troubleshooting the connection

- **Sign-in fails with 401 / "Invalid credentials"** — the credentials don't match the backend's `ALLR_DASHBOARD_BASIC_AUTH_USERNAME` / `ALLR_DASHBOARD_BASIC_AUTH_PASSWORD`. The backend returns the same generic error for an unknown user and a wrong password, so check both. Confirm the gate is on with `curl -s http://<host>:9119/api/status | jq '.auth_required, .auth_providers'`.
- **No "Sign in" button — it asks for a session token instead** — the backend's username/password provider isn't active, so `/api/status` doesn't list `"basic"` in `auth_providers`. Set both the username and a password (or password hash) in `~/.allr/.env` and restart the backend.
- **Signed out on every restart** — set `ALLR_DASHBOARD_BASIC_AUTH_SECRET` to a stable value. Without it the token-signing key is regenerated per boot.
- **Connection refused / times out** — the backend bound to `127.0.0.1` (the default) or a firewall is blocking the port. Bind to a reachable address and open the port to your trusted network.

## Updating

On **desktop the app updates itself.** Open **Settings → About** and choose **Update now**: it downloads the new build, verifies it, swaps it in and restarts. Every bundle is signed, and the signature is checked against a key compiled into the app before anything is replaced, so a tampered or substituted download is refused rather than installed. Results are cached for a few hours, and **Check now** forces a fresh look.

Two exceptions on desktop. `.deb` and `.rpm` installs update through your package manager instead — they are owned by the system packager, not by the app. And builds installed from a distro repository or built from source have no update channel at all.

On **mobile** the stores own installation: Android points at the Play Store listing and iOS at the App Store, because neither platform lets an app replace its own binary. Those checks remain a build-time option and are off in a default build, which reports "disabled" rather than an error.

The [manual update process](https://allr.work/docs/getting-started/updating) always works.

To uninstall, use the CLI — `allr uninstall` removes the agent, `allr uninstall --full` removes it and all user data. The app itself is removed the way your platform removes any app.

## Extending the app

The app is contribution-driven — panes, pages, sidebar nav, status-bar items, palette commands, keybinds, and themes all register through one SDK, and you can add your own. A plugin is a single ESM file dropped in `$ALLR_HOME/desktop-plugins/<id>/plugin.js`; the app loads it within seconds and hot-reloads every save. It reads that folder on **this** device, and — so plugins also work on a phone, which has no local Allr home — falls back to the same folder on the connected gateway's machine. Both doors are listed in **Settings → Plugins**, where you can also turn the gateway one off.

See [App Plugin SDK](../developer-guide/desktop-plugin-sdk.md) for the full reference. (This is separate from the [web dashboard plugin system](./features/extending-the-dashboard.md).)

## Building from source

Prerequisites are platform-specific and listed in [`apps/hermes-universal/README.md`](https://github.com/allr-ajmx/allr-agent/blob/main/apps/hermes-universal/README.md) — on Debian/Ubuntu the webview and bundler system libraries (`libwebkit2gtk-4.1-dev`, `librsvg2-dev`, `patchelf`, …) are the part people miss, because nothing fails until the final bundling step.

```bash
cd apps/hermes-universal
npm install
npm run dev          # Vite dev server on port 5176
npm run tauri dev    # the native shell against it
```

To attach several native shells to **one** dev server — desktop and a phone showing the same frontend at once:

```bash
npm run dev:ext:vite       # the one dev server — leave it running
npm run dev:ext:desktop    # in another terminal
npm run dev:ext:android    # …and another
npm run dev:ext:ios
```

Bundle a release with `npm run tauri build` (deb + rpm + AppImage on Linux; add `--bundles deb` to skip AppImage). `npm run check` runs what CI runs: typecheck → lint → test → build.

## Troubleshooting

Boot logs land in `ALLR_HOME/logs/desktop.log` — check it first if the app reports a boot failure. You can also tail it from the CLI:

```bash
allr logs gui -f
```

Common resets:

```bash
# Force a clean first-launch setup (macOS/Linux)
rm "$HOME/.allr/allr-agent/.hermes-bootstrap-complete"

# Rebuild a broken Python venv (macOS/Linux)
rm -rf "$HOME/.allr/allr-agent/venv"

# Reset a stuck macOS permission prompt (the app's bundle id is work.allr.app)
tccutil reset Microphone work.allr.app
```

## See also

- [CLI Guide](./cli.md) — the terminal interface
- [TUI](./tui.md) — the modern terminal UI used by `allr --tui` and the dashboard chat tab
- [Web Dashboard](./features/web-dashboard.md) — browser admin panel with an embedded chat tab
- [Configuration](./configuration.md) — config that the app reads and writes
- [Windows (Native)](./windows-native.md) — native Windows install path
