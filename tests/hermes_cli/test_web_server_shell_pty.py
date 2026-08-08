"""The /api/shell-pty endpoint: spawns the operator's $SHELL and pumps bytes
(keystrokes in, output out) with the shared `\\x1b[RESIZE:cols;rows]` resize
escape consumed server-side. Mirrors tests/test_pty_keepalive_ws.py's approach:
monkeypatch PtyBridge.spawn with a fake, bypass the WS auth gates."""

import pytest

from hermes_cli import web_server


@pytest.mark.asyncio
async def test_shell_pty_spawns_shell_and_pumps(monkeypatch):
    captured = {}
    resizes = []

    class FakeBridge:
        def __init__(self):
            self._outbox = [b"welcome\r\n"]  # a fresh shell's first prompt

        def read(self, timeout):
            return self._outbox.pop(0) if self._outbox else b""

        def write(self, data):
            self._outbox.append(bytes(data))  # a shell echoes stdin back to the tty

        def resize(self, cols, rows):
            resizes.append((cols, rows))

        def close(self):
            pass

    def fake_spawn(argv, **kwargs):
        captured["argv"] = list(argv)
        captured["cwd"] = kwargs.get("cwd")
        captured["env"] = kwargs.get("env") or {}
        return FakeBridge()

    monkeypatch.setattr(web_server.PtyBridge, "spawn", staticmethod(fake_spawn))
    monkeypatch.setattr(web_server, "_PTY_BRIDGE_AVAILABLE", True)
    monkeypatch.setattr(web_server, "_ws_auth_reason", lambda ws: (None, "test"))
    monkeypatch.setattr(web_server, "_ws_host_origin_reason", lambda ws: None)
    monkeypatch.setattr(web_server, "_ws_client_reason", lambda ws: None)
    # A gateway secret in the env must NOT leak into the child shell (finding 2).
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sekret")

    from starlette.testclient import TestClient

    client = TestClient(web_server.app)
    with client.websocket_connect("/api/shell-pty") as ws:
        assert ws.receive_bytes() == b"welcome\r\n"
        # The resize escape is consumed by the pump, never written to the PTY.
        ws.send_bytes(b"\x1b[RESIZE:120;40]")
        # A keystroke reaches bridge.write and is echoed straight back.
        ws.send_bytes(b"echo hi\r")
        assert ws.receive_bytes() == b"echo hi\r"

    # It spawned a login shell (argv == [shell, "-l"]) with a real cwd + a terminal env.
    assert captured["argv"] and captured["argv"][0]
    assert captured["argv"] == [captured["argv"][0], "-l"]
    assert captured["cwd"]
    assert captured["env"].get("TERM") == "xterm-256color"
    # Secret dropped by the allowlist.
    assert "ANTHROPIC_API_KEY" not in captured["env"]
    assert "sekret" not in captured["env"].values()
    assert resizes == [(120, 40)]


@pytest.mark.asyncio
async def test_shell_pty_disabled_off(monkeypatch):
    spawned = []

    def fake_spawn(argv, **kwargs):
        spawned.append(list(argv))
        raise AssertionError("spawn must not be called when shell_pty is off")

    monkeypatch.setattr(web_server.PtyBridge, "spawn", staticmethod(fake_spawn))
    monkeypatch.setattr(web_server, "_PTY_BRIDGE_AVAILABLE", True)
    monkeypatch.setattr(web_server, "_ws_auth_reason", lambda ws: (None, "test"))
    monkeypatch.setattr(web_server, "_ws_host_origin_reason", lambda ws: None)
    monkeypatch.setattr(web_server, "_ws_client_reason", lambda ws: None)
    monkeypatch.setenv("TERMINAL_SHELL_PTY", "off")

    from starlette.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect

    client = TestClient(web_server.app)

    # /api/health is the primary gate the client probes.
    assert client.get("/api/health").json()["features"]["shell_pty"] is False

    # The WS accepts, sends an ANSI banner, then closes 4404 without spawning.
    with pytest.raises(WebSocketDisconnect) as excinfo:
        with client.websocket_connect("/api/shell-pty") as ws:
            banner = ws.receive_text()
            assert "disabled" in banner
            ws.receive_text()  # next frame is the disconnect
    assert excinfo.value.code == 4404
    assert spawned == []


def _bypass_ws_gates(monkeypatch):
    """Neutralize the auth/host/client WS gates so tests hit the routing logic."""
    monkeypatch.setattr(web_server, "_PTY_BRIDGE_AVAILABLE", True)
    monkeypatch.setattr(web_server, "_ws_auth_reason", lambda ws: (None, "test"))
    monkeypatch.setattr(web_server, "_ws_host_origin_reason", lambda ws: None)
    monkeypatch.setattr(web_server, "_ws_client_reason", lambda ws: None)


