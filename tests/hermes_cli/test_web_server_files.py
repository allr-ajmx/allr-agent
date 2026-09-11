"""Tests for the dashboard-managed file browser API."""

from types import SimpleNamespace

import pytest
from starlette.testclient import TestClient

from hermes_cli import web_server


def _client_with_app_state():
    prev_auth_required = getattr(web_server.app.state, "auth_required", None)
    prev_bound_host = getattr(web_server.app.state, "bound_host", None)
    web_server.app.state.auth_required = False
    web_server.app.state.bound_host = None

    client = TestClient(web_server.app)
    client.headers[web_server._SESSION_HEADER_NAME] = web_server._SESSION_TOKEN
    return client, prev_auth_required, prev_bound_host


def _restore_app_state(prev_auth_required, prev_bound_host):
    if prev_auth_required is None:
        delattr(web_server.app.state, "auth_required")
    else:
        web_server.app.state.auth_required = prev_auth_required
    if prev_bound_host is None:
        if hasattr(web_server.app.state, "bound_host"):
            delattr(web_server.app.state, "bound_host")
    else:
        web_server.app.state.bound_host = prev_bound_host


def _close_client(client):
    close = getattr(client, "close", None)
    if close is not None:
        close()


@pytest.fixture
def forced_files_client(monkeypatch, tmp_path):
    root = tmp_path / "data"
    monkeypatch.setenv("ALLR_DASHBOARD_FILES_ROOT", str(root))

    client, prev_auth_required, prev_bound_host = _client_with_app_state()
    try:
        yield client, root
    finally:
        _close_client(client)
        _restore_app_state(prev_auth_required, prev_bound_host)


@pytest.fixture
def local_files_client(monkeypatch, tmp_path):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.delenv("ALLR_DASHBOARD_FILES_ROOT", raising=False)
    monkeypatch.delenv("ALLR_HOME", raising=False)
    monkeypatch.setenv("HOME", str(home))

    client, prev_auth_required, prev_bound_host = _client_with_app_state()
    try:
        yield client, home
    finally:
        _close_client(client)
        _restore_app_state(prev_auth_required, prev_bound_host)














def _seed_file(client, root, name="out/hello.txt"):
    file_path = root / name
    created = client.post(
        "/api/files/upload",
        json={"path": str(file_path), "data_url": "data:text/plain;base64,aGVsbG8="},
    )
    assert created.status_code == 200
    return file_path




def test_download_authenticates_via_query_token(forced_files_client):
    client, root = forced_files_client
    file_path = _seed_file(client, root)

    # Drop the session header so only the ?token= query param authenticates —
    # mirrors a browser/shell-opened download that can't set the session header.
    del client.headers[web_server._SESSION_HEADER_NAME]

    ok = client.get(
        "/api/files/download",
        params={"path": str(file_path), "token": web_server._SESSION_TOKEN},
    )
    assert ok.status_code == 200
    assert ok.content == b"hello"

    assert client.get(
        "/api/files/download", params={"path": str(file_path), "token": "nope"}
    ).status_code == 401
    assert client.get(
        "/api/files/download", params={"path": str(file_path)}
    ).status_code == 401


# ---------------------------------------------------------------------------
# Folder download (/api/files/download-archive) and the lifted download ceiling
# ---------------------------------------------------------------------------


def _seed_tree(root):
    """A directory with one member of every category the archive must decide on."""
    tree = root / "project"
    (tree / "src").mkdir(parents=True, exist_ok=True)
    (tree / "src" / "main.py").write_text("print('hi')\n")
    (tree / "README.md").write_text("# readme\n")
    # Sensitive: a credential basename the managed-files guard denies everywhere.
    (tree / ".env").write_text("SECRET_KEY=abc123\n")
    # Build/VCS noise the listing endpoint already hides.
    (tree / "node_modules").mkdir(exist_ok=True)
    (tree / "node_modules" / "junk.js").write_text("// vendored\n")
    # A credential DIRECTORY tree, denied by component and not by basename.
    (tree / "mcp-tokens").mkdir(exist_ok=True)
    (tree / "mcp-tokens" / "github.json").write_text('{"access_token": "SECRET"}\n')
    return tree


