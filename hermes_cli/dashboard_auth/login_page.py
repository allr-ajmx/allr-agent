"""Server-rendered /login page.

No React, no JavaScript dependency. Listed providers come from the
registry; clicking a provider sends a GET to
``/auth/login?provider=<name>``.

Visual styling follows the Allr design language (cream surface, Young
Serif wordmark, forest-green pill buttons): the same
``Collapse`` / ``Rules Compressed`` typeface, amber-on-dark colour
tokens (``#170d02`` / ``#ffac02`` / ``#fff``), uppercase + wide-tracking
brand chrome, and the inset-bevel button shadow. Fonts are served
out of the SPA's ``/fonts/`` directory which the dashboard-auth gate
already allowlists pre-auth (see ``_GATE_PUBLIC_PREFIXES`` in
``middleware.py``), so the page renders without needing the React
bundle loaded.

Test-stable class names: the existing test suite extracts the
``class="provider-btn"`` anchor href to walk the OAuth flow. That
class name MUST NOT change without updating
``tests/hermes_cli/test_dashboard_auth_401_reauth.py``.
"""
from __future__ import annotations

import html

from hermes_cli.dashboard_auth import list_session_providers

# Inline minimal CSS. The dashboard's full skin lives in the React
# bundle, which we deliberately do NOT load here — the login page must
# not depend on the SPA build being present or on the injected session
# token.
#
# Single curly braces are placeholders for ``str.format``; CSS curlies
# are doubled (``{{`` / ``}}``).
_SHELL_CSS = """\
  :root {
    --surface: #fff9ee;
    --card: #FBF8F2;
    --line: rgba(194, 200, 196, 0.35);
    --line-soft: rgba(194, 200, 196, 0.5);
    --ink: #1d1c15;
    --ink-soft: #424845;
    --forest: #223B33;
    --forest-deep: #0c251e;
    --sage: #2E9E63;
    --amber: #E9A83E;
    --cream: #F7F1E6;
    --error: #ba1a1a;
    --error-bg: #ffdad6;
  }
  *, *::before, *::after { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0; min-height: 100%;
    background: var(--surface);
    color: var(--ink);
    font-family: 'Nunito Sans', system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 16px; line-height: 1.6;
    -webkit-font-smoothing: antialiased;
  }
  body { display: flex; flex-direction: column; min-height: 100vh; }
  .site-header {
    display: flex; align-items: center;
    height: 64px; padding: 0 20px;
  }
  .wordmark {
    font-family: 'Young Serif', Georgia, serif;
    font-size: 32px; line-height: 1.3;
    color: var(--forest); text-decoration: none;
  }
  .wordmark:hover { opacity: 0.8; }
  main {
    flex: 1 0 auto;
    display: flex; align-items: center; justify-content: center;
    padding: 48px 20px; position: relative; overflow: hidden;
  }
  .blobs { position: absolute; inset: 0; pointer-events: none; opacity: 0.2; display: none; }
  @media (min-width: 768px) { .blobs { display: block; } }
  .blob { position: absolute; width: 24rem; height: 24rem; border-radius: 9999px; filter: blur(64px); opacity: 0.5; }
  .blob-sage { top: 25%; left: -10%; background: var(--sage); }
  .blob-amber { bottom: 25%; right: -10%; background: var(--amber); }
  .card {
    width: 100%; max-width: 28rem; position: relative; z-index: 1;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 1rem;
    padding: 40px;
  }
  @media (max-width: 480px) { .card { background: transparent; border: 0; padding: 24px 0; } }
  h1 {
    margin: 0 0 16px; text-align: center;
    font-family: 'Young Serif', Georgia, serif;
    font-weight: 400; font-size: 32px; line-height: 1.2;
    color: var(--forest);
  }
  @media (min-width: 768px) { h1 { font-size: 42px; } }
  .subtitle {
    margin: 0 0 40px; text-align: center;
    font-size: 20px; color: var(--ink-soft);
  }
  .provider-list { display: grid; gap: 16px; }
  .provider-btn {
    display: flex; align-items: center; justify-content: center; gap: 12px;
    width: 100%; padding: 16px 24px;
    background: var(--forest); color: var(--cream);
    border: 0; border-radius: 9999px;
    font-family: inherit; font-size: 16px; font-weight: 700;
    text-decoration: none; cursor: pointer;
    box-shadow: 0 1px 2px rgba(29, 28, 21, 0.08);
    transition: background 0.2s ease, transform 0.1s ease;
  }
  .provider-btn:hover { background: var(--forest-deep); }
  .provider-btn:active { transform: scale(0.97); }
  .provider-btn:focus-visible { outline: 2px solid var(--sage); outline-offset: 2px; }
  .divider { display: flex; align-items: center; padding: 16px 0; }
  .divider::before, .divider::after { content: ""; flex: 1; border-top: 1px solid var(--line-soft); }
  .divider span {
    flex-shrink: 0; margin: 0 16px;
    font-size: 12px; font-weight: 700; letter-spacing: 0.1em;
    color: var(--ink-soft);
  }
  .legal {
    margin: 32px 0 0; text-align: center;
    font-size: 14px; color: rgba(66, 72, 69, 0.7);
  }
  .legal a { color: inherit; text-decoration: underline; }
  .legal a:hover { color: var(--forest); }
  .site-footer {
    flex-shrink: 0;
    display: flex; flex-direction: column; align-items: center; gap: 16px;
    padding: 32px 20px; margin-top: auto;
    background: var(--surface); border-top: 1px solid var(--line);
  }
  .footer-links { display: flex; gap: 24px; }
  .footer-links a { color: var(--ink-soft); text-decoration: none; }
  .footer-links a:hover { color: var(--forest-deep); }
  .copyright { margin: 0; font-size: 14px; color: rgba(66, 72, 69, 0.6); }
  /* password provider form (multi-provider chooser only) */
  .provider-form { display: grid; gap: 12px; }
  .form-title { text-align: center; font-weight: 700; color: var(--ink-soft); }
  .field { display: block; }
  .field-label {
    display: block; margin-bottom: 4px;
    font-size: 12px; font-weight: 700; letter-spacing: 0.1em;
    text-transform: uppercase; color: var(--ink-soft);
  }
  .field-input {
    width: 100%; padding: 12px 16px;
    background: #ffffff; color: var(--ink);
    border: 1px solid var(--line-soft); border-radius: 0.75rem;
    font-family: inherit; font-size: 16px;
  }
  .field-input:focus { border-color: var(--sage); outline: none; }
  .form-error {
    padding: 10px 14px; border-radius: 0.5rem;
    background: var(--error-bg); color: var(--error);
    font-size: 14px;
  }
  .retry-btn {
    display: flex; align-items: center; justify-content: center;
    width: 100%; padding: 16px 24px;
    background: var(--forest); color: var(--cream);
    border: 0; border-radius: 9999px;
    font-size: 16px; font-weight: 700;
    text-decoration: none; cursor: pointer;
    transition: background 0.2s ease, transform 0.1s ease;
  }
  .retry-btn:hover { background: var(--forest-deep); }
  .retry-btn:active { transform: scale(0.97); }
  .hint {
    margin: 16px 0 0; text-align: center;
    font-size: 14px; color: rgba(66, 72, 69, 0.7);
  }
"""

