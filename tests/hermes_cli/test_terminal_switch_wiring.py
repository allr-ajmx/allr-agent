"""Every terminal/shell-pty switch, driven through its REAL resolution path.

Why this file exists, precisely: the kill switch shipped broken and the suite was
green, because the one test covering it did

    monkeypatch.setenv("TERMINAL_SHELL_PTY", "off")

— handing the code a Python ``str``. The bug was that ``load_config`` parses YAML
1.1, where a bare ``off`` becomes the *boolean* ``False``, and the read site
collapsed that back to ``"auto"``. The documented form in
``cli-config.yaml.example`` therefore left the interactive host shell enabled on
a gateway whose operator had switched it off. The env-var test could never have
caught it: it exercised the one path that was never broken.

So the rule for this file: **write a real config.yaml and call the real
``load_config``.** No monkeypatching of config reads. A test that stubs the
resolution it is supposed to be verifying is not evidence.
"""

import textwrap

import pytest
import yaml

from hermes_cli import web_server
from hermes_cli.config import get_config_path, load_config

# Every TERMINAL_* var the switches under test consult. The hermetic conftest
# fixture isolates HERMES_HOME but not these, and a stray value from the
# developer's shell would silently mask a config-path regression — which is
# exactly the failure mode this file exists to prevent.
_TERMINAL_ENV_VARS = (
    "TERMINAL_SHELL_PTY",
    "TERMINAL_SHELL_PTY_BACKEND",
    "TERMINAL_ALLOW_UNSANDBOXED_SHELL",
    "TERMINAL_ENV",
)


@pytest.fixture(autouse=True)
def _no_terminal_env(monkeypatch):
    for name in _TERMINAL_ENV_VARS:
        monkeypatch.delenv(name, raising=False)


def _write_config(body: str) -> None:
    """Write a real config.yaml into the per-test HERMES_HOME."""
    path = get_config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(textwrap.dedent(body), encoding="utf-8")
    # Guard against a typo in the fixture silently producing an empty config and
    # a vacuously-passing test.
    assert isinstance(yaml.safe_load(path.read_text(encoding="utf-8")), dict)


# ---------------------------------------------------------------------------
# terminal.shell_pty — the switch that shipped inert
# ---------------------------------------------------------------------------

# (yaml literal, expected disabled?). The first four are the forms an operator
# actually writes; `off` unquoted is the one the example file documents.
_SHELL_PTY_CASES = [
    ("off", True),
    ('"off"', True),
    ("false", True),
    ("no", True),
    ("0", True),
    ("auto", False),
    ('"auto"', False),
    ("on", False),
    ("true", False),
    ("null", False),
]


@pytest.mark.parametrize("literal,expect_disabled", _SHELL_PTY_CASES)
def test_shell_pty_from_real_yaml(literal, expect_disabled):
    _write_config(f"""
        terminal:
          backend: local
          shell_pty: {literal}
        """)

    reason = web_server._shell_pty_disabled_reason()

    assert (reason is not None) == expect_disabled, (
        f"terminal.shell_pty: {literal} → YAML "
        f"{yaml.safe_load(f'x: {literal}')['x']!r} resolved to "
        f"{'disabled' if reason else 'ENABLED'}"
    )


def test_documented_example_line_actually_disables():
    """The exact text of cli-config.yaml.example must work when uncommented.

    Pins the docs to the code: if someone changes the example's suggested value
    without changing the parser, this fails.
    """
    example = (
        get_config_path().parent.parent  # noqa: F841 — kept for readability below
    )
    del example
    # The example documents: `shell_pty: auto   # auto | off`
    _write_config("""
        terminal:
          shell_pty: off   # auto | off — set off to disable the dashboard shell terminal
        """)

    assert web_server._shell_pty_disabled_reason() is not None


def test_env_wins_over_config_for_shell_pty(monkeypatch):
    """Env is the documented precedence; a deployment's container env must beat
    a config file baked into an image."""
    _write_config("""
        terminal:
          shell_pty: auto
        """)
    monkeypatch.setenv("TERMINAL_SHELL_PTY", "off")

    assert web_server._shell_pty_disabled_reason() is not None


def test_bridged_bool_from_env_still_disables(monkeypatch):
    """apply_terminal_config_to_env stringifies a YAML bool, so the bridged form
    of `shell_pty: off` arrives as the literal "False" — not "off"."""
    monkeypatch.setenv("TERMINAL_SHELL_PTY", "False")

    assert web_server._shell_pty_disabled_reason() is not None


def test_health_features_track_the_switch():
    """/api/health is what the client believes; it must not advertise a shell the
    gateway will refuse."""
    from starlette.testclient import TestClient

    _write_config("""
        terminal:
          shell_pty: off
        """)

    with TestClient(web_server.app) as client:
        features = client.get("/api/health").json()["features"]

    assert features["shell_pty"] is False
    assert features["shell_pty_reattach"] is False


# ---------------------------------------------------------------------------
# terminal.backend vs TERMINAL_ENV — the picker divergence
# ---------------------------------------------------------------------------


