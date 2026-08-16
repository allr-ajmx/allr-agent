"""Custom image-model ids over the toolset REST routes.

OpenRouter's image catalog moves faster than we ship, so the GUI must be able
to name a model this build has never heard of. Backends whose ids are a closed
set stay validated — typing one there only produces a runtime failure later.

The handlers are exercised directly rather than through the dashboard
TestClient: these assertions are about catalog validation, not routing.
"""

from __future__ import annotations

import asyncio

import pytest

from agent import image_gen_registry
from agent.image_gen_provider import ImageGenProvider


class _Fake(ImageGenProvider):
    def __init__(self, name: str, *, accepts_custom: bool):
        self._name = name
        self._accepts_custom = accepts_custom

    @property
    def name(self) -> str:
        return self._name

    def is_available(self) -> bool:
        return True

    def list_models(self):
        return [{"id": f"{self._name}/known-v1", "display": "Known v1"}]

    def default_model(self):
        return f"{self._name}/known-v1"

    def capabilities(self):
        return {
            "modalities": ["text", "image"],
            "accepts_custom_model": self._accepts_custom,
        }

    def get_setup_schema(self):
        return {"name": self._name, "badge": "test", "tag": "", "env_vars": []}

    def generate(self, prompt, aspect_ratio="landscape", **kw):
        return {"success": True, "image": "x"}


@pytest.fixture(autouse=True)
def _isolated_home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    image_gen_registry._reset_for_tests()
    yield
    image_gen_registry._reset_for_tests()


def _activate(plugin_name: str, *, model: str | None = None) -> None:
    from hermes_cli.config import load_config, save_config

    config = load_config()
    section = config.setdefault("image_gen", {})
    section["provider"] = plugin_name
    if model is not None:
        section["model"] = model
        section[plugin_name] = {"model": model}
    save_config(config)


def _select(model: str):
    from hermes_cli.web_models import ToolsetModelSelect
    from hermes_cli.web_routers.tools import select_toolset_model

    return asyncio.run(
        select_toolset_model("image_gen", ToolsetModelSelect(model=model))
    )


def _catalog():
    from hermes_cli.web_routers.tools import get_toolset_models

    return asyncio.run(get_toolset_models("image_gen"))


class TestCustomModelSelection:
    def test_custom_id_accepted_for_open_backend(self):
        image_gen_registry.register_provider(_Fake("openish", accepts_custom=True))
        _activate("openish")

        result = _select("vendor/model-we-have-never-heard-of")

        assert result["ok"] is True
        assert result["model"] == "vendor/model-we-have-never-heard-of"

    def test_custom_id_is_written_to_both_keys(self):
        from hermes_cli.config import load_config

        image_gen_registry.register_provider(_Fake("openish", accepts_custom=True))
        _activate("openish")

        _select("vendor/hand-typed")

        section = load_config()["image_gen"]
        # The scoped key is what deepinfra and xai actually resolve against.
        assert section["openish"]["model"] == "vendor/hand-typed"
        assert section["model"] == "vendor/hand-typed"

    def test_unknown_id_still_rejected_for_closed_backend(self):
        from fastapi import HTTPException

        image_gen_registry.register_provider(_Fake("closed", accepts_custom=False))
        _activate("closed")

        with pytest.raises(HTTPException) as excinfo:
            _select("vendor/not-in-the-catalog")
        assert excinfo.value.status_code == 400

    def test_blank_id_rejected_even_for_open_backend(self):
        from fastapi import HTTPException

        image_gen_registry.register_provider(_Fake("openish", accepts_custom=True))
        _activate("openish")

        with pytest.raises(HTTPException) as excinfo:
            _select("   ")
        assert excinfo.value.status_code == 400


class TestCatalogReporting:
    def test_custom_current_is_preserved(self):
        """It is absent from the catalog by definition. Rewriting it to the
        default would render the wrong model as selected and quietly lose the
        user's choice on the next save."""
        image_gen_registry.register_provider(_Fake("openish", accepts_custom=True))
        _activate("openish", model="vendor/hand-typed")

        payload = _catalog()

        assert payload["current"] == "vendor/hand-typed"
        assert payload["accepts_custom_model"] is True

    def test_unknown_current_reset_for_closed_backend(self):
        image_gen_registry.register_provider(_Fake("closed", accepts_custom=False))
        _activate("closed", model="vendor/stale-id")

        payload = _catalog()

        assert payload["current"] == "closed/known-v1"
        assert payload["accepts_custom_model"] is False

    def test_scoped_key_wins_over_stale_top_level(self):
        from hermes_cli.config import load_config, save_config

        image_gen_registry.register_provider(_Fake("openish", accepts_custom=True))
        _activate("openish")
        config = load_config()
        config["image_gen"]["model"] = "some-other-backends-model"
        config["image_gen"]["openish"] = {"model": "openish/known-v1"}
        save_config(config)

        assert _catalog()["current"] == "openish/known-v1"