@pytest.mark.asyncio
async def test_shell_pty_docker_happy_path(monkeypatch):
    captured = {}

    class FakeBridge:
        def __init__(self):
            self._outbox = [b"container\r\n"]

        def read(self, timeout):
            return self._outbox.pop(0) if self._outbox else b""

        def write(self, data):
            pass

        def resize(self, cols, rows):
            pass

        def close(self):
            pass

    def fake_spawn(argv, **kwargs):
        captured["argv"] = list(argv)
        return FakeBridge()

    _bypass_ws_gates(monkeypatch)
    monkeypatch.setattr(web_server.PtyBridge, "spawn", staticmethod(fake_spawn))
    monkeypatch.setattr(web_server, "_probe_docker_backend", lambda: ("ready", ""))
    monkeypatch.setattr(web_server, "load_config", lambda: {"terminal": {"backend": "docker"}})
    # TERMINAL_ENV would otherwise win over the config backend.
    monkeypatch.delenv("TERMINAL_ENV", raising=False)

    class _CP:
        stdout = "abc123def456\n"

    monkeypatch.setattr(web_server.subprocess, "run", lambda *a, **k: _CP())

    from starlette.testclient import TestClient

    client = TestClient(web_server.app)
    with client.websocket_connect("/api/shell-pty") as ws:
        assert ws.receive_bytes() == b"container\r\n"

    argv = captured["argv"]
    assert argv[:3] == [argv[0], "exec", "-it"]
    assert "abc123def456" in argv
    assert argv[-2:] == ["bash", "-l"]
    assert "-w" in argv


@pytest.mark.asyncio
async def test_shell_pty_docker_daemon_down_refuses(monkeypatch):
    spawned = []

    def fake_spawn(argv, **kwargs):
        spawned.append(list(argv))
        raise AssertionError("spawn must not be called when the daemon is down")

    _bypass_ws_gates(monkeypatch)
    monkeypatch.setattr(web_server.PtyBridge, "spawn", staticmethod(fake_spawn))
    monkeypatch.setattr(
        web_server,
        "_probe_docker_backend",
        lambda: ("needs_setup", "Docker daemon not reachable — start Docker and retry."),
    )
    monkeypatch.setattr(web_server, "load_config", lambda: {"terminal": {"backend": "docker"}})
    monkeypatch.delenv("TERMINAL_ENV", raising=False)

    from starlette.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect

    client = TestClient(web_server.app)
    with pytest.raises(WebSocketDisconnect) as excinfo:
        with client.websocket_connect("/api/shell-pty") as ws:
            assert "not reachable" in ws.receive_text()
            ws.receive_text()
    assert excinfo.value.code == 4404
    assert spawned == []


@pytest.mark.asyncio
async def test_shell_pty_network_local_refuses(monkeypatch):
    spawned = []

    def fake_spawn(argv, **kwargs):
        spawned.append(list(argv))
        raise AssertionError("spawn must not be called on a network bind + local")

    _bypass_ws_gates(monkeypatch)
    monkeypatch.setattr(web_server.PtyBridge, "spawn", staticmethod(fake_spawn))
    monkeypatch.setattr(web_server, "load_config", lambda: {"terminal": {"backend": "local"}})
    monkeypatch.delenv("TERMINAL_ENV", raising=False)
    # setattr (not a bare assignment) so monkeypatch restores the prior value on
    # teardown — a leaked non-loopback bound_host arms the host-header gate for
    # every later test.
    monkeypatch.setattr(web_server.app.state, "bound_host", "0.0.0.0", raising=False)

    from starlette.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect

    client = TestClient(web_server.app)
    with pytest.raises(WebSocketDisconnect) as excinfo:
        with client.websocket_connect("/api/shell-pty") as ws:
            assert "network-exposed" in ws.receive_text()
            ws.receive_text()
    assert excinfo.value.code == 4404
    assert spawned == []


@pytest.mark.asyncio
async def test_shell_pty_modal_refuses(monkeypatch):
    spawned = []

    def fake_spawn(argv, **kwargs):
        spawned.append(list(argv))
        raise AssertionError("spawn must not be called for a non-interactive backend")

    _bypass_ws_gates(monkeypatch)
    monkeypatch.setattr(web_server.PtyBridge, "spawn", staticmethod(fake_spawn))
    monkeypatch.setattr(web_server, "load_config", lambda: {"terminal": {"backend": "modal"}})
    monkeypatch.delenv("TERMINAL_ENV", raising=False)

    from starlette.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect

    client = TestClient(web_server.app)
    with pytest.raises(WebSocketDisconnect) as excinfo:
        with client.websocket_connect("/api/shell-pty") as ws:
            assert "modal" in ws.receive_text()
            ws.receive_text()
    assert excinfo.value.code == 4404
    assert spawned == []


