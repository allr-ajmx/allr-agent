import shutil
import subprocess
from pathlib import Path

import pytest

from hermes_cli import web_git, web_server

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


def _git_out(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=repo, check=True, capture_output=True, text=True
    ).stdout.strip()


def _head_of(worktree: Path) -> str:
    """The branch checked out in `worktree` — "" when HEAD is detached."""
    return subprocess.run(
        ["git", "symbolic-ref", "--quiet", "--short", "HEAD"],
        cwd=worktree,
        capture_output=True,
        text=True,
    ).stdout.strip()


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

    # ...while a remote whose branch has a local head is suppressed.
    local_default = next(branch for branch in branches if branch["isDefault"])
    assert local_default["isRemote"] is False
    assert f"origin/{local_default['name']}" not in by_name
    # NOTE: this test used to also assert no name ends in "/HEAD". That could
    # never fail — git shortens `refs/remotes/origin/HEAD` to a bare `origin`,
    # so the alias it claimed to catch was never spelled that way. It read as
    # coverage while the alias leaked; `test_branch_pickers_drop_the_remote_head_alias`
    # is the assertion that actually discriminates.


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


def test_base_branch_list_flags_a_non_origin_remote(client, cloned_repo):
    """`isRemote` and the default flag come from the repo's real remotes, not
    from an "origin/" name prefix — a repo whose remote is called anything else
    is no less remote.

    The default flag is what the picker preselects, and that value becomes the
    `base` every new worktree is cut from. Reading it off a literal
    `refs/remotes/origin/HEAD` came up empty here and fell through to the LOCAL
    trunk, so work branched off an unfetched copy instead of the remote's.
    """
    _git(cloned_repo, "remote", "rename", "origin", "upstream")
    _git(cloned_repo, "fetch", "-q", "upstream")
    # The rename really did leave a HEAD alias to find, so the assertions below
    # are not passing for want of one.
    assert subprocess.run(
        ["git", "symbolic-ref", "refs/remotes/upstream/HEAD"],
        cwd=cloned_repo,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip().startswith("refs/remotes/upstream/")

    base = client.get("/api/git/base-branches", params={"path": str(cloned_repo)}).json()["branches"]
    by_name = {branch["name"]: branch for branch in base}

    assert by_name["upstream/feature/remote-only"]["isRemote"] is True
    assert "upstream" not in by_name

    trunk = _git_out(cloned_repo, "rev-parse", "--abbrev-ref", "HEAD")
    default = next(branch for branch in base if branch["isDefault"])
    assert default["name"] == f"upstream/{trunk}"
    assert default["isRemote"] is True


@pytest.fixture
def slashy_remote_repo(cloned_repo):
    """A clone whose remote is named with a slash in it — git allows it, and it
    breaks every shortcut that treats a remote name as one path segment."""
    _git(cloned_repo, "remote", "rename", "origin", "corp/mirror")
    _git(cloned_repo, "fetch", "-q", "corp/mirror")
    _git(cloned_repo, "remote", "set-head", "corp/mirror", "-a")
    return cloned_repo


def test_pickers_survive_a_remote_named_with_a_slash(client, slashy_remote_repo):
    """`refs/remotes/corp/mirror/HEAD` is still just an alias, and
    `corp/mirror/feature/x` is still the branch `feature/x`.

    Matching the alias by ref depth (four segments) or splitting the short name
    on its first "/" both assume a remote name is a single path segment. Neither
    holds here: the alias leaked back in as a phantom branch called
    `corp/mirror`, and converting a real row created a branch misnamed
    `mirror/feature/remote-only`.
    """
    names = {
        branch["name"]
        for branch in client.get(
            "/api/git/branches", params={"path": str(slashy_remote_repo)}
        ).json()["branches"]
    }

    assert "corp/mirror" not in names
    assert "corp/mirror/feature/remote-only" in names
    # The remote copy of a branch that has a local head is still suppressed —
    # the dedup has to split off the real remote name to see they match.
    local = _git_out(slashy_remote_repo, "rev-parse", "--abbrev-ref", "HEAD")
    assert local in names
    assert f"corp/mirror/{local}" not in names

    added = client.post(
        "/api/git/worktree/add",
        json={"path": str(slashy_remote_repo), "existingBranch": "corp/mirror/feature/remote-only"},
    ).json()

    assert added["branch"] == "feature/remote-only"
    assert _head_of(Path(added["path"])) == "feature/remote-only"


@pytest.mark.parametrize("kind", ["tag", "sha", "head"])
def test_worktree_add_refuses_a_commit_ish_instead_of_detaching(client, cloned_repo, kind):
    """`git worktree add <path> <commit-ish>` checks out a nameless HEAD.

    A tag, a raw sha and "HEAD" all resolve, so passing one straight through
    produced exactly the detached worktree this endpoint exists to prevent —
    commits there belong to no branch and a push has no upstream. Only something
    that is provably a branch may reach git.
    """
    _git(cloned_repo, "tag", "v1.0")
    requested = {
        "tag": "v1.0",
        "sha": _git_out(cloned_repo, "rev-parse", "HEAD"),
        "head": "HEAD",
    }[kind]

    response = client.post(
        "/api/git/worktree/add", json={"path": str(cloned_repo), "existingBranch": requested}
    )

    assert response.status_code == 400
    assert "no branch named" in response.json()["detail"].lower()
    # Nothing was checked out anywhere, detached or otherwise.
    assert not (cloned_repo / ".worktrees").exists()


def test_worktree_add_converts_a_branch_whose_name_has_punctuation(client, cloned_repo):
    """A name the picker offered must be one convert accepts.

    `#`, `+` and `@` are legal in a branch name; the sanitizer meant for typed
    input rewrote them (`fix#123` → `fix123`), so rows the gateway had just
    listed came back "invalid reference" when clicked.
    """
    _git(cloned_repo, "branch", "fix#123")

    listed = {
        branch["name"]
        for branch in client.get(
            "/api/git/branches", params={"path": str(cloned_repo)}
        ).json()["branches"]
    }
    assert "fix#123" in listed

    added = client.post(
        "/api/git/worktree/add", json={"path": str(cloned_repo), "existingBranch": "fix#123"}
    ).json()

    assert added["branch"] == "fix#123"
    assert _head_of(Path(added["path"])) == "fix#123"


def test_worktree_add_recovers_a_worktree_deleted_off_disk(client, cloned_repo):
    """A worktree directory removed by hand stays registered, and git then
    refuses that path forever — a dead end, since the dialog cannot prune."""
    first = client.post(
        "/api/git/worktree/add",
        json={"path": str(cloned_repo), "existingBranch": "origin/feature/remote-only"},
    ).json()
    shutil.rmtree(first["path"])
    assert "prunable" in subprocess.run(
        ["git", "worktree", "list", "--porcelain"],
        cwd=cloned_repo,
        check=True,
        capture_output=True,
        text=True,
    ).stdout

    again = client.post(
        "/api/git/worktree/add",
        json={"path": str(cloned_repo), "existingBranch": "origin/feature/remote-only"},
    )

    assert again.status_code == 200, again.json()
    assert again.json()["path"] == first["path"]
    assert _head_of(Path(first["path"])) == "feature/remote-only"


def test_branch_list_empty_never_stands_in_for_a_failed_call(repo, tmp_path):
    """An empty list is a real answer for a repo with no branches, so it must
    not double as a swallowed error — a vanished folder rendering as "No
    branches found" is indistinguishable from an empty repo."""
    unborn = tmp_path / "unborn"
    unborn.mkdir()
    _git(unborn, "init", "-q")
    plain = tmp_path / "plain"
    plain.mkdir()

    # Legitimately empty: no refs yet, and a folder that is no repo at all.
    assert web_git.branch_list(str(unborn)) == []
    assert web_git.base_branch_list(str(plain)) == []

    # Actually broken: the path is gone. That has to be audible.
    with pytest.raises(RuntimeError, match="Could not list branches"):
        web_git.branch_list(str(tmp_path / "vanished"))
    with pytest.raises(RuntimeError, match="Could not list branches"):
        web_git.base_branch_list(str(tmp_path / "vanished"))


def test_default_branch_does_not_invent_one_from_global_config(repo):
    """`init.defaultBranch` is a preference for *new* repos, not a claim about
    this one. Honouring it unchecked named a trunk that is not in the repo, so
    no row ever matched and the picker flagged no default at all."""
    _git(repo, "checkout", "-qb", "develop")
    for other in _git_out(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads").split():
        if other != "develop":
            _git(repo, "branch", "-qD", other)
    _git(repo, "config", "init.defaultBranch", "trunk-that-is-not-here")

    assert web_git._default_branch(str(repo)) == ""

    # …but a configured default that IS here is still honoured, so the guard is
    # "does this branch exist", not "ignore the config".
    _git(repo, "branch", "trunk-that-is-not-here")
    assert web_git._default_branch(str(repo)) == "trunk-that-is-not-here"


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
