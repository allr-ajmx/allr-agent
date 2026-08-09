import asyncio
import threading
import time

import pytest

from hermes_cli.pty_session import RingBuffer


def test_ringbuffer_keeps_everything_under_capacity():
    rb = RingBuffer(10)
    rb.append(b"abc")
    rb.append(b"def")
    assert rb.snapshot() == b"abcdef"
    assert rb.truncated is False


def test_ringbuffer_drops_oldest_over_capacity():
    rb = RingBuffer(4)
    rb.append(b"abcdef")          # 6 bytes into a 4-byte buffer
    assert rb.snapshot() == b"cdef"
    assert rb.truncated is True




class FakeBridge:
    """Implements the bridge contract PtySession depends on."""

    def __init__(self, chunks):
        self._chunks = list(chunks)   # bytes; b"" = idle tick; None = EOF
        self.written = bytearray()
        self.closed = False
        self.resized = None

    def read(self, timeout):
        if not self._chunks:
            return b""                # idle
        return self._chunks.pop(0)

    def write(self, data):
        self.written.extend(data)

    def resize(self, cols, rows):
        self.resized = (cols, rows)

    def close(self):
        self.closed = True


class FakeWS:
    def __init__(self):
        self.sent = []               # list of ("bytes"|"text", payload)
        self.close_code = None

    async def send_bytes(self, data):
        self.sent.append(("bytes", bytes(data)))

    async def send_text(self, text):
        self.sent.append(("text", text))

    async def close(self, code=1000, reason=""):
        self.close_code = code


@pytest.mark.asyncio
async def test_attach_replays_buffer_then_streams_live():
    from hermes_cli.pty_session import PtySession
    bridge = FakeBridge([b"hello ", b"world", None])
    s = PtySession("k", bridge, buffer_cap=1024, read_timeout=0.01)
    await s.start()
    await asyncio.sleep(0.05)                      # drain consumes "hello world"
    ws = FakeWS()
    await s.attach(ws)
    replay = b"".join(p for kind, p in ws.sent if kind == "bytes")
    assert replay == b"hello world"
    await s.close()




@pytest.mark.asyncio
async def test_eof_marks_dead_and_closes_socket_4410():
    from hermes_cli.pty_session import PtySession
    bridge = FakeBridge([b"bye", None])
    s = PtySession("k", bridge, buffer_cap=1024, read_timeout=0.01)
    await s.start()
    ws = FakeWS()
    await s.attach(ws)
    await asyncio.sleep(0.05)                      # drain hits None (EOF)
    assert s.alive is False
    assert ws.close_code == 4410
    await s.close()


from hermes_cli.pty_session import PtySessionRegistry, RegistryFull


def make_registry(ttl=1800.0, max_sessions=16):
    return PtySessionRegistry(ttl=ttl, max_sessions=max_sessions,
                              buffer_cap=1024, read_timeout=0.01)


@pytest.mark.asyncio
async def test_same_key_reattaches_same_session():
    reg = make_registry()
    b1 = FakeBridge([b"", b"", b""])
    s1, created1 = await reg.attach_or_spawn("tok", spawn=lambda: b1)
    s2, created2 = await reg.attach_or_spawn("tok", spawn=lambda: FakeBridge([]))
    assert created1 is True and created2 is False
    assert s1 is s2
    assert s2.bridge is b1                     # second spawn callable was NOT used
    await reg.close_all()




@pytest.mark.asyncio
async def test_new_key_at_capacity_raises_when_none_reapable():
    reg = make_registry(max_sessions=1)
    b = FakeBridge([b"", b""])
    s, _ = await reg.attach_or_spawn("a", spawn=lambda: b)
    await s.attach(FakeWS())                    # attached → not reapable
    with pytest.raises(RegistryFull):
        await reg.attach_or_spawn("b", spawn=lambda: FakeBridge([]))
    await reg.close_all()


async def _drop_the_caller_mid_fork(reg, bridge):
    """Cancel an attach_or_spawn caller while its fork is in flight.

    Stands in for the client that disconnects inside the few milliseconds the
    spawn takes — a refresh, a flaky tunnel. Returns once the registry has
    settled.
    """
    forked = threading.Event()
    release = threading.Event()

    def slow_spawn():
        forked.set()              # the child exists as of this line...
        release.wait(5)
        return bridge

    caller = asyncio.create_task(reg.attach_or_spawn("tok", spawn=slow_spawn))
    while not forked.is_set():    # ...and the caller walks away right here
        await asyncio.sleep(0.01)
    caller.cancel()
    with pytest.raises(asyncio.CancelledError):
        await caller
    release.set()

    for _ in range(500):
        if "tok" in reg._sessions:
            return
        await asyncio.sleep(0.01)


@pytest.mark.asyncio
async def test_spawn_cancelled_mid_fork_is_not_orphaned():
    """The registry ends up owning a child whose caller never came back.

    Before the shield, the CancelledError landed between the fork and the
    registry insert and the process was leaked for the life of the gateway:
    unregistered, unreferenced, and with nothing left alive to close it.
    """
    reg = make_registry()
    b = FakeBridge([b"", b""])
    await _drop_the_caller_mid_fork(reg, b)

    assert "tok" in reg._sessions
    assert b.closed is False              # still running — it is a live PTY
    await reg.close_all()
    assert b.closed is True               # ...and the registry can dispose of it


@pytest.mark.asyncio
async def test_spawn_cancelled_mid_fork_is_reapable():
    """Nobody will ever attach to it, so it must not sit there holding a PTY."""
    reg = make_registry(ttl=10.0)
    b = FakeBridge([b"", b""])
    await _drop_the_caller_mid_fork(reg, b)

    s = reg._sessions["tok"]
    assert s.attached is False
    await reg.reap_idle(now=s.last_detached_at + 11.0)   # idle 11s, ttl 10s
    assert "tok" not in reg._sessions
    assert b.closed is True


@pytest.mark.asyncio
async def test_reaper_loop_invokes_reap(monkeypatch):
    from hermes_cli.pty_session import run_reaper
    reg = make_registry()
    calls = {"n": 0}

    async def fake_reap(now=None):
        calls["n"] += 1

    monkeypatch.setattr(reg, "reap_idle", fake_reap)
    task = asyncio.create_task(run_reaper(reg, interval=0.01))
    await asyncio.sleep(0.05)
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    assert calls["n"] >= 2
