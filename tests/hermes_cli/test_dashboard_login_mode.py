"""Precedence for ``dashboard.login`` / ``ALLR_DASHBOARD_LOGIN``.

The resolution rules matter more than they look. This setting decides
whether a deployment has a login page at all, so every failure mode has to
land on the side of rendering one: a typo, a half-populated container env,
an unreadable config.yaml. Each of those is a test below.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest

from hermes_cli.dashboard_auth.login_mode import (
    ENV_VAR,
    LOGIN_EXTERNAL,
    LOGIN_INTERNAL,
    login_is_external,
    resolve_login_mode,
)


@pytest.fixture(autouse=True)
def _no_env(monkeypatch):
    """Start every test from "operator has set nothing"."""
    monkeypatch.delenv(ENV_VAR, raising=False)


def _with_config(value):
    """Patch the config.yaml ``dashboard`` section this module reads."""
    section = {} if value is None else {"login": value}
    return patch(
        "hermes_cli.dashboard_auth.login_mode._load_dashboard_section",
        return_value=section,
    )


class TestDefault:
    def test_nothing_configured_renders_our_page(self):
        with _with_config(None):
            assert resolve_login_mode() == LOGIN_INTERNAL
            assert login_is_external() is False


class TestEnvVar:
    def test_external(self, monkeypatch):
        monkeypatch.setenv(ENV_VAR, "external")
        with _with_config(None):
            assert resolve_login_mode() == LOGIN_EXTERNAL
            assert login_is_external() is True

    def test_is_case_insensitive(self, monkeypatch):
        monkeypatch.setenv(ENV_VAR, "ExTeRnAl")
        with _with_config(None):
            assert resolve_login_mode() == LOGIN_EXTERNAL

    def test_surrounding_whitespace_is_ignored(self, monkeypatch):
        monkeypatch.setenv(ENV_VAR, "  external\n")
        with _with_config(None):
            assert resolve_login_mode() == LOGIN_EXTERNAL

    def test_beats_config(self, monkeypatch):
        monkeypatch.setenv(ENV_VAR, "internal")
        with _with_config("external"):
            assert resolve_login_mode() == LOGIN_INTERNAL

    def test_empty_does_not_shadow_config(self, monkeypatch):
        # A provisioned-but-unpopulated container env must not silently
        # override a deliberate config.yaml entry.
        monkeypatch.setenv(ENV_VAR, "   ")
        with _with_config("external"):
            assert resolve_login_mode() == LOGIN_EXTERNAL

    def test_unrecognised_falls_through_to_config(self, monkeypatch):
        # A typo in one surface must not prevent the other from working.
        monkeypatch.setenv(ENV_VAR, "extenral")
        with _with_config("external"):
            assert resolve_login_mode() == LOGIN_EXTERNAL


class TestConfigFile:
    def test_external(self):
        with _with_config("external"):
            assert resolve_login_mode() == LOGIN_EXTERNAL

    def test_unrecognised_falls_back_to_rendering(self):
        # The important direction: a bad value costs the operator the
        # hand-off, never the login page.
        with _with_config("stern"):
            assert resolve_login_mode() == LOGIN_INTERNAL

    def test_non_string_value_does_not_raise(self):
        with _with_config({"nested": "yaml mistake"}):
            assert resolve_login_mode() == LOGIN_INTERNAL

    def test_unreadable_config_falls_back(self):
        # _load_dashboard_section already degrades to {} on a malformed or
        # absent config.yaml; assert we inherit that rather than raising
        # into the request path.
        with _with_config(None):
            assert resolve_login_mode() == LOGIN_INTERNAL
