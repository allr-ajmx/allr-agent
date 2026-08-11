import subprocess
from pathlib import Path

import pytest

from hermes_cli import web_server

pytest.importorskip("starlette.testclient")
from starlette.testclient import TestClient


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


def _git(repo: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True)


@pytest.fixture
def repo(tmp_path):
    root = tmp_path / "repo"
    root.mkdir()
    _git(root, "init", "-q")
    _git(root, "config", "user.email", "t@example.com")
    _git(root, "config", "user.name", "Test")
    (root / "a.txt").write_text("one\ntwo\n")
    _git(root, "add", "-A")
    _git(root, "commit", "-qm", "init")
    # A tracked modification + a brand-new untracked file (the new-file case the
    # rail/review must surface).
    (root / "a.txt").write_text("one\ntwo\nthree\n")
    (root / "new.py").write_text("print(1)\nprint(2)\n")
    return root










def test_stage_commit_roundtrip_clears_changes(client, repo):
    assert client.post("/api/git/review/stage", json={"path": str(repo), "file": "a.txt"}).json() == {"ok": True}
    staged = client.get("/api/git/status", params={"path": str(repo)}).json()
    assert staged["staged"] >= 1

    assert client.post(
        "/api/git/review/commit", json={"path": str(repo), "message": "tracked change", "push": False}
    ).json() == {"ok": True}

    after = client.get("/api/git/status", params={"path": str(repo)}).json()
    # The tracked change is committed; only the untracked file remains.
    assert after["changed"] == 1
    assert after["untracked"] == 1






def test_worktree_add_initializes_plain_folder(client, tmp_path):
    folder = tmp_path / "plain-project"
    folder.mkdir()
    (folder / "notes.txt").write_text("not committed\n")

    added = client.post(
        "/api/git/worktree/add", json={"path": str(folder), "branch": "feature/plain"}
    ).json()

    assert added["branch"] == "feature/plain"
    assert Path(added["path"]).is_dir()
    assert (folder / ".git").exists()
    _git(folder, "rev-parse", "--verify", "HEAD")

    status = client.get("/api/git/status", params={"path": str(folder)}).json()
    assert status["branch"] == status["defaultBranch"]
    assert status["branch"]
    # Existing files are not silently committed by repo initialization.
    assert any(file["path"] == "notes.txt" and file["untracked"] for file in status["files"])




