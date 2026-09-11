"""Fuzzy file-search primitives for the gateway's `complete.path` (pure move).

Extracted verbatim from ``tui_gateway/server.py``'s "Methods: complete"
section so the same ranker/lister can be reused by the dashboard's
``GET /api/fs/search`` without importing the 19K-line server module.

Nothing here changed: bodies, cache state and the module-level constants are
byte-identical to their pre-split server.py form.  ``server.py`` re-imports
every name below at module level — that is load-bearing, not cosmetic:
``method_ctx.HandlerRegistry.install()`` rebinds each split-out handler's
``__globals__`` to ``vars(server)``, so ``methods_complete.py``'s
``complete.path`` resolves ``_fuzzy_basename_rank`` / ``_list_repo_files`` /
``_FUZZY_FALLBACK_EXCLUDES`` as *server.py* globals at call time.  Drop the
re-import and that handler dies with a ``NameError`` no import-time check
would catch.  The cache dict and its lock move together for the same reason:
two copies would mean two caches with divergent contents (and tests that
clear ``server._fuzzy_cache`` would clear the wrong one).
"""

from __future__ import annotations

import os
import subprocess
import threading
import time
from pathlib import Path


_FUZZY_CACHE_TTL_S = 5.0
_FUZZY_CACHE_MAX_FILES = 20000
_FUZZY_FALLBACK_EXCLUDES = frozenset(
    {
        ".git",
        ".hg",
        ".svn",
        ".next",
        ".cache",
        ".venv",
        "venv",
        "node_modules",
        "__pycache__",
        "dist",
        "build",
        "target",
        ".mypy_cache",
        ".pytest_cache",
        ".ruff_cache",
    }
)
_fuzzy_cache_lock = threading.Lock()
_fuzzy_cache: dict[str, tuple[float, list[str]]] = {}


def _list_repo_files(root: str) -> list[str]:
    """Return file paths relative to ``root``.

    Uses ``git ls-files`` from the repo top (resolved via
    ``rev-parse --show-toplevel``) so the listing covers tracked + untracked
    files anywhere in the repo, then converts each path back to be relative
    to ``root``. Files outside ``root`` (parent directories of cwd, sibling
    subtrees) are excluded so the picker stays scoped to what's reachable
    from the gateway's cwd. Falls back to a bounded ``os.walk(root)`` when
    ``root`` isn't inside a git repo. Result cached per-root for
    ``_FUZZY_CACHE_TTL_S`` so rapid keystrokes don't respawn git processes.
    """
    now = time.monotonic()
    with _fuzzy_cache_lock:
        cached = _fuzzy_cache.get(root)
        if cached and now - cached[0] < _FUZZY_CACHE_TTL_S:
            return cached[1]

    files: list[str] = []
    from hermes_cli._subprocess_compat import windows_hide_flags

    _creationflags = windows_hide_flags()
    try:
        top_result = subprocess.run(
            ["git", "-C", root, "rev-parse", "--show-toplevel"],
            capture_output=True,
            timeout=2.0,
            check=False,
            stdin=subprocess.DEVNULL,
            creationflags=_creationflags,
        )
        if top_result.returncode == 0:
            top = top_result.stdout.decode("utf-8", "replace").strip()
            list_result = subprocess.run(
                [
                    "git",
                    "-C",
                    top,
                    "ls-files",
                    "-z",
                    "--cached",
                    "--others",
                    "--exclude-standard",
                ],
                capture_output=True,
                timeout=2.0,
                check=False,
                stdin=subprocess.DEVNULL,
                creationflags=_creationflags,
            )
            if list_result.returncode == 0:
                for p in list_result.stdout.decode("utf-8", "replace").split("\0"):
                    if not p:
                        continue
                    rel = os.path.relpath(os.path.join(top, p), root).replace(
                        os.sep, "/"
                    )
                    # Skip parents/siblings of cwd — keep the picker scoped
                    # to root-and-below, matching Cmd-P workspace semantics.
                    if rel.startswith("../"):
                        continue
                    files.append(rel)
                    if len(files) >= _FUZZY_CACHE_MAX_FILES:
                        break
    except (OSError, subprocess.TimeoutExpired):
        pass

    if not files:
        # Fallback walk: skip vendor/build dirs + dot-dirs so the walk stays
        # tractable. Dotfiles themselves survive — the ranker decides based
        # on whether the query starts with `.`.
        try:
            for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
                dirnames[:] = [
                    d
                    for d in dirnames
                    if d not in _FUZZY_FALLBACK_EXCLUDES and not d.startswith(".")
                ]
                rel_dir = os.path.relpath(dirpath, root)
                for f in filenames:
                    rel = f if rel_dir == "." else f"{rel_dir}/{f}"
                    files.append(rel.replace(os.sep, "/"))
                    if len(files) >= _FUZZY_CACHE_MAX_FILES:
                        break
                if len(files) >= _FUZZY_CACHE_MAX_FILES:
                    break
        except OSError:
            pass

    with _fuzzy_cache_lock:
        _fuzzy_cache[root] = (now, files)

    return files


