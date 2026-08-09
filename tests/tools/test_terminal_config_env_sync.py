"""Regression tests for terminal config -> env-var bridging.

terminal_tool._get_env_config() reads ALL terminal settings from os.environ
(TERMINAL_*).  config.yaml values therefore have to be bridged into env vars
at startup, by THREE separate code paths:

  1. cli.py            -> ``env_mappings`` dict (CLI / TUI startup)
  2. gateway/run.py    -> ``_terminal_env_map`` dict (gateway / messaging
                          platforms)
  3. hermes_cli/config.py:set_config_value
                       -> bridges via the canonical ``TERMINAL_CONFIG_ENV_MAP``
                          (one-shot when the user runs ``hermes config set …``)

If any one of these is missing a key, the corresponding config.yaml setting
silently does nothing for that entry-point.  This bug already shipped once
for ``docker_run_as_host_user`` (gateway and CLI maps) and once for
``docker_mount_cwd_to_workspace`` (gateway map).

This test guards against future drift by extracting all three maps via source
inspection and asserting they all bridge the same set of writable
``terminal.*`` keys.  Source inspection (rather than importing the live
dicts) keeps the test independent of the user's ~/.hermes/config.yaml and
mirrors the pattern used in tests/hermes_cli/test_config_drift.py.
"""

import ast
import inspect

import pytest


def _extract_dict_values(source: str, dict_name: str) -> set[str]:
    """Return the set of *value* strings in `dict_name = { "k": "VALUE", ... }`.

    We parse the source with ast (so multi-line dicts and comments are
    handled) instead of regex.  The first matching assignment wins.
    """
    tree = ast.parse(source)
    for node in ast.walk(tree):
        if not isinstance(node, ast.Assign):
            continue
        targets = [t for t in node.targets if isinstance(t, ast.Name)]
        if not any(t.id == dict_name for t in targets):
            continue
        if not isinstance(node.value, ast.Dict):
            continue
        out: set[str] = set()
        for k, v in zip(node.value.keys, node.value.values):
            if isinstance(k, ast.Constant) and isinstance(v, ast.Constant):
                if isinstance(v.value, str):
                    out.add(v.value)
        return out
    raise AssertionError(f"Could not find `{dict_name} = {{...}}` literal in source")


def _extract_dict_keys(source: str, dict_name: str) -> set[str]:
    """Return the set of *key* strings in `dict_name = { "KEY": "v", ... }`."""
    tree = ast.parse(source)
    for node in ast.walk(tree):
        if not isinstance(node, ast.Assign):
            continue
        targets = [t for t in node.targets if isinstance(t, ast.Name)]
        if not any(t.id == dict_name for t in targets):
            continue
        if not isinstance(node.value, ast.Dict):
            continue
        out: set[str] = set()
        for k in node.value.keys:
            if isinstance(k, ast.Constant) and isinstance(k.value, str):
                out.add(k.value)
        return out
    raise AssertionError(f"Could not find `{dict_name} = {{...}}` literal in source")


def _cli_env_map_keys() -> set[str]:
    """terminal config keys bridged by cli.load_cli_config()."""
    import cli
    source = inspect.getsource(cli.load_cli_config)
    return _extract_dict_keys(source, "env_mappings")


def _gateway_env_map_keys() -> set[str]:
    """terminal config keys bridged by gateway/run.py at module load."""
    # gateway/run.py builds the dict at module top-level (not inside a
    # function), so inspect the whole module source.
    import gateway.run as gr
    source = inspect.getsource(gr)
    return _extract_dict_keys(source, "_terminal_env_map")


def _save_config_env_sync_keys() -> set[str]:
    """terminal config keys bridged by ``hermes config set foo bar``.

    ``set_config_value`` no longer carries its own ``_config_to_env_sync``
    dict — it bridges through the canonical ``TERMINAL_CONFIG_ENV_MAP`` via
    ``terminal_config_env_var_for_key()`` (config.py), excluding ``cwd``
    (handled separately).  Read the live map so this test tracks the actual
    source of truth that the config-set path uses, rather than a string
    literal that the consolidation removed.
    """
    from hermes_cli import config as hc_config
    # set_config_value bridges every TERMINAL_CONFIG_ENV_MAP key except
    # terminal.cwd (see the ``key != "terminal.cwd"`` guard in
    # set_config_value); mirror that exclusion here.
    return {k for k in hc_config.TERMINAL_CONFIG_ENV_MAP if k != "cwd"}