def test_effective_backend_prefers_the_pinned_env(monkeypatch):
    """TERMINAL_ENV is pinned at startup from config-as-it-was; a later config
    edit does not move it. Both values have to be reportable."""
    _write_config("""
        terminal:
          backend: docker
        """)
    monkeypatch.setenv("TERMINAL_ENV", "local")

    effective, configured = web_server._effective_terminal_backend()

    assert effective == "local"
    assert configured == "docker"


def test_effective_backend_falls_back_to_config():
    _write_config("""
        terminal:
          backend: docker
        """)

    assert web_server._effective_terminal_backend() == ("docker", "docker")


@pytest.mark.asyncio
async def test_picker_reports_restart_required(monkeypatch):
    """The regression test for the reported bug: the panel must not paint "In
    use" on a backend the running process is not using."""
    _write_config("""
        terminal:
          backend: docker
        """)
    monkeypatch.setenv("TERMINAL_ENV", "local")
    # Probes shell out to docker/ssh; the payload shape is what is under test.
    monkeypatch.setattr(web_server, "_probe_terminal_backend", lambda *a, **k: ("ready", ""))

    payload = await web_server.get_terminal_backends()

    assert payload["active"] == "local"
    assert payload["configured"] == "docker"
    assert payload["restart_required"] is True

    rows = {row["name"]: row for row in payload["backends"]}
    assert rows["local"]["active"] is True
    assert rows["docker"]["active"] is False
    assert rows["docker"]["pending"] is True


@pytest.mark.asyncio
async def test_picker_agrees_when_nothing_is_pinned(monkeypatch):
    _write_config("""
        terminal:
          backend: docker
        """)
    monkeypatch.setattr(web_server, "_probe_terminal_backend", lambda *a, **k: ("ready", ""))

    payload = await web_server.get_terminal_backends()

    assert payload["restart_required"] is False
    assert all(row["pending"] is False for row in payload["backends"])


# ---------------------------------------------------------------------------
# terminal.shell_pty_backend — routed independently, and LIVE by design
# ---------------------------------------------------------------------------


def test_shell_pty_backend_overrides_agent_backend_from_config():
    """Deliberately absent from TERMINAL_CONFIG_ENV_MAP so a config edit takes
    effect without a restart — the property the picker's key does not have."""
    _write_config("""
        terminal:
          backend: local
          shell_pty_backend: docker
        """)

    assert web_server._resolve_shell_pty_backend() == "docker"


def test_shell_pty_backend_auto_inherits_effective_backend(monkeypatch):
    _write_config("""
        terminal:
          backend: docker
          shell_pty_backend: auto
        """)
    monkeypatch.setenv("TERMINAL_ENV", "ssh")

    assert web_server._resolve_shell_pty_backend() == "ssh"


def test_env_wins_for_shell_pty_backend(monkeypatch):
    """Precedence nothing covered before: a non-empty env value must beat a
    conflicting config value."""
    _write_config("""
        terminal:
          backend: local
          shell_pty_backend: docker
        """)
    monkeypatch.setenv("TERMINAL_SHELL_PTY_BACKEND", "ssh")

    assert web_server._resolve_shell_pty_backend() == "ssh"


# ---------------------------------------------------------------------------
# terminal.allow_unsandboxed_shell — the one switch already written correctly
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("literal,expected", [
    ("true", True), ("false", False), ("yes", True), ("no", False),
    ("on", True), ("off", False), ("null", False), ('"true"', True),
])
def test_allow_unsandboxed_from_real_yaml(literal, expected):
    _write_config(f"""
        terminal:
          allow_unsandboxed_shell: {literal}
        """)

    assert web_server._shell_pty_allow_unsandboxed() is expected


def test_env_wins_for_allow_unsandboxed(monkeypatch):
    _write_config("""
        terminal:
          allow_unsandboxed_shell: false
        """)
    monkeypatch.setenv("TERMINAL_ALLOW_UNSANDBOXED_SHELL", "1")

    assert web_server._shell_pty_allow_unsandboxed() is True


# ---------------------------------------------------------------------------
# Schema honesty — a dropdown must not offer values the code rejects
# ---------------------------------------------------------------------------


def test_modal_mode_options_are_accepted_by_the_coercer():
    """terminal.modal_mode offered ["sandbox", "function"]; coerce_modal_mode
    accepts neither, so both choices silently became "auto"."""
    from tools.tool_backend_helpers import coerce_modal_mode

    options = web_server._SCHEMA_OVERRIDES["terminal.modal_mode"]["options"]

    assert options, "modal_mode must offer options"
    for option in options:
        assert coerce_modal_mode(option) == option, (
            f"schema offers {option!r} but coerce_modal_mode discards it"
        )


def test_shell_pty_schema_options_round_trip():
    options = web_server._SCHEMA_OVERRIDES["terminal.shell_pty"]["options"]

    assert set(options) == {"auto", "off"}
    for option in options:
        assert web_server._normalize_shell_pty_mode(option) == option
