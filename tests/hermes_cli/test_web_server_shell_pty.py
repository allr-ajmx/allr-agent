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