# Keys present in cli.py env_mappings but intentionally absent from
# gateway/run.py or set_config_value.  Each entry must be justified.
_CLI_ONLY_OK = frozenset({
    # `env_type` is a legacy YAML key alias for `backend` that cli.py
    # accepts for backwards-compat with older cli-config.yaml.  The
    # gateway path normalizes on the canonical `backend` key, which is
    # also in the map and handles the same bridging.  See cli.py ~line 515.
    "env_type",
    # sudo_password is not a terminal-backend option — it's a credential
    # used across backends, bridged to $SUDO_PASSWORD (not TERMINAL_*).
    # Treating it as terminal-only would be misleading.
    "sudo_password",
})


def _terminal_tool_env_var_names() -> set[str]:
    """All TERMINAL_* env vars actually consumed by terminal_tool."""
    import tools.terminal_tool as tt
    source = inspect.getsource(tt)
    # Naive scan: every os.getenv("TERMINAL_X", ...) and _parse_env_var("TERMINAL_X", ...).
    import re
    pat = re.compile(r'["\'](TERMINAL_[A-Z0-9_]+)["\']')
    return set(pat.findall(source))


def test_cli_and_gateway_env_maps_agree():
    """cli.py and gateway/run.py must bridge the same set of terminal keys.

    Both feed the same downstream consumer (terminal_tool).  Drift between
    them means a config.yaml setting that "works in CLI mode but not gateway
    mode" (or vice-versa) — the bug class that shipped twice already.
    """
    cli_keys = _cli_env_map_keys() - _CLI_ONLY_OK
    gw_keys = _gateway_env_map_keys()

    # Normalize the legacy `env_type` alias: cli.py accepts both `env_type`
    # and `backend` as source keys for TERMINAL_ENV; gateway only accepts
    # `backend`.  Since cli.py copies `backend` → `env_type` before the
    # lookup, they're equivalent.  Remove `backend` from the gateway side
    # to avoid a spurious "backend missing from cli" failure.
    gw_keys = gw_keys - {"backend"}

    missing_in_gateway = cli_keys - gw_keys
    missing_in_cli = gw_keys - cli_keys

    assert not missing_in_gateway, (
        f"Keys in cli.py env_mappings but missing from gateway/run.py "
        f"_terminal_env_map: {sorted(missing_in_gateway)}.  Add them to "
        f"both maps (same bug class as docker_run_as_host_user shipping "
        f"wired in cli but not gateway in April 2026)."
    )
    assert not missing_in_cli, (
        f"Keys in gateway/run.py _terminal_env_map but missing from cli.py "
        f"env_mappings: {sorted(missing_in_cli)}.  Add them to both maps."
    )


def test_save_config_set_supports_critical_bridged_keys():
    """``hermes config set terminal.X true`` must propagate to .env for
    known-critical keys.  This used to be an all-keys invariant but the SSH
    terminal keys (ssh_*) aren't in _config_to_env_sync and are instead
    handled via the separate api_keys TERMINAL_SSH_* fallback path or
    user-edits-yaml-directly.

    Until those gaps are audited and fixed, pin the specific keys that are
    load-bearing for the docker backend so the bugs we fixed cannot silently
    regress.  (docker_volumes / docker_forward_env, previously listed here as
    gaps, are now bridged — see the dedicated tests below.)
    """
    save_keys = _save_config_env_sync_keys()
    required = {
        "docker_run_as_host_user",
        "docker_mount_cwd_to_workspace",
        "backend",
        "docker_image",
        "container_cpu",
        "container_memory",
        "container_disk",
        "container_persistent",
    }
    missing = required - save_keys
    assert not missing, (
        f"`hermes config set terminal.X` doesn't sync these load-bearing "
        f"keys to .env: {sorted(missing)}.  Add them to TERMINAL_CONFIG_ENV_MAP "
        f"in hermes_cli/config.py (set_config_value bridges through it)."
    )


