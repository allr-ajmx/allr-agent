"""A prompt that lands mid-turn is redirected or queued, never dropped.

Before this, ``prompt.submit`` on a running session returned ``session busy``,
forcing clients into a deadline-bounded busy-retry. When turn teardown outlived
the deadline — e.g. a slow, non-interruptible tool (``web_search``) still
running when the user hit stop — the resubmitted message was silently dropped
("it just doesn't listen"). The gateway now applies the ``busy_input_mode``
policy: redirect the live turn by default, with the legacy interrupt + queue
path retained as a compatibility fallback.
"""

import threading
import time
import types

import tools.async_delegation as ad
from tui_gateway import server


def _session(agent=None, **extra):
    return {
        "agent": agent if agent is not None else types.SimpleNamespace(),
        "session_key": "session-key",
        "history": [],
        "history_lock": threading.Lock(),
        "history_version": 0,
        "running": False,
        "transport": None,
        "attached_images": [],
        **extra,
    }


# ── _enqueue_prompt ────────────────────────────────────────────────────────

def test_enqueue_pins_text_and_transport():
    session = _session()
    server._enqueue_prompt(session, "hello", "ws-1")
    assert session["queued_prompt"] == {"text": "hello", "transport": "ws-1"}


def test_enqueue_preserves_order_after_an_image_turn():
    session = _session()
    server._enqueue_prompt(session, "B", "ws-1")
    server._enqueue_prompt(session, "C", "ws-1", image_paths=["/tmp/c.png"])
    server._enqueue_prompt(session, "D", "ws-1")

    assert session["queued_prompt"] == {"text": "B", "transport": "ws-1"}
    assert session["queued_prompts"] == [
        {"text": "C", "transport": "ws-1", "image_paths": ["/tmp/c.png"]},
        {"text": "D", "transport": "ws-1"},
    ]


# ── who owns the stream when a prompt lands mid-turn ───────────────────────
#
# `session.resume` was taught not to steal a running session's transport
# (_resume_may_rebind_transport). `prompt.submit` had the identical steal: it
# rebound the session transport up front, before it knew the prompt would only
# be QUEUED — so viewer B typing while viewer A streamed redirected A's
# in-flight answer to B, exactly the symptom the resume guard exists to stop.


def _submit_as(viewer, rid, params):
    """Dispatch prompt.submit with *viewer* bound as the request transport."""
    token = server.bind_transport(viewer)
    try:
        return server._methods["prompt.submit"](rid, params)
    finally:
        server.reset_transport(token)


def test_queued_prompt_does_not_steal_the_running_viewers_stream(monkeypatch):
    """B queueing behind A's turn must leave A's stream where it is.

    The queued entry pins B's own transport and `_drain_queued_prompt` rebinds
    when it actually runs, so nothing is lost by waiting.
    """
    monkeypatch.setattr(server, "_load_busy_input_mode", lambda: "queue")
    viewer_a = types.SimpleNamespace(_closed=False)
    viewer_b = types.SimpleNamespace(_closed=False)
    session = _session(running=True, transport=viewer_a)
    server._sessions["sid"] = session
    try:
        resp = _submit_as(viewer_b, "r1", {"session_id": "sid", "text": "B"})
    finally:
        server._sessions.pop("sid", None)

    assert resp["result"]["status"] == "queued"
    assert session["transport"] is viewer_a
    assert session["queued_prompt"] == {"text": "B", "transport": viewer_b}


def test_queued_prompt_claims_a_running_session_whose_viewer_is_gone(monkeypatch):
    """No live reader, so the arriving client is strictly better than nothing."""
    monkeypatch.setattr(server, "_load_busy_input_mode", lambda: "queue")
    viewer_b = types.SimpleNamespace(_closed=False)
    session = _session(running=True, transport=server._detached_ws_transport)
    server._sessions["sid"] = session
    try:
        _submit_as(viewer_b, "r1", {"session_id": "sid", "text": "B"})
    finally:
        server._sessions.pop("sid", None)

    assert session["transport"] is viewer_b


