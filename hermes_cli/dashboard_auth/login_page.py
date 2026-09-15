"""Server-rendered sign-in pages: ``/login`` and the auth error pages.

No React and no JavaScript dependency (the password form aside). Listed
providers come from the registry; clicking a provider sends a GET to
``/auth/login?provider=<name>``.

Visual styling follows the Allr brand (allr.github.io: paper surface, Young
Serif headings, Nunito Sans, ghost and green buttons in a 420px card). On
Allr.OS, Caddy serves the shared brand kit on the dashboard's own host and
``ALLR_DASHBOARD_BRAND_CSS`` points at it (``/_allr/allr.css``): the page then
links that stylesheet, its favicon and the Allr mark, so every sign-in page
Allr shows comes from one source. Without it (upstream or standalone use) a
compact inline copy of the same look is used, with system fonts.

Test-stable markup: ``class="provider-btn"``, ``<form class="provider-form"
data-provider=...`` and ``class="retry-btn"`` are asserted by
``tests/hermes_cli/test_dashboard_auth_*``. The brand kit styles those class
names as aliases of its own, so they MUST NOT change without updating both.
"""
from __future__ import annotations

import html
import os

from hermes_cli.dashboard_auth import list_session_providers

# The inline fallback: the same card, buttons and fields as the brand kit, with
# its tokens (brand-src src/app/globals.css) but system fonts and no mesh.
_FALLBACK_CSS = """\
  :root {
    --color-paper: #fdfcf9; --color-card: #ffffff; --color-ink: #223b33; --color-ink-soft: #5c7168;
    --color-line: #e7e0d2; --color-honey: #e9a83e; --color-honey-line: #f0dcb4;
    --color-green: #2e9e63; --color-green-deep: #1e7a49; --color-alert: #a6543c;
  }
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100svh; background: var(--color-paper); color: var(--color-ink);
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif; line-height: 1.7;
  }
  h1 { margin: 0; font-family: Georgia, serif; font-weight: 400; line-height: 1.18; }
  p { margin: 0; }
  :focus-visible { outline: 3px solid var(--color-honey); outline-offset: 3px; border-radius: 12px; }
  [hidden] { display: none !important; }
  /* Safe area, all four sides, on the one centred block.

     On Android the app's MainActivity calls `enableEdgeToEdge()`, and
     mobile sign-in navigates the CALLING webview here (see
     `src-tauri/src/oauth.rs`) rather than opening a system browser — so
     this page draws under the status bar and the gesture strip unless it
     pads itself. `viewport-fit=cover` is what makes `env(safe-area-inset-*)`
     report non-zero at all. Raw `env()` on purpose: the SPA's
     `var(--safe-area-inset-*)` do not exist outside its bundle. Longhands
     only; a `padding` shorthand here would override them. The brand kit's
     `.allr-main` (Allr.OS brand/src/components.css) follows the same rule. */
  .allr-main {
    display: grid; place-items: center; min-height: 100dvh;
    padding-top: max(64px, env(safe-area-inset-top));
    padding-right: max(24px, env(safe-area-inset-right));
    padding-bottom: max(64px, env(safe-area-inset-bottom));
    padding-left: max(24px, env(safe-area-inset-left));
  }
  .allr-card {
    width: 100%; max-width: 420px; padding: 32px; background: var(--color-card);
    border: 1px solid var(--color-line); border-radius: 20px;
    box-shadow: 0 8px 24px rgba(34, 59, 51, 0.07);
  }
  .allr-wordmark {
    display: inline-flex; align-items: center; gap: 8px; margin-bottom: 28px;
    font-family: Georgia, serif; font-size: 1.5rem; color: var(--color-ink); text-decoration: none;
  }
  .allr-wordmark img { width: 34px; height: 34px; }
  .allr-title { margin-bottom: 28px; font-size: 1.7rem; }
  .allr-title--tight { margin-bottom: 12px; }
  .allr-text { margin-bottom: 12px; font-size: 0.98rem; color: var(--color-ink-soft); }
  .allr-detail { margin-top: 12px; font-size: 0.86rem; color: var(--color-ink-soft); }
  .allr-stack, .allr-actions { display: flex; flex-direction: column; gap: 12px; }
  .allr-actions { margin-top: 24px; }
  .provider-btn, .retry-btn {
    display: flex; width: 100%; align-items: center; justify-content: center; gap: 12px;
    padding: 12px 20px; border: 1px solid var(--color-line); border-radius: 10px;
    background: var(--color-card); color: var(--color-ink); font: inherit; font-size: 1rem;
    font-weight: 700; text-decoration: none; cursor: pointer;
  }
  .provider-btn:hover { border-color: #d8cfbb; background: var(--color-paper); }
  .retry-btn, .provider-form .provider-btn { border-color: transparent; background: var(--color-green); color: #fff; }
  .retry-btn:hover, .provider-form .provider-btn:hover { background: var(--color-green-deep); }
  .provider-form { display: flex; flex-direction: column; gap: 16px; }
  .allr-fieldset { display: flex; flex-direction: column; gap: 6px; }
  .allr-label { font-size: 0.92rem; font-weight: 700; }
  .allr-field {
    width: 100%; padding: 0.72em 1em; border: 1.5px solid var(--color-line); border-radius: 10px;
    background: var(--color-card); color: var(--color-ink); font: inherit; font-weight: 600;
  }
  .allr-field:focus { outline: 3px solid var(--color-honey); outline-offset: 2px; border-color: var(--color-honey-line); }
  .form-error { font-size: 0.9rem; font-weight: 600; color: var(--color-alert); }
  .allr-legal {
    margin-top: 28px; padding-top: 20px; border-top: 1px solid var(--color-line);
    font-size: 0.86rem; line-height: 1.6; color: var(--color-ink-soft);
  }
  .allr-legal a { font-weight: 700; color: var(--color-ink); }
"""