def _archive_of(client, path):
    """Fetch the archive and return ``(sorted names, {name: bytes})``."""
    import io
    import zipfile

    response = client.get("/api/files/download-archive", params={"path": str(path)})
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "application/zip"
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        # A streamed archive is written with per-member data descriptors rather
        # than back-patched local headers; testzip() is what proves the result
        # is a readable zip and not merely a plausible byte string.
        assert archive.testzip() is None
        names = sorted(archive.namelist())
        return names, {name: archive.read(name) for name in names}


def test_archive_contains_the_expected_members(forced_files_client):
    client, root = forced_files_client
    tree = _seed_tree(root)

    names, contents = _archive_of(client, tree)
    assert names == ["README.md", "src/main.py"]
    assert contents["src/main.py"] == b"print('hi')\n"


def test_archive_names_the_download_after_the_directory(forced_files_client):
    client, root = forced_files_client
    tree = _seed_tree(root)

    response = client.get("/api/files/download-archive", params={"path": str(tree)})
    assert response.headers["content-disposition"].startswith(
        'attachment; filename="project.zip"'
    )


def test_archive_excludes_sensitive_and_hidden_members(forced_files_client):
    """#57505 from the other side: the archive must not become the exfil path
    the listing and read routes refuse to be."""
    client, root = forced_files_client
    tree = _seed_tree(root)

    names, _contents = _archive_of(client, tree)
    assert ".env" not in names
    assert "mcp-tokens/github.json" not in names
    assert not any(name.startswith("node_modules/") for name in names)


def test_archive_skips_symlinked_members(forced_files_client):
    """A symlink is the one member that could walk out of a locked root."""
    client, root = forced_files_client
    tree = _seed_tree(root)
    outside = root.parent / "outside-secret.txt"
    outside.write_text("not yours\n")
    try:
        (tree / "escape.txt").symlink_to(outside)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks unavailable on this platform")

    names, _contents = _archive_of(client, tree)
    assert "escape.txt" not in names


def test_archive_refuses_a_path_outside_a_locked_root(forced_files_client):
    client, root = forced_files_client
    root.mkdir(parents=True, exist_ok=True)
    outside = root.parent / "elsewhere"
    outside.mkdir(exist_ok=True)
    (outside / "file.txt").write_text("nope\n")

    denied = client.get("/api/files/download-archive", params={"path": str(outside)})
    assert denied.status_code == 403


def test_archive_404_is_distinguishable_from_a_missing_route(forced_files_client):
    """MJXHRM-511 freezes the gateway, so the desktop client must feature-detect
    this route and hide the folder-download affordance on an older backend
    instead of erroring. Both 404s look alike by status, so the client tells
    them apart by BODY: this route's 404 always carries a FastAPI ``detail``
    that does not mention a route, while an unmatched /api/* path lands on one
    of the two catch-alls — ``{"detail": "No such API endpoint: ..."}`` when the
    SPA is built, ``{"error": "Frontend not built..."}`` when it is not. Both
    shapes are pinned here; breaking either one makes every folder download on a
    current gateway silently disappear instead."""
    client, root = forced_files_client
    file_path = _seed_file(client, root)

    not_a_dir = client.get("/api/files/download-archive", params={"path": str(file_path)})
    assert not_a_dir.status_code == 400

    missing = client.get(
        "/api/files/download-archive", params={"path": str(root / "no-such-dir")}
    )
    assert missing.status_code == 404
    body = missing.json()
    assert "detail" in body
    assert "No such API endpoint" not in body["detail"]

    absent_route = client.get("/api/files/download-archive-that-does-not-exist").json()
    assert "error" in absent_route or "No such API endpoint" in absent_route.get("detail", "")


