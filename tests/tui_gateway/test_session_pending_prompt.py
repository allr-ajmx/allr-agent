"""A parked blocking prompt must be describable to a client that reconnects.

``_block`` emits its request EXACTLY once and keeps no replay buffer, and a turn
parked inside a blocking tool call is in no committed transcript (history is
written when a turn ENDS). So a client that cold-opens — or reloads into — a
waiting session had no way to learn the question, its choices, or the
``request_id`` an answer has to carry: the agent sat in ``_block`` until its
timeout while the UI could only show a contentless "waiting" dot, and the
clarify was unanswerable (MJXHRM-362).

Contract pinned here:

* ``_session_pending_prompt`` returns the payload ``_block`` actually emitted,
  scoped to the session that owns it, and nothing once it is released.
* ``_session_pending_kind`` — the eviction/liveness signal — still answers the
  same word off that one reader.
* ``session.resume``'s live payload carries it, and omits the key entirely when
  no prompt is parked.

Driven through the real ``_block`` rather than hand-seeded dicts: the whole
point is that what a resuming client gets back is what the original emit sent.
"""

from __future__ import annotations

import threading
import types

import pytest

from tui_gateway import server


def _session(**extra):
    return {
        "agent": types.SimpleNamespace(),
        "session_key": "session-key",
        "history": [],
        "history_lock": threading.Lock(),
        "history_version": 0,
        "running": True,
        "cols": 80,
        "inflight_turn": None,
        "created_at": 0.0,
        **extra,
    }


@pytest.fixture()
def parked(monkeypatch):
    """Run one clarify through ``_block`` and observe the world mid-prompt.

    ``_emit`` fires while ``_pending`` is populated, so the hook is the only
    place a synchronous test can see the state a reconnecting client would ask
    about. ``timeout=0`` then releases it immediately (Event.wait(0)).
    """
    seen: dict = {}

    def _capture(event, sid, payload=None):
        if event != "clarify.request":
            return  # the trailing clarify.expire, after _pending is popped
        seen["emitted"] = dict(payload or {})
        seen["pending"] = server._session_pending_prompt(sid)
        seen["kind"] = server._session_pending_kind(sid)
        seen["stranger"] = server._session_pending_prompt("some-other-sid")
        seen["resume"] = server._live_session_payload(sid, _session(), omit_messages=True)

    monkeypatch.setattr(server, "_emit", _capture)
    monkeypatch.setattr(server, "_get_db", lambda: None)

    answer = server._block(
        "clarify.request",
        "sid-1",
        {"question": "Which branch?", "choices": ["main", "dev"]},
        timeout=0,
    )

    seen["answer"] = answer
    return seen


def test_pending_prompt_is_the_payload_the_client_was_sent(parked):
    assert parked["pending"] == {"event": "clarify.request", "payload": parked["emitted"]}
    # The three fields a client needs to put the question back on screen and
    # answer it. `request_id` is minted by `_block`, not by the caller.
    assert parked["pending"]["payload"]["question"] == "Which branch?"
    assert parked["pending"]["payload"]["choices"] == ["main", "dev"]
    assert parked["pending"]["payload"]["request_id"] == parked["emitted"]["request_id"]


def test_pending_prompt_is_scoped_to_its_own_session(parked):
    assert parked["stranger"] is None


def test_pending_kind_still_reads_off_the_same_prompt(parked):
    assert parked["kind"] == "clarify"


def test_resume_payload_carries_the_parked_prompt(parked):
    assert parked["resume"]["pending_prompt"] == parked["pending"]
    # And says so in the status line the sidebar already read.
    assert parked["resume"]["status"] == "waiting"


def test_nothing_is_reported_once_the_prompt_is_released(parked, monkeypatch):
    assert parked["answer"] == ""
    assert server._session_pending_prompt("sid-1") is None
    assert server._session_pending_kind("sid-1") == ""

    monkeypatch.setattr(server, "_get_db", lambda: None)
    payload = server._live_session_payload("sid-1", _session(), omit_messages=True)

    # Absent, not null: an idle session's resume payload gains no new key.
    assert "pending_prompt" not in payload