def _fuzzy_basename_rank(name: str, query: str) -> tuple[int, int] | None:
    """Rank ``name`` against ``query``; lower is better. Returns None to reject.

    Tiers (kind):
      0 — exact basename
      1 — basename prefix (e.g. `app` → `appChrome.tsx`)
      2 — word-boundary / camelCase hit (e.g. `chrome` → `appChrome.tsx`)
      3 — substring anywhere in basename
      4 — subsequence match (every query char appears in order)

    Secondary key is `len(name)` so shorter names win ties.
    """
    if not query:
        return (3, len(name))

    nl = name.lower()
    ql = query.lower()

    if nl == ql:
        return (0, len(name))

    if nl.startswith(ql):
        return (1, len(name))

    # Word-boundary split: `foo-bar_baz.qux` → ["foo","bar","baz","qux"].
    # camelCase split: `appChrome` → ["app","Chrome"]. Cheap approximation;
    # falls through to substring/subsequence if it misses.
    parts: list[str] = []
    buf = ""
    for ch in name:
        if ch in "-_." or (ch.isupper() and buf and not buf[-1].isupper()):
            if buf:
                parts.append(buf)
            buf = ch if ch not in "-_." else ""
        else:
            buf += ch
    if buf:
        parts.append(buf)
    for p in parts:
        if p.lower().startswith(ql):
            return (2, len(name))

    if ql in nl:
        return (3, len(name))

    i = 0
    for ch in nl:
        if ch == ql[i]:
            i += 1
            if i == len(ql):
                return (4, len(name))

    return None


# ── Directory search (the pure half of `GET /api/fs/search`) ──────────────
#
# `complete.path` (methods_complete.py) does exactly this walk inline to build
# `@name` completions.  The dashboard's file picker needs the same answers in
# `fs_list`'s entry shape, so the walk lives here — no FastAPI, no gateway
# module, unit-testable on a tmp_path.

FS_SEARCH_DEFAULT_LIMIT = 50
FS_SEARCH_MAX_LIMIT = 500


def rank_search_matches(
    root: str, query: str, limit: int = FS_SEARCH_DEFAULT_LIMIT
) -> list[tuple[int, str, str, bool]]:
    """Rank paths under ``root`` against ``query``. Mirrors `complete.path`.

    Returns ``(tier, rel, basename, is_dir)`` best-first, where ``tier`` is
    :func:`_fuzzy_basename_rank`'s primary key (0 = exact basename … 4 =
    subsequence) and ``rel`` is ``/``-separated and relative to ``root``.

    Three behaviours are copied deliberately from the completion handler:

    * **Ancestors of matched files are ranked too.** The listing is files-only,
      so a folder containing no name-matching file would otherwise be invisible
      — the "can't find a folder by name" bug.
    * **The root's immediate children seed the result set.** ``_list_repo_files``
      is capped at ``_FUZZY_CACHE_MAX_FILES`` and, outside a git repo, the
      fallback walk can spend that whole budget on one deep subtree before it
      ever reaches a sibling — which is why searching a non-repo ``$HOME``
      found nothing. One ``listdir`` keeps the top level always reachable.
    * **Dotfiles surface only when the query itself starts with ``.``**, and the
      seed skips ``_FUZZY_FALLBACK_EXCLUDES`` (vendor/build dirs).

    Ties break folders-first, then shorter path, then lexicographically.
    """
    ranked: list[tuple[tuple[int, int], str, str, bool]] = []
    walked_dirs: set[str] = set()
    seen: set[str] = set()
    want_hidden = query.startswith(".")

    def _consider(rel: str, name: str, is_dir: bool) -> None:
        if rel in seen or (name.startswith(".") and not want_hidden):
            return
        rank = _fuzzy_basename_rank(name, query)
        if rank is not None:
            seen.add(rel)
            ranked.append((rank, rel, name, is_dir))

    try:
        for entry in os.listdir(root):
            if entry not in _FUZZY_FALLBACK_EXCLUDES:
                _consider(entry, entry, os.path.isdir(os.path.join(root, entry)))
    except OSError:
        pass

    for rel in _list_repo_files(root):
        _consider(rel, os.path.basename(rel), False)

        parent = os.path.dirname(rel)
        while parent and parent not in walked_dirs:
            walked_dirs.add(parent)
            _consider(parent, os.path.basename(parent), True)
            parent = os.path.dirname(parent)

    ranked.sort(key=lambda r: (r[0], not r[3], len(r[1]), r[1]))
    capped = max(1, min(int(limit or FS_SEARCH_DEFAULT_LIMIT), FS_SEARCH_MAX_LIMIT))
    return [(rank[0], rel, name, is_dir) for rank, rel, name, is_dir in ranked[:capped]]


def search_entries(
    root: str, query: str, limit: int = FS_SEARCH_DEFAULT_LIMIT
) -> list[dict]:
    """:func:`rank_search_matches` in ``/api/fs/list``'s entry shape.

    ``{name, path, isDirectory}`` — identical to what ``fs_list`` returns —
    plus ``rank`` (lower is better) so a client can group by match quality.
    """
    base = Path(root)
    return [
        {
            "name": name,
            "path": str(base.joinpath(*rel.split("/"))),
            "isDirectory": is_dir,
            "rank": tier,
        }
        for tier, rel, name, is_dir in rank_search_matches(root, query, limit)
    ]