def test_prompt_claims_an_idle_sessions_stream(monkeypatch):
    """With no turn in flight there is nothing to interrupt — the sender wins."""
    monkeypatch.setattr(
        server, "_run_prompt_submit",
        lambda rid, sid, session, text, **kwargs: {"result": {"status": "started"}},
    )
    viewer_a = types.SimpleNamespace(_closed=False)
    viewer_b = types.SimpleNamespace(_closed=False)
    session = _session(running=False, transport=viewer_a)
    server._sessions["sid"] = session
    try:
        _submit_as(viewer_b, "r1", {"session_id": "sid", "text": "B"})
    finally:
        server._sessions.pop("sid", None)

    assert session["transport"] is viewer_b


def test_steer_claims_the_stream_it_just_changed(monkeypatch):
    """Steering rewrites what the live turn is answering, so the steerer owns it."""
    monkeypatch.setattr(server, "_load_busy_input_mode", lambda: "steer")
    viewer_a = types.SimpleNamespace(_closed=False)
    viewer_b = types.SimpleNamespace(_closed=False)
    agent = types.SimpleNamespace(steer=lambda _text: True)
    session = _session(agent=agent, running=True, transport=viewer_a)

    resp = server._handle_busy_submit("r1", "sid", session, "actually, B", viewer_b)

    assert resp["result"]["status"] == "steered"
    assert session["transport"] is viewer_b


def test_redirect_claims_the_stream_it_just_changed(monkeypatch):
    """Same for an in-place redirect: the turn is now answering B's prompt."""
    monkeypatch.setattr(server, "_load_busy_input_mode", lambda: "interrupt")
    viewer_a = types.SimpleNamespace(_closed=False)
    viewer_b = types.SimpleNamespace(_closed=False)
    agent = types.SimpleNamespace(
        _supports_active_turn_redirect=True,
        redirect=lambda _text: True,
        interrupt=lambda: None,
    )
    session = _session(agent=agent, running=True, transport=viewer_a)

    resp = server._handle_busy_submit("r1", "sid", session, "actually, B", viewer_b)

    assert resp["result"]["status"] == "redirected"
    assert session["transport"] is viewer_b


# ── _handle_busy_submit (policy) ───────────────────────────────────────────

def test_busy_interrupt_mode_redirects_active_turn(monkeypatch):
    monkeypatch.setattr(server, "_load_busy_input_mode", lambda: "interrupt")
    seen = []
    agent = types.SimpleNamespace(
        _supports_active_turn_redirect=True,
        redirect=lambda text: seen.append(text) or True,
        interrupt=lambda *a, **k: (_ for _ in ()).throw(
            AssertionError("redirect must not hard-interrupt")
        ),
    )
    session = _session(agent=agent, running=True)
    session["inflight_turn"] = {"user": "original request", "assistant": "partial reply"}

    resp = server._handle_busy_submit("r1", "sid", session, "redirect", "ws-1")

    assert resp["result"]["status"] == "redirected"
    assert seen == ["redirect"]
    # Appended, not overwritten: the original prompt must stay recoverable.
    assert session["inflight_turn"]["user"] == "original request"
    assert session["inflight_turn"]["corrections"] == ["redirect"]
    assert session.get("queued_prompt") is None








def test_busy_interrupt_mode_ignores_completed_background_delegation(monkeypatch):
    """A terminal delegation must not suppress normal busy-turn interruption."""
    monkeypatch.setattr(server, "_load_busy_input_mode", lambda: "interrupt")
    calls = {"interrupt": 0}
    agent = types.SimpleNamespace(
        interrupt=lambda *a, **k: calls.__setitem__("interrupt", calls["interrupt"] + 1)
    )
    session = _session(agent=agent, running=True)

    with ad._records_lock:
        ad._records["deleg_completed"] = {
            "delegation_id": "deleg_completed",
            "status": "completed",
            "session_key": "session-key",
            "origin_ui_session_id": "sid",
        }

    try:
        resp = server._handle_busy_submit("r1", "sid", session, "continue", "ws-1")
    finally:
        with ad._records_lock:
            ad._records.clear()

    assert resp["result"]["status"] == "queued"
    assert calls["interrupt"] == 1
    assert session["queued_prompt"]["text"] == "continue"




