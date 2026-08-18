#!/usr/bin/env python3
"""Rename the Hermes brand to Allr across this repository, re-runnably.

`allr-agent` keeps ingesting `NousResearch/hermes-agent` and
`jaxmatrix/mjx-hermes-agent` through the `stream/*` lanes (see
`docs/repo-streams.md`). Every ingest merge drags the old brand back in, so the
rename cannot be a one-shot sed — it has to be a gate you re-run after each
merge:

    git merge origin/stream/<lane>     # resolve conflicts
    python scripts/rebrand/rebrand.py
    git commit -am "chore(rebrand): re-apply Allr naming after ingest"
    python scripts/rebrand/rebrand.py --check   # must exit 0

Idempotence is structural, not hopeful: no replacement string may contain any
source pattern (asserted at import), so `f(f(x)) == f(x)`.

DELIBERATE NON-SCOPE — these keep the word "hermes" on purpose:

* Python module/package names (`hermes_cli`, `hermes_constants`, `hermes_state*`,
  `hermes_logging`, `hermes_time`, `hermes_bootstrap`, `get_hermes_home`, …).
  Renaming them is a mechanical but enormous diff that would conflict with every
  future ingest, for zero user-visible gain.
* Class / CamelCase identifiers (`HermesGateway`, `HermesCLI`, …) and Rust crate
  / Cargo package names (`hermes_universal_lib`, `hermes-bootstrap`).
* npm scope `@hermes/*` and the TS path aliases `@/hermes`, `@/types/hermes`.
* localStorage / sessionStorage keys under `apps/` (`'hermes.layout.tree.v2'`,
  `'hermes.gateway.mode'`, …) — renaming them silently wipes user state.
* Upstream repository links (`NousResearch/hermes-agent`,
  `jaxmatrix/mjx-hermes-agent`) and Nous model names (`Hermes 4`,
  `hermes-4-405b`) — those name someone else's project, not ours.
* `metadata.hermes.*`, `.hermes.md`, `HERMES.md`, `.hermes-kanban-*` CSS classes,
  `.hermes-bootstrap-complete` / `.hermes-runtime` / `.hermes-update-*` state
  markers, `hermes.service` (a systemd unit filename), `services.hermes-agent`
  (a NixOS module option), and the Honcho `workspace="hermes"` / `hermes.coder`
  peer names — all on-disk or on-wire contracts with existing installs.
* `hermes.run` — an OpenTelemetry resource attribute emitted from BOTH the
  Python side and `apps/hermes-universal/src-tauri`; renaming only one half
  splits every trace in two.
* Directory/package names under `gen/android` and `gen/apple` — the app
  identifier lives there and is maintained by hand.
* Any line carrying a `# rebrand:keep` (or `// rebrand:keep`) comment — the deliberate
  backward-compat literals (legacy `HERMES_*` env names, legacy unit names)
  that exist precisely to read the pre-rename world.

Usage:

    python scripts/rebrand/rebrand.py [PATH...] [--exclude PATH]... [--check|--stat]
    python scripts/rebrand/rebrand.py --selftest

PATH... are git pathspecs, passed straight to `git ls-files` (so `.` and
`':!website'` both work). No flags = apply.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent


# --------------------------------------------------------------------------
# PROTECT — spans masked out before any rule runs.
# --------------------------------------------------------------------------

PROTECT_PARTS = [
    # Escape hatch: a line carrying `# rebrand:keep` is masked whole. Use it for
    # the deliberate backward-compat literals (legacy env names, legacy unit
    # names) that read the pre-rename world and must survive every re-run.
    # Anchored to line start: an unanchored `[^\n]*…` is quadratic on the
    # single-line dist bundles and turns --check into a multi-minute hang.
    r"(?<![^\n])[^\n]*(?:#|//) rebrand:keep[^\n]*",
    # Python modules / internal identifiers.
    r"hermes_cli\b",
    r"hermes_constants\b",
    r"hermes_state\w*",
    r"hermes_logging\b",
    r"hermes_time\b",
    r"hermes_bootstrap\w*",
    r"hermes_home\w*",
    r"hermes_tools_mcp_server\b",
    r"hermes_agent\.egg-info",
    # Crates / workspaces / npm scope / TS aliases.
    r"hermes-universal",
    r"hermes_universal_lib",
    r"Theme\.hermes_universal",
    r"hermes-sample-plugins",
    r"@hermes/[\w.-]+",
    r"@/types/hermes",
    r"@/hermes",
    # Upstream repositories. Bare `Org/repo` too: GitHub Actions guards spell it
    # `github.repository == 'NousResearch/hermes-agent'` with no host prefix.
    r"(?:(?:github\.com|raw\.githubusercontent\.com)[:/])?"
    r"[Nn]ous[Rr]esearch/[Hh]ermes-[Aa]gent[\w./#?=&-]*",
    r"(?:(?:github\.com|raw\.githubusercontent\.com)[:/])?jaxmatrix/mjx-hermes-agent[\w./#?=&-]*",
    r"services\.hermes-agent",
    # Third-party upstream of the bundled achievements plugin.
    r"PCinkusz/hermes-achievements",
    # Nous model names: "Hermes 4", "Hermes-4-405B", "hermes-4-70b", and the
    # family as a whole — "Hermes model(s)" never means this product here.
    r"[Hh]ermes[ -]\d[\w.]*",
    r"Nous[ /-]Hermes\b",
    r"Hermes models?\b",
    # Data endpoints: manifests published by Nous Research that Allr consumes
    # as-is (skills index, model catalog). Doc links on the same host still move.
    r"hermes-agent\.nousresearch\.com/docs/api/[\w./-]*",
    # On-disk / on-wire contracts.
    r"metadata\.hermes\.\w+",
    r"\.hermes\.md",
    r"\bHERMES\.md\b",
    r'"hermes\.service"',
    r"hermes\.run\b",
    # CamelCase identifiers (HermesGateway, HermesCLI, currentHermesSessionId…).
    r"Hermes[A-Z]\w*",
]

# localStorage / sessionStorage keys — only inside the app sources, where they
# really are storage keys. Elsewhere `"hermes.task_run.started"`-shaped strings
# are OpenTelemetry names and R18 must be free to rename them.
LOCALSTORAGE_KEY = r"""['"]hermes\.[\w.$-]+['"]"""

PROTECT = re.compile("|".join(PROTECT_PARTS))
PROTECT_APP = re.compile("|".join([LOCALSTORAGE_KEY, *PROTECT_PARTS]))

_APP_STORAGE_SCOPE = ("apps/hermes-universal/src/", "apps/shared/")


def _protect_for(path: str) -> re.Pattern[str]:
    return PROTECT_APP if path.startswith(_APP_STORAGE_SCOPE) else PROTECT


def _outside_apps(path: str) -> bool:
    return not path.startswith("apps/")


# --------------------------------------------------------------------------
# RULES — ordered; each is (name, pattern, replacement, scope-or-None).
# --------------------------------------------------------------------------

# Real CLI subcommands: hermes_cli/main.py's _BUILTIN_SUBCOMMANDS union the
# plugin-registered commands. `desktop`/`gui` are absent on purpose.
# Deliberately NOT here even though the brief listed them: `user`, `home`,
# `runtime`, `help`, `models` and `mcp-server` are never subcommands in this
# tree — every "hermes user" / "hermes home" / "hermes runtime" hit is prose
# about the container's unix user, the state directory, or a testimonial quote.
SUBCOMMANDS = """
acp approvals auth backup bundles chat checkpoints claw codex-runtime completion
computer-use config console cron curator dashboard debug doctor dump egress
fallback gateway honcho hooks import import-agent insights journey kanban
learning login logout logs lsp mcp meet memory memory-graph migrate moa model
monitoring pairing pause pets photon plugins portal profile project prompt-size
proxy resume secrets security send serve sessions sethome setup skills skin
slack snapshot status sync teams-pipeline tools trace uninstall update verify
version webhook whatsapp whatsapp-cloud
""".split()

# OpenTelemetry metric / span / attribute namespaces. Enumerated from
# `git grep -hoE '"hermes\.[a-z_]+' -- . ':!apps'`, minus everything that turned
# out to be a filename (`hermes.service`, `hermes.stdout.txt`), a hostname
# placeholder (`hermes.example.com`), a storage key (`hermes.pty.token.chat`),
# a Honcho peer (`hermes.coder`), or cross-boundary (`hermes.run`).
OTEL_PREFIXES = """
active_agents api_server approval call_role client coding_context cron custom
error_code event execution_surface gateway gateway_health lint logical_llm_call
mcp_serve metrics middleware model_call model_route monitoring nemo_relay
new_state observer old_state platform probe profile relay security_audit session
shared_metrics skill ssi_health subagent supervision_mode task_run tool
tool_approval tool_call tool_calls turn
""".split()


def _longest_first(words: list[str]) -> str:
    return "|".join(re.escape(w) for w in sorted(words, key=len, reverse=True))


RULES: list[tuple[str, str, str, object]] = [
    ("R1  launchd/gateway id", r"ai\.hermes\.gateway", "work.allr.gateway", None),
    ("R2  env vars", r"HERMES_", "ALLR_", None),
    ("R3  url scheme", r"hermes://", "allr://", None),
    # POSIX home. The lookbehind alone kills `ai.hermes.gateway`,
    # `metadata.hermes.tags` and every other dotted namespace; the lookahead
    # kills `.hermesDesktop`, `.hermes-kanban-*`, `.hermes-bootstrap-complete`,
    # `.hermes-runtime`, `.hermes-update-*`, `.hermes_history`.
    ("R4  posix home", r"(?<![A-Za-z0-9_.-])\.hermes(?=[/\\'\"`\s)\]},;:]|$)", ".allr", None),
    ("R4b windows home", r"(LOCALAPPDATA[%}]?)(\\\\?)hermes(?![\w.-])", r"\1\2allr", None),
    ("R4b windows home", r'(base / )"hermes"', r'\1"allr"', None),
    ("R5  install host", r"hermes-agent\.nousresearch\.com", "allr.work", None),
    ("R6  app product name", r"Hermes \(MJX\)", "Allr", None),
    ("R7  product name", r"Hermes Agent\b", "Allr", None),
    ("R8  product name", r"Hermes-Agent", "Allr", None),
    ("R9  product name", r"Hermes-Universal", "Allr", None),
    ("R10 repo/dir slug", r"hermes-agent", "allr-agent", None),
    ("R10b renamed dirs", r"hermes-achievements", "allr-achievements", None),
    ("R10b renamed dirs", r"hermes-s6-container-supervision", "allr-s6-container-supervision", None),
    ("R10b renamed dirs", r"hermes-kanban-dispatcher", "allr-kanban-dispatcher", None),
    ("R10b renamed dirs", r"hermes-exec-shim", "allr-exec-shim", None),
    ("R10b renamed dirs", r"main-hermes", "main-allr", None),
    ("R10b renamed dirs", r"setup-hermes", "setup-allr", None),
    ("R11 acp launcher", r"hermes-acp", "allr-acp", None),
    ("R12 gateway launcher", r"hermes-gateway", "allr-gateway", None),
    ("R13 installer", r"hermes-setup", "allr-setup", None),
    ("R13 installer", r"Hermes-Setup", "Allr-Setup", None),
    ("R14 windows exe", r"hermes\.exe", "allr.exe", None),
    ("R15 bin symlink", r"bin/hermes(?![\w.-])", "bin/allr", None),
    ("R16 oauth cookies", r"hermes_session_(at|rt|pkce|provider)", r"allr_session_\1", None),
    # R16b — exact literals found by grep that no general rule can reach.
    ("R16b literals", r'prog="hermes"', 'prog="allr"', None),
    ("R16b literals", r'KEYRING_SERVICE: &str = "hermes"', 'KEYRING_SERVICE: &str = "allr"', None),
    ("R16b literals", r"const SERVICE = 'hermes'", "const SERVICE = 'allr'", None),
    ("R16b literals", r'TRAY_ID: &str = "hermes"', 'TRAY_ID: &str = "allr"', None),
    ("R16b literals", r"(\$command_link_dir|\$command_link_display_dir|\$link_dir|\$INSTALL_DIR)/hermes(?![\w.-])", r"\1/allr", None),
    ("R16b literals", r"\{_cmd_link_display\}/hermes(?![\w.-])", "{_cmd_link_display}/allr", None),
    # `./hermes` / `../hermes` launcher paths. Skipped under apps/, where
    # `from './hermes'` is a TypeScript module specifier.
    ("R16b literals", r"(?<![\w])(\.{1,2})/hermes(?![\w.-])", r"\1/allr", _outside_apps),
    ("R17 cli invocations", rf"(?<![\w-])hermes ({_longest_first(SUBCOMMANDS)})(?![\w-])", r"allr \1", None),
    # R18 — telemetry namespace. Python side only: the app half of these names
    # lives under apps/ and is either a storage key or `hermes.run`.
    ("R18 otel namespace", rf"\bhermes\.(?=({_longest_first(OTEL_PREFIXES)})\b)", "allr.", _outside_apps),
    ("R19 brand word", r"\bHermes\b", "Allr", None),
    ("R20 brand shout", r"\bHERMES\b(?!_)", "ALLR", None),
    # R21 — the caduceus is a brand ornament next to the name, but also a
    # generic status marker elsewhere (` ⚕ ` in the TUI status bar, test
    # fixtures). Only strip it where it decorates the brand.
    ("R21 caduceus", r"⚕ (\*?)Allr", r"\1Allr", None),
    ("R21 caduceus", r"Allr ☤", "Allr", None),
    ("R21 caduceus", r"Goodbye! ⚕", "Goodbye!", None),
]

COMPILED = [(name, re.compile(pat), repl, scope) for name, pat, repl, scope in RULES]


def _apply(text: str, path: str = "") -> tuple[str, dict[str, int]]:
    """Run every in-scope rule over already-masked text."""
    counts: dict[str, int] = {}
    for name, rx, repl, scope in COMPILED:
        if scope is not None and path and not scope(path):
            continue
        text, n = rx.subn(repl, text)
        if n:
            counts[name] = counts.get(name, 0) + n
    return text, counts


# Structural idempotence: a replacement must not feed any rule. Backrefs are
# dropped first — they carry captured input, which is checked by the selftest's
# f(f(x)) == f(x) assertion instead.
for _name, _pat, _repl, _scope in RULES:
    _literal = re.sub(r"\\\d", "", _repl)
    assert _apply(_literal)[0] == _literal, f"{_name}: replacement {_repl!r} is not a fixed point"


# --------------------------------------------------------------------------
# PATH_RENAMES
# --------------------------------------------------------------------------

PATH_RENAMES = [
    ("hermes", "allr"),
    ("setup-hermes.sh", "setup-allr.sh"),
    ("scripts/hermes-gateway", "scripts/allr-gateway"),
    ("docker/hermes-exec-shim.sh", "docker/allr-exec-shim.sh"),
    ("docker/s6-rc.d/main-hermes", "docker/s6-rc.d/main-allr"),
    ("docker/s6-rc.d/user/contents.d/main-hermes", "docker/s6-rc.d/user/contents.d/main-allr"),
    (
        "plugins/kanban/systemd/hermes-kanban-dispatcher.service",
        "plugins/kanban/systemd/allr-kanban-dispatcher.service",
    ),
    (
        "apps/bootstrap-installer/src-tauri/hermes-setup.manifest",
        "apps/bootstrap-installer/src-tauri/allr-setup.manifest",
    ),
    (
        "hermes_cli/observability/schemas/hermes.shared_metrics.v1.schema.json",
        "hermes_cli/observability/schemas/allr.shared_metrics.v1.schema.json",
    ),
    (
        "hermes_cli/observability/schemas/hermes.shared_metrics.v2.schema.json",
        "hermes_cli/observability/schemas/allr.shared_metrics.v2.schema.json",
    ),
    ("plugins/hermes-achievements", "plugins/allr-achievements"),
    ("skills/autonomous-ai-agents/hermes-agent", "skills/autonomous-ai-agents/allr-agent"),
    (
        "skills/software-development/hermes-agent-skill-authoring",
        "skills/software-development/allr-agent-skill-authoring",
    ),
    (
        "optional-skills/devops/hermes-s6-container-supervision",
        "optional-skills/devops/allr-s6-container-supervision",
    ),
]


# --------------------------------------------------------------------------
# File selection
# --------------------------------------------------------------------------

SKIP_SUFFIXES = (".lock", "-lock.json")
SKIP_NAMES = {"LICENSE", ".mailmap", ".git-blame-ignore-revs"}
# No `dist/`/`build/` skip: the only tracked ones are the dashboard plugins'
# hand-written IIFE bundles (no build step), and skipping them left them calling
# `window.__HERMES_PLUGIN_SDK__` after the host renamed the global.
SKIP_PREFIXES = (
    "contributors/",
    "scripts/rebrand/",
    # gen/android + gen/apple carry the platform app identifier, kept by hand.
    "apps/hermes-universal/src-tauri/gen/",
)


def _git(*args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=REPO, check=True, capture_output=True, text=True
    ).stdout


def candidate_files(pathspecs: list[str], excludes: list[str]) -> list[str]:
    listed = _git("ls-files", "-z", "--", *(pathspecs or ["."])).split("\0")
    out = []
    for path in listed:
        if not path or path in SKIP_NAMES or path.endswith(SKIP_SUFFIXES):
            continue
        if path.startswith(SKIP_PREFIXES):
            continue
        if any(path == e or path.startswith(e.rstrip("/") + "/") for e in excludes):
            continue
        out.append(path)
    return out


def read_text(path: Path) -> str | None:
    """Return decoded text, or None when the file is binary."""
    try:
        raw = path.read_bytes()
    except OSError:
        return None
    if b"\0" in raw[:8192]:
        return None
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return None


def rewrite(path: str) -> tuple[str, str, dict[str, int]] | None:
    """Return (original, rewritten, counts) when the file changes."""
    text = read_text(REPO / path)
    if text is None:
        return None
    vault: list[str] = []

    def stash(m: re.Match[str]) -> str:
        vault.append(m.group(0))
        return f"\0{len(vault) - 1}\0"

    masked = _protect_for(path).sub(stash, text)
    masked, counts = _apply(masked, path)
    new = re.sub(r"\0(\d+)\0", lambda m: vault[int(m.group(1))], masked)
    return (text, new, counts) if new != text else None


def rename_paths(dry_run: bool) -> list[tuple[str, str]]:
    done = []
    for src, dst in PATH_RENAMES:
        if not (REPO / src).exists() or (REPO / dst).exists():
            continue
        done.append((src, dst))
        if not dry_run:
            (REPO / dst).parent.mkdir(parents=True, exist_ok=True)
            _git("mv", src, dst)
    return done


# --------------------------------------------------------------------------
# Self-test
# --------------------------------------------------------------------------

KEEP = [
    "from hermes_cli.config import Config",
    "import hermes_constants",
    "https://github.com/NousResearch/hermes-agent/issues/18594",
    "github.repository == 'NousResearch/hermes-agent'",
    "https://github.com/jaxmatrix/mjx-hermes-agent/pull/99",
    'meta = metadata.hermes.tags',
    "model: Hermes-4-405B and hermes-4-70b and Hermes 4",
    "description = 'Nous Research — Hermes model family'",
    "Hermes models are already uncensored",
    "# drops to the hermes user via s6-setuidgid",
    "junk-filtered (hermes home subtree + bare)",
    "https://github.com/PCinkusz/hermes-achievements (MIT)",
    "import x from '@/types/hermes'",
    '"@hermes/shared": "workspace:*"',
    "path apps/hermes-universal/src-tauri",
    "crate hermes_universal_lib",
    'android:theme="@style/Theme.hermes_universal"',
    "el.classList.add('hermesDesktop')",
    ".hermes-kanban-card { color: red }",
    "services.hermes-agent.settings = {}",
    "marker = home / '.hermes-bootstrap-complete'",
    "see .hermes.md and HERMES.md",
    "let gw = HermesGateway::new()",
    'client = Honcho(workspace="hermes")',
    'tag = metadata["hermes"]',
    'unit = "hermes.service"',
    'KeyValue::new("hermes.run", run_label())',
    'legacy = os.environ["HERMES_HOME"]  # rebrand:keep',
    "description: 'Hosted Hermes & Nous-trained models', // rebrand:keep",
    'URL = "https://hermes-agent.nousresearch.com/docs/api/model-catalog.json"',
]

# (input, expected) — one per rule.
CHANGE = [
    ("~/Library/LaunchAgents/ai.hermes.gateway.plist", "~/Library/LaunchAgents/work.allr.gateway.plist"),
    ("export HERMES_HOME=/tmp", "export ALLR_HOME=/tmp"),
    ('href="hermes://open/session"', 'href="allr://open/session"'),
    ("cfg = Path.home() / '.hermes' / 'config.yaml'", "cfg = Path.home() / '.allr' / 'config.yaml'"),
    (r"%LOCALAPPDATA%\hermes\node", r"%LOCALAPPDATA%\allr\node"),
    ('return base / "hermes"', 'return base / "allr"'),
    ("curl -fsSL https://hermes-agent.nousresearch.com/install.sh", "curl -fsSL https://allr.work/install.sh"),
    ('"productName": "Hermes (MJX)"', '"productName": "Allr"'),
    ("Welcome to Hermes Agent!", "Welcome to Allr!"),
    ("the Hermes-Agent runtime", "the Allr runtime"),
    ('concat!("Hermes-Universal/", V)', 'concat!("Allr/", V)'),
    ("INSTALL_DIR=/usr/local/lib/hermes-agent", "INSTALL_DIR=/usr/local/lib/allr-agent"),
    ("plugins/hermes-achievements/dashboard", "plugins/allr-achievements/dashboard"),
    ("optional-skills/devops/hermes-s6-container-supervision", "optional-skills/devops/allr-s6-container-supervision"),
    ("systemctl --user start hermes-kanban-dispatcher", "systemctl --user start allr-kanban-dispatcher"),
    ("COPY docker/hermes-exec-shim.sh /usr/local/bin/", "COPY docker/allr-exec-shim.sh /usr/local/bin/"),
    ("s6-rc.d/main-hermes/run", "s6-rc.d/main-allr/run"),
    ("bash setup-hermes.sh --yes", "bash setup-allr.sh --yes"),
    ("exec hermes-acp \"$@\"", "exec allr-acp \"$@\""),
    ("scripts/hermes-gateway restart", "scripts/allr-gateway restart"),
    ("$HOME/hermes-setup.exe --update", "$HOME/allr-setup.exe --update"),
    ('name = "Hermes-Setup"', 'name = "Allr-Setup"'),
    (r'"%LOCALAPPDATA%\bin\hermes.exe"', r'"%LOCALAPPDATA%\bin\allr.exe"'),
    ("ln -s ~/.local/bin/hermes", "ln -s ~/.local/bin/allr"),
    ('cookie("hermes_session_at")', 'cookie("allr_session_at")'),
    ('parser = ArgumentParser(prog="hermes")', 'parser = ArgumentParser(prog="allr")'),
    ('const KEYRING_SERVICE: &str = "hermes";', 'const KEYRING_SERVICE: &str = "allr";'),
    ("const SERVICE = 'hermes'", "const SERVICE = 'allr'"),
    ('const TRAY_ID: &str = "hermes";', 'const TRAY_ID: &str = "allr";'),
    ('rm -f "$command_link_dir/hermes"', 'rm -f "$command_link_dir/allr"'),
    ("run `./hermes` from the checkout", "run `./allr` from the checkout"),
    ("install -Dm755 ${../hermes} $out/bin/hermes", "install -Dm755 ${../allr} $out/bin/allr"),
    ("run `hermes gateway status` then hermes prompt-size", "run `allr gateway status` then allr prompt-size"),
    ('counter("hermes.tool_call.count")', 'counter("allr.tool_call.count")'),
    ('attrs = {"hermes.task_run.started": 1}', 'attrs = {"allr.task_run.started": 1}'),
    ("Hermes is running", "Allr is running"),
    ("# HERMES CONFIG", "# ALLR CONFIG"),
    ('label = "⚕ Hermes"', 'label = "Allr"'),
    ('REPLY_PREFIX = "⚕ *Hermes Agent*"', 'REPLY_PREFIX = "*Allr*"'),
    ("# Hermes Agent ☤", "# Allr"),
    ('goodbye: "Goodbye! ⚕"', 'goodbye: "Goodbye!"'),
]


APP_KEEP = [
    "persistentAtom('hermes.layout.tree.v2', [])",
    "localStorage.getItem('hermes.gateway.mode')",
    "const K = 'hermes.session.tiles.v2'",
]


def _run(text: str, path: str) -> str:
    vault: list[str] = []

    def stash(m: re.Match[str]) -> str:
        vault.append(m.group(0))
        return f"\0{len(vault) - 1}\0"

    masked = _protect_for(path).sub(stash, text)
    masked, _ = _apply(masked, path)
    return re.sub(r"\0(\d+)\0", lambda m: vault[int(m.group(1))], masked)


def selftest() -> int:
    failures = []

    fixture = "\n".join(KEEP + [src for src, _ in CHANGE])
    first = _run(fixture, "gateway/telemetry.py")
    if _run(first, "gateway/telemetry.py") != first:
        failures.append("  not idempotent: f(f(x)) != f(x)")

    lines = first.split("\n")
    for i, expected in enumerate(KEEP):
        if lines[i] != expected:
            failures.append(f"  MUST NOT CHANGE: {expected!r}\n              got: {lines[i]!r}")
    for j, (src, expected) in enumerate(CHANGE):
        got = lines[len(KEEP) + j]
        if got != expected:
            failures.append(f"  {src!r}\n     expected: {expected!r}\n          got: {got!r}")

    # Storage keys survive only inside the app sources.
    app_path = "apps/hermes-universal/src/store/layout.ts"
    app_first = _run("\n".join(APP_KEEP), app_path)
    if _run(app_first, app_path) != app_first:
        failures.append("  app fixture not idempotent")
    for want, got in zip(APP_KEEP, app_first.split("\n")):
        if want != got:
            failures.append(f"  MUST NOT CHANGE (app): {want!r}\n                    got: {got!r}")

    if failures:
        print(f"selftest FAILED ({len(failures)}):\n" + "\n".join(failures))
        return 1
    print(
        f"selftest OK — {len(KEEP)} protected lines, {len(APP_KEEP)} app storage keys, "
        f"{len(CHANGE)} rewrites, idempotent"
    )
    return 0


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("paths", nargs="*", help="git pathspecs to restrict the walk")
    ap.add_argument("--exclude", action="append", default=[], help="path to skip (repeatable)")
    ap.add_argument("--check", action="store_true", help="exit 1 if anything would change")
    ap.add_argument("--stat", action="store_true", help="print per-rule hit counts")
    ap.add_argument("--selftest", action="store_true", help="run the built-in fixture test")
    args = ap.parse_args(argv)

    if args.selftest:
        return selftest()

    dry = args.check
    totals: dict[str, int] = {}
    changed: list[str] = []

    for path in candidate_files(args.paths, args.exclude):
        result = rewrite(path)
        if result is None:
            continue
        _, new, counts = result
        changed.append(path)
        for name, n in counts.items():
            totals[name] = totals.get(name, 0) + n
        if not dry:
            (REPO / path).write_bytes(new.encode("utf-8"))

    renames = rename_paths(dry_run=dry)

    if args.stat:
        width = max((len(n) for n in totals), default=0)
        for name, _pat, _repl, _scope in RULES:
            if name in totals:
                print(f"{name:<{width}}  {totals.pop(name):>6}")
        print(f"{'-' * width}  ------")
        print(f"{'files':<{width}}  {len(changed):>6}")
        print(f"{'renames':<{width}}  {len(renames):>6}")

    if dry:
        if not changed and not renames:
            print("clean — no Hermes naming left to rewrite")
            return 0
        for path in changed:
            print(path)
        for src, dst in renames:
            print(f"{src} -> {dst}")
        print(f"\n{len(changed)} file(s) and {len(renames)} path(s) would change — run without --check")
        return 1

    print(f"rewrote {len(changed)} file(s), renamed {len(renames)} path(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