def test_docker_run_as_host_user_is_bridged_everywhere():
    """Explicit pin for the bug we just fixed.

    docker_run_as_host_user was added to terminal_tool._get_env_config and
    DockerEnvironment but NOT to cli.py's env_mappings or gateway/run.py's
    _terminal_env_map, so ``terminal.docker_run_as_host_user: true`` in
    config.yaml had no effect at runtime.  This guard makes the regression
    impossible to reintroduce silently.
    """
    assert "docker_run_as_host_user" in _cli_env_map_keys()
    assert "docker_run_as_host_user" in _gateway_env_map_keys()
    assert "docker_run_as_host_user" in _save_config_env_sync_keys()
    assert "TERMINAL_DOCKER_RUN_AS_HOST_USER" in _terminal_tool_env_var_names()


def test_docker_mount_cwd_to_workspace_is_bridged_everywhere():
    """Same regression class — docker_mount_cwd_to_workspace was missing from
    gateway/run.py's _terminal_env_map until the docker_run_as_host_user
    audit caught it.
    """
    assert "docker_mount_cwd_to_workspace" in _cli_env_map_keys()
    assert "docker_mount_cwd_to_workspace" in _gateway_env_map_keys()
    assert "docker_mount_cwd_to_workspace" in _save_config_env_sync_keys()
    assert "TERMINAL_DOCKER_MOUNT_CWD_TO_WORKSPACE" in _terminal_tool_env_var_names()


def test_docker_env_is_bridged_everywhere():
    """Regression pin for docker_env config key being silently ignored.

    ``terminal.docker_env`` in config.yaml specifies extra env vars to inject
    into the Docker container at runtime.  The key was present in
    _create_environment's container_config consumer (line ~1130) but never
    bridged from config.yaml to TERMINAL_DOCKER_ENV, so the dict was always
    empty regardless of what the user set.  Guard all four bridging points so
    this cannot regress.
    """
    assert "docker_env" in _cli_env_map_keys()
    assert "docker_env" in _gateway_env_map_keys()
    assert "docker_env" in _save_config_env_sync_keys()
    assert "TERMINAL_DOCKER_ENV" in _terminal_tool_env_var_names()


def test_docker_extra_args_is_bridged_everywhere():
    """Regression pin for docker_extra_args config key being silently ignored.

    ``terminal.docker_extra_args`` in config.yaml passes extra flags verbatim
    to ``docker run`` (e.g. ``--gpus=all``, ``--shm-size=16g``).  The key was
    present in DEFAULT_CONFIG, TERMINAL_CONFIG_ENV_MAP (so ``hermes config
    set`` bridged it), terminal_tool._get_env_config (reads
    TERMINAL_DOCKER_EXTRA_ARGS), and DockerEnvironment (applies extra_args) --
    but it was MISSING from cli.py's env_mappings and gateway/run.py's
    _terminal_env_map.  So a user who hand-edited config.yaml had their GPU /
    shm-size flags silently dropped on the CLI and gateway/desktop paths,
    while ``image``/``volumes`` (which were in those maps) bridged fine --
    producing the "Hermes partially reads the Docker config" symptom.  Guard
    all four bridging points so this cannot regress.
    """
    assert "docker_extra_args" in _cli_env_map_keys()
    assert "docker_extra_args" in _gateway_env_map_keys()
    assert "docker_extra_args" in _save_config_env_sync_keys()
    assert "TERMINAL_DOCKER_EXTRA_ARGS" in _terminal_tool_env_var_names()