@pytest.fixture
def cloned_repo(tmp_path, repo):
    """A clone of `repo` that has an extra branch only on the remote.

    `repo` gains `feature/remote-only`; the clone fetches it but never checks it
    out, so the clone sees it solely as `origin/feature/remote-only`.
    """
    _git(repo, "checkout", "-qb", "feature/remote-only")
    (repo / "remote-only.txt").write_text("from the remote\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "remote only")
    default = subprocess.run(
        ["git", "rev-parse", "--abbrev-ref", "HEAD"],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    _git(repo, "checkout", "-q", "-")
    assert default == "feature/remote-only"

    clone = tmp_path / "clone"
    subprocess.run(
        ["git", "clone", "-q", str(repo), str(clone)], check=True, capture_output=True
    )
    _git(clone, "config", "user.email", "t@example.com")
    _git(clone, "config", "user.name", "Test")
    return clone


def test_branch_list_offers_remote_only_branches(client, cloned_repo):
    branches = client.get("/api/git/branches", params={"path": str(cloned_repo)}).json()["branches"]
    by_name = {branch["name"]: branch for branch in branches}

    # The remote-only branch is offered under its remote-tracking name...
    remote_only = by_name["origin/feature/remote-only"]
    assert remote_only["isRemote"] is True
    assert remote_only["checkedOut"] is False
    assert remote_only["worktreePath"] is None

    # ...while a remote whose short name has a local head is suppressed, and
    # `origin/HEAD` (a symref alias, not a branch) never shows up at all.
    local_default = next(branch for branch in branches if branch["isDefault"])
    assert local_default["isRemote"] is False
    assert f"origin/{local_default['name']}" not in by_name
    assert not any(name.endswith("/HEAD") for name in by_name)


def test_branch_pickers_drop_the_remote_head_alias(client, cloned_repo):
    """`refs/remotes/origin/HEAD` must not surface as a branch named "origin".

    Git shortens that ref to a bare remote name, so a suffix test for "/HEAD" on
    the SHORT name never fires. The row that leaked through resolved to a
    commit-ish, so converting it ran `git worktree add <path> origin` and landed
    on a detached HEAD — the failure remote-branch support exists to prevent.
    """
    # The alias really is set on this clone, so the assertions below are not vacuous.
    head_alias = subprocess.run(
        ["git", "symbolic-ref", "refs/remotes/origin/HEAD"],
        cwd=cloned_repo,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    assert head_alias.startswith("refs/remotes/origin/")

    convert = client.get("/api/git/branches", params={"path": str(cloned_repo)}).json()["branches"]
    base = client.get("/api/git/base-branches", params={"path": str(cloned_repo)}).json()["branches"]

    assert "origin" not in {branch["name"] for branch in convert}
    assert "origin" not in {branch["name"] for branch in base}
    # The real remote branch still rides both lists.
    assert "origin/feature/remote-only" in {branch["name"] for branch in convert}
    remote_base = next(b for b in base if b["name"] == "origin/feature/remote-only")
    assert remote_base["isRemote"] is True


def test_base_branch_list_flags_a_non_origin_remote(client, cloned_repo, tmp_path):
    """`isRemote` comes from the ref namespace, not an "origin/" name prefix —
    a repo whose remote is called anything else is no less remote."""
    _git(cloned_repo, "remote", "rename", "origin", "upstream")
    _git(cloned_repo, "fetch", "-q", "upstream")

    base = client.get("/api/git/base-branches", params={"path": str(cloned_repo)}).json()["branches"]
    by_name = {branch["name"]: branch for branch in base}

    assert by_name["upstream/feature/remote-only"]["isRemote"] is True
    assert "upstream" not in by_name


def test_worktree_add_tracks_a_remote_only_branch(client, cloned_repo):
    added = client.post(
        "/api/git/worktree/add",
        json={"path": str(cloned_repo), "existingBranch": "origin/feature/remote-only"},
    ).json()

    # The local branch is created, not a detached HEAD on the remote ref.
    assert added["branch"] == "feature/remote-only"
    worktree = Path(added["path"])
    assert worktree.is_dir()

    head = subprocess.run(
        ["git", "symbolic-ref", "--quiet", "--short", "HEAD"],
        cwd=worktree,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    assert head == "feature/remote-only"

    upstream = subprocess.run(
        ["git", "rev-parse", "--abbrev-ref", "HEAD@{upstream}"],
        cwd=worktree,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    assert upstream == "origin/feature/remote-only"

    status = client.get("/api/git/status", params={"path": str(worktree)}).json()
    assert status["branch"] == "feature/remote-only"


def test_worktree_add_still_reuses_a_local_branch(client, cloned_repo):
    _git(cloned_repo, "branch", "feature/local-only")

    added = client.post(
        "/api/git/worktree/add",
        json={"path": str(cloned_repo), "existingBranch": "feature/local-only"},
    ).json()

    assert added["branch"] == "feature/local-only"
    head = subprocess.run(
        ["git", "symbolic-ref", "--quiet", "--short", "HEAD"],
        cwd=Path(added["path"]),
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    assert head == "feature/local-only"


def test_git_endpoints_require_auth(repo):
    unauth = TestClient(web_server.app)

    assert unauth.get("/api/git/status", params={"path": str(repo)}).status_code == 401
    assert unauth.post("/api/git/review/stage", json={"path": str(repo)}).status_code == 401
