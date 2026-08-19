"""The legacy-env bridge and legacy-home adoption in hermes_constants.

Both live at module-import time, so every case runs in a fresh subprocess with
an explicit HOME (the adoption branch probes the real home directory).
"""

import os
import subprocess
import sys

import pytest

CODE = "import hermes_constants as c; print(c.get_hermes_home())"

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _home(tmp_path, **env):
    """Run CODE with a scratch HOME and return the resolved home path."""
    proc = subprocess.run(
        [sys.executable, "-c", CODE],
        cwd=REPO_ROOT,
        env={
            "PATH": os.environ.get("PATH", ""),
            "HOME": str(tmp_path),
            "PYTHONPATH": REPO_ROOT,
            **env,
        },
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert proc.returncode == 0, proc.stderr
    return proc.stdout.strip()


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX home layout")
class TestAllrEnvBridge:
    def test_default_is_new_home(self, tmp_path):
        assert _home(tmp_path) == str(tmp_path / ".allr")

    def test_allr_home_wins_over_default(self, tmp_path):
        assert _home(tmp_path, ALLR_HOME="/tmp/x") == "/tmp/x"

    def test_legacy_hermes_home_is_bridged(self, tmp_path):
        assert _home(tmp_path, HERMES_HOME="/tmp/y") == "/tmp/y"  # rebrand:keep

    def test_allr_home_wins_over_hermes_home(self, tmp_path):
        assert _home(tmp_path, ALLR_HOME="/tmp/x", HERMES_HOME="/tmp/y") == "/tmp/x"  # rebrand:keep

    def test_legacy_home_dir_is_adopted(self, tmp_path):
        (tmp_path / ".hermes").mkdir()  # rebrand:keep
        assert _home(tmp_path) == str(tmp_path / ".hermes")  # rebrand:keep

    def test_new_home_dir_wins_over_legacy_dir(self, tmp_path):
        (tmp_path / ".hermes").mkdir()  # rebrand:keep
        (tmp_path / ".allr").mkdir()
        assert _home(tmp_path) == str(tmp_path / ".allr")
