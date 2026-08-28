"""The /login page's safe-area contract.

Modelled on ``apps/hermes-universal/src/styles.connect-safe-area.test.ts``,
which forbids exactly these two mistakes on the in-app connect screen. The
same rule has to hold here for a reason that is easy to miss: on Android the
app's ``MainActivity`` calls ``enableEdgeToEdge()``, and mobile sign-in does
NOT open a system browser — ``src-tauri/src/oauth.rs`` navigates the CALLING
webview to this page (both the cookie-cascade ``/auth/login`` path and the
RFC 8252 native ``/auth/native/authorize`` path, which 302s here without a
session). So this server-rendered document IS the app's whole UI for the
duration of the login, drawn edge to edge, and nothing above it applies the
insets.

Textual on purpose, for the same reason as the TypeScript original: the CSS
lives in a string with no renderer in the test suite, no headless browser
resolves ``env()``, and a regression would be invisible everywhere except on
a physical phone.

Note the deliberate asymmetry with the SPA: this page uses raw
``env(safe-area-inset-*)`` rather than the ``var(--safe-area-inset-*)``
that ``lib/safe-area.ts`` publishes, because it renders outside the React
bundle where those custom properties do not exist. The comment beside the
rule says so; this test asserts the ``env()`` form on purpose.
"""

from __future__ import annotations

import re

import pytest

from hermes_cli.dashboard_auth.login_page import _EMPTY_HTML, _LOGIN_HTML_TEMPLATE

# Both documents are CSS-in-a-Python-string. ``_LOGIN_HTML_TEMPLATE`` is a
# ``str.format`` template, so its CSS braces are doubled; ``_EMPTY_HTML`` is
# emitted verbatim. Un-double the former so one parser handles both.
DOCUMENTS = {
    "_LOGIN_HTML_TEMPLATE": _LOGIN_HTML_TEMPLATE.replace("{{", "{").replace("}}", "}"),
    "_EMPTY_HTML": _EMPTY_HTML,
}


def body_layout_rule(document: str) -> str:
    """The declaration block of the ``body`` rule that lays the page out.

    Both documents declare ``body`` more than once (a shared ``html, body``
    reset, a backdrop rule). The one under test is the one that centres the
    card — identified by ``place-items``, not by ordinal, so re-ordering the
    stylesheet cannot silently point this test at the wrong block.
    """
    stripped = re.sub(r"/\*.*?\*/", "", document, flags=re.DOTALL)
    for match in re.finditer(r"(?:^|[};])\s*body\s*\{([^}]*)\}", stripped, re.MULTILINE):
        if "place-items" in match.group(1):
            return match.group(1)
    pytest.fail("no `body` rule with `place-items` found")


@pytest.mark.parametrize("name", sorted(DOCUMENTS))
class TestLoginPageSafeArea:
    def test_opts_into_the_display_cutout(self, name: str) -> None:
        # Without `viewport-fit=cover` the webview letterboxes the page inside
        # the safe area's *inner* rectangle and every env() below reports 0 —
        # the padding would be correct and do nothing.
        assert re.search(
            r'<meta name="viewport" content="[^"]*viewport-fit=cover',
            DOCUMENTS[name],
        ), f"{name} does not request viewport-fit=cover"

    def test_pads_every_side_by_at_least_the_device_inset(self, name: str) -> None:
        rule = body_layout_rule(DOCUMENTS[name])
        # Top clears the status bar, bottom the gesture strip / home indicator,
        # and left/right the notch on a phone held in landscape either way.
        for side in ("top", "bottom", "left", "right"):
            assert re.search(
                rf"padding-{side}:\s*max\([^;]*env\(safe-area-inset-{side}\)",
                rule,
            ), f"{name}: padding-{side} does not account for safe-area-inset-{side}"

    def test_leaves_no_shorthand_padding_to_override_them(self, name: str) -> None:
        # A `padding: clamp(...) 1.25rem` in the same block — which is what this
        # page shipped before — silently wins and reinstates the bug.
        rule = body_layout_rule(DOCUMENTS[name])
        assert not re.search(r"(^|[;\s])padding:", rule), (
            f"{name}: a `padding` shorthand would override the safe-area longhands"
        )
