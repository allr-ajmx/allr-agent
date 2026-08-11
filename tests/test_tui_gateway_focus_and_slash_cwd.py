"""Focus view over the gateway, and the working directory slash commands run in.

Two halves of the same ticket (MJXHRM-42):

* ``config.set focus`` gained ``display_only`` for clients that hide tool rows
  themselves. Pinning ``display.tool_progress`` to "off" is how a *terminal*
  hides them — it also makes the gateway stop emitting ``tool.start`` /
  ``tool.complete`` altogether, which for a GUI takes the todo panel and the
  changed-files card down with it and makes a hidden row unrecoverable.
* ``slash.exec`` now runs the worker command against the SESSION's cwd. The
  worker is spawned in the gateway's launch directory, so ``/diff`` used to
  render the wrong repository's changes with no indication anything was off.
"""

import json
import queue
import threading
import types

from tui_gateway import server


class _FakeStdin:
    def __init__(self):
        self.lines: list[str] = []

    def write(self, text):
        self.lines.append(text)

    def flush(self):
        pass


class _FakeProc:
    def __init__(self):
        self.stdin = _FakeStdin()

    def poll(self):
        return None


def _worker_with_reply(output: str):
    """A _SlashWorker with its subprocess replaced by fakes."""
    worker = server._SlashWorker.__new__(server._SlashWorker)
    worker._lock = threading.Lock()
    worker._seq = 0
    worker.stderr_tail = []
    worker.stdout_queue = queue.Queue()
    worker.proc = _FakeProc()
    worker.stdout_queue.put({"id": 1, "ok": True, "output": output})

    return worker


# ---------------------------------------------------------------------------
# slash worker cwd
# ---------------------------------------------------------------------------


def test_slash_worker_run_sends_the_session_cwd(tmp_path):
    worker = _worker_with_reply("diff output")

    assert worker.run("/diff staged", cwd=str(tmp_path)) == "diff output"

    request = json.loads(worker.proc.stdin.lines[0])
    assert request["command"] == "/diff staged"
    assert request["cwd"] == str(tmp_path)


def test_slash_worker_run_omits_cwd_when_there_is_none():
    worker = _worker_with_reply("ok")
    worker.run("/status")

    assert "cwd" not in json.loads(worker.proc.stdin.lines[0])


def test_slash_exec_runs_the_command_in_the_sessions_directory(tmp_path, monkeypatch):
    """The bug: the worker's own launch directory answered for every session."""
    project = tmp_path / "project"
    project.mkdir()
    seen: dict[str, object] = {}

    class _RecordingWorker:
        def run(self, command, cwd=None):
            seen["command"] = command
            seen["cwd"] = cwd

            return "Unstaged: ..."

    session = {
        "agent": types.SimpleNamespace(),
        "session_key": "k",
        "history": [],
        "history_lock": threading.Lock(),
        "history_version": 0,
        "running": False,
        "cols": 80,
        "tool_progress_mode": "all",
        "cwd": str(project),
        "slash_worker": _RecordingWorker(),
    }
    monkeypatch.setitem(server._sessions, "sid", session)

    try:
        resp = server.handle_request(
            {
                "id": "s1",
                "method": "slash.exec",
                "params": {"session_id": "sid", "command": "diff"},
            }
        )
    finally:
        server._sessions.pop("sid", None)

    assert resp["result"]["output"] == "Unstaged: ..."
    assert seen["cwd"] == str(project)


def test_worker_applies_cwd_to_terminal_cwd_only_when_it_exists(tmp_path, monkeypatch):
    from tui_gateway import slash_worker

    monkeypatch.delenv("TERMINAL_CWD", raising=False)
    slash_worker._apply_command_cwd(str(tmp_path / "gone"))
    assert "TERMINAL_CWD" not in __import__("os").environ

    slash_worker._apply_command_cwd(str(tmp_path))
    assert __import__("os").environ["TERMINAL_CWD"] == str(tmp_path)

    # An empty/absent cwd leaves whatever the worker inherited alone.
    slash_worker._apply_command_cwd(None)
    assert __import__("os").environ["TERMINAL_CWD"] == str(tmp_path)


# ---------------------------------------------------------------------------
# config.set focus
# ---------------------------------------------------------------------------


def _focus_call(monkeypatch, *, config: dict, params: dict) -> tuple[dict, dict]:
    writes: dict[str, object] = {}
    monkeypatch.setattr(server, "_load_cfg", lambda: {"display": dict(config)})
    monkeypatch.setattr(
        server, "_write_config_key", lambda k, v: writes.__setitem__(k, v)
    )
    resp = server.dispatch(
        {"id": "f1", "method": "config.set", "params": {"key": "focus", **params}}
    )

    return resp, writes


def test_focus_on_display_only_records_the_flag_and_nothing_else(monkeypatch):
    resp, writes = _focus_call(
        monkeypatch,
        config={"focus_view": False, "tool_progress": "all"},
        params={"value": "on", "display_only": True},
    )

    assert resp["result"]["value"] == "on"
    assert resp["result"]["display_only"] is True
    # Tool progress untouched: the GUI keeps receiving tool events and hides
    # the rows itself.
    assert resp["result"]["tool_progress"] == "all"
    assert writes == {"display.focus_view": True}


def test_focus_on_display_only_leaves_a_live_sessions_events_flowing(monkeypatch):
    monkeypatch.setattr(
        server, "_load_cfg", lambda: {"display": {"focus_view": False, "tool_progress": "all"}}
    )
    monkeypatch.setattr(server, "_write_config_key", lambda k, v: None)
    session = {"session_key": "k", "tool_progress_mode": "all"}
    monkeypatch.setitem(server._sessions, "sid", session)

    try:
        server.dispatch(
            {
                "id": "f2",
                "method": "config.set",
                "params": {
                    "key": "focus",
                    "value": "on",
                    "display_only": True,
                    "session_id": "sid",
                },
            }
        )
    finally:
        server._sessions.pop("sid", None)

    assert session["focus_view"] is True
    # _tool_progress_enabled() gates tool.start / tool.complete on exactly this.
    assert session["tool_progress_mode"] == "all"


def test_focus_on_without_display_only_still_pins_tool_progress(monkeypatch):
    """The terminal path is unchanged — it cannot un-print a line."""
    resp, writes = _focus_call(
        monkeypatch,
        config={"focus_view": False, "tool_progress": "verbose"},
        params={"value": "on"},
    )

    assert resp["result"]["tool_progress"] == "off"
    assert resp["result"]["display_only"] is False
    assert writes == {
        "display.focus_saved_tool_progress": "verbose",
        "display.tool_progress": "off",
        "display.focus_view": True,
    }


def test_focus_off_restores_the_stashed_mode(monkeypatch):
    _resp, writes = _focus_call(
        monkeypatch,
        config={
            "focus_view": True,
            "tool_progress": "off",
            "focus_saved_tool_progress": "new",
        },
        params={"value": "off"},
    )

    assert writes == {"display.tool_progress": "new", "display.focus_view": False}


def test_focus_off_without_a_stash_does_not_clobber_tool_progress(monkeypatch):
    """Focus turned on display-only (or by hand) never stashed a mode. The old
    code restored a hardcoded "all", quietly overwriting a user on `new`."""
    resp, writes = _focus_call(
        monkeypatch,
        config={"focus_view": True, "tool_progress": "new"},
        params={"value": "off"},
    )

    assert writes == {"display.focus_view": False}
    assert resp["result"]["tool_progress"] == "new"
