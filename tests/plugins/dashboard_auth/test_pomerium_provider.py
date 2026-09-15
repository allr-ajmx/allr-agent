"""Pomerium dashboard-auth plugin + the gate's trusted-proxy (assertion) path.

Pomerium signs users in at the edge and forwards a signed
``X-Pomerium-Jwt-Assertion``. The provider verifies it; the gate consults it
before bearer/cookie auth. Keys are generated per run, nothing is checked in.
"""
from __future__ import annotations

import base64
import time

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.testclient import TestClient

import plugins.dashboard_auth.pomerium as pomerium_plugin
from hermes_cli import web_server
from hermes_cli.dashboard_auth import (
    AccountNotAllowedError,
    ProviderError,
    assert_protocol_compliance,
    clear_providers,
    list_session_providers,
    register_provider,
)
from plugins.dashboard_auth.pomerium import (
    ASSERTION_HEADER,
    SIGN_OUT_PATH,
    PomeriumAssertionProvider,
    load_public_keys,
)
from tests.hermes_cli.conftest_dashboard_auth import StubAuthProvider

HOST = "xm.allr.test"
OWNER = "xm@example.com"


def _keypair():
    private = ec.generate_private_key(ec.SECP256R1())
    public_pem = private.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    return private, public_pem


def _b64(pem: bytes) -> str:
    return base64.b64encode(pem).decode()


def _assertion(private, **overrides) -> str:
    now = int(time.time())
    claims = {
        "iss": HOST, "aud": HOST, "sub": "user-1", "iat": now, "exp": now + 300,
        "email": OWNER, "name": "Xm",
    }
    claims.update(overrides)
    return jwt.encode(claims, private, algorithm="ES256")


@pytest.fixture(scope="module")
def signing():
    return _keypair()


@pytest.fixture
def provider(signing):
    _, public_pem = signing
    return PomeriumAssertionProvider(
        public_keys=load_public_keys(_b64(public_pem)), audience=HOST, allowed_emails=OWNER
    )


# ---------------------------------------------------------------------------
# Provider
# ---------------------------------------------------------------------------


def test_protocol_compliance():
    assert assert_protocol_compliance(PomeriumAssertionProvider) is None


def test_owner_assertion_yields_session(provider, signing):
    session = provider.verify_assertion(assertion=_assertion(signing[0]))
    assert session is not None
    assert session.email == OWNER
    assert session.user_id == "user-1"
    assert session.provider == "pomerium"
    assert session.access_token == "" and session.refresh_token == ""


def test_owner_match_ignores_case(provider, signing):
    token = _assertion(signing[0], email="XM@Example.COM")
    assert provider.verify_assertion(assertion=token) is not None


def test_other_account_is_not_allowed(provider, signing):
    token = _assertion(signing[0], email="stranger@example.com")
    with pytest.raises(AccountNotAllowedError) as exc:
        provider.verify_assertion(assertion=token)
    # Existing callers match on ProviderError / the "not allowed" wording.
    assert isinstance(exc.value, ProviderError)
    assert "not allowed" in str(exc.value)


@pytest.mark.parametrize("overrides", [
    {"aud": "someone.allr.test"},            # minted for another dashboard
    {"aud": f"app.{HOST}", "iss": f"app.{HOST}"},  # minted for the portal
    {"iss": "evil.example"},
    {"iat": 1, "exp": 2},                    # expired
])
def test_foreign_or_expired_assertion_is_rejected(provider, signing, overrides):
    assert provider.verify_assertion(assertion=_assertion(signing[0], **overrides)) is None


def test_assertion_signed_by_another_key_is_rejected(provider):
    other, _ = _keypair()
    assert provider.verify_assertion(assertion=_assertion(other)) is None


