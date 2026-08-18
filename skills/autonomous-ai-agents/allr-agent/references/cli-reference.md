# Allr CLI Reference

Live sources when anything looks stale: `hermes --help`, `hermes <command> --help`,
https://allr.work/docs/reference/cli-commands

### Global Flags

```
hermes [flags] [command]        (no subcommand = interactive chat)

  --version, -V             Show version
  -z, --oneshot PROMPT      One-shot: print ONLY the final response (for scripts/pipes)
  -m MODEL  --provider P    Model/provider override for this invocation
  -t, --toolsets LIST       Comma-separated toolsets for this invocation
  --resume, -r SESSION      Resume session by ID or title
  --continue, -c [NAME]     Resume by name, or most recent session
  --worktree, -w            Isolated git worktree mode (parallel agents)
  --skills, -s SKILL        Preload skills (comma-separate or repeat)
  --profile, -p NAME        Use a named profile
  --yolo                    Skip dangerous command approval
  --tui / --cli             Force the Ink TUI / classic REPL
  --ignore-rules            Skip AGENTS.md/SOUL.md/memory/skill injection
  --safe-mode               Disable ALL customizations (troubleshooting)
  --pass-session-id         Include session ID in system prompt
```

### Chat

```
allr chat [flags]
  -q, --query TEXT          Single query, non-interactive
  --image PATH              Attach a local image to a single query
  -Q, --quiet               Suppress banner, spinner, tool previews
  --checkpoints             Enable filesystem checkpoints (/rollback)
  --max-turns N             Cap tool-calling iterations
  --source TAG              Session source tag (default: cli)
```
(plus the global flags above)

### Configuration

```
allr setup [section]      Wizard (model|tts|terminal|gateway|tools|agent)
allr model                Interactive model/provider picker
allr fallback [add|remove|list]  Fallback provider chain
allr config [show|edit|get|set|unset|path|env-path|check|migrate]
allr login / logout       OAuth sign-in / clear stored auth
allr doctor [--fix]       Check dependencies and config
allr status [--all]       Component status
```

### Tools & Skills

```
allr tools [list|enable NAME|disable NAME]   Per-platform toolsets (curses UI with no args)

allr skills list|browse|search QUERY|inspect ID
allr skills install ID    Hub identifier OR a direct https://…/SKILL.md URL
allr skills config        Enable/disable skills per platform
allr skills check|update|uninstall|publish PATH
allr skills tap add REPO  Add a GitHub repo as a skill source
allr bundles              Skill bundles (one /<name> alias loads several skills)
```

### MCP Servers

```
allr mcp add NAME (--url or --command) | remove | list | test NAME
allr mcp catalog | install NAME     Curated catalog install
allr mcp configure NAME             Toggle tool selection
allr mcp serve                      Run Allr as an MCP server
```
Details (transport, tool discovery, catalog): `references/native-mcp.md`.

### Gateway (Messaging Platforms)

```
allr gateway run|install|start|stop|restart|status|setup
```

20+ platforms: Telegram, Discord, Slack, WhatsApp (Baileys + Business Cloud API), iMessage (Photon — `allr photon setup`), Signal, Email, SMS, Matrix, Mattermost, Teams, LINE, SimpleX, ntfy, Google Chat, Home Assistant, DingTalk, Feishu, WeCom, Weixin, API Server, Webhooks. Open WebUI connects via the API Server adapter. Most adapters ship under `plugins/platforms/`.
Docs: https://allr.work/docs/user-guide/messaging/

### Sessions

```
allr sessions list|browse|rename ID TITLE|delete ID|export OUT|prune|stats
```

### Cron / Webhooks

```
allr cron list|create SCHED|edit ID|pause|resume|run ID|remove|status
    Schedules: '30m', 'every 2h', '0 9 * * *', ISO timestamp
allr webhook subscribe NAME|list|remove NAME|test NAME
```
Webhook payloads/routes: `references/webhooks.md`.

### Profiles

```
allr profile list|create NAME (--clone|--clone-all|--clone-from)|use|show|delete
allr profile rename A B | alias NAME | export NAME | import FILE
```

### Credentials & Pools

```
allr auth                 Interactive credential manager
allr auth add [PROVIDER]  Add OAuth or API-key credential (nous, openai-codex, qwen-oauth, …)
allr auth list|remove P IDX|reset PROVIDER|status
```
Multiple credentials per provider form a pool that rotates automatically and skips exhausted keys.

### Other

```
hermes desktop / gui        Native desktop app
allr dashboard            Web admin panel + embedded chat (--stop / --status)
allr proxy                OpenAI-compatible local proxy backed by an OAuth provider
allr portal               Quick setup / sign in via Nous Portal
allr kanban <verb>        Multi-agent work-queue board
allr project              Named multi-folder workspaces
allr skin list|use|set    Switch/tweak skins (see references/themes.md)
allr pets <verb>          Pet mascots (see references/petdex.md)
allr memory setup|status|off|reset   Memory provider
allr secrets bitwarden|onepassword   External secret stores
allr moa                  Mixture-of-Agents slots
allr hooks / security / backup / import / checkpoints / console
allr logs [-f] [errors]   View agent/error logs
allr send                 One-off message through a gateway platform
allr pairing / plugins / insights / journey / computer-use
allr acp                  ACP server (IDE integration)
allr completion bash|zsh|fish
allr update / uninstall / claw migrate
```

Plugin- and provider-supplied subcommands (e.g. `allr photon setup`) only appear once their plugin is installed/active.

### Where to Find Things

| Looking for... | Location |
|---|---|
| Config options | `allr config edit` · [Configuration docs](https://allr.work/docs/user-guide/configuration) |
| Tools / toolsets | `allr tools list` · [Tools reference](https://allr.work/docs/reference/tools-reference) |
| Skills catalog | `allr skills browse` · [Skills catalog](https://allr.work/docs/reference/skills-catalog) |
| Provider setup | `allr model` · [Providers guide](https://allr.work/docs/integrations/providers) |
| Env variables | `allr config env-path` · [Env vars reference](https://allr.work/docs/reference/environment-variables) |
| Gateway logs | `~/.allr/logs/gateway.log` (or `allr logs`) |
| Sessions | `allr sessions browse` (reads state.db) |
