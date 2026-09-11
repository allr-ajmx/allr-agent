import base64
from pathlib import Path

import pytest

from hermes_cli import web_server

pytest.importorskip("starlette.testclient")
from starlette.testclient import TestClient


@pytest.fixture
def client(monkeypatch):
    previous_auth_required = getattr(web_server.app.state, "auth_required", None)
    web_server.app.state.auth_required = False
    test_client = TestClient(web_server.app)
    test_client.headers[web_server._SESSION_HEADER_NAME] = web_server._SESSION_TOKEN
    try:
        yield test_client
    finally:
        if previous_auth_required is None:
            try:
                delattr(web_server.app.state, "auth_required")
            except AttributeError:
                pass
        else:
            web_server.app.state.auth_required = previous_auth_required


def test_fs_list_sorts_and_hides_noise(client, tmp_path):
    root = tmp_path / "project"
    root.mkdir()
    (root / "b.txt").write_text("b")
    (root / "a_dir").mkdir()
    (root / "a.txt").write_text("a")
    (root / "node_modules").mkdir()
    (root / ".git").mkdir()

    response = client.get("/api/fs/list", params={"path": str(root)})

    assert response.status_code == 200
    entries = response.json()["entries"]
    assert [entry["name"] for entry in entries] == ["a_dir", "a.txt", "b.txt"]
    assert entries[0] == {"name": "a_dir", "path": str(root / "a_dir"), "isDirectory": True}
    assert all(entry["name"] not in {".git", "node_modules"} for entry in entries)


def test_fs_read_data_url_rejects_over_cap(client, tmp_path, monkeypatch):
    monkeypatch.setattr(web_server, "_FS_DATA_URL_MAX_BYTES", 3)
    target = tmp_path / "image.png"
    target.write_bytes(b"1234")

    response = client.get("/api/fs/read-data-url", params={"path": str(target)})

    assert response.status_code == 413


def test_fs_endpoints_require_auth(tmp_path):
    client = TestClient(web_server.app)
    target = tmp_path / "secret.txt"
    target.write_text("secret")

    list_response = client.get("/api/fs/list", params={"path": str(tmp_path)})
    read_response = client.get("/api/fs/read-text", params={"path": str(target)})
    default_response = client.get("/api/fs/default-cwd")

    assert list_response.status_code == 401
    assert read_response.status_code == 401
    assert default_response.status_code == 401


# ---------------------------------------------------------------------------
# GET /api/fs/search
#
# The ranking + entry-shaping half lives in ``tui_gateway.file_search`` (a pure
# move of the gateway's `complete.path` ranker), so most of these assertions
# need no TestClient at all — per design rule 35, the decision half is testable
# without the transport.
# ---------------------------------------------------------------------------

from tui_gateway import file_search as _file_search  # noqa: E402


@pytest.fixture(autouse=True)
def _clear_fuzzy_cache():
    """`_list_repo_files` memoizes per root for 5s; each test gets a fresh dir,
    but clear anyway so a reused tmp path can never serve a stale listing."""
    _file_search._fuzzy_cache.clear()
    yield
    _file_search._fuzzy_cache.clear()


def _tree(root: Path) -> None:
    (root / "widget.ts").write_text("x")
    (root / "src").mkdir()
    (root / "src" / "appChrome.tsx").write_text("x")
    # Matches "widget.ts" only as a subsequence (w-i-d-g-e-t-.-t-s in order).
    (root / "src" / "wild-dog-eats-toast.ts").write_text("x")
    (root / ".hidden.txt").write_text("x")
    (root / "node_modules").mkdir()
    (root / "node_modules" / "widget.ts").write_text("x")


def test_search_exact_basename_outranks_subsequence(tmp_path):
    _tree(tmp_path)

    entries = _file_search.search_entries(str(tmp_path), "widget.ts")
    names = [e["name"] for e in entries]

    assert names[0] == "widget.ts"
    assert entries[0]["rank"] == 0
    # `wild-dog-eats-toast.ts` matches "widget.ts" only as a subsequence
    # (tier 4) and must therefore sort strictly after the exact hit.
    subsequence = [e for e in entries if e["name"].startswith("wild-dog")]
    assert subsequence, "expected the subsequence match to still be returned"
    assert subsequence[0]["rank"] == 4
    assert names.index("widget.ts") < names.index(subsequence[0]["name"])


def test_search_tiers_cover_prefix_and_word_boundary(tmp_path):
    _tree(tmp_path)

    by_name = {e["name"]: e["rank"] for e in _file_search.search_entries(str(tmp_path), "app")}
    assert by_name["appChrome.tsx"] == 1  # basename prefix

    by_name = {e["name"]: e["rank"] for e in _file_search.search_entries(str(tmp_path), "chrome")}
    assert by_name["appChrome.tsx"] == 2  # camelCase word boundary

    by_name = {e["name"]: e["rank"] for e in _file_search.search_entries(str(tmp_path), "idget")}
    assert by_name["widget.ts"] == 3  # substring


