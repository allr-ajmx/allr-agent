import asyncio
import concurrent.futures
import json
import threading
import time

from hermes_cli import mcp_startup
from tui_gateway import server
from tui_gateway import ws as ws_mod


def test_ws_does_not_own_mcp_discovery_startup(monkeypatch):
    """WebSocket transport must not start MCP discovery itself.

    MCP discovery ownership belongs to the profile-scoped agent build path.
    The WS layer only establishes the transport and emits gateway readiness.
    """
    calls = []

    monkeypatch.setattr(
        mcp_startup,
        "start_background_mcp_discovery",
        lambda **kw: calls.append(kw),
    )

    class FakeWS:
        async def accept(self):
            pass

        async def send_text(self, line):
            pass

        async def receive_text(self):
            raise ws_mod._WebSocketDisconnect()

        async def close(self):
            pass

    server._sessions.clear()
    try:
        asyncio.run(ws_mod.handle_ws(FakeWS()))
    finally:
        server._sessions.clear()

    assert calls == []


def _run_disconnect(monkeypatch, seed):
    """Drive handle_ws to its disconnect `finally`, seeding sessions against the
    live WSTransport the moment it exists. Returns nothing; inspect _sessions."""
    # Disable the grace-reap Timer: detached sessions normally schedule a
    # threading.Timer via _schedule_ws_orphan_reap, which would outlive the test
    # and fire _reap during interpreter teardown — touching _sessions/DB and
    # producing spurious post-run errors under the per-file CI runner. Grace=0
    # short-circuits the Timer (see _schedule_ws_orphan_reap) so the test leaves
    # no lingering thread.
    monkeypatch.setattr(server, "_WS_ORPHAN_REAP_GRACE_S", 0)

    # Mirror the real _finalize_session chokepoint: it is the single place that
    # closes the slash-worker (#38095). Stub it but keep that behavior so the
    # disconnect-reap path still exercises worker teardown.
    def _fake_finalize(s, end_reason="tui_close"):
        w = s.get("slash_worker")
        if w:
            w.close()

    monkeypatch.setattr(server, "_finalize_session", _fake_finalize)

    created = []
    real_transport = ws_mod.WSTransport
    monkeypatch.setattr(
        ws_mod, "WSTransport",
        lambda ws, loop, **kw: created.append(real_transport(ws, loop, **kw)) or created[-1],
    )

    class FakeWS:
        async def accept(self):
            pass

        async def send_text(self, line):
            pass

        async def receive_text(self):
            seed(created[0])  # transport now exists; attach it to sessions
            raise ws_mod._WebSocketDisconnect()

        async def close(self):
            pass

    asyncio.run(ws_mod.handle_ws(FakeWS()))


def test_ws_disconnect_reaps_flagged_session_and_closes_worker(monkeypatch):
    closed = []

    class FakeWorker:
        def close(self):
            closed.append(True)

    server._sessions.clear()
    try:
        _run_disconnect(
            monkeypatch,
            lambda t: server._sessions.update(
                flagged={
                    "transport": t,
                    "close_on_disconnect": True,
                    "slash_worker": FakeWorker(),
                    "session_key": "k",
                }
            ),
        )
        assert "flagged" not in server._sessions
        assert closed == [True]
    finally:
        server._sessions.clear()


def test_ws_disconnect_preserves_and_repoints_reconnectable_session(monkeypatch):
    server._sessions.clear()
    try:
        _run_disconnect(
            monkeypatch,
            lambda t: server._sessions.update(
                plain={"transport": t, "close_on_disconnect": False, "session_key": "k"}
            ),
        )
        assert server._sessions["plain"]["transport"] is server._detached_ws_transport
    finally:
        server._sessions.clear()


def test_ws_connection_registers_then_disconnect_unregisters_live_transport(monkeypatch):
    """A connected client must be tracked in the live-transport registry so a
    session-less global broadcast (skin.changed from the background watcher)
    reaches it, and dropped on disconnect so no stale write targets a dead peer.
    This is the WS half of the cross-surface live-theme fix."""
    server._sessions.clear()
    server._live_transports.clear()
    seen = {}
    try:
        _run_disconnect(
            monkeypatch,
            lambda t: seen.__setitem__("registered", t in server._live_transports),
        )
        # Seeded at receive_text time — i.e. after gateway.ready registered it.
        assert seen["registered"] is True
        # handle_ws's finally must have unregistered it.
        assert not server._live_transports
    finally:
        server._sessions.clear()
        server._live_transports.clear()


def test_ws_disconnect_releases_wake_word_owner(monkeypatch):
    released = []
    created = []
    monkeypatch.setattr(
        server,
        "_release_wake_for_transport",
        lambda transport: released.append(transport) or True,
    )

    _run_disconnect(monkeypatch, lambda transport: created.append(transport))

    assert released == created