def test_hs256_forgery_with_public_key_is_rejected(provider, signing):
    """Algorithm confusion: an HMAC 'signed' with the public PEM must not pass.

    Built by hand, because PyJWT itself refuses to HMAC-sign with a PEM key.
    """
    import hashlib
    import hmac
    import json

    _, public_pem = signing
    now = int(time.time())

    def b64url(raw: bytes) -> bytes:
        return base64.urlsafe_b64encode(raw).rstrip(b"=")

    header = b64url(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    payload = b64url(json.dumps({
        "iss": HOST, "aud": HOST, "sub": "x", "iat": now, "exp": now + 300, "email": OWNER,
    }).encode())
    sig = b64url(hmac.new(public_pem, header + b"." + payload, hashlib.sha256).digest())
    forged = (header + b"." + payload + b"." + sig).decode()
    assert provider.verify_assertion(assertion=forged) is None


def test_garbage_assertion_is_rejected(provider):
    assert provider.verify_assertion(assertion="not-a-jwt") is None


def test_rotation_window_accepts_either_key(signing):
    new_private, new_pem = _keypair()
    _, old_pem = signing
    p = PomeriumAssertionProvider(
        public_keys=load_public_keys(_b64(old_pem + new_pem)),
        audience=HOST,
        allowed_emails=OWNER,
    )
    assert p.verify_assertion(assertion=_assertion(new_private)) is not None


def test_refuses_to_run_without_an_owner(signing):
    with pytest.raises(ValueError, match="allowed_emails"):
        PomeriumAssertionProvider(
            public_keys=load_public_keys(_b64(signing[1])), audience=HOST, allowed_emails=" , "
        )


def test_load_public_keys_accepts_raw_pem_and_rejects_garbage(signing):
    assert len(load_public_keys(signing[1].decode())) == 1
    with pytest.raises(ValueError):
        load_public_keys(_b64(b"no key in here"))
    with pytest.raises(ValueError):
        load_public_keys("")


def test_is_not_a_login_page_provider(provider):
    clear_providers()
    try:
        register_provider(StubAuthProvider())
        register_provider(provider)
        assert [p.name for p in list_session_providers()] == ["stub"]
    finally:
        clear_providers()


# ---------------------------------------------------------------------------
# Plugin registration
# ---------------------------------------------------------------------------


class _Ctx:
    def __init__(self):
        self.providers = []

    def register_dashboard_auth_provider(self, p):
        self.providers.append(p)


def test_register_skips_without_public_key(monkeypatch):
    monkeypatch.delenv("ALLR_DASHBOARD_POMERIUM_PUBLIC_KEY", raising=False)
    ctx = _Ctx()
    pomerium_plugin.register(ctx)
    assert ctx.providers == []
    assert "not configured" in pomerium_plugin.LAST_SKIP_REASON


def test_register_refuses_to_run_open(monkeypatch, signing):
    monkeypatch.setenv("ALLR_DASHBOARD_POMERIUM_PUBLIC_KEY", _b64(signing[1]))
    monkeypatch.setenv("ALLR_DASHBOARD_PUBLIC_URL", f"https://{HOST}")
    monkeypatch.delenv("ALLR_DASHBOARD_POMERIUM_ALLOWED_EMAILS", raising=False)
    ctx = _Ctx()
    pomerium_plugin.register(ctx)
    assert ctx.providers == []
    assert "allowed_emails" in pomerium_plugin.LAST_SKIP_REASON


def test_register_derives_audience_from_public_url(monkeypatch, signing):
    monkeypatch.setenv("ALLR_DASHBOARD_POMERIUM_PUBLIC_KEY", _b64(signing[1]))
    monkeypatch.setenv("ALLR_DASHBOARD_POMERIUM_ALLOWED_EMAILS", OWNER)
    monkeypatch.setenv("ALLR_DASHBOARD_PUBLIC_URL", f"https://{HOST}")
    monkeypatch.delenv("ALLR_DASHBOARD_POMERIUM_AUDIENCE", raising=False)
    ctx = _Ctx()
    pomerium_plugin.register(ctx)
    assert len(ctx.providers) == 1
    assert ctx.providers[0].verify_assertion(assertion=_assertion(signing[0])) is not None


# ---------------------------------------------------------------------------
# Gate: trusted-proxy path
# ---------------------------------------------------------------------------


@pytest.fixture
def gated(provider):
    """web_server.app gated, with a cookie provider AND the assertion provider."""
    clear_providers()
    register_provider(StubAuthProvider())
    register_provider(provider)
    prev = {
        k: getattr(web_server.app.state, k, None)
        for k in ("bound_host", "bound_port", "auth_required")
    }
    web_server.app.state.bound_host = HOST
    web_server.app.state.bound_port = 443
    web_server.app.state.auth_required = True
    yield TestClient(web_server.app, base_url=f"https://{HOST}")
    clear_providers()
    for k, v in prev.items():
        setattr(web_server.app.state, k, v)


def test_gate_admits_owner_by_assertion_alone(gated, signing):
    r = gated.get("/api/auth/me", headers={ASSERTION_HEADER: _assertion(signing[0])})
    assert r.status_code == 200, r.text
    assert r.json()["email"] == OWNER
    assert r.json()["provider"] == "pomerium"
    # Stateless: the proxy owns the session, the dashboard sets no cookie.
    assert "set-cookie" not in r.headers


def test_gate_without_assertion_is_unchanged(gated):
    assert gated.get("/api/auth/me").status_code == 401


def test_gate_answers_403_json_for_another_account_on_api(gated, signing):
    token = _assertion(signing[0], email="stranger@example.com")
    r = gated.get("/api/auth/me", headers={ASSERTION_HEADER: token})
    assert r.status_code == 403
    assert r.json()["error"] == "account_not_allowed"


def test_gate_answers_branded_403_for_another_account_in_browser(gated, signing):
    token = _assertion(signing[0], email="stranger@example.com")
    r = gated.get("/sessions", headers={ASSERTION_HEADER: token}, follow_redirects=False)
    assert r.status_code == 403
    assert "text/html" in r.headers["content-type"]
    assert "Access denied" in r.text
    assert SIGN_OUT_PATH in r.text


def test_gate_rejects_forged_assertion(gated):
    other, _ = _keypair()
    r = gated.get("/api/auth/me", headers={ASSERTION_HEADER: _assertion(other)})
    assert r.status_code == 401


def test_logout_behind_proxy_sets_signed_out_marker(gated, signing):
    r = gated.post(
        "/auth/logout",
        headers={ASSERTION_HEADER: _assertion(signing[0])},
        follow_redirects=False,
    )
    assert r.status_code == 302
    assert any("allr_signed_out=1" in c for c in r.headers.get_list("set-cookie"))


def test_spa_logout_behind_proxy_does_not_redirect(gated, signing):
    """The SPA logs out with fetch(): a redirect would be followed inside fetch
    into the proxy's cross-origin sign-out, the promise would reject and the
    page would never leave the (already signed-out) dashboard."""
    r = gated.post(
        "/auth/logout",
        headers={ASSERTION_HEADER: _assertion(signing[0]), "sec-fetch-mode": "cors"},
        follow_redirects=False,
    )
    assert r.status_code == 200
    assert "location" not in r.headers
    assert r.json()["next"] == "/login"
    assert any("allr_signed_out=1" in c for c in r.headers.get_list("set-cookie"))


def test_form_logout_behind_proxy_still_redirects(gated, signing):
    r = gated.post(
        "/auth/logout",
        headers={ASSERTION_HEADER: _assertion(signing[0]), "sec-fetch-mode": "navigate"},
        follow_redirects=False,
    )
    assert r.status_code == 302
    assert r.headers["location"] == "/login"


def test_spa_logout_without_proxy_is_unchanged(gated):
    r = gated.post("/auth/logout", headers={"sec-fetch-mode": "cors"}, follow_redirects=False)
    assert r.status_code == 302
    assert r.headers["location"] == "/login"


def test_logout_without_proxy_sets_no_marker(gated):
    r = gated.post("/auth/logout", follow_redirects=False)
    assert r.status_code == 302
    assert not any("allr_signed_out" in c for c in r.headers.get_list("set-cookie"))


def test_login_after_logout_finishes_sign_out_at_proxy(gated, signing):
    r = gated.get(
        "/login",
        headers={ASSERTION_HEADER: _assertion(signing[0]), "cookie": "allr_signed_out=1"},
        follow_redirects=False,
    )
    assert r.status_code == 302
    assert r.headers["location"] == SIGN_OUT_PATH
    assert any("allr_signed_out=" in c and "Max-Age=0" in c for c in r.headers.get_list("set-cookie"))


def test_login_when_already_signed_in_at_proxy_goes_home(gated, signing):
    r = gated.get(
        "/login", headers={ASSERTION_HEADER: _assertion(signing[0])}, follow_redirects=False
    )
    assert r.status_code == 302
    assert r.headers["location"] == "/"


def test_login_with_forged_assertion_renders_the_normal_page(gated):
    other, _ = _keypair()
    r = gated.get("/login", headers={ASSERTION_HEADER: _assertion(other)}, follow_redirects=False)
    assert r.status_code == 200
    assert "text/html" in r.headers["content-type"]