def test_search_finds_a_folder_with_no_matching_file_inside(tmp_path):
    """The listing is files-only, so a folder is reachable only via ancestor
    ranking (or the root's-children seed). `Desktop/notes.md` matches neither
    `Desk` nor `Deskt`, so only the ancestor pass can surface the folder."""
    nested = tmp_path / "outer" / "Desktop"
    nested.mkdir(parents=True)
    (nested / "notes.md").write_text("x")

    entries = _file_search.search_entries(str(tmp_path), "Desktop")

    match = [e for e in entries if e["name"] == "Desktop"]
    assert match, [e["name"] for e in entries]
    assert match[0]["isDirectory"] is True
    assert match[0]["path"] == str(nested)


def test_search_hides_dotfiles_unless_the_query_starts_with_a_dot(tmp_path):
    _tree(tmp_path)

    assert not [e for e in _file_search.search_entries(str(tmp_path), "hidden")]
    assert [e for e in _file_search.search_entries(str(tmp_path), ".hidden")]


def test_search_seed_respects_fallback_excludes(tmp_path):
    (tmp_path / "node_modules").mkdir()

    assert not [
        e
        for e in _file_search.search_entries(str(tmp_path), "node_modules")
        if e["name"] == "node_modules"
    ]


def test_search_caps_results(tmp_path):
    for i in range(40):
        (tmp_path / f"match{i}.txt").write_text("x")

    assert len(_file_search.search_entries(str(tmp_path), "match", limit=5)) == 5
    # A nonsense limit must not blow the cap open or return nothing.
    assert len(_file_search.search_entries(str(tmp_path), "match", limit=0)) >= 1
    assert (
        len(_file_search.search_entries(str(tmp_path), "match", limit=10_000))
        <= _file_search.FS_SEARCH_MAX_LIMIT
    )


def test_fs_search_route_returns_fs_list_entry_shape(client, tmp_path):
    _tree(tmp_path)

    search = client.get("/api/fs/search", params={"path": str(tmp_path), "q": "widget.ts"})
    listing = client.get("/api/fs/list", params={"path": str(tmp_path)})

    assert search.status_code == 200
    entry = search.json()["entries"][0]
    assert set(entry) == set(listing.json()["entries"][0]) | {"rank"}
    assert entry["name"] == "widget.ts"
    assert entry["path"] == str(tmp_path / "widget.ts")
    assert entry["isDirectory"] is False


def test_fs_search_hardens_path_like_fs_list(client, tmp_path):
    for params in (
        {"path": "", "q": "a"},
        {"path": "   ", "q": "a"},
        {"path": "with\0nul", "q": "a"},
    ):
        search = client.get("/api/fs/search", params=params)
        listing = client.get("/api/fs/list", params={"path": params["path"]})
        assert search.status_code == 400, params
        assert search.status_code == listing.status_code, params

    # A traversal is resolved (not rejected) exactly as `_fs_path` does for
    # `fs_list`: the answer is about the resolved directory, not the literal.
    nested = tmp_path / "a" / "b"
    nested.mkdir(parents=True)
    (tmp_path / "a" / "target.txt").write_text("x")
    response = client.get(
        "/api/fs/search", params={"path": f"{nested}/../", "q": "target"}
    )
    assert response.status_code == 200
    assert [e["name"] for e in response.json()["entries"]] == ["target.txt"]


def test_fs_search_missing_path_is_200_not_404(client, tmp_path):
    """MJXHRM-511 feature-detection contract, server side.

    A *missing directory* must never be reported the way a *missing route* is,
    because a bare 404 is ambiguous: this app has two catch-alls that both 404
    (`{"detail": "No such API endpoint: ..."}` when the SPA is built,
    `{"error": "Frontend not built..."}` when it is not) and neither carries an
    `entries` key. So the discriminator is the BODY: `entries` present ⇒ the
    route exists; `entries` absent ⇒ this gateway predates the route.
    """
    missing = client.get(
        "/api/fs/search", params={"path": str(tmp_path / "nope"), "q": "x"}
    )
    assert missing.status_code == 200
    assert missing.json() == {"entries": [], "error": "ENOENT"}

    a_file = tmp_path / "afile.txt"
    a_file.write_text("x")
    not_dir = client.get("/api/fs/search", params={"path": str(a_file), "q": "x"})
    assert not_dir.status_code == 200
    assert not_dir.json() == {"entries": [], "error": "ENOTDIR"}

    # ...and the route-missing shape, from the same client, for contrast.
    absent_route = client.get("/api/fs/search-that-does-not-exist", params={"path": "/"})
    assert absent_route.status_code == 404
    body = absent_route.json()
    assert "entries" not in body
    assert "detail" in body or "error" in body


