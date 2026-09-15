"""PomeriumAssertionProvider — dashboard auth by Pomerium's signed identity assertion.

Allr.OS puts Pomerium, an identity-aware proxy, in front of every browser
dashboard. Pomerium signs the user in once (through Dex) and forwards each
request with an ``X-Pomerium-Jwt-Assertion`` header: an ES256 JWT naming the
user, minted for this dashboard's host name and valid for five minutes. This
provider verifies that assertion and admits only the dashboard's owner. For
browser traffic the dashboard therefore does no OIDC round trip, sets no
session cookie and refreshes nothing.

Why a signed assertion and not a plain ``X-User`` header: every agent container
shares a Docker network, so another agent can reach this dashboard's port
without passing through Caddy or Pomerium. A header anyone can set would be a
takeover; a signature only Pomerium's private key can produce is not. ``aud``
and ``iss`` are pinned to this dashboard's public host, so an assertion minted
for a different route (another dashboard, the portal) is rejected as well.

The public key is pinned in the environment instead of fetched from Pomerium's
JWKS endpoint: a fetch over that shared network is exactly the path a hostile
neighbour could tamper with, and pinning also removes a runtime dependency.

Configuration (environment only; this plugin exists for the Allr.OS edge)::

    ALLR_DASHBOARD_POMERIUM_PUBLIC_KEY      base64-encoded PEM with one or more
                                            public keys (several = a rotation
                                            window). Required.
    ALLR_DASHBOARD_POMERIUM_ALLOWED_EMAILS  comma-separated owner email(s).
                                            Required: Pomerium lets any signed-in
                                            account through, the owner check is
                                            this plugin's job, so it refuses to
                                            run without one.
    ALLR_DASHBOARD_POMERIUM_AUDIENCE        the dashboard's public host name.
                                            Defaults to the host of
                                            ALLR_DASHBOARD_PUBLIC_URL.

The provider is assertion-only (``supports_session = False``): it never appears
on the login page and takes no part in the cookie verify/refresh loops. The
desktop app's native login and bearer tokens keep using the ``self-hosted``
OIDC provider, which Caddy routes to directly.
"""

from __future__ import annotations

import base64
import logging
import os
import re
import urllib.parse
from typing import Any, List, Optional

from hermes_cli.dashboard_auth import (
    DashboardAuthProvider,
    LoginStart,
    ProviderError,
    RefreshExpiredError,
    Session,
)
from hermes_cli.dashboard_auth.base import AccountNotAllowedError

logger = logging.getLogger(__name__)

ASSERTION_HEADER = "x-pomerium-jwt-assertion"
# Pomerium's own sign-out endpoint, served on every route host.
SIGN_OUT_PATH = "/.pomerium/sign_out"
# Pomerium signs assertions with P-256 keys.
_ALLOWED_ALGS = ("ES256",)
# Clock skew between the proxy and this container.
_LEEWAY_SEC = 30
_PEM_RE = re.compile(r"-----BEGIN PUBLIC KEY-----.+?-----END PUBLIC KEY-----", re.S)

LAST_SKIP_REASON: str = ""


def load_public_keys(value: str) -> List[Any]:
    """Parse one or more PEM public keys, raw or base64-encoded.

    Base64 is Pomerium's own convention for key material in environment
    variables (its ``SIGNING_KEY`` is a base64 PEM), so the public half is
    carried the same way. Raises ``ValueError`` on anything unusable.
    """
    from cryptography.hazmat.primitives.serialization import load_pem_public_key

    value = (value or "").strip()
    if not value:
        raise ValueError("no public key configured")
    pem = value if value.startswith("-----BEGIN") else base64.b64decode(value).decode()
    blocks = _PEM_RE.findall(pem)
    if not blocks:
        raise ValueError("no PEM public key found")
    return [load_pem_public_key(block.encode()) for block in blocks]


def _host_of(url: str) -> str:
    return (urllib.parse.urlparse(url.strip()).hostname or "") if url else ""


