"""Backend git-repository discovery for the Projects sidebar.

The desktop app crawls the user's disk from its Electron main process
(``apps/desktop/electron/git-repo-scan.ts``); hermes-universal ports the same
crawl to Rust (``apps/hermes-universal/src-tauri/src/repo_scan.rs``) and runs it
against the *Tauri host's* filesystem.  Neither speaks for the machine sessions
actually run on once the gateway is remote — and a phone has no crawlable disk
at all.  This module is the gateway-side half: the identical walk, executed
where the repos really live, exposed as ``GET /api/git/scan-repos``.

No git binary is involved.  A directory *is* a repository when ``.git/`` is a
directory whose ``HEAD`` we can read, and descent stops there.

**The roots are never taken from the caller.**  Unlike the Electron/Tauri
versions — which crawl the user's own machine at the user's own request — this
walks a server's filesystem on behalf of a possibly-remote client, so the
policy comes from the gateway's own config (``desktop.repo_scan_*``).  A client
cannot point the crawl anywhere the operator has not configured, and results
outside those roots are therefore unreachable.
"""

from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

# Mirrors desktop's ``DEFAULT_MAX_DEPTH``: repos nested deeper than this are
# intentionally invisible, so a home-directory scan stays bounded.
DEFAULT_MAX_DEPTH = 3
# Mirrors desktop's ``MAX_CONCURRENCY`` (its ``mapLimit`` bound): how many
# directories we stat at once.
MAX_CONCURRENCY = 32
# Mirrors desktop's ``JUNK_DIRS`` — big trees that never hold a user's repos.
JUNK_DIRS = frozenset({
    "Applications",
    "Library",
    "node_modules",
    "site-packages",
    "vendor",
    "venv",
})


@dataclass(frozen=True)
class ScanPath:
    """A normalized scan path: ``value`` is what we walk and report, ``key`` is
    the comparison form (case-folded on Windows, where paths are insensitive)."""

    key: str
    value: str


def home_dir() -> str:
    """``$HOME`` / ``%USERPROFILE%``, falling back to the current directory so a
    missing env var can't turn a relative root into a filesystem-root crawl."""
    for name in ("HOME", "USERPROFILE"):
        value = (os.environ.get(name) or "").strip()
        if value:
            return value
    try:
        return os.getcwd()
    except OSError:
        return "."


def _scan_path(absolute: str) -> ScanPath:
    value = os.path.normpath(absolute)
    return ScanPath(key=os.path.normcase(value), value=value)


def normalize_scan_path(raw: str, home: str) -> ScanPath | None:
    """Expand ``~``, absolutize against ``home``, then normalize.  Blank input
    yields ``None`` so empty config entries are skipped rather than scanning
    ``/``."""
    raw = (raw or "").strip()
    if not raw:
        return None

    if raw == "~":
        expanded = home
    elif raw.startswith("~/") or raw.startswith("~\\"):
        expanded = os.path.join(home, raw[2:])
    else:
        expanded = raw

    if not os.path.isabs(expanded):
        expanded = os.path.join(home, expanded)

    return _scan_path(expanded)


def path_is_within(candidate_key: str, parent_key: str) -> bool:
    """Whether ``candidate_key`` is ``parent_key`` or lives underneath it, so
    excluding a folder also excludes its descendants.  Compares whole path
    components — ``~/coder`` is not inside ``~/code``."""
    if candidate_key == parent_key:
        return True
    return candidate_key.startswith(parent_key.rstrip(os.sep) + os.sep)


def _is_repo(directory: str) -> bool:
    """``.git/`` is a directory whose ``HEAD`` we can read.  The readability
    probe skips half-initialized / permission-denied ``.git`` folders that would
    otherwise show up as broken projects."""
    git_dir = os.path.join(directory, ".git")
    if not os.path.isdir(git_dir):
        return False
    try:
        with open(os.path.join(git_dir, "HEAD"), "rb"):
            return True
    except OSError:
        return False


def _visit(path: ScanPath) -> tuple[ScanPath, bool, list[ScanPath]]:
    """Either record this directory as a repo (and stop descending) or return
    the child directories worth walking next."""
    if _is_repo(path.value):
        return path, True, []

    children: list[ScanPath] = []
    try:
        with os.scandir(path.value) as entries:
            for entry in entries:
                name = entry.name
                if name.startswith(".") or name in JUNK_DIRS:
                    continue
                try:
                    # Symlinks are not followed — the same rule as desktop's
                    # `Dirent.isDirectory()`, and it keeps a cyclic link from
                    # turning the walk into an infinite one.
                    if entry.is_dir(follow_symlinks=False):
                        children.append(_scan_path(os.path.join(path.value, name)))
                except OSError:
                    continue
    except OSError:
        return path, False, []

    return path, False, children