def test_fs_search_requires_auth(tmp_path):
    unauthenticated = TestClient(web_server.app)
    response = unauthenticated.get("/api/fs/search", params={"path": str(tmp_path), "q": "a"})
    assert response.status_code == 401


# ---------------------------------------------------------------------------
# GET /api/fs/default-cwd — `home` + profile scoping
# ---------------------------------------------------------------------------


def _make_profile(name: str, *, terminal_cwd: Path | None = None) -> Path:
    """Create a real named profile home and return its directory."""
    from hermes_cli import profiles as profiles_mod

    profile_dir = profiles_mod.get_profile_dir(name)
    profile_dir.mkdir(parents=True, exist_ok=True)
    if terminal_cwd is not None:
        import yaml

        (profile_dir / "config.yaml").write_text(
            yaml.safe_dump({"terminal": {"cwd": str(terminal_cwd)}}), encoding="utf-8"
        )
    return profile_dir


def test_fs_default_cwd_reports_the_gateway_home(client):
    response = client.get("/api/fs/default-cwd")

    assert response.status_code == 200
    body = response.json()
    assert "home" in body
    assert body["home"] == str(Path.home())
    assert Path(body["home"]).is_absolute()


def test_fs_default_cwd_is_profile_scoped(client, tmp_path):
    alpha_cwd = tmp_path / "alpha-workspace"
    beta_cwd = tmp_path / "beta-workspace"
    alpha_cwd.mkdir()
    beta_cwd.mkdir()
    _make_profile("alpha", terminal_cwd=alpha_cwd)
    _make_profile("beta", terminal_cwd=beta_cwd)

    alpha = client.get("/api/fs/default-cwd", params={"profile": "alpha"})
    beta = client.get("/api/fs/default-cwd", params={"profile": "beta"})

    assert alpha.status_code == 200 and beta.status_code == 200
    assert alpha.json()["cwd"] == str(alpha_cwd)
    assert beta.json()["cwd"] == str(beta_cwd)
    assert alpha.json()["cwd"] != beta.json()["cwd"]


def test_fs_default_cwd_prefers_the_profiles_active_project(client, tmp_path):
    from hermes_cli import projects_db as pdb

    config_cwd = tmp_path / "from-config"
    project_dir = tmp_path / "from-active-project"
    config_cwd.mkdir()
    project_dir.mkdir()
    profile_dir = _make_profile("alpha", terminal_cwd=config_cwd)

    with pdb.connect_closing(profile_dir / "projects.db") as conn:
        pid = pdb.create_project(conn, name="Alpha", folders=[str(project_dir)])
        pdb.set_active(conn, pid)

    response = client.get("/api/fs/default-cwd", params={"profile": "alpha"})

    assert response.status_code == 200
    assert response.json()["cwd"] == str(project_dir)


def test_fs_default_cwd_falls_through_a_stale_active_project(client, tmp_path):
    """A project whose primary folder was deleted must degrade to terminal.cwd,
    not 500 and not hand back a path that no longer exists."""
    from hermes_cli import projects_db as pdb

    config_cwd = tmp_path / "from-config"
    config_cwd.mkdir()
    stale = tmp_path / "deleted-repo"
    stale.mkdir()
    profile_dir = _make_profile("alpha", terminal_cwd=config_cwd)

    with pdb.connect_closing(profile_dir / "projects.db") as conn:
        pid = pdb.create_project(conn, name="Alpha", folders=[str(stale)])
        pdb.set_active(conn, pid)
    stale.rmdir()

    response = client.get("/api/fs/default-cwd", params={"profile": "alpha"})

    assert response.status_code == 200
    assert response.json()["cwd"] == str(config_cwd)


def test_fs_default_cwd_degrades_without_a_projects_db(client, tmp_path):
    config_cwd = tmp_path / "from-config"
    config_cwd.mkdir()
    profile_dir = _make_profile("alpha", terminal_cwd=config_cwd)
    assert not (profile_dir / "projects.db").exists()

    response = client.get("/api/fs/default-cwd", params={"profile": "alpha"})

    assert response.status_code == 200
    assert response.json()["cwd"] == str(config_cwd)
    # Reading a default cwd must never CREATE the profile's projects DB.
    assert not (profile_dir / "projects.db").exists()


def test_fs_default_cwd_rejects_an_unknown_profile(client):
    response = client.get("/api/fs/default-cwd", params={"profile": "no-such-profile"})
    assert response.status_code == 404
