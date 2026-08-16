"""Gateway-side git repository discovery.

Mirrors the assertions the same walk carries on the other two implementations —
``apps/desktop/electron/git-repo-scan.test.ts`` and the Rust
``apps/hermes-universal/src-tauri/src/repo_scan.rs`` tests — so the three stay
behaviourally identical.
"""

import os
from pathlib import Path

import pytest

from hermes_cli import web_repo_scan
from hermes_cli import web_server

pytest.importorskip("starlette.testclient")
from starlette.testclient import TestClient


def make_repo(directory: Path) -> Path:
    (directory / ".git").mkdir(parents=True)
    (directory / ".git" / "HEAD").write_text("ref: refs/heads/main\n")
    return directory


def roots_of(entries) -> list[str]:
    return [entry["root"] for entry in entries]


def test_disabled_policy_scans_nothing(tmp_path):
    make_repo(tmp_path / "alpha")

    assert web_repo_scan.scan_repos([str(tmp_path)], enabled=False) == []


def test_finds_repos_and_stops_descending_at_a_hit(tmp_path):
    make_repo(tmp_path / "alpha")
    # A repo nested inside a repo must not be reported — descent stops at the
    # outer hit, exactly like the desktop and Rust walks.
    make_repo(tmp_path / "alpha" / "inner")
    make_repo(tmp_path / "nested" / "beta")
    (tmp_path / "plain").mkdir()

    found = roots_of(web_repo_scan.scan_repos([str(tmp_path)]))

    assert found == [str(tmp_path / "alpha"), str(tmp_path / "nested" / "beta")]


def test_label_is_the_directory_basename(tmp_path):
    make_repo(tmp_path / "my-project")

    assert web_repo_scan.scan_repos([str(tmp_path)])[0]["label"] == "my-project"


def test_unreadable_git_head_is_not_a_repo(tmp_path):
    (tmp_path / "broken" / ".git").mkdir(parents=True)

    assert web_repo_scan.scan_repos([str(tmp_path)]) == []


def test_max_depth_is_honoured(tmp_path):
    make_repo(tmp_path / "a" / "b" / "c" / "deep")

    assert web_repo_scan.scan_repos([str(tmp_path)], max_depth=1) == []
    assert len(web_repo_scan.scan_repos([str(tmp_path)], max_depth=4)) == 1


def test_default_depth_cap_hides_deeper_repos(tmp_path):
    make_repo(tmp_path / "one" / "two" / "three" / "four")

    assert web_repo_scan.scan_repos([str(tmp_path)]) == []


def test_dotdirs_and_junk_dirs_are_skipped(tmp_path):
    make_repo(tmp_path / "node_modules" / "pkg")
    make_repo(tmp_path / ".cache" / "thing")
    make_repo(tmp_path / "keep")

    assert roots_of(web_repo_scan.scan_repos([str(tmp_path)])) == [str(tmp_path / "keep")]


def test_exclusions_cover_descendants(tmp_path):
    make_repo(tmp_path / "skipped" / "alpha")
    make_repo(tmp_path / "kept")

    found = web_repo_scan.scan_repos(
        [str(tmp_path)], exclude_paths=[str(tmp_path / "skipped")]
    )

    assert roots_of(found) == [str(tmp_path / "kept")]


def test_duplicate_and_nested_roots_are_deduped(tmp_path):
    make_repo(tmp_path / "alpha")

    found = web_repo_scan.scan_repos(
        [str(tmp_path), f"{tmp_path}{os.sep}", str(tmp_path / "alpha")]
    )

    assert len(found) == 1


def test_empty_roots_fall_back_to_home(tmp_path, monkeypatch):
    make_repo(tmp_path / "alpha")
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))

    assert roots_of(web_repo_scan.scan_repos([])) == [str(tmp_path / "alpha")]
    # Blank strings are not roots either — they must not widen the scan.
    assert roots_of(web_repo_scan.scan_repos(["   "])) == [str(tmp_path / "alpha")]


def test_tilde_and_relative_paths_expand_against_home():
    home = os.path.join(os.sep, "home", "tester")

    assert web_repo_scan.normalize_scan_path("~/code", home).value == os.path.join(home, "code")
    assert web_repo_scan.normalize_scan_path("code/../work", home).value == os.path.join(home, "work")
    assert web_repo_scan.normalize_scan_path("   ", home) is None