_FONTS_HTML = """\
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Nunito+Sans:wght@400;700&family=Young+Serif&display=swap" rel="stylesheet">"""

_PAGE_TEMPLATE = """\
<!doctype html>
<html class="light" lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
{fonts}
<style>
{css}
</style>
</head>
<body>
<header class="site-header">
  <a class="wordmark" href="/">Allr</a>
</header>
<main>
  <div class="blobs">
    <div class="blob blob-sage"></div>
    <div class="blob blob-amber"></div>
  </div>
  <div class="card">
{card}
  </div>
</main>
<footer class="site-footer">
  <a class="wordmark" href="https://allr.work">Allr</a>
  <div class="footer-links">
    <a href="https://allr.work">Help</a>
    <a href="https://allr.work/privacy">Privacy</a>
    <a href="https://allr.work/terms">Terms</a>
  </div>
  <p class="copyright">&copy; 2026 Allr. All rights reserved.</p>
</footer>
{script}
</body>
</html>
"""


def _render_page(*, title: str, card: str, script: str = "") -> str:
    """Assemble the shared Allr shell (header, card, footer) around a card body."""
    return _PAGE_TEMPLATE.format(
        title=title, fonts=_FONTS_HTML, css=_SHELL_CSS, card=card,
        script=script,
    )