def test_docker_persist_across_processes_is_bridged_everywhere():
    """Regression pin for the cross-process container reuse toggle.

    ``terminal.docker_persist_across_processes`` (issue #20561) controls
    whether ``DockerEnvironment.__init__`` probes for and reuses an existing
    labeled container at startup, and whether ``cleanup()`` removes the
    container on Hermes exit or just stops it (keeping it for the next
    process).  Same four-bridge invariant as docker_run_as_host_user /
    docker_env / docker_mount_cwd_to_workspace — drift between any of the
    four sites means ``terminal.docker_persist_across_processes: false`` in
    config.yaml silently does nothing for that entry point, leaving the
    user unable to opt out of the documented "ONE long-lived container
    shared across sessions" behavior.
    """
    assert "docker_persist_across_processes" in _cli_env_map_keys()
    assert "docker_persist_across_processes" in _gateway_env_map_keys()
    assert "docker_persist_across_processes" in _save_config_env_sync_keys()
    assert "TERMINAL_DOCKER_PERSIST_ACROSS_PROCESSES" in _terminal_tool_env_var_names()


def test_docker_orphan_reaper_is_bridged_everywhere():
    """Regression pin for the startup orphan reaper toggle (issue #20561).

    ``terminal.docker_orphan_reaper`` controls whether Hermes sweeps stale
    Exited containers from prior SIGKILL'd processes at startup.  Same
    four-site bridge invariant — drift means
    ``terminal.docker_orphan_reaper: false`` silently does nothing for one
    entry point, and the reaper either runs when the operator disabled it
    or fails to run when they enabled it.
    """
    assert "docker_orphan_reaper" in _cli_env_map_keys()
    assert "docker_orphan_reaper" in _gateway_env_map_keys()
    assert "docker_orphan_reaper" in _save_config_env_sync_keys()
    assert "TERMINAL_DOCKER_ORPHAN_REAPER" in _terminal_tool_env_var_names()


def test_docker_volumes_is_bridged_everywhere():
    """Regression pin for ``terminal.docker_volumes`` being silently dropped by
    ``hermes config set``.

    The JSON list of ``host:container`` bind mounts was bridged by cli.py and
    gateway/run.py and consumed by terminal_tool (via json.loads), but was
    missing from set_config_value's _config_to_env_sync.  So
    ``hermes config set terminal.docker_volumes '["/host:/workspace"]'`` wrote
    config.yaml yet left the running process's TERMINAL_DOCKER_VOLUMES stale —
    the mounts didn't apply until a full restart.  Same four-site bridge
    invariant as docker_env / docker_run_as_host_user.
    """
    assert "docker_volumes" in _cli_env_map_keys()
    assert "docker_volumes" in _gateway_env_map_keys()
    assert "docker_volumes" in _save_config_env_sync_keys()
    assert "TERMINAL_DOCKER_VOLUMES" in _terminal_tool_env_var_names()


def test_docker_forward_env_is_bridged_everywhere():
    """Regression pin for ``terminal.docker_forward_env`` — the sibling gap to
    docker_volumes.

    The JSON list of host env-var names forwarded into the container was
    bridged by cli.py and gateway/run.py and consumed by terminal_tool (via
    json.loads), but missing from set_config_value's _config_to_env_sync, so
    ``hermes config set terminal.docker_forward_env '["GITHUB_TOKEN"]'`` had no
    effect on the running process until restart.
    """
    assert "docker_forward_env" in _cli_env_map_keys()
    assert "docker_forward_env" in _gateway_env_map_keys()
    assert "docker_forward_env" in _save_config_env_sync_keys()
    assert "TERMINAL_DOCKER_FORWARD_ENV" in _terminal_tool_env_var_names()


# ---------------------------------------------------------------------------
# The general invariant.
#
# The eight pins above were each written after a key had already shipped broken
# in one map. That is one test per bug, discovered one bug at a time —
# `terminal.home_mode` sat in cli.py and gateway/run.py but not in
# TERMINAL_CONFIG_ENV_MAP, so it silently did nothing under `hermes serve`, and
# no pin existed to notice.
#
# This parametrization closes the class instead of the instances: every key
# bridged by ANY of the three maps must be bridged by all three, or be listed as
# a justified exception. A new key cannot be half-wired without failing here.
# ---------------------------------------------------------------------------