def test_busy_steer_mode_injects_when_accepted(monkeypatch):
    monkeypatch.setattr(server, "_load_busy_input_mode", lambda: "steer")
    agent = types.SimpleNamespace(steer=lambda text: True, interrupt=lambda *a, **k: None)
    session = _session(agent=agent, running=True)

    resp = server._handle_busy_submit("r1", "sid", session, "nudge", "ws-1")

    assert resp["result"]["status"] == "steered"
    assert session.get("queued_prompt") is None






def test_busy_helper_retries_when_turn_finished(monkeypatch):
    monkeypatch.setattr(server, "_load_busy_input_mode", lambda: "interrupt")
    session = _session(running=False)

    assert server._handle_busy_submit("r1", "sid", session, "run now", "ws-1") is None
    assert session.get("queued_prompt") is None






def test_busy_interrupt_mode_queues_multimodal_payload_instead_of_redirect(monkeypatch):
    monkeypatch.setattr(server, "_load_busy_input_mode", lambda: "interrupt")
    seen = []
    rich = [
        {"type": "text", "text": "caption"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,abc"}},
    ]
    agent = types.SimpleNamespace(
        _supports_active_turn_redirect=True,
        redirect=lambda text: seen.append(text) or True,
        interrupt=lambda *a, **k: None,
    )
    session = _session(agent=agent, running=True)

    resp = server._handle_busy_submit("r1", "sid", session, rich, "ws-1")

    assert resp["result"]["status"] == "queued"
    assert seen == []
    assert session["queued_prompt"]["text"] == rich


def test_busy_submit_claims_attached_image_for_queued_turn(monkeypatch):
    """A pasted image belongs to its submitted prompt, not ambient session state."""
    monkeypatch.setattr(server, "_load_busy_input_mode", lambda: "interrupt")
    redirected = []
    interrupted = threading.Event()
    agent = types.SimpleNamespace(
        _supports_active_turn_redirect=True,
        redirect=lambda text: redirected.append(text) or True,
        interrupt=interrupted.set,
    )
    session = _session(agent=agent, running=True, attached_images=["/tmp/b.png"])
    server._sessions["sid"] = session
    try:
        response = server._methods["prompt.submit"](
            "r1", {"session_id": "sid", "text": "is this B?"}
        )
    finally:
        server._sessions.pop("sid", None)

    assert response["result"]["status"] == "queued"
    assert redirected == []
    assert not interrupted.wait(0.1)
    assert session["attached_images"] == []
    assert session["queued_prompt"] == {
        "text": "is this B?",
        "image_paths": ["/tmp/b.png"],
        "transport": None,
    }


def test_busy_image_prompts_keep_b_and_c_attachments_in_submission_order(monkeypatch):
    """A later paste must not replace the image already claimed by B."""
    monkeypatch.setattr(server, "_load_busy_input_mode", lambda: "interrupt")
    monkeypatch.setattr(
        server,
        "_run_prompt_submit",
        lambda rid, sid, _session, text, **kwargs: dispatched.append((rid, sid, text, kwargs)),
    )
    agent = types.SimpleNamespace(
        _supports_active_turn_redirect=True,
        redirect=lambda _text: (_ for _ in ()).throw(AssertionError("images must queue")),
        interrupt=lambda: None,
    )
    session = _session(agent=agent, running=True, attached_images=["/tmp/b.png"])
    dispatched = []
    server._sessions["sid"] = session
    try:
        server._methods["prompt.submit"]("b", {"session_id": "sid", "text": "B"})
        session["attached_images"] = ["/tmp/c.png"]
        server._methods["prompt.submit"]("c", {"session_id": "sid", "text": "C"})

        assert session["queued_prompt"]["image_paths"] == ["/tmp/b.png"]
        assert session["queued_prompts"] == [
            {"text": "C", "image_paths": ["/tmp/c.png"], "transport": None}
        ]

        session["running"] = False
        assert server._drain_queued_prompt("drain-b", "sid", session) is True
        session["running"] = False
        assert server._drain_queued_prompt("drain-c", "sid", session) is True
    finally:
        server._sessions.pop("sid", None)

    assert dispatched == [
        (
            "drain-b",
            "sid",
            "B",
            {"image_paths": ["/tmp/b.png"], "queued_prompt_generation": 0},
        ),
        (
            "drain-c",
            "sid",
            "C",
            {"image_paths": ["/tmp/c.png"], "queued_prompt_generation": 0},
        ),
    ]


# ── _drain_queued_prompt ───────────────────────────────────────────────────

def test_drain_fires_queued_prompt_and_claims_running(monkeypatch):
    fired = {}
    monkeypatch.setattr(
        server, "_run_prompt_submit",
        lambda rid, sid, session, text, **kwargs: fired.update(rid=rid, sid=sid, text=text),
    )
    session = _session(queued_prompt={"text": "go", "transport": "ws-9"})

    assert server._drain_queued_prompt("r1", "sid", session) is True
    assert fired == {"rid": "r1", "sid": "sid", "text": "go"}
    assert session["running"] is True
    assert session["queued_prompt"] is None
    assert session["transport"] == "ws-9"


def test_drain_compute_host_forwards_queued_image_paths(monkeypatch):
    captured = {}
    monkeypatch.setattr(server, "_session_uses_compute_host", lambda _session: True)
    monkeypatch.setattr(
        server,
        "_submit_prompt_to_compute_host",
        lambda rid, sid, session, text, **kwargs: captured.update(
            rid=rid, sid=sid, text=text, image_paths=kwargs.get("image_paths")
        )
        or {"result": {"status": "started"}},
    )
    session = _session(
        queued_prompt={"text": "inspect", "image_paths": ["/tmp/b.png"], "transport": "ws-9"}
    )

    assert server._drain_queued_prompt("r1", "sid", session) is True
    assert captured == {
        "rid": "r1",
        "sid": "sid",
        "text": "inspect",
        "image_paths": ["/tmp/b.png"],
    }






def test_drain_releases_running_on_dispatch_failure(monkeypatch):
    def _boom(*a, **k):
        raise RuntimeError("dispatch failed")
    monkeypatch.setattr(server, "_run_prompt_submit", _boom)
    session = _session(queued_prompt={"text": "go", "transport": None})

    assert server._drain_queued_prompt("r1", "sid", session) is True
    # Failure must not leave the session wedged as running.
    assert session["running"] is False


def test_drain_does_not_dispatch_a_prompt_cancelled_after_claim(monkeypatch):
    session = _session(queued_prompt={"text": "B", "transport": None})
    monkeypatch.setattr(
        server,
        "_session_uses_compute_host",
        lambda _session: session.__setitem__("_queued_prompt_generation", 1) or False,
    )
    monkeypatch.setattr(
        server,
        "_run_prompt_submit",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("must not dispatch")),
    )

    assert server._drain_queued_prompt("r1", "sid", session) is True
    assert session["running"] is False


