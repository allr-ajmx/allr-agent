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

from hermes_cli.dashboard_auth.login_page import _EMPTY_HTML, render_login_html

# Both documents are fully rendered pages rather than raw templates. The
# page was once a single ``str.format`` template whose CSS braces had to be
# un-doubled here; it is now assembled from ``_SHELL_CSS`` plus a card, so
# rendering is both simpler and closer to what a phone actually receives.
DOCUMENTS = {
    "login_page": render_login_html(),
    "_EMPTY_HTML": _EMPTY_HTML,
}

# Which rule owns which edge. The page is a flex column — a header strip, then
# a centred ``main`` — so the insets are split rather than sitting on one
# centred ``body`` block as they did when this page was a single card:
#   * the header is the topmost painted thing, so it clears the status bar;
#   * ``main`` is the bottommost, so it clears the gesture strip;
#   * both span the full width, so both clear a landscape notch.
# Keyed by selector so a re-ordered stylesheet cannot point this at the wrong
# block, which is what the old ``place-items`` lookup was protecting against.
EDGE_OWNERS = {
    ".site-header": ("top", "left", "right"),
    "main": ("bottom", "left", "right"),
}


def rule_block(document: str, selector: str) -> str:
    """The declaration block for ``selector``, comments stripped."""
    stripped = re.sub(r"/\*.*?\*/", "", document, flags=re.DOTALL)
    pattern = rf"(?:^|[}};])\s*{re.escape(selector)}\s*\{{([^}}]*)\}}"
    for match in re.finditer(pattern, stripped, re.MULTILINE):
        block = match.group(1)
        if "padding" in block:
            return block
    pytest.fail(f"no `{selector}` rule with padding found")


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
        # Top clears the status bar, bottom the gesture strip / home indicator,
        # and left/right the notch on a phone held in landscape either way.
        # Every edge must be claimed by some rule, or that edge draws under a
        # system bar.
        document = DOCUMENTS[name]
        for selector, sides in EDGE_OWNERS.items():
            rule = rule_block(document, selector)
            for side in sides:
                # `top` has no design padding to preserve, so a bare env() is
                # correct there; the others must not shrink below their floor.
                expected = (
                    rf"padding-{side}:\s*env\(safe-area-inset-{side}\)"
                    if side == "top"
                    else rf"padding-{side}:\s*max\([^;]*env\(safe-area-inset-{side}\)"
                )
                assert re.search(expected, rule), (
                    f"{name}: {selector} padding-{side} does not account for "
                    f"safe-area-inset-{side}"
                )

    def test_leaves_no_shorthand_padding_to_override_them(self, name: str) -> None:
        # A `padding: 48px 20px` in the same block — which is what this page
        # shipped before — silently wins and reinstates the bug.
        document = DOCUMENTS[name]
        for selector in EDGE_OWNERS:
            rule = rule_block(document, selector)
            assert not re.search(r"(^|[;\s])padding:", rule), (
                f"{name}: a `padding` shorthand in {selector} would override "
                f"the safe-area longhands"
            )