def test_archive_authenticates_via_query_token(forced_files_client):
    client, root = forced_files_client
    tree = _seed_tree(root)

    del client.headers[web_server._SESSION_HEADER_NAME]

    assert client.get(
        "/api/files/download-archive",
        params={"path": str(tree), "token": web_server._SESSION_TOKEN},
    ).status_code == 200
    assert client.get(
        "/api/files/download-archive", params={"path": str(tree)}
    ).status_code == 401


def test_large_file_downloads_but_still_cannot_be_read(forced_files_client, monkeypatch):
    """The 100 MB ceiling was the wrong guard on the wrong route.

    /api/files/read base64-encodes the whole file into a JSON body and genuinely
    cannot afford a large one, so it keeps the cap. /api/files/download hands a
    FileResponse to the ASGI server, which streams it in fixed-size chunks — the
    cap there only ever meant "the desktop app cannot download your 200 MB
    checkpoint". The constant is lowered rather than a 100 MB file written, so
    the test stays fast; what it pins is which route enforces it.
    """
    client, root = forced_files_client
    monkeypatch.setattr(web_server, "_MANAGED_FILE_MAX_BYTES", 8)

    root.mkdir(parents=True, exist_ok=True)
    big = root / "big.bin"
    big.write_bytes(b"x" * 64)

    assert client.get("/api/files/read", params={"path": str(big)}).status_code == 413

    downloaded = client.get("/api/files/download", params={"path": str(big)})
    assert downloaded.status_code == 200
    assert downloaded.content == b"x" * 64


def test_query_token_does_not_authenticate_other_endpoints(forced_files_client):
    client, root = forced_files_client
    file_path = _seed_file(client, root)

    del client.headers[web_server._SESSION_HEADER_NAME]

    # The query-token escape hatch is scoped to /api/files/download only; it must
    # not unlock the rest of the API surface.
    leaked = client.get(
        "/api/files/read",
        params={"path": str(file_path), "token": web_server._SESSION_TOKEN},
    )
    assert leaked.status_code == 401




# ---------------------------------------------------------------------------
# Streaming multipart upload (/api/files/upload-stream) — NS-501
# ---------------------------------------------------------------------------








def test_stream_upload_cleans_temp_on_cancellation(forced_files_client):
    """A client disconnect mid-stream (asyncio.CancelledError) must not leak a temp file.

    CancelledError is a BaseException, not an Exception, so it bypasses the
    endpoint's ``except`` clauses entirely. The cleanup therefore lives in a
    ``finally`` keyed on a success flag — without it, every aborted large
    upload (the exact NS-501 scenario) would orphan a partial ``.upload`` temp
    file in the target directory. We invoke the endpoint coroutine directly so
    the BaseException propagates instead of being swallowed by the test client.
    """
    import asyncio

    _client, root = forced_files_client
    target = root / "out" / "aborted.bin"
    target.parent.mkdir(parents=True, exist_ok=True)

    class _AbortingUpload:
        """UploadFile stand-in that yields one chunk then aborts like a dropped client."""

        filename = "aborted.bin"

        def __init__(self):
            self._calls = 0

        async def read(self, _size):
            self._calls += 1
            if self._calls == 1:
                return b"partial chunk before the client vanished"
            raise asyncio.CancelledError()

        async def close(self):
            return None

    request = SimpleNamespace()

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(
            web_server.upload_managed_file_stream(
                request=request,
                file=_AbortingUpload(),
                path=str(target),
                overwrite=True,
            )
        )

    # No partial data was promoted into place ...
    assert not target.exists()
    # ... and no .upload temp file was left behind.
    leftovers = [p.name for p in target.parent.iterdir() if ".upload" in p.name]
    assert leftovers == [], f"temp upload files leaked on cancellation: {leftovers}"


