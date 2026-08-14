from __future__ import annotations

import json
import pytest

from agent import image_gen_registry
from agent.image_gen_provider import ImageGenProvider


@pytest.fixture(autouse=True)
def _reset_registry():
    image_gen_registry._reset_for_tests()
    yield
    image_gen_registry._reset_for_tests()


@pytest.fixture
def hermetic(monkeypatch, tmp_path):
    """Isolate the unset-provider path from the developer's real machine.

    With ``image_gen.provider`` unset the tool now resolves a backend, which
    means plugin discovery and ``is_available()`` probes. Left unpatched those
    read the real ~/.hermes credentials and reach the network — which also
    poisons ``hermes_cli.models``' negative catalog cache for later tests.
    """
    from hermes_cli import plugins as plugins_module
    from hermes_cli import runtime_provider as runtime_module

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.delenv("FAL_KEY", raising=False)
    monkeypatch.setattr(plugins_module, "_ensure_plugins_discovered", lambda *a, **kw: None)

    def _set_runtime(name: str) -> None:
        monkeypatch.setattr(runtime_module, "resolve_requested_provider", lambda *a, **kw: name)

    _set_runtime("auto")

    return _set_runtime


class _FakeProvider(ImageGenProvider):
    """Records what generate() was handed, so kwarg regressions are visible."""

    def __init__(self, name: str, *, available: bool = True, max_refs: int = 4):
        self._name = name
        self._available = available
        self._max_refs = max_refs
        self.calls: list[dict] = []

    @property
    def name(self) -> str:
        return self._name

    @property
    def display_name(self) -> str:
        return self._name.title()

    def is_available(self) -> bool:
        return self._available

    def capabilities(self):
        return {"modalities": ["text", "image"], "max_reference_images": self._max_refs}

    def list_models(self):
        return [{"id": f"{self._name}/model-v1", "display": "v1"}]

    def default_model(self):
        return f"{self._name}/model-v1"

    def generate(self, prompt, aspect_ratio="landscape", **kwargs):
        self.calls.append({"prompt": prompt, "aspect_ratio": aspect_ratio, **kwargs})

        return {
            "success": True,
            "image": f"/tmp/{self._name}.png",
            "model": kwargs.get("model") or self.default_model(),
            "prompt": prompt,
            "aspect_ratio": aspect_ratio,
            "provider": self._name,
        }


class _FakeCodexProvider(ImageGenProvider):
    @property
    def name(self) -> str:
        return "codex"

    def generate(self, prompt, aspect_ratio="landscape", **kwargs):
        return {
            "success": True,
            "image": "/tmp/codex-test.png",
            "model": "gpt-5.2-codex",
            "prompt": prompt,
            "aspect_ratio": aspect_ratio,
            "provider": "codex",
        }


class TestPluginDispatch:
    def test_dispatch_routes_to_codex_provider(self, monkeypatch, tmp_path):
        from tools import image_generation_tool
        from agent import image_gen_registry as registry_module
        from hermes_cli import plugins as plugins_module

        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        (tmp_path / "config.yaml").write_text("image_gen:\n  provider: codex\n")
        image_gen_registry.register_provider(_FakeCodexProvider())

        monkeypatch.setattr(image_generation_tool, "_read_configured_image_provider", lambda: "codex")
        monkeypatch.setattr(plugins_module, "_ensure_plugins_discovered", lambda: None)
        monkeypatch.setattr(registry_module, "get_provider", lambda name: _FakeCodexProvider() if name == "codex" else None)

        dispatched = image_generation_tool._dispatch_to_plugin_provider("draw cat", "square")
        payload = json.loads(dispatched)

        assert payload["success"] is True
        assert payload["provider"] == "codex"
        assert payload["image"] == "/tmp/codex-test.png"
        assert payload["aspect_ratio"] == "square"