_PAGE_TEMPLATE = """\
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>{title}</title>
{assets}
</head>
<body class="allr-welcome">
<main class="allr-main">
  <div class="allr-card">
    <a class="allr-wordmark" href="/">{mark}allr</a>
{card}
  </div>
</main>
{script}
</body>
</html>
"""


def _brand_assets() -> tuple[str, str]:
    """``(<head> assets, mark markup)``: the shared brand kit if configured, else the fallback.

    Read per render rather than at import, so the dashboard picks up the
    setting from its environment the way every other ``ALLR_DASHBOARD_*``
    option does.
    """
    css_url = os.environ.get("ALLR_DASHBOARD_BRAND_CSS", "").strip()
    if not css_url:
        return f"<style>\n{_FALLBACK_CSS}</style>", ""
    base = html.escape(css_url.rsplit("/", 1)[0], quote=True)
    assets = (
        f'<link rel="stylesheet" href="{html.escape(css_url, quote=True)}">\n'
        f'<link rel="icon" href="{base}/favicon.ico">'
    )
    return assets, f'<img src="{base}/mark.svg" alt="" width="34" height="34">'


def _render_page(*, title: str, card: str, script: str = "") -> str:
    """Assemble the Allr sign-in shell (wordmark + card) around a card body."""
    assets, mark = _brand_assets()
    return _PAGE_TEMPLATE.format(
        title=title, assets=assets, mark=mark, card=card, script=script,
    )


_LEGAL_HTML = (
    '<p class="allr-legal">By continuing you agree to our '
    '<a href="https://allr.work/terms/">Terms</a> and confirm you have read our '
    '<a href="https://allr.work/privacy/">Privacy Policy</a>.</p>'
)

_EMPTY_CARD = (
    '    <h1 class="allr-title allr-title--tight">Sign-in isn’t switched on</h1>\n'
    '    <p class="allr-text">This dashboard is reachable from other machines, '
    "but no sign-in provider is installed.</p>\n"
    '    <p class="allr-detail">Install an auth provider, or restart with '
    "--insecure to bypass the auth gate (not recommended on untrusted "
    "networks).</p>"
)

# Kept as a rendered document for callers and tests that import it; it uses
# whatever brand setting the process had at import time.
_EMPTY_HTML = _render_page(title="Sign-in isn’t switched on · Allr", card=_EMPTY_CARD)


def render_auth_error_html(
    *,
    title: str,
    message: str,
    retry_href: str = "/login",
    hint: str = "",
    action_label: str = "Try again",
) -> str:
    """Branded full-page error for browser-facing auth failures.

    Rendered by the OAuth callback / login routes instead of FastAPI's
    default ``{"detail": ...}`` JSON, which browsers display raw. All
    inputs are HTML-escaped; ``retry_href`` is additionally attribute-
    escaped (callers pass fixed local paths, never IDP-supplied values).
    ``action_label`` names what the button actually does when that is not a
    retry (e.g. signing out to pick another account).
    """
    hint_html = (
        f'    <p class="allr-detail">{html.escape(hint)}</p>\n' if hint else ""
    )
    card = (
        f'    <h1 class="allr-title allr-title--tight">{html.escape(title)}</h1>\n'
        f'    <p class="allr-text">{html.escape(message)}</p>\n'
        f"{hint_html}"
        f'    <div class="allr-actions"><a class="retry-btn" '
        f'href="{html.escape(retry_href, quote=True)}">{html.escape(action_label)}</a></div>'
    )
    return _render_page(title=f"{title} · Allr", card=card)


