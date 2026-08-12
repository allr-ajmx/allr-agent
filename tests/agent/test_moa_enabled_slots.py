"""The MoA ``enabled`` opt-outs actually change what runs.

``MoaModelSlot.enabled`` (per reference slot) and the preset-level ``enabled``
are both honoured deep inside ``MoAChatCompletions.create`` — a disabled
reference slot must be dropped from the advisor fan-out, and a disabled preset
must skip the fan-out entirely and let the aggregator act alone.

Nothing exercised either path before: the settings UI that writes these flags
is new, and the only existing coverage was ``hermes_cli/test_moa_config.py``,
which proves the flag *survives normalization* — not that anything reads it.
Without these tests a regression that ran every slot regardless would be
invisible, and the toggles would be a control writing state nobody acts on.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest


def _response(content="ok"):
    message = SimpleNamespace(content=content, tool_calls=[])
    choice = SimpleNamespace(message=message, finish_reason="stop")
    return SimpleNamespace(choices=[choice], usage=None, model="fake")


def _write_config(home, *, preset_enabled: bool, first_ref_enabled: bool):
    (home / "config.yaml").write_text(
        f"""
moa:
  default_preset: closed
  presets:
    closed:
      enabled: {str(preset_enabled).lower()}
      reference_models:
        - provider: openrouter
          model: advisor-one
          enabled: {str(first_ref_enabled).lower()}
        - provider: openrouter
          model: advisor-two
      aggregator:
        provider: openrouter
        model: aggregator-model
""".strip(),
        encoding="utf-8",
    )


@pytest.fixture
def moa_home(tmp_path, monkeypatch):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    return home


def _run_turn(monkeypatch):
    """Run one MoA turn, returning (advisor models called, aggregator calls)."""
    from agent.moa_loop import MoAChatCompletions

    advisors: list[str] = []
    aggregators: list[str] = []

    def fake_call_llm(**kwargs):
        if kwargs.get("task") == "moa_reference":
            advisors.append(str(kwargs.get("model")))
            return _response("advice")

        aggregators.append(str(kwargs.get("model")))
        return _response("acted")

    monkeypatch.setattr("agent.moa_loop.call_llm", fake_call_llm)

    MoAChatCompletions("closed").create(
        model="closed",
        messages=[{"role": "user", "content": "clean the db"}],
    )

    return advisors, aggregators


def test_disabled_reference_slot_is_dropped_from_the_fanout(moa_home, monkeypatch):
    """`enabled: false` on one reference slot removes exactly that advisor."""
    _write_config(moa_home, preset_enabled=True, first_ref_enabled=False)

    advisors, aggregators = _run_turn(monkeypatch)

    assert "advisor-one" not in advisors
    # The remaining advisor still contributes — the flag is a per-slot opt-out,
    # not an accidental kill switch for the whole fan-out.
    assert advisors == ["advisor-two"]
    assert aggregators == ["aggregator-model"]


def test_enabled_reference_slot_still_runs(moa_home, monkeypatch):
    """Control: the same slot with `enabled: true` DOES fan out.

    Pins the assertion above to the flag rather than to some unrelated reason
    ``advisor-one`` might be missing.
    """
    _write_config(moa_home, preset_enabled=True, first_ref_enabled=True)

    advisors, _ = _run_turn(monkeypatch)

    assert sorted(advisors) == ["advisor-one", "advisor-two"]


def test_disabled_preset_skips_the_fanout_and_the_aggregator_acts_alone(
    moa_home, monkeypatch
):
    """A disabled preset degrades to "just use the aggregator" — not an error.

    This is also the empty-fan-out answer: zero advisors is a supported state
    that still produces an answer, so a UI that lets every reference model be
    switched off does not need to guard against it.
    """
    _write_config(moa_home, preset_enabled=False, first_ref_enabled=True)

    advisors, aggregators = _run_turn(monkeypatch)

    assert advisors == []
    assert aggregators == ["aggregator-model"]


def test_every_reference_disabled_still_answers(moa_home, monkeypatch):
    """Every slot off = the same safe degradation as a disabled preset."""
    (moa_home / "config.yaml").write_text(
        """
moa:
  default_preset: closed
  presets:
    closed:
      enabled: true
      reference_models:
        - provider: openrouter
          model: advisor-one
          enabled: false
        - provider: openrouter
          model: advisor-two
          enabled: false
      aggregator:
        provider: openrouter
        model: aggregator-model
""".strip(),
        encoding="utf-8",
    )

    advisors, aggregators = _run_turn(monkeypatch)

    assert advisors == []
    assert aggregators == ["aggregator-model"]
