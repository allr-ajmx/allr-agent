"""Tests for agent/image_gen_registry.py — provider registration & active lookup."""

from __future__ import annotations

import pytest

from agent import image_gen_registry
from agent.image_gen_provider import ImageGenProvider


class _FakeProvider(ImageGenProvider):
    def __init__(self, name: str, available: bool = True):
        self._name = name
        self._available = available

    @property
    def name(self) -> str:
        return self._name

    def is_available(self) -> bool:
        return self._available

    def generate(self, prompt, aspect_ratio="landscape", **kw):
        return {"success": True, "image": f"{self._name}://{prompt}"}


@pytest.fixture(autouse=True)
def _reset_registry():
    image_gen_registry._reset_for_tests()
    yield
    image_gen_registry._reset_for_tests()


class TestRegisterProvider:


    def test_rejects_empty_name(self):
        class Empty(ImageGenProvider):
            @property
            def name(self) -> str:
                return ""

            def generate(self, prompt, aspect_ratio="landscape", **kw):
                return {}

        with pytest.raises(ValueError):
            image_gen_registry.register_provider(Empty())


    def test_list_is_sorted(self):
        image_gen_registry.register_provider(_FakeProvider("zeta"))
        image_gen_registry.register_provider(_FakeProvider("alpha"))
        names = [p.name for p in image_gen_registry.list_providers()]
        assert names == ["alpha", "zeta"]


class TestGetActiveProvider:


    def test_explicit_config_wins(self, tmp_path, monkeypatch):
        import yaml

        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        (tmp_path / "config.yaml").write_text(
            yaml.safe_dump({"image_gen": {"provider": "openai"}})
        )
        image_gen_registry.register_provider(_FakeProvider("fal"))
        image_gen_registry.register_provider(_FakeProvider("openai"))
        active = image_gen_registry.get_active_provider()
        assert active is not None and active.name == "openai"


    def test_none_when_empty(self, tmp_path, monkeypatch):
        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        assert image_gen_registry.get_active_provider() is None


class TestRuntimeProviderFallback:
    """Rule 2: with image_gen.provider unset, prefer the image backend
    belonging to the user's active LLM provider — they already pay that vendor
    for inference, so it cannot be a surprise bill.
    """

    @pytest.fixture
    def runtime(self, tmp_path, monkeypatch):
        from hermes_cli import runtime_provider as runtime_module

        monkeypatch.setenv("HERMES_HOME", str(tmp_path))

        def _set(name: str) -> None:
            monkeypatch.setattr(
                runtime_module, "resolve_requested_provider", lambda *a, **kw: name
            )

        _set("auto")

        return _set

    def test_matches_the_active_runtime_provider(self, runtime):
        """The case the single-available rule misses: more than one provider
        has credentials, so only the runtime match can disambiguate."""
        runtime("openrouter")
        image_gen_registry.register_provider(_FakeProvider("openai"))
        image_gen_registry.register_provider(_FakeProvider("openrouter"))

        active = image_gen_registry.get_active_provider()
        assert active is not None and active.name == "openrouter"

    def test_match_must_be_available(self, runtime):
        runtime("openrouter")
        image_gen_registry.register_provider(_FakeProvider("openrouter", available=False))
        image_gen_registry.register_provider(_FakeProvider("openai"))

        # Falls through to the single-available rule.
        active = image_gen_registry.get_active_provider()
        assert active is not None and active.name == "openai"

    def test_auto_matches_no_backend(self, runtime):
        """"auto" is the unconfigured default; it names no image backend, so
        holding two unrelated keys must not select one."""
        runtime("auto")
        image_gen_registry.register_provider(_FakeProvider("openai"))
        image_gen_registry.register_provider(_FakeProvider("openrouter"))

        assert image_gen_registry.get_active_provider() is None

    def test_explicit_config_still_wins(self, runtime, tmp_path):
        import yaml

        runtime("openrouter")
        (tmp_path / "config.yaml").write_text(
            yaml.safe_dump({"image_gen": {"provider": "openai"}})
        )
        image_gen_registry.register_provider(_FakeProvider("openai"))
        image_gen_registry.register_provider(_FakeProvider("openrouter"))

        active = image_gen_registry.get_active_provider()
        assert active is not None and active.name == "openai"

    def test_resolution_failure_is_not_fatal(self, runtime, monkeypatch):
        from hermes_cli import runtime_provider as runtime_module

        monkeypatch.setattr(
            runtime_module,
            "resolve_requested_provider",
            lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("boom")),
        )
        image_gen_registry.register_provider(_FakeProvider("openrouter"))

        # Single available provider — the later rules still resolve it.
        active = image_gen_registry.get_active_provider()
        assert active is not None and active.name == "openrouter"