# Inline script that wires every password provider form to POST JSON to
# ``/auth/password-login`` and navigate on success. Emitted ONLY when at
# least one ``supports_password`` provider is listed (OAuth-only login
# pages stay script-free, preserving the no-JS contract for that case).
#
# Plain string (NOT run through ``str.format``), so braces are literal —
# do not double them. A single delegated submit handler covers all forms;
# the provider name is read from the form's ``data-provider`` attribute.
_PASSWORD_FORM_SCRIPT = """\
<script>
(function () {
  function handle(form) {
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var err = form.querySelector('.form-error');
      var btn = form.querySelector('button[type=submit]');
      if (err) { err.hidden = true; err.textContent = ''; }
      if (btn) { btn.disabled = true; }
      var body = {
        provider: form.getAttribute('data-provider') || '',
        username: (form.querySelector('input[name=username]') || {}).value || '',
        password: (form.querySelector('input[name=password]') || {}).value || '',
        next: (form.querySelector('input[name=next]') || {}).value || ''
      };
      fetch('/auth/password-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'same-origin'
      }).then(function (resp) {
        if (resp.ok) {
          return resp.json().then(function (data) {
            window.location.assign((data && data.next) || '/');
          });
        }
        var msg = resp.status === 429
          ? 'That’s a lot of attempts. Wait a moment, then try again?'
          : (resp.status === 401 ? 'That username and password don’t match. Try again?'
                                 : 'That didn’t go through. Try again in a moment?');
        if (err) { err.textContent = msg; err.hidden = false; }
        if (btn) { btn.disabled = false; }
      }).catch(function () {
        if (err) { err.textContent = 'We couldn’t reach the dashboard. Try again in a moment?'; err.hidden = false; }
        if (btn) { btn.disabled = false; }
      });
    });
  }
  var forms = document.querySelectorAll('form.provider-form');
  for (var i = 0; i < forms.length; i++) { handle(forms[i]); }
})();
</script>
"""


def render_login_html(*, next_path: str = "") -> str:
    """Return the full HTML for ``GET /login``.

    ``next_path`` — when set, the post-login landing path the user
    originally requested. Threaded into each provider button's ``href``
    as a ``next=`` query parameter so the OAuth round trip carries it
    end-to-end. The caller (``routes.login_page``) is responsible for
    validating ``next_path`` against the same-origin rules before we
    emit it; we still HTML-escape it as defence in depth.
    """
    providers = list_session_providers()
    if not providers:
        return _render_page(title="Sign-in isn’t switched on · Allr", card=_EMPTY_CARD)

    if next_path:
        # URL-encode then HTML-escape. The URL-encode step matches the
        # gate's ``_safe_next_target`` output shape (also URL-encoded),
        # so a value that round-tripped from /login?next=... back into
        # the button href is byte-identical.
        from urllib.parse import quote
        next_qs = f"&next={html.escape(quote(next_path, safe=''), quote=True)}"
    else:
        next_qs = ""

    buttons = []
    needs_password_script = False
    for p in providers:
        if getattr(p, "supports_password", False):
            needs_password_script = True
            buttons.append(_render_password_form(p, next_path))
        else:
            buttons.append(
                f'      <a class="provider-btn" '
                f'href="/auth/login?provider={html.escape(p.name, quote=True)}{next_qs}">'
                f'Continue with {html.escape(p.display_name)}</a>'
            )
    script = _PASSWORD_FORM_SCRIPT if needs_password_script else ""
    card = (
        '    <h1 class="allr-title">Sign in</h1>\n'
        '    <div class="allr-stack">\n'
        + "\n".join(buttons)
        + "\n    </div>\n"
        + f"    {_LEGAL_HTML}"
    )
    return _render_page(title="Sign in · Allr", card=card, script=script)


def _render_password_form(provider, next_path: str) -> str:
    """Render a username/password form for a ``supports_password`` provider.

    The form is wired by :data:`_PASSWORD_FORM_SCRIPT` (a single delegated
    submit handler) to POST JSON to ``/auth/password-login`` and navigate
    on success. ``next_path`` is carried in a hidden field; it has already
    been validated same-origin by the caller and is HTML-escaped here as
    defence in depth. The provider ``name`` is emitted in a ``data-``
    attribute (not a hidden input) so the script reads it without trusting
    form-field ordering.
    """
    pname = html.escape(provider.name, quote=True)
    plabel = html.escape(provider.display_name)
    safe_next = html.escape(next_path, quote=True) if next_path else ""
    return (
        f'      <form class="provider-form" data-provider="{pname}" '
        f'autocomplete="on">\n'
        f'        <p class="allr-text">Sign in with {plabel}</p>\n'
        f'        <input type="hidden" name="next" value="{safe_next}">\n'
        f'        <div class="allr-fieldset">\n'
        f'          <label class="allr-label" for="{pname}-username">Username</label>\n'
        f'          <input class="allr-field" id="{pname}-username" type="text" name="username" '
        f'autocomplete="username" autocapitalize="none" '
        f'autocorrect="off" spellcheck="false" required>\n'
        f'        </div>\n'
        f'        <div class="allr-fieldset">\n'
        f'          <label class="allr-label" for="{pname}-password">Password</label>\n'
        f'          <input class="allr-field" id="{pname}-password" type="password" name="password" '
        f'autocomplete="current-password" required>\n'
        f'        </div>\n'
        f'        <p class="form-error" role="alert" hidden></p>\n'
        f'        <button class="provider-btn" type="submit">Sign in</button>\n'
        f'      </form>'
    )