_LEGAL_HTML = (
    '<p class="legal">By continuing, you agree to Allr\'s '
    '<a href="https://allr.work/terms">Terms of Service</a> and '
    '<a href="https://allr.work/privacy">Privacy Policy</a>.</p>'
)

_EMPTY_HTML = _render_page(
    title="Sign-in unavailable — Allr",
    card=(
        "    <h1>Sign-in unavailable</h1>\n"
        '    <p class="subtitle">This dashboard is bound to a non-loopback '
        "host but no authentication providers are installed.</p>\n"
        '    <p class="legal">Install an auth provider, or restart with '
        "--insecure to bypass the auth gate (not recommended on untrusted "
        "networks).</p>"
    ),
)



def render_auth_error_html(
    *,
    title: str,
    message: str,
    retry_href: str = "/login",
    hint: str = "",
) -> str:
    """Branded full-page error for browser-facing auth failures.

    Rendered by the OAuth callback / login routes instead of FastAPI's
    default ``{"detail": ...}`` JSON, which browsers display raw. All
    inputs are HTML-escaped; ``retry_href`` is additionally attribute-
    escaped (callers pass fixed local paths, never IDP-supplied values).
    """
    hint_html = (
        f'    <p class="hint">{html.escape(hint)}</p>\n' if hint else ""
    )
    card = (
        f"    <h1>{html.escape(title)}</h1>\n"
        f'    <p class="subtitle">{html.escape(message)}</p>\n'
        f'    <a class="retry-btn" '
        f'href="{html.escape(retry_href, quote=True)}">Try again</a>\n'
        f"{hint_html}"
    )
    return _render_page(title=f"{title} — Allr", card=card)


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
          ? 'Too many attempts. Please wait and try again.'
          : (resp.status === 401 ? 'Invalid username or password.'
                                 : 'Sign-in failed. Please try again.');
        if (err) { err.textContent = msg; err.hidden = false; }
        if (btn) { btn.disabled = false; }
      }).catch(function () {
        if (err) { err.textContent = 'Network error. Please try again.'; err.hidden = false; }
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
        return _EMPTY_HTML

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
        if buttons:
            buttons.append('      <div class="divider"><span>OR</span></div>')
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
        "    <h1>Welcome back.</h1>\n"
        '    <p class="subtitle">Log in to your workspace.</p>\n'
        '    <div class="provider-list">\n'
        + "\n".join(buttons)
        + "\n    </div>\n"
        + f"    {_LEGAL_HTML}"
    )
    return _render_page(title="Allr — Login", card=card, script=script)


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
        f'        <div class="form-title">Sign in with {plabel}</div>\n'
        f'        <input type="hidden" name="next" value="{safe_next}">\n'
        f'        <label class="field">\n'
        f'          <span class="field-label">Username</span>\n'
        f'          <input class="field-input" type="text" name="username" '
        f'autocomplete="username" autocapitalize="none" '
        f'autocorrect="off" spellcheck="false" required>\n'
        f'        </label>\n'
        f'        <label class="field">\n'
        f'          <span class="field-label">Password</span>\n'
        f'          <input class="field-input" type="password" name="password" '
        f'autocomplete="current-password" required>\n'
        f'        </label>\n'
        f'        <div class="form-error" role="alert" hidden></div>\n'
        f'        <button class="provider-btn" type="submit">Sign in</button>\n'
        f'      </form>'
    )