def test_containment_check_matches_descendants_only():
    home = os.path.join(os.sep, "home", "tester")

    def key(raw: str) -> str:
        return web_repo_scan.normalize_scan_path(raw, home).key

    assert web_repo_scan.path_is_within(key("~/code/app"), key("~/code"))
    assert web_repo_scan.path_is_within(key("~/code"), key("~/code"))
    # A sibling whose name merely starts with the excluded one is not inside it.
    assert not web_repo_scan.path_is_within(key("~/coder"), key("~/code"))
    assert not web_repo_scan.path_is_within(key("~/other"), key("~/code"))


def test_missing_root_is_not_an_error(tmp_path):
    assert web_repo_scan.scan_repos([str(tmp_path / "nope")]) == []


def test_policy_accepts_both_flat_and_nested_shapes():
    flat = web_repo_scan.resolve_repo_discovery_policy(
        {"repo_scan_enabled": False, "repo_scan_roots": [" ~/code "], "repo_scan_exclude_paths": []}
    )
    nested = web_repo_scan.resolve_repo_discovery_policy(
        {"enabled": False, "roots": ["~/code"], "exclude_paths": []}
    )

    assert flat == nested == {"enabled": False, "roots": ["~/code"], "exclude_paths": []}


def test_policy_falls_back_to_defaults_on_junk():
    policy = web_repo_scan.resolve_repo_discovery_policy(
        {"repo_scan_enabled": "yes", "repo_scan_roots": "nope", "repo_scan_exclude_paths": None}
    )

    assert policy == {"enabled": True, "roots": [], "exclude_paths": []}


def test_gateway_policy_matches_the_rpc_sink_resolver():
    """The RPC sink and the crawl must agree on what a policy means."""
    from tui_gateway.server import _repo_discovery_policy

    raw = {"repo_scan_enabled": True, "repo_scan_roots": ["~/code", ""], "repo_scan_exclude_paths": ["~/code/junk"]}

    assert _repo_discovery_policy(raw) == web_repo_scan.resolve_repo_discovery_policy(raw)


# ── The route ───────────────────────────────────────────────────────────────


@pytest.fixture
def client():
    previous = getattr(web_server.app.state, "auth_required", None)
    web_server.app.state.auth_required = False
    test_client = TestClient(web_server.app)
    test_client.headers[web_server._SESSION_HEADER_NAME] = web_server._SESSION_TOKEN
    try:
        yield test_client
    finally:
        if previous is None:
            try:
                delattr(web_server.app.state, "auth_required")
            except AttributeError:
                pass
        else:
            web_server.app.state.auth_required = previous


def test_scan_repos_route_uses_the_gateways_own_policy(client, tmp_path, monkeypatch):
    make_repo(tmp_path / "alpha")
    monkeypatch.setattr(
        web_repo_scan,
        "configured_policy",
        lambda: {"enabled": True, "roots": [str(tmp_path)], "exclude_paths": []},
    )

    body = client.get("/api/git/scan-repos").json()

    assert body["repos"] == [{"root": str(tmp_path / "alpha"), "label": "alpha"}]
    # Echoed back so an empty result is legible as a configuration answer
    # (disabled / no roots) rather than "this machine has no repos".
    assert body["policy"] == {"enabled": True, "roots": [str(tmp_path)], "exclude_paths": []}


def test_scan_repos_route_ignores_caller_supplied_roots(client, tmp_path, monkeypatch):
    """Roots are policy, not client input — a server-side walk must not be aimable."""
    secret = tmp_path / "elsewhere"
    make_repo(secret / "private")
    configured = tmp_path / "configured"
    make_repo(configured / "alpha")

    monkeypatch.setattr(
        web_repo_scan,
        "configured_policy",
        lambda: {"enabled": True, "roots": [str(configured)], "exclude_paths": []},
    )

    body = client.get(
        "/api/git/scan-repos",
        params={"roots": str(secret), "path": str(secret), "enabled": "true"},
    ).json()

    assert roots_of(body["repos"]) == [str(configured / "alpha")]


def test_scan_repos_route_honours_a_disabled_policy(client, tmp_path, monkeypatch):
    make_repo(tmp_path / "alpha")
    monkeypatch.setattr(
        web_repo_scan,
        "configured_policy",
        lambda: {"enabled": False, "roots": [str(tmp_path)], "exclude_paths": []},
    )

    assert client.get("/api/git/scan-repos").json()["repos"] == []


def test_scan_repos_route_requires_auth():
    unauth = TestClient(web_server.app)

    assert unauth.get("/api/git/scan-repos").status_code == 401