def test_drain_does_not_clear_stop_after_its_final_generation_check(monkeypatch):
    class _Agent:
        clear_calls = 0

        def clear_interrupt(self):
            self.clear_calls += 1

    agent = _Agent()
    session = _session(agent=agent, queued_prompt={"text": "B", "transport": None})
    original_run = server._run_prompt_submit

    def stop_before_run(*args, **kwargs):
        session["_queued_prompt_generation"] = 1
        return original_run(*args, **kwargs)

    monkeypatch.setattr(server, "_session_uses_compute_host", lambda _session: False)
    monkeypatch.setattr(server, "_run_prompt_submit", stop_before_run)

    assert server._drain_queued_prompt("r1", "sid", session) is True
    assert agent.clear_calls == 0
    assert session["running"] is False


def test_drain_continues_with_later_queued_prompt_after_dispatch_failure(monkeypatch):
    calls = []

    def _run(_rid, _sid, session, text, **_kwargs):
        calls.append(text)
        if text == "broken":
            raise RuntimeError("dispatch failed")
        session["running"] = False

    monkeypatch.setattr(server, "_run_prompt_submit", _run)
    session = _session(
        queued_prompt={"text": "broken", "transport": None},
        queued_prompts=[{"text": "next", "image_paths": ["/tmp/next.png"], "transport": None}],
    )

    assert server._drain_queued_prompt("r1", "sid", session) is True
    assert calls == ["broken", "next"]
    assert session["queued_prompt"] is None
    assert session.get("queued_prompts") is None