def test_ws_write_loop_stall_does_not_latch_transport(monkeypatch):
    """A write that times out because the event loop is stalled (GIL-heavy
    agent turn) must NOT latch the transport closed — the frame is already
    scheduled and flushes when the loop recovers. Latching here permanently
    silenced live watch windows after one slow write."""
    monkeypatch.setattr(ws_mod, "_WS_WRITE_TIMEOUT_S", 0.05)
    sent = []

    class FakeWS:
        async def send_text(self, line):
            sent.append(line)

    loop = asyncio.new_event_loop()
    thread = threading.Thread(target=loop.run_forever, daemon=True)
    thread.start()
    try:
        transport = ws_mod.WSTransport(FakeWS(), loop, peer="stall-test")
        # Stall the loop well past the write timeout, then write from this
        # (non-loop) thread: the wait times out but the send stays in flight.
        loop.call_soon_threadsafe(time.sleep, 0.3)
        assert transport.write({"a": 1}) is True
        assert transport._closed is False

        # Once the loop breathes again, both the stalled frame and new writes
        # must reach the socket.
        assert transport.write({"b": 2}) is True
        deadline = time.time() + 2
        while len(sent) < 2 and time.time() < deadline:
            time.sleep(0.01)
        assert len(sent) == 2
        assert transport._closed is False
    finally:
        loop.call_soon_threadsafe(loop.stop)
        thread.join(timeout=2)
        loop.close()


def test_ws_starts_mcp_discovery_before_ready(monkeypatch):
    import tui_gateway.entry as entry

    calls = []
    events = []

    monkeypatch.setattr(server, "_WS_ORPHAN_REAP_GRACE_S", 0)
    monkeypatch.setattr(entry, "ensure_mcp_discovery_started", lambda: calls.append("mcp"))

    class FakeWS:
        async def accept(self):
            events.append("accept")

        async def send_text(self, line):
            if '"gateway.ready"' in line:
                events.append(f"ready_after_{len(calls)}")

        async def receive_text(self):
            raise ws_mod._WebSocketDisconnect()

        async def close(self):
            pass

    asyncio.run(ws_mod.handle_ws(FakeWS()))

    # Discovery moved to profile-aware agent construction. WebSocket transport
    # should not start MCP discovery before a profile has been bound.
    assert calls == []
    assert events == ["accept", "ready_after_0"]


def test_ws_transport_serializes_concurrent_sends():
    active_sends = 0
    max_active_sends = 0
    sent = []

    class FakeWS:
        async def send_text(self, line):
            nonlocal active_sends, max_active_sends
            active_sends += 1
            max_active_sends = max(max_active_sends, active_sends)
            try:
                await asyncio.sleep(0.05)
                sent.append(line)
            finally:
                active_sends -= 1

    loop = asyncio.new_event_loop()
    thread = threading.Thread(target=loop.run_forever, daemon=True)
    thread.start()
    try:
        transport = ws_mod.WSTransport(FakeWS(), loop, peer="serialize-test")
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            futures = [
                pool.submit(transport.write, {"idx": 1}),
                pool.submit(transport.write, {"idx": 2}),
            ]
            assert [f.result(timeout=2) for f in futures] == [True, True]

        assert len(sent) == 2
        assert max_active_sends == 1
        assert transport._closed is False
    finally:
        loop.call_soon_threadsafe(loop.stop)
        thread.join(timeout=2)
        loop.close()


def test_ws_transport_preserves_cross_batch_order():
    async def scenario():
        entered = []
        first_entered = asyncio.Event()
        release_first = asyncio.Event()
        second_started = asyncio.Event()

        class FakeWS:
            async def send_text(self, line):
                entered.append(line)
                if line == "A1":
                    first_entered.set()
                    await release_first.wait()

        transport = ws_mod.WSTransport(
            FakeWS(), asyncio.get_running_loop(), peer="batch-order-test"
        )
        first = asyncio.create_task(transport._safe_send_many(["A1", "A2"]))
        await first_entered.wait()

        async def send_second():
            second_started.set()
            await transport._safe_send_many(["B1", "B2"])

        second = asyncio.create_task(send_second())
        await second_started.wait()

        # The second task has reached the transport. Without whole-batch
        # serialization it runs B1/B2 before this task can resume.
        assert entered == ["A1"]

        release_first.set()
        await asyncio.gather(first, second)
        assert entered == ["A1", "A2", "B1", "B2"]

    asyncio.run(scenario())