class TestAutoSelection:
    """With image_gen.provider unset, the tool resolves the image backend
    belonging to the user's active LLM provider.

    The consent rule stands: a bare credential for some *other* vendor must
    never opt a user into paid image generation.
    """

    def test_matching_runtime_provider_is_selected(self, hermetic):
        from tools import image_generation_tool

        hermetic("openrouter")
        provider = _FakeProvider("openrouter")
        image_gen_registry.register_provider(provider)

        payload = json.loads(image_generation_tool._dispatch_to_plugin_provider("a cat", "square"))

        assert payload["provider"] == "openrouter"

    def test_check_and_dispatch_agree_when_unset(self, hermetic):
        """Both directions in one test so the two call sites cannot drift.

        If the check advertises the tool while dispatch falls through to the
        keyless in-tree FAL path, the model is handed a tool that cannot run.
        """
        from tools import image_generation_tool

        hermetic("openrouter")
        image_gen_registry.register_provider(_FakeProvider("openrouter"))

        assert image_generation_tool.check_image_generation_requirements() is True
        assert image_generation_tool._dispatch_to_plugin_provider("a cat", "square") is not None

    def test_check_and_dispatch_agree_when_nothing_resolves(self, hermetic):
        from tools import image_generation_tool

        hermetic("anthropic")
        image_gen_registry.register_provider(_FakeProvider("openrouter"))
        image_gen_registry.register_provider(_FakeProvider("openai"))

        assert image_generation_tool.check_image_generation_requirements() is False
        assert image_generation_tool._dispatch_to_plugin_provider("a cat", "square") is None

    def test_unrelated_key_alone_does_not_select_image_backend(self, hermetic):
        """DeepInfra chat credentials do not imply consent to image billing.

        Two providers are available and neither matches the runtime provider,
        so no rule may resolve one.
        """
        from tools import image_generation_tool

        hermetic("anthropic")
        image_gen_registry.register_provider(_FakeProvider("deepinfra"))
        image_gen_registry.register_provider(_FakeProvider("xai"))

        assert image_generation_tool._dispatch_to_plugin_provider("a cat", "square") is None

    def test_auto_runtime_matches_nothing(self, hermetic):
        """"auto" is the unconfigured default and names no image backend."""
        from tools import image_generation_tool

        hermetic("auto")
        image_gen_registry.register_provider(_FakeProvider("openrouter"))
        image_gen_registry.register_provider(_FakeProvider("openai"))

        assert image_generation_tool._auto_selected_provider() is None

    def test_unavailable_match_is_skipped(self, hermetic):
        from tools import image_generation_tool

        hermetic("openrouter")
        image_gen_registry.register_provider(_FakeProvider("openrouter", available=False))
        image_gen_registry.register_provider(_FakeProvider("openai"))

        # Falls through to the single-available rule, which openai satisfies.
        selected = image_generation_tool._auto_selected_provider()
        assert selected is not None and selected.name == "openai"

    def test_auto_selection_never_returns_fal(self, hermetic):
        """FAL belongs on the in-tree pipeline, not plugin dispatch — the
        registry's legacy-FAL rule would otherwise hand it back here."""
        from tools import image_generation_tool

        hermetic("fal")
        image_gen_registry.register_provider(_FakeProvider("fal"))

        assert image_generation_tool._auto_selected_provider() is None
        assert image_generation_tool._dispatch_to_plugin_provider("a cat", "square") is None

    def test_stale_top_level_model_is_not_passed(self, hermetic, tmp_path):
        """image_gen.model is written alongside image_gen.provider, so with no
        provider set it belongs to a different backend. Passing it would also
        disable the plugin's own fallback chain, since an explicit model kwarg
        means "use exactly this"."""
        from tools import image_generation_tool

        hermetic("openrouter")
        (tmp_path / "config.yaml").write_text("image_gen:\n  model: fal-ai/flux/dev\n")
        provider = _FakeProvider("openrouter")
        image_gen_registry.register_provider(provider)

        image_generation_tool._dispatch_to_plugin_provider("a cat", "square")

        assert provider.calls, "provider was never dispatched to"
        assert "model" not in provider.calls[0]

    def test_explicit_provider_still_receives_the_configured_model(self, hermetic, tmp_path):
        from tools import image_generation_tool

        (tmp_path / "config.yaml").write_text(
            "image_gen:\n  provider: openrouter\n  model: vendor/pinned\n"
        )
        provider = _FakeProvider("openrouter")
        image_gen_registry.register_provider(provider)

        image_generation_tool._dispatch_to_plugin_provider("a cat", "square")

        assert provider.calls[0]["model"] == "vendor/pinned"

    def test_capabilities_reflect_the_auto_selected_backend(self, hermetic):
        """The third call site. Falling through to the FAL catalog here would
        advertise text-to-image only, so the model would never be told it can
        pass a reference image to a backend that accepts one."""
        from tools import image_generation_tool

        hermetic("openrouter")
        image_gen_registry.register_provider(_FakeProvider("openrouter", max_refs=14))

        info = image_generation_tool._active_image_capabilities()

        assert "image" in info["modalities"]
        assert info["max_reference_images"] == 14
        assert info["model"] == "openrouter/model-v1"


class TestExplicitFalUnchanged:
    def test_explicit_fal_keeps_the_in_tree_path(self, hermetic, tmp_path):
        """`provider: fal` must short-circuit to the in-tree pipeline even
        though a fal plugin is registered and available."""
        from tools import image_generation_tool

        (tmp_path / "config.yaml").write_text("image_gen:\n  provider: fal\n")
        provider = _FakeProvider("fal")
        image_gen_registry.register_provider(provider)

        assert image_generation_tool._dispatch_to_plugin_provider("a cat", "square") is None
        assert provider.calls == []

    def test_requirements_false_for_explicit_fal_without_key(self, monkeypatch, tmp_path):
        from tools import image_generation_tool

        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        monkeypatch.setattr(image_generation_tool, "check_fal_api_key", lambda: False)
        monkeypatch.setattr(
            image_generation_tool, "_read_configured_image_provider", lambda: "fal"
        )
        assert image_generation_tool.check_image_generation_requirements() is False
