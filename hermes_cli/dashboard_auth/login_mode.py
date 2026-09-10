"""Where the dashboard's login page comes from: us, or the IdP.

Two deployment shapes want opposite things from ``/login``:

* A plain self-hosted install wants Allr's own page — the provider
  chooser, the password form, the "no providers configured" notice. It
  is the only login UI that exists.
* A provisioned stack (Allr.OS) puts a branded IdP in front of every
  dashboard — Dex, carrying the Allr design — and registers exactly one
  provider pointing at it. Rendering our chooser there means an extra
  click through an interstitial that offers precisely one option.

This used to be derived rather than declared: ``/login`` redirected
whenever exactly one non-password provider happened to be registered.
That silently took the page away from every single-OIDC self-hoster,
with no way to ask for it back. ``dashboard.login`` makes it a choice.

``external`` deliberately keeps the "one non-password provider" guard
rather than forcing the redirect. Allr.OS's break-glass for a locked-out
user is to add ``ALLR_DASHBOARD_BASIC_AUTH_*`` back to their container,
which registers a second, password-backed provider — and rendering the
chooser is exactly what makes that recovery reachable. So ``external``
means "prefer the IdP when the choice is unambiguous", never "refuse to
render".

The setting governs both places that skip the page: the ``/login`` route
itself (:mod:`hermes_cli.dashboard_auth.routes`) and the unauthenticated
document-load auto-SSO in :mod:`hermes_cli.dashboard_auth.middleware`.
Gating only the first would leave the dashboard root still bouncing to
the IdP, so ``internal`` would not actually produce a login page on the
path users arrive by.
"""
from __future__ import annotations

import logging
import os

# Reuse the guarded config read rather than repeating its try/except
# ladder — one place decides what a missing/malformed config.yaml means.
from hermes_cli.dashboard_auth.prefix import _load_dashboard_section

_log = logging.getLogger(__name__)

LOGIN_INTERNAL = "internal"
LOGIN_EXTERNAL = "external"

_VALID = frozenset({LOGIN_INTERNAL, LOGIN_EXTERNAL})

#: Render our own page unless told otherwise. A deployment that has put
#: an IdP in front of the dashboard knows it; a deployment that has not
#: must never end up with no login UI at all.
_DEFAULT = LOGIN_INTERNAL

ENV_VAR = "ALLR_DASHBOARD_LOGIN"


def _clean(raw: object) -> str:
    """Normalise a candidate value; ``""`` when it isn't one of ours."""
    value = str(raw or "").strip().lower()
    return value if value in _VALID else ""


def resolve_login_mode() -> str:
    """Resolve ``dashboard.login`` — ``"internal"`` or ``"external"``.

    Precedence mirrors :func:`~hermes_cli.dashboard_auth.prefix.resolve_public_url`:

      1. ``ALLR_DASHBOARD_LOGIN`` env var, when non-empty after strip.
         Empty is treated as unset so a provisioned-but-not-populated
         container env can't shadow a valid config.yaml entry.
      2. ``dashboard.login`` in ``config.yaml``.
      3. ``"internal"``.

    Matching is case-insensitive. An unrecognised value warns, naming the
    surface it came from, and falls through to the next candidate — a
    typo in the env var still lets config.yaml decide, and a typo in
    config.yaml still yields a working login page rather than a dead
    dashboard.
    """
    env_raw = os.environ.get(ENV_VAR, "")
    env_clean = _clean(env_raw)
    if env_clean:
        return env_clean
    if str(env_raw or "").strip():
        _log.warning(
            "dashboard-auth: %s=%r is not %r or %r; ignoring it",
            ENV_VAR, env_raw, LOGIN_INTERNAL, LOGIN_EXTERNAL,
        )

    cfg_raw = _load_dashboard_section().get("login", "")
    cfg_clean = _clean(cfg_raw)
    if cfg_clean:
        return cfg_clean
    if str(cfg_raw or "").strip():
        _log.warning(
            "dashboard-auth: dashboard.login=%r in config.yaml is not %r or "
            "%r; falling back to %r",
            cfg_raw, LOGIN_INTERNAL, LOGIN_EXTERNAL, _DEFAULT,
        )
    return _DEFAULT


def login_is_external() -> bool:
    """True when login is handed off to the IdP rather than rendered here."""
    return resolve_login_mode() == LOGIN_EXTERNAL