def test_sensitive_env_files_hidden_from_listing(forced_files_client):
    """Regression test for #57505: .env files must not appear in directory listings."""
    client, root = forced_files_client

    # Create a regular file and .env variants including shorthand suffixes.
    root.mkdir(parents=True, exist_ok=True)
    regular = root / "config.txt"
    regular.write_text("safe content")
    env_file = root / ".env"
    env_file.write_text("SECRET_KEY=abc123")
    env_local = root / ".env.local"
    env_local.write_text("LOCAL_SECRET=def456")
    env_prod = root / ".env.prod"
    env_prod.write_text("PROD_SECRET=ghi789")

    listing = client.get("/api/files", params={"path": str(root)})
    assert listing.status_code == 200
    names = [e["name"] for e in listing.json()["entries"]]
    assert "config.txt" in names
    assert ".env" not in names
    assert ".env.local" not in names
    assert ".env.prod" not in names












def test_other_credential_store_basenames_blocked(forced_files_client):
    """Regression: the managed-files guard must cover the same credential
    basenames as gateway.platforms.base._ROOT_CREDENTIAL_FILES and
    agent.file_safety.get_read_block_error, not just .env — an operator can
    point the managed root at ALLR_HOME itself (#57505), which contains
    all of these live secret stores."""
    client, root = forced_files_client
    root.mkdir(parents=True, exist_ok=True)

    for name in (
        "auth.json",
        "auth.lock",
        "credentials",
        "config.yaml",
        ".anthropic_oauth.json",
        "google_token.json",
        "google_oauth_pending.json",
        "google_oauth.json",
        "webhook_subscriptions.json",
        "bws_cache.json",
        "bws_cache.enc.json",
    ):
        p = root / name
        p.write_text("SECRET=abc123")
        assert client.get("/api/files/read", params={"path": str(p)}).status_code == 403, name
        assert client.get("/api/files/download", params={"path": str(p)}).status_code == 403, name

    listing = client.get("/api/files", params={"path": str(root)})
    names = [e["name"] for e in listing.json()["entries"]]
    assert names == []




def test_credential_dir_trees_blocked_on_subdir_descent(forced_files_client):
    """Regression: mcp-tokens/ (live MCP OAuth tokens) and pairing/ are denied
    as whole directory trees by both canonical guards
    (gateway.platforms.base._ROOT_CREDENTIAL_DIRS and
    agent.file_safety). A basename-only check would still expose their
    per-server files (e.g. ``mcp-tokens/github.json``) once the browser
    descends into the subdir. The managed-files guard must block any path with
    a credential-directory component, not just leaf basenames."""
    client, root = forced_files_client
    root.mkdir(parents=True, exist_ok=True)

    # A per-server MCP token file with a NON-canonical basename that the
    # basename denylist alone would not catch.
    mcp_dir = root / "mcp-tokens"
    mcp_dir.mkdir(parents=True, exist_ok=True)
    mcp_file = mcp_dir / "github.json"
    mcp_file.write_text('{"access_token": "SECRET"}\n')

    pairing_dir = root / "pairing"
    pairing_dir.mkdir(parents=True, exist_ok=True)
    pairing_file = pairing_dir / "device-abc"
    pairing_file.write_text("PAIRING-SECRET\n")

    # The token dirs themselves must not appear in the root listing.
    root_names = [e["name"] for e in client.get(
        "/api/files", params={"path": str(root)}).json()["entries"]]
    assert "mcp-tokens" not in root_names
    assert "pairing" not in root_names

    # Read/download of the per-server files must be denied even though their
    # basenames aren't in _SENSITIVE_MANAGED_FILE_BASENAMES.
    for p in (mcp_file, pairing_file):
        assert client.get("/api/files/read", params={"path": str(p)}).status_code == 403, str(p)
        assert client.get("/api/files/download", params={"path": str(p)}).status_code == 403, str(p)

    # Listing the credential dir itself yields nothing exploitable: every child
    # is filtered because the parent component is a credential dir.
    mcp_listing = client.get("/api/files", params={"path": str(mcp_dir)})
    assert [e["name"] for e in mcp_listing.json()["entries"]] == []