def scan_repos(
    roots: list[str] | None,
    max_depth: int | None = None,
    enabled: bool | None = None,
    exclude_paths: list[str] | None = None,
) -> list[dict]:
    """Scan ``roots`` for git repositories, returning ``{root, label}`` dicts.

    Disabled discovery returns before resolving home or touching the disk.  An
    empty root list preserves desktop's historical home-directory scan.  The
    walk is breadth-first by depth level, each level fanned out over at most
    ``MAX_CONCURRENCY`` threads (the walk is stat-bound, so threads help even
    under the GIL).

    Blocking — callers run it off the event loop.
    """
    if enabled is False:
        return []

    home = home_dir()
    depth_cap = DEFAULT_MAX_DEPTH if max_depth is None else int(max_depth)

    requested = [value for value in (roots or []) if isinstance(value, str) and value.strip()]
    if not requested:
        requested = [home]

    # Dedupe roots by comparison key so nested/duplicate config entries don't
    # walk the same tree twice.
    seen_roots: set[str] = set()
    level: list[ScanPath] = []
    for raw in requested:
        path = normalize_scan_path(raw, home)
        if path is not None and path.key not in seen_roots:
            seen_roots.add(path.key)
            level.append(path)

    exclusions = [
        path.key
        for path in (
            normalize_scan_path(value, home)
            for value in (exclude_paths or [])
            if isinstance(value, str)
        )
        if path is not None
    ]

    found: dict[str, dict] = {}
    depth = 0

    while level and depth <= depth_cap:
        level = [
            path
            for path in level
            if not any(path_is_within(path.key, excluded) for excluded in exclusions)
        ]
        if not level:
            break

        with ThreadPoolExecutor(max_workers=min(MAX_CONCURRENCY, len(level))) as pool:
            results = list(pool.map(_visit, level))

        next_level: list[ScanPath] = []
        for path, is_repo, children in results:
            if is_repo:
                label = os.path.basename(path.value) or path.value
                found.setdefault(path.key, {"root": path.value, "label": label})
                continue
            next_level.extend(children)

        level = next_level
        depth += 1

    # Deterministic order — dict insertion order follows thread completion.
    return sorted(found.values(), key=lambda entry: entry["root"])


def repo_scan_defaults() -> tuple[bool, list[str], list[str]]:
    """The shipped ``desktop.repo_scan_*`` defaults, as ``(enabled, roots, excludes)``.

    Narrowed through ``isinstance`` instead of indexed straight out of
    ``DEFAULT_CONFIG``: that literal is a heterogeneous dict, so every
    ``DEFAULT_CONFIG["desktop"]["repo_scan_*"]`` chain is untypeable and the
    static checker flags it.  One narrowing here keeps the resolver clean.
    """
    from hermes_cli.config_defaults import DEFAULT_CONFIG

    section = DEFAULT_CONFIG.get("desktop")
    defaults: dict = section if isinstance(section, dict) else {}

    enabled = defaults.get("repo_scan_enabled", True)
    roots = defaults.get("repo_scan_roots", [])
    excludes = defaults.get("repo_scan_exclude_paths", [])

    return (
        bool(enabled),
        [str(value) for value in roots] if isinstance(roots, list) else [],
        [str(value) for value in excludes] if isinstance(excludes, list) else [],
    )


def resolve_repo_discovery_policy(source: dict | None) -> dict:
    """Normalize a ``desktop`` config section into the effective scan policy.

    Accepts both the flat ``repo_scan_*`` config keys and the nested
    ``{enabled, roots, exclude_paths}`` shape the clients post back with
    ``projects.record_repos``, so one resolver serves both.
    """
    default_enabled, default_roots, default_excludes = repo_scan_defaults()
    if not isinstance(source, dict):
        source = {}

    enabled = source.get("enabled", source.get("repo_scan_enabled", default_enabled))
    roots = source.get("roots", source.get("repo_scan_roots", default_roots))
    excludes = source.get(
        "exclude_paths",
        source.get("repo_scan_exclude_paths", default_excludes),
    )

    return {
        "enabled": enabled if isinstance(enabled, bool) else default_enabled,
        "roots": [value.strip() for value in roots if isinstance(value, str) and value.strip()]
        if isinstance(roots, list)
        else list(default_roots),
        "exclude_paths": [
            value.strip() for value in excludes if isinstance(value, str) and value.strip()
        ]
        if isinstance(excludes, list)
        else list(default_excludes),
    }


def configured_policy() -> dict:
    """The gateway's own effective policy, read from the active profile's config.

    Blocking (a disk read) — callers run it off the event loop.
    """
    from hermes_cli.config import load_config

    try:
        desktop = (load_config() or {}).get("desktop")
    except Exception:
        desktop = None
    return resolve_repo_discovery_policy(desktop if isinstance(desktop, dict) else {})
