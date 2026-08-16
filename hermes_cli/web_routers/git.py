"""Git dashboard routes (extracted verbatim from web_server.py).

Handler bodies are byte-identical to their previous in-web_server form; the
helpers they call (``_git_op``, ``_git_path``) still live in web_server and are
reached via the late-binding seam in :mod:`hermes_cli.web_deps`, so
``monkeypatch.setattr(web_server, ...)`` keeps working.
"""

import asyncio
from typing import Optional

from fastapi import APIRouter

from hermes_cli import web_git as _web_git  # noqa: F401 — used by handlers
from hermes_cli import web_repo_scan as _web_repo_scan  # noqa: F401 — used by handlers
from hermes_cli.web_deps import late
from hermes_cli.web_models import (
    GitPathBody,
    GitFileBody,
    GitCommitBody,
    GitPrListBody,
    GitWorktreeAddBody,
    GitWorktreeRemoveBody,
    GitBranchSwitchBody,
)

router = APIRouter()

# Late-bound web_server helpers (resolved at call time; cycle-safe,
# monkeypatch-transparent).
_git_op = late("_git_op")
_git_path = late("_git_path")
_config_profile_scope = late("_config_profile_scope")


@router.get("/api/git/scan-repos")
async def git_scan_repos_route(profile: Optional[str] = None):
    """Discover git repositories on the *gateway's* filesystem.

    The desktop/Tauri clients crawl their own disk, which is only the gateway's
    when the backend was spawned locally; a remote gateway owns a different
    filesystem and a phone has none, so those clients call this instead.

    The crawl takes no roots from the caller — the policy is read from this
    gateway's own ``desktop.repo_scan_*`` config (see
    :mod:`hermes_cli.web_repo_scan`), so a client cannot aim a server-side walk
    at an unconfigured path.  The resolved policy is echoed back so a caller can
    see what produced this list — an empty ``repos`` with ``enabled: false``, or
    with roots the operator never set, is a configuration answer rather than "no
    repos" — without a second round-trip to ``/api/config``.  The client's own
    ``projects.record_repos`` policy comes from that same config, read under the
    same ``profile``.
    """
    # The policy read resolves HERMES_HOME at call time, so it must run inside
    # the profile scope. `asyncio.to_thread` copies the contextvar; the executor
    # `_git_op` uses does not, which is why the crawl takes explicit arguments.
    with _config_profile_scope(profile):
        policy = await asyncio.to_thread(_web_repo_scan.configured_policy)

    repos = await _git_op(
        _web_repo_scan.scan_repos,
        policy["roots"],
        None,
        policy["enabled"],
        policy["exclude_paths"],
    )
    return {"repos": repos, "policy": policy}


@router.get("/api/git/status")
async def git_status_route(path: str):
    return await _git_op(_web_git.repo_status, _git_path(path))


@router.get("/api/git/worktrees")
async def git_worktrees_route(path: str):
    return {"worktrees": await _git_op(_web_git.worktree_list, _git_path(path))}


@router.get("/api/git/branches")
async def git_branches_route(path: str):
    return {"branches": await _git_op(_web_git.branch_list, _git_path(path))}


@router.get("/api/git/base-branches")
async def git_base_branches_route(path: str):
    return {"branches": await _git_op(_web_git.base_branch_list, _git_path(path))}


@router.get("/api/git/review/list")
async def git_review_list_route(path: str, scope: str = "uncommitted", base: Optional[str] = None):
    return await _git_op(_web_git.review_list, _git_path(path), scope, base)


@router.get("/api/git/review/diff")
async def git_review_diff_route(
    path: str, file: str, scope: str = "uncommitted", base: Optional[str] = None, staged: bool = False
):
    return {"diff": await _git_op(_web_git.review_diff, _git_path(path), file, scope, base, staged)}


@router.get("/api/git/file-diff")
async def git_file_diff_route(path: str, file: str):
    return {"diff": await _git_op(_web_git.file_diff_vs_head, _git_path(path), file)}


@router.get("/api/git/review/commit-context")
async def git_commit_context_route(path: str):
    return await _git_op(_web_git.review_commit_context, _git_path(path))


@router.get("/api/git/review/rev-parse")
async def git_rev_parse_route(path: str, ref: Optional[str] = None):
    return {"sha": await _git_op(_web_git.review_rev_parse, _git_path(path), ref)}


@router.get("/api/git/review/ship-info")
async def git_ship_info_route(path: str):
    return await _git_op(_web_git.review_ship_info, _git_path(path))


@router.post("/api/git/review/pr-list")
async def git_pr_list_route(body: GitPrListBody):
    return await _git_op(_web_git.review_pr_list, _git_path(body.path), body.branches, body.numbers)


@router.post("/api/git/review/stage")
async def git_stage_route(body: GitFileBody):
    return await _git_op(_web_git.review_stage, _git_path(body.path), body.file)


@router.post("/api/git/review/unstage")
async def git_unstage_route(body: GitFileBody):
    return await _git_op(_web_git.review_unstage, _git_path(body.path), body.file)


@router.post("/api/git/review/revert")
async def git_revert_route(body: GitFileBody):
    return await _git_op(_web_git.review_revert, _git_path(body.path), body.file)


@router.post("/api/git/review/commit")
async def git_commit_route(body: GitCommitBody):
    return await _git_op(_web_git.review_commit, _git_path(body.path), body.message, body.push)


@router.post("/api/git/review/push")
async def git_push_route(body: GitPathBody):
    return await _git_op(_web_git.review_push, _git_path(body.path))


@router.post("/api/git/review/create-pr")
async def git_create_pr_route(body: GitPathBody):
    return await _git_op(_web_git.review_create_pr, _git_path(body.path))


@router.post("/api/git/worktree/add")
async def git_worktree_add_route(body: GitWorktreeAddBody):
    options = {
        key: value
        for key, value in {
            "name": body.name,
            "branch": body.branch,
            "base": body.base,
            "existingBranch": body.existingBranch,
        }.items()
        if value
    }
    return await _git_op(_web_git.worktree_add, _git_path(body.path), options)


@router.post("/api/git/worktree/remove")
async def git_worktree_remove_route(body: GitWorktreeRemoveBody):
    return await _git_op(
        _web_git.worktree_remove, _git_path(body.path), _git_path(body.worktreePath), body.force
    )


@router.post("/api/git/branch/switch")
async def git_branch_switch_route(body: GitBranchSwitchBody):
    return await _git_op(_web_git.branch_switch, _git_path(body.path), body.branch)
