"""Tests for plugin image_gen providers injecting themselves into the picker.

Covers `_plugin_image_gen_providers`, `_visible_providers`, and
`_toolset_needs_configuration_prompt` handling of plugin providers.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from agent import image_gen_registry
from agent.image_gen_provider import ImageGenProvider


class _FakeProvider(ImageGenProvider):
    def __init__(
        self,
        name: str,
        available: bool = True,
        schema=None,
        models=None,
        accepts_custom: bool = False,
    ):
        self._name = name
        self._available = available
        self._accepts_custom = accepts_custom
        self._schema = schema or {
            "name": name.title(),
            "badge": "test",
            "tag": f"{name} test tag",
            "env_vars": [{"key": f"{name.upper()}_API_KEY", "prompt": f"{name} key"}],
        }
        # `is not None`, not `or`: an explicitly empty catalog is a real case
        # (live discovery unreachable) and must not fall back to the default.
        self._models = models if models is not None else [
            {"id": f"{name}-model-v1", "display": f"{name} v1",
             "speed": "~5s", "strengths": "test", "price": "$"},
        ]

    @property
    def name(self) -> str:
        return self._name

    def is_available(self) -> bool:
        return self._available

    def list_models(self):
        return list(self._models)

    def default_model(self):
        return self._models[0]["id"] if self._models else None

    def capabilities(self):
        return {
            "modalities": ["text", "image"],
            "accepts_custom_model": self._accepts_custom,
        }

    def get_setup_schema(self):
        return dict(self._schema)

    def generate(self, prompt, aspect_ratio="landscape", **kw):
        return {"success": True, "image": f"{self._name}://{prompt}"}


@pytest.fixture(autouse=True)
def _reset_registry():
    image_gen_registry._reset_for_tests()
    yield
    image_gen_registry._reset_for_tests()


class TestPluginPickerInjection:
    def test_plugin_providers_returns_registered(self, monkeypatch):
        from hermes_cli import tools_config

        image_gen_registry.register_provider(_FakeProvider("myimg"))

        rows = tools_config._plugin_image_gen_providers()
        names = [r["name"] for r in rows]
        plugin_names = [r.get("image_gen_plugin_name") for r in rows]

        assert "Myimg" in names
        assert "myimg" in plugin_names


    def test_visible_providers_includes_plugins_for_image_gen(self, monkeypatch):
        from hermes_cli import tools_config

        image_gen_registry.register_provider(_FakeProvider("someimg"))

        cat = tools_config.TOOL_CATEGORIES["image_gen"]
        visible = tools_config._visible_providers(cat, {})
        plugin_names = [p.get("image_gen_plugin_name") for p in visible if p.get("image_gen_plugin_name")]
        assert "someimg" in plugin_names


    def test_post_setup_omitted_when_not_declared(self, monkeypatch):
        from hermes_cli import tools_config

        image_gen_registry.register_provider(_FakeProvider("plain_img"))

        rows = tools_config._plugin_image_gen_providers()
        match = next(r for r in rows if r.get("image_gen_plugin_name") == "plain_img")
        assert "post_setup" not in match


class TestPluginCatalog:
    def test_plugin_catalog_returns_models(self):
        from hermes_cli import tools_config

        image_gen_registry.register_provider(_FakeProvider("catimg"))

        catalog, default = tools_config._plugin_image_gen_catalog("catimg")
        assert "catimg-model-v1" in catalog
        assert default == "catimg-model-v1"


class TestConfigPrompt:
    def test_image_gen_satisfied_by_plugin_provider(self, monkeypatch, tmp_path):
        """When a plugin provider reports is_available(), the picker should
        not force a setup prompt on the user."""
        from hermes_cli import tools_config

        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        monkeypatch.delenv("FAL_KEY", raising=False)

        image_gen_registry.register_provider(_FakeProvider("avail-img", available=True))

        assert tools_config._toolset_needs_configuration_prompt("image_gen", {}) is False


class TestConfigWriting:
    def test_picking_plugin_provider_writes_provider_and_model(self, monkeypatch, tmp_path):
        """When a user picks a plugin-backed image_gen provider with no
        env vars needed, ``_configure_provider`` should write both
        ``image_gen.provider`` and ``image_gen.model``."""
        from hermes_cli import tools_config

        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        image_gen_registry.register_provider(_FakeProvider("noenv", schema={
            "name": "NoEnv",
            "badge": "free",
            "tag": "",
            "env_vars": [],
        }))

        # Stub out the interactive model picker — no TTY in tests.
        monkeypatch.setattr(tools_config, "_prompt_choice", lambda *a, **kw: 0)

        config: dict = {}
        provider_row = {
            "name": "NoEnv",
            "env_vars": [],
            "image_gen_plugin_name": "noenv",
        }
        tools_config._configure_provider(provider_row, config)

        assert config["image_gen"]["provider"] == "noenv"
        assert config["image_gen"]["model"] == "noenv-model-v1"
        # The scoped key is the one deepinfra and xai actually resolve against.
        assert config["image_gen"]["noenv"]["model"] == "noenv-model-v1"

    def test_model_pick_writes_the_provider_scoped_key(self, monkeypatch, tmp_path):
        """The deepinfra and xai plugins read only ``image_gen.<name>.model``
        and never fall back to the top-level key, so a top-level-only write
        made their model selection a silent no-op — the picker reported
        success and generation kept using the previous model."""
        from hermes_cli import tools_config

        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        image_gen_registry.register_provider(
            _FakeProvider(
                "scoped",
                models=[
                    {"id": "scoped-model-v1", "display": "v1"},
                    {"id": "scoped-model-v2", "display": "v2"},
                ],
            )
        )
        # Pick the second row (index 0 is "currently in use").
        monkeypatch.setattr(tools_config, "_prompt_choice", lambda *a, **kw: 1)

        config: dict = {}
        tools_config._configure_imagegen_model_for_plugin("scoped", config)

        assert config["image_gen"]["scoped"]["model"] == "scoped-model-v2"
        assert config["image_gen"]["model"] == "scoped-model-v2"

    def test_model_pick_shows_the_scoped_key_as_current(self, monkeypatch, tmp_path):
        """A stale top-level value left by another backend must not be
        presented as this backend's current model."""
        from hermes_cli import tools_config

        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        image_gen_registry.register_provider(
            _FakeProvider(
                "scoped",
                models=[
                    {"id": "scoped-model-v1", "display": "v1"},
                    {"id": "scoped-model-v2", "display": "v2"},
                ],
            )
        )
        seen = {}
        monkeypatch.setattr(
            tools_config,
            "_prompt_choice",
            lambda _q, rows, **kw: seen.setdefault("rows", rows) and 0 or 0,
        )

        config = {
            "image_gen": {
                "model": "some-other-backends-model",
                "scoped": {"model": "scoped-model-v2"},
            }
        }
        tools_config._configure_imagegen_model_for_plugin("scoped", config)

        assert "scoped-model-v2" in seen["rows"][0]
        assert "currently in use" in seen["rows"][0]


    def test_plugin_provider_active_overrides_managed_nous_active_label(self, monkeypatch):
        from hermes_cli import tools_config

        monkeypatch.setattr(
            tools_config,
            "get_nous_subscription_features",
            lambda config, **kwargs: SimpleNamespace(
                features={"image_gen": SimpleNamespace(managed_by_nous=True)}
            ),
        )

        config = {"image_gen": {"provider": "openai", "use_gateway": False}}
        nous_row = {
            "name": "Nous Subscription",
            "managed_nous_feature": "image_gen",
        }
        openai_row = {
            "name": "OpenAI",
            "image_gen_plugin_name": "openai",
        }

        assert tools_config._is_provider_active(openai_row, config) is True
        assert tools_config._is_provider_active(nous_row, config) is False