class PomeriumAssertionProvider(DashboardAuthProvider):
    """Verifies ``X-Pomerium-Jwt-Assertion`` and admits the dashboard's owner."""

    name = "pomerium"
    display_name = "Allr SSO"

    supports_session = False
    supports_assertion = True
    assertion_header = ASSERTION_HEADER
    sign_out_url = SIGN_OUT_PATH

    def __init__(
        self,
        *,
        public_keys: List[Any],
        audience: str,
        allowed_emails: str,
    ) -> None:
        if not public_keys:
            raise ValueError("at least one public key is required")
        if not audience:
            raise ValueError("audience (the dashboard's public host) is required")
        emails = {e.strip().lower() for e in allowed_emails.split(",") if e.strip()}
        if not emails:
            raise ValueError(
                "allowed_emails is required: Pomerium admits any signed-in "
                "account, so without an owner this dashboard would be open"
            )
        self._keys = list(public_keys)
        self._audience = audience
        self._allowed_emails = emails

    # ---- assertion (the only real path) ------------------------------------

    def verify_assertion(self, *, assertion: str) -> Optional[Session]:
        import jwt  # lazy import, like the self-hosted provider

        claims = None
        for key in self._keys:
            try:
                claims = jwt.decode(
                    assertion,
                    key,
                    algorithms=list(_ALLOWED_ALGS),
                    audience=self._audience,
                    issuer=self._audience,
                    options={"require": ["exp", "iat", "aud", "iss", "sub"]},
                    leeway=_LEEWAY_SEC,
                )
                break
            except jwt.InvalidSignatureError:
                continue  # possibly the other key of a rotation pair
            except jwt.InvalidTokenError:
                # Expired, wrong audience, malformed: no other key changes that.
                return None
        if claims is None:
            return None

        email = str(claims.get("email") or "").strip()
        if email.lower() not in self._allowed_emails:
            raise AccountNotAllowedError(
                f"account {email or '<no email>'!r} is not allowed on this dashboard"
            )
        return Session(
            user_id=str(claims["sub"]),
            email=email,
            display_name=str(claims.get("name") or email),
            org_id="",
            provider=self.name,
            expires_at=int(claims["exp"]),
            access_token="",
            refresh_token="",
        )

    # ---- interactive protocol: not applicable behind the proxy -------------

    def start_login(self, *, redirect_uri: str) -> LoginStart:
        raise ProviderError("Pomerium signs users in at the edge; there is no dashboard login")

    def complete_login(
        self, *, code: str, state: str, code_verifier: str, redirect_uri: str
    ) -> Session:
        raise ProviderError("Pomerium signs users in at the edge; there is no dashboard login")

    def verify_session(self, *, access_token: str) -> Optional[Session]:
        return None

    def refresh_session(self, *, refresh_token: str) -> Session:
        raise RefreshExpiredError("Pomerium sessions are refreshed by the proxy")

    def revoke_session(self, *, refresh_token: str) -> None:
        return None


def register(ctx) -> None:
    """Plugin entry: register only when a public key and an owner are configured."""
    global LAST_SKIP_REASON
    LAST_SKIP_REASON = ""

    raw_keys = os.environ.get("ALLR_DASHBOARD_POMERIUM_PUBLIC_KEY", "").strip()
    if not raw_keys:
        LAST_SKIP_REASON = (
            "Pomerium dashboard auth is not configured "
            "(ALLR_DASHBOARD_POMERIUM_PUBLIC_KEY is unset)."
        )
        logger.debug("dashboard-auth-pomerium: %s", LAST_SKIP_REASON)
        return

    audience = os.environ.get("ALLR_DASHBOARD_POMERIUM_AUDIENCE", "").strip() or _host_of(
        os.environ.get("ALLR_DASHBOARD_PUBLIC_URL", "")
    )
    try:
        provider = PomeriumAssertionProvider(
            public_keys=load_public_keys(raw_keys),
            audience=audience,
            allowed_emails=os.environ.get("ALLR_DASHBOARD_POMERIUM_ALLOWED_EMAILS", ""),
        )
    except (ValueError, TypeError) as exc:
        LAST_SKIP_REASON = f"PomeriumAssertionProvider construction failed: {exc}"
        logger.warning("dashboard-auth-pomerium: %s", LAST_SKIP_REASON)
        return

    ctx.register_dashboard_auth_provider(provider)
    logger.info(
        "dashboard-auth-pomerium: registered provider (audience=%s, keys=%d, allowed_emails=%d)",
        audience,
        len(provider._keys),
        len(provider._allowed_emails),
    )