@pytest.mark.asyncio
async def test_shell_pty_attach_registers_and_reattaches(monkeypatch):
    """?attach= binds the shell to a keep-alive session: one spawn, reattach by
    token, and a second live connect on the same token supersedes the first."""
    spawned = []

    class FakeBridge:
        def __init__(self):
            self.alive = True

        def read(self, timeout):
            return b""  # idle forever — keeps the session alive across the drop

        def write(self, data):
            pass

        def resize(self, cols, rows):
            pass

        def close(self):
            self.alive = False

    def fake_spawn(argv, cwd=None, env=None):
        spawned.append(list(argv))
        return FakeBridge()

    _bypass_ws_gates(monkeypatch)
    monkeypatch.setattr(web_server.PtyBridge, "spawn", staticmethod(fake_spawn))

    from starlette.testclient import TestClient

    client = TestClient(web_server.app)
    try:
        with client.websocket_connect("/api/shell-pty?attach=TOK1") as ws1:
            ws1.send_bytes(b"hi")
        # Registered under the namespaced key, kept alive after the socket dropped.
        assert "shellpty:TOK1" in web_server.PTY_REGISTRY._sessions

        # Reattach with the same token: no respawn.
        with client.websocket_connect("/api/shell-pty?attach=TOK1") as ws2:
            ws2.send_bytes(b"again")
        assert len(spawned) == 1

        # A distinct token spawns its own session (no collision with /api/pty keys).
        with client.websocket_connect("/api/shell-pty?attach=TOK2") as ws3:
            ws3.send_bytes(b"other")
        assert len(spawned) == 2
        assert "shellpty:TOK2" in web_server.PTY_REGISTRY._sessions
    finally:
        web_server.PTY_REGISTRY._sessions.clear()


@pytest.mark.asyncio
async def test_shell_pty_attach_second_live_connect_supersedes(monkeypatch):
    """Two overlapping connects on one token: the first is closed 4409 (superseded)."""
    def fake_spawn(argv, cwd=None, env=None):
        class FakeBridge:
            alive = True

            def read(self, timeout):
                return b""

            def write(self, data):
                pass

            def resize(self, cols, rows):
                pass

            def close(self):
                pass

        return FakeBridge()

    _bypass_ws_gates(monkeypatch)
    monkeypatch.setattr(web_server.PtyBridge, "spawn", staticmethod(fake_spawn))

    from starlette.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect

    client = TestClient(web_server.app)
    try:
        with client.websocket_connect("/api/shell-pty?attach=DUP") as ws1:
            ws1.send_bytes(b"first")
            with pytest.raises(WebSocketDisconnect) as excinfo:
                with client.websocket_connect("/api/shell-pty?attach=DUP") as ws2:
                    ws2.send_bytes(b"second")
                    # ws1 is now superseded; the next frame it sees is the close.
                    ws1.receive_bytes()
            from hermes_cli.pty_session import WS_CLOSE_SUPERSEDED

            assert excinfo.value.code == WS_CLOSE_SUPERSEDED
    finally:
        web_server.PTY_REGISTRY._sessions.clear()


@pytest.mark.asyncio
async def test_health_advertises_shell_pty_reattach(monkeypatch):
    from starlette.testclient import TestClient

    client = TestClient(web_server.app)
    # A loopback Host header so this passes whether or not a prior test armed the
    # host-header gate by leaving app.state.bound_host set.
    h = {"host": "127.0.0.1"}

    monkeypatch.delenv("TERMINAL_SHELL_PTY", raising=False)
    feats = client.get("/api/health", headers=h).json()["features"]
    assert feats["shell_pty_reattach"] is True

    monkeypatch.setenv("TERMINAL_SHELL_PTY", "off")
    feats = client.get("/api/health", headers=h).json()["features"]
    assert feats["shell_pty_reattach"] is False


@pytest.mark.asyncio
async def test_shell_pty_rejects_unauthenticated(monkeypatch):
    monkeypatch.setattr(web_server, "_ws_auth_reason", lambda ws: ("missing", ""))

    from starlette.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect

    client = TestClient(web_server.app)
    with pytest.raises(WebSocketDisconnect) as excinfo:
        with client.websocket_connect("/api/shell-pty") as ws:
            ws.receive_bytes()

    assert excinfo.value.code == 4401