# Keys deliberately bridged by only some paths. Each needs a reason, not just an
# entry — an unexplained exception is how the drift starts again.
_JUSTIFIED_PARTIAL = {
    # Legacy YAML alias for `backend`, accepted only by cli.py for old
    # cli-config.yaml files. `backend` itself is bridged everywhere.
    "env_type",
    # A credential, not a terminal-backend option. Bridged to $SUDO_PASSWORD by
    # cli.py only, and deliberately NOT via TERMINAL_CONFIG_ENV_MAP: that path
    # also mirrors values into ~/.hermes/.env, and a sudo password must not be
    # written there as a side effect of `hermes config set`. See the SCOPE note
    # in cli-config.yaml.example.
    "sudo_password",
    # set_config_value handles terminal.cwd separately (placeholder values like
    # "." must not be bridged as literal paths), so it is absent from
    # _save_config_env_sync_keys by construction while present in both launcher
    # maps. See the `key != "terminal.cwd"` guard in set_config_value.
    "cwd",
    # TERMINAL_SHELL_PTY is consumed only by hermes_cli/web_server.py, and the
    # only process that serves /api/shell-pty is `hermes serve` / `hermes
    # dashboard`, which bridges through TERMINAL_CONFIG_ENV_MAP via
    # cmd_dashboard. The classic CLI and the messaging gateway host no such
    # endpoint, so bridging it there would be noise.
    "shell_pty",
}

# cli.py names the backend key `env_type` (the legacy cli-config.yaml spelling)
# while the other two maps use `backend`. Same setting, same env var.
_CLI_KEY_ALIASES = {"backend": "env_type"}


def _all_bridged_keys() -> set[str]:
    """Union of every terminal key any bridge path claims to handle."""
    from hermes_cli import config as hc_config

    return (
        _cli_env_map_keys()
        | _gateway_env_map_keys()
        | set(hc_config.TERMINAL_CONFIG_ENV_MAP)
    ) - _JUSTIFIED_PARTIAL


@pytest.mark.parametrize("key", sorted(_all_bridged_keys()))
def test_every_terminal_key_is_bridged_everywhere(key):
    """A terminal.* key bridged by one launcher must be bridged by all of them.

    Half-bridging means the setting works from one entry point and silently does
    nothing from another — the exact shape of every bug the pins above record.
    """
    from hermes_cli import config as hc_config

    cli_keys = _cli_env_map_keys()
    cli_name = _CLI_KEY_ALIASES.get(key, key)

    missing = [
        name
        for name, keys, lookup in (
            ("cli.py env_mappings", cli_keys, cli_name),
            ("gateway/run.py _terminal_env_map", _gateway_env_map_keys(), key),
            ("config.py TERMINAL_CONFIG_ENV_MAP", set(hc_config.TERMINAL_CONFIG_ENV_MAP), key),
        )
        if lookup not in keys
    ]

    assert not missing, (
        f"terminal.{key} is bridged by some paths but missing from: "
        f"{', '.join(missing)}. Add it there, or justify the omission in "
        f"_JUSTIFIED_PARTIAL."
    )


def test_bridged_env_vars_are_actually_consumed():
    """A key bridged into an env var nothing reads is dead config.

    Not fatal, but it should be a deliberate choice: either something consumes
    the variable, or the key should not claim to be bridged.
    """
    from hermes_cli import config as hc_config

    consumed = _terminal_tool_env_var_names()
    # Read by other modules rather than terminal_tool, verified by grep:
    #   TERMINAL_SANDBOX_DIR  -> tools/environments/base.py::get_sandbox_dir
    #   TERMINAL_HOME_MODE    -> home-mode resolution outside terminal_tool
    #   TERMINAL_SHELL_PTY    -> hermes_cli/web_server.py::_shell_pty_disabled_reason
    consumed_elsewhere = {
        "TERMINAL_SANDBOX_DIR",
        "TERMINAL_HOME_MODE",
        "TERMINAL_SHELL_PTY",
    }

    orphans = {
        key: env_var
        for key, env_var in hc_config.TERMINAL_CONFIG_ENV_MAP.items()
        if env_var not in consumed and env_var not in consumed_elsewhere
    }

    assert not orphans, f"bridged but never read: {orphans}"
