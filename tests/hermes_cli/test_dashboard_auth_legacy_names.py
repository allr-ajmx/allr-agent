"""Both brand spellings of the auth wire contract must keep working.

The Allr rename swept the dashboard-auth cookie names and the session-token
header from ``hermes_*`` / ``X-Hermes-*`` to ``allr_*`` / ``X-Allr-*`` on both
sides of the wire at once. Every test stayed green, because both sides moved
together -- and every already-deployed peer broke, because they did not.

The concrete failure: the desktop app opened its sign-in window, the user
completed the login, the gateway set ``hermes_session_at``, and the client polled
for ``allr_session_at`` until it timed out. The window never closed and no token
was ever exchanged.

So the readers take either spelling. These tests pin that, and pin the two
things that make it safe: the current name still wins when both are present, and
signing out clears both (otherwise the next read would resurrect the session).
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from hermes_cli import web_server
from hermes_cli.dashboard_auth import clear_providers, register_provider
from hermes_cli.dashboard_auth.cookies import (
    LEGACY_PKCE_COOKIE,
    LEGACY_SESSION_AT_COOKIE,
    PKCE_COOKIE,
    SESSION_AT_COOKIE,
    pkce_payload_from,
)
from tests.hermes_cli.conftest_dashboard_auth import StubAuthProvider


@pytest.fixture
def gated_app():
    clear_providers()
    register_provider(StubAuthProvider())
    prev_host = getattr(web_server.app.state, "bound_host", None)
    prev_port = getattr(web_server.app.state, "bound_port", None)
    prev_required = getattr(web_server.app.state, "auth_required", None)
    web_server.app.state.bound_host = "fly-app.fly.dev"
    web_server.app.state.bound_port = 443
    web_server.app.state.auth_required = True
    client = TestClient(web_server.app, base_url="https://fly-app.fly.dev")
    yield client
    clear_providers()
    web_server.app.state.bound_host = prev_host
    web_server.app.state.bound_port = prev_port
    web_server.app.state.auth_required = prev_required


def _login(client: TestClient) -> str:
    """Walk the stub round trip and return the access token it landed."""
    r1 = client.get("/auth/login?provider=stub", follow_redirects=False)
    assert r1.status_code == 302
    state = r1.headers["location"].split("state=")[1]
    r2 = client.get(
        f"/auth/callback?code=stub_code&state={state}", follow_redirects=False,
    )
    assert r2.status_code == 302

    for name, value in client.cookies.items():
        if name.endswith(SESSION_AT_COOKIE):
            return value
    raise AssertionError(f"no session cookie in {dict(client.cookies)}")


def test_a_pre_rename_session_cookie_still_authenticates(gated_app):
    """The reported bug, at the layer that caused it.

    A gateway from before the rename sets ``hermes_session_at``. Present only
    that, and the gate must still recognise a live session -- otherwise a client
    that completed a real login reads as signed out.
    """
    token = _login(gated_app)
    gated_app.cookies.clear()
    gated_app.cookies.set(LEGACY_SESSION_AT_COOKIE, token)

    assert gated_app.get("/api/auth/me").status_code == 200


def test_the_current_cookie_wins_when_both_are_present(gated_app):
    """A jar that signed in before AND after the rename must not resolve to the
    stale half. Prefix variants of the canonical name are tried before the
    legacy name at all."""
    token = _login(gated_app)
    gated_app.cookies.set(LEGACY_SESSION_AT_COOKIE, "stale-and-invalid")

    assert gated_app.get("/api/auth/me").status_code == 200


def test_sign_out_clears_both_spellings(gated_app):
    """Otherwise sign-out is silently partial: the legacy cookie survives and
    the very next request authenticates with it again."""
    _login(gated_app)
    deleted = {
        header.split("=", 1)[0]
        for header in gated_app.post(
            "/auth/logout", follow_redirects=False,
        ).headers.get_list("set-cookie")
    }

    for bare in (SESSION_AT_COOKIE, LEGACY_SESSION_AT_COOKIE):
        assert any(name.endswith(bare) for name in deleted), (bare, deleted)


def test_the_session_token_header_is_accepted_under_either_name():
    """Token mode, the other half of the same break. A desktop build that only
    knows ``X-Hermes-Session-Token`` has no other way to authenticate."""
    for header in ("X-Allr-Session-Token", "X-Hermes-Session-Token"):
        request = type(
            "R", (), {"headers": {header: web_server._SESSION_TOKEN}},
        )()

        assert web_server._has_valid_session_token(request) is True, header


def test_a_wrong_token_is_still_refused_under_either_name():
    """The fallback widens which NAME is read, never which VALUE passes."""
    for header in ("X-Allr-Session-Token", "X-Hermes-Session-Token"):
        request = type("R", (), {"headers": {header: "not-the-token"}})()

        assert web_server._has_valid_session_token(request) is False, header


@pytest.mark.parametrize("key", [PKCE_COOKIE, LEGACY_PKCE_COOKIE])
def test_a_provider_may_name_the_pkce_payload_either_way(key):
    """``cookie_payload`` is a plugin-facing contract: a dashboard_auth provider
    written before the rename is still a valid provider."""
    assert pkce_payload_from({key: "state=s;verifier=v"}) == "state=s;verifier=v"


def test_an_absent_pkce_payload_reads_as_empty_not_a_crash():
    assert pkce_payload_from({}) == ""