def test_ws_write_async_keeps_drained_tokens_with_current_frame():
    async def scenario():
        entered = []
        first_entered = asyncio.Event()
        release_first = asyncio.Event()
        current_started = asyncio.Event()

        class FakeWS:
            async def send_text(self, line):
                entered.append(line)
                if line == "A1":
                    first_entered.set()
                    await release_first.wait()

        transport = ws_mod.WSTransport(
            FakeWS(), asyncio.get_running_loop(), peer="async-order-test"
        )
        transport._pending_tokens.append("pending-token")

        first = asyncio.create_task(transport._safe_send_many(["A1", "A2"]))
        await first_entered.wait()

        async def send_current():
            current_started.set()
            await transport.write_async({"id": "current"})

        current = asyncio.create_task(send_current())
        await current_started.wait()
        later = asyncio.create_task(transport._safe_send_many(["later-batch"]))

        release_first.set()
        await asyncio.gather(first, current, later)
        assert entered == [
            "A1",
            "A2",
            "pending-token",
            json.dumps({"id": "current"}),
            "later-batch",
        ]

    asyncio.run(scenario())


# ---------------------------------------------------------------------------
# Concurrent sessions on ONE websocket.
#
# The client demuxes purely on params.session_id, so these guard the two
# properties that makes possible: every frame is attributed, and a session
# already streaming to one viewer is not handed to another (MJX-132).
# ---------------------------------------------------------------------------


def test_event_frames_always_carry_their_session_id():
    """`_event_frame` is the single builder for every event the gateway emits."""
    for event in (
        "message.start",
        "message.delta",
        "reasoning.delta",
        "tool.start",
        "tool.complete",
        "message.complete",
    ):
        for sid in ("session-a", "session-b"):
            frame = server._event_frame(event, sid, {"text": "x"})

            assert frame["method"] == "event"
            assert frame["params"]["session_id"] == sid
            assert frame["params"]["type"] == event

    # A payload-less frame still carries its id (payload is the optional half).
    assert server._event_frame("message.start", "session-a")["params"] == {
        "type": "message.start",
        "session_id": "session-a",
    }


def test_two_sessions_on_one_transport_keep_their_own_ids():
    """Interleaved emits from two sessions never borrow each other's id."""
    written = []

    class RecordingTransport:
        def write(self, obj):
            written.append(obj)
            return True

    transport = RecordingTransport()

    for sid, text in (("a", "A1"), ("b", "B1"), ("a", "A2"), ("b", "B2")):
        transport.write(server._event_frame("message.delta", sid, {"text": text}))

    by_session = {}
    for frame in written:
        params = frame["params"]
        by_session.setdefault(params["session_id"], []).append(params["payload"]["text"])

    assert by_session == {"a": ["A1", "A2"], "b": ["B1", "B2"]}


def _rebind_session(running, current_transport):
    return {"running": running, "transport": current_transport}


def test_resume_does_not_steal_a_running_sessions_transport():
    """A second viewer resuming a session must not take over its live stream.

    Resume is also how another window / tile / bubble PEEKS at a session. When
    it rebound unconditionally, a turn already streaming to viewer A suddenly
    emitted to viewer B, and A watched its own answer stop mid-sentence.
    """
    viewer_a = object()
    viewer_b = object()

    assert not server._resume_may_rebind_transport(_rebind_session(True, viewer_a), viewer_b)


def test_resume_rebinds_an_idle_session():
    """With no turn in flight there is nothing to interrupt."""
    viewer_a = object()
    viewer_b = object()

    assert server._resume_may_rebind_transport(_rebind_session(False, viewer_a), viewer_b)


def test_resume_rebinds_a_running_session_whose_viewer_disconnected():
    """A detached session has no live reader, so the resuming client wins."""
    viewer_b = object()

    detached = _rebind_session(True, server._detached_ws_transport)
    assert server._resume_may_rebind_transport(detached, viewer_b)

    on_stdio = _rebind_session(True, server._stdio_transport)
    assert server._resume_may_rebind_transport(on_stdio, viewer_b)


def test_resume_is_idempotent_for_the_same_viewer():
    """The viewer that already owns the stream may always re-assert it."""
    viewer_a = object()

    assert server._resume_may_rebind_transport(_rebind_session(True, viewer_a), viewer_a)
    assert server._resume_may_rebind_transport(_rebind_session(True, None), viewer_a)


def test_secret_capture_callback_is_thread_local():
    """Concurrent turns must not share one session's secret-capture callback.

    The gateway wires this per turn with a callback closed over that turn's
    session id; as a module global the last writer won, so a secret prompt
    raised by session A could be emitted carrying session B's id.
    """
    from tools import skills_tool

    previous_default = skills_tool._secret_capture_callback
    seen = {}
    barrier = threading.Barrier(2)

    def worker(sid):
        skills_tool.set_secret_capture_callback(lambda: sid, thread_only=True)
        barrier.wait(timeout=5)  # let the other thread install its callback too
        seen[sid] = skills_tool.get_secret_capture_callback()()

    try:
        threads = [threading.Thread(target=worker, args=(sid,)) for sid in ("a", "b")]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=5)

        assert seen == {"a": "a", "b": "b"}
        # thread_only must leave the process-wide default untouched.
        assert skills_tool._secret_capture_callback is previous_default
    finally:
        skills_tool._secret_capture_callback = previous_default
        skills_tool._secret_capture_tls.callback = None