class TestCustomModelEntry:
    """OpenRouter's catalog moves faster than we ship, so the picker must let
    a user name a model it has never heard of."""

    def _rows_shown(self, monkeypatch, plugin, config, pick):
        from hermes_cli import tools_config

        seen = {}

        def _choice(_question, rows, **kw):
            seen["rows"] = rows
            return pick(rows)

        monkeypatch.setattr(tools_config, "_prompt_choice", _choice)
        tools_config._configure_imagegen_model_for_plugin(plugin, config)
        return seen["rows"]

    def test_sentinel_offered_only_for_custom_capable_backends(self, monkeypatch, tmp_path):
        from hermes_cli import tools_config

        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        image_gen_registry.register_provider(_FakeProvider("openish", accepts_custom=True))
        image_gen_registry.register_provider(_FakeProvider("closed", accepts_custom=False))

        open_rows = self._rows_shown(monkeypatch, "openish", {}, lambda rows: 0)
        closed_rows = self._rows_shown(monkeypatch, "closed", {}, lambda rows: 0)

        assert tools_config._CUSTOM_MODEL_ROW in open_rows
        assert tools_config._CUSTOM_MODEL_ROW not in closed_rows

    def test_typed_id_is_persisted(self, monkeypatch, tmp_path):
        from hermes_cli import tools_config

        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        image_gen_registry.register_provider(_FakeProvider("openish", accepts_custom=True))
        monkeypatch.setattr(tools_config, "_prompt", lambda *a, **kw: "  vendor/brand-new-model  ")

        config: dict = {}
        # Last row is the sentinel.
        self._rows_shown(monkeypatch, "openish", config, lambda rows: len(rows) - 1)

        assert config["image_gen"]["model"] == "vendor/brand-new-model"
        assert config["image_gen"]["openish"]["model"] == "vendor/brand-new-model"

    def test_blank_entry_cancels_without_writing(self, monkeypatch, tmp_path):
        from hermes_cli import tools_config

        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        image_gen_registry.register_provider(_FakeProvider("openish", accepts_custom=True))
        monkeypatch.setattr(tools_config, "_prompt", lambda *a, **kw: "   ")

        config: dict = {}
        self._rows_shown(monkeypatch, "openish", config, lambda rows: len(rows) - 1)

        assert "model" not in config.get("image_gen", {})

    def test_existing_custom_id_stays_selected(self, monkeypatch, tmp_path):
        """It is absent from the catalog by definition — it must not silently
        revert to the default on the next visit."""
        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        image_gen_registry.register_provider(_FakeProvider("openish", accepts_custom=True))

        config = {"image_gen": {"openish": {"model": "vendor/hand-typed"}}}
        rows = self._rows_shown(monkeypatch, "openish", config, lambda rows: 0)

        assert "vendor/hand-typed" in rows[0]
        assert "currently in use" in rows[0]
        assert config["image_gen"]["openish"]["model"] == "vendor/hand-typed"

    def test_empty_catalog_still_offers_entry(self, monkeypatch, tmp_path):
        """An empty catalog used to return silently, configuring nothing and
        explaining nothing."""
        from hermes_cli import tools_config

        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        image_gen_registry.register_provider(
            _FakeProvider("openish", models=[], accepts_custom=True)
        )
        monkeypatch.setattr(tools_config, "_prompt", lambda *a, **kw: "vendor/only-choice")

        config: dict = {}
        rows = self._rows_shown(monkeypatch, "openish", config, lambda rows: len(rows) - 1)

        assert rows == [tools_config._CUSTOM_MODEL_ROW]
        assert config["image_gen"]["model"] == "vendor/only-choice"
