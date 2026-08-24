"""System-prompt assembly for the Allr app surface (``apps/hermes-universal``).

The universal client already tags every session it creates with
``source="universal"`` (``session.create`` in ``tui_gateway/methods_session.py``),
which reaches the agent as ``platform="universal"`` via
``_resolve_agent_platform``. There was no ``PLATFORM_HINTS["universal"]`` entry
to match it, so the lookup in ``agent/system_prompt.py`` fell through the
plugin-registry branch to an empty string: the app's agent got **no** surface
framing at all.

The user-visible symptom was file delivery. ``MEDIA:/absolute/path`` is the only
convention the client renders as an attachment (``renderMediaTags`` →
``#media:`` → ``MediaAttachment``), and it is the platform hint that teaches it.
With no hint, the model fell back to plain markdown links to gateway paths,
which the client could not open.

Runs against the real builders, mirroring ``test_platform_hint_desktop.py``:
these are text contracts, and mocking the resolver would hide the bug class.
"""

from types import SimpleNamespace
from unittest.mock import patch

from agent.prompt_builder import PLATFORM_HINTS
from agent.system_prompt import build_system_prompt_parts


def _stable_prompt(agent):
    with (
        patch("run_agent.load_soul_md", return_value=""),
        patch("run_agent.build_nous_subscription_prompt", return_value=""),
        patch("run_agent.build_environment_hints", return_value=""),
        patch("run_agent.build_context_files_prompt", return_value=""),
    ):
        return build_system_prompt_parts(agent)["stable"]


def _make_agent(platform="", **overrides):
    base = dict(
        load_soul_identity=False,
        skip_context_files=False,
        valid_tool_names=[],
        _task_completion_guidance=False,
        _tool_use_enforcement=False,
        _environment_probe=False,
        _kanban_worker_guidance="",
        _memory_store=None,
        _memory_manager=None,
        _platform_hint_overrides={},
        model="",
        provider="",
        pass_session_id=False,
        session_id="",
    )
    base["platform"] = platform
    base.update(overrides)
    return SimpleNamespace(**base)


class TestUniversalHintEntry:
    def test_universal_key_exists(self):
        """The tag the client actually sends must resolve to a hint. Without
        this entry the lookup yields "" and the agent is told nothing about the
        surface it is on."""
        assert "universal" in PLATFORM_HINTS

    def test_universal_hint_teaches_file_delivery(self):
        """``MEDIA:`` is the only file-delivery convention the app renders. If
        the hint stops naming it, files silently regress to dead markdown
        links — the bug this entry exists to fix."""
        assert "MEDIA:" in PLATFORM_HINTS["universal"]

    def test_universal_hint_advertises_markdown(self):
        """The app renders full GFM through Streamdown, so the hint must steer
        toward markdown rather than away from it as the cli/tui hints do."""
        assert "markdown" in PLATFORM_HINTS["universal"].lower()

    def test_universal_hint_is_not_desktop_specific(self):
        """One Tauri codebase ships to desktop, iOS and Android. Calling it a
        "desktop app" (as the ``desktop`` hint does) is wrong on a phone, and
        the model repeats that framing back to the user."""
        hint = PLATFORM_HINTS["universal"]
        assert "desktop app" not in hint.lower()
        assert "mobile" in hint.lower()

    def test_universal_hint_does_not_call_it_a_terminal(self):
        """The failure mode that motivated the ``desktop`` entry: a graphical
        surface inheriting terminal framing gets TUI-only advice."""
        assert "not a terminal" in PLATFORM_HINTS["universal"].lower()


class TestUniversalHintReachesThePrompt:
    def test_hint_lands_in_the_stable_prompt(self):
        """End-to-end through the real resolver — the entry existing is not
        enough if the lookup site does not pick it up for this platform key."""
        prompt = _stable_prompt(_make_agent(platform="universal"))
        assert "MEDIA:/absolute/path/to/file" in prompt

    def test_other_platforms_are_untouched(self):
        """Adding a key must not leak into neighbouring surfaces. The cli hint
        names MEDIA: only to FORBID it (a terminal renders the tag literally),
        and that prohibition must survive."""
        assert "NOT emit MEDIA:" in PLATFORM_HINTS["cli"]
        assert "MEDIA:" not in PLATFORM_HINTS["tui"]
