#!/usr/bin/env python3
"""Tests for the OpenRouter-compatible image gen provider (OpenRouter + Nous)."""

from __future__ import annotations

import base64
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

_RUNTIME = "hermes_cli.runtime_provider.resolve_runtime_provider"
_B64 = "dGVzdC1pbWFnZS1kYXRh"  # "test-image-data"
_PNG_DATA_URI = f"data:image/png;base64,{_B64}"


def _runtime_ok(**over):
    base = {
        "provider": "openrouter",
        "api_mode": "chat_completions",
        "base_url": "https://openrouter.ai/api/v1",
        "api_key": "sk-or-test",
        "source": "env",
    }
    base.update(over)
    return base


def _mock_chat_response(images):
    """A `/chat/completions` image response — the Nous Portal protocol."""
    resp = MagicMock()
    resp.status_code = 200
    resp.raise_for_status = MagicMock()
    resp.json.return_value = {
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": "",
                    "images": [
                        {"type": "image_url", "image_url": {"url": u}} for u in images
                    ],
                }
            }
        ]
    }
    return resp


def _mock_images_response(items=((_B64, "image/png"),)):
    """A `/v1/images` response — the OpenRouter protocol.

    Base64 bytes plus a sibling media_type; never a hosted URL.
    """
    resp = MagicMock()
    resp.status_code = 200
    resp.raise_for_status = MagicMock()
    resp.json.return_value = {
        "created": 1748372400,
        "data": [{"b64_json": b64, "media_type": media} for b64, media in items],
        "usage": {"prompt_tokens": 16, "completion_tokens": 272, "cost": 0.04},
    }
    return resp


def _http_error(status, message):
    """A ``requests.post`` return value whose raise_for_status() raises."""
    import requests as req_lib

    resp = MagicMock()
    resp.status_code = status
    resp.text = message
    resp.json.return_value = {"error": {"message": message}}
    resp.raise_for_status.side_effect = req_lib.HTTPError(response=resp)
    return resp


# Vendor-neutral ids: the fallback trigger must not depend on who makes the
# model (it used to only fire for ``openai/``).
_CHAIN = ("vendor/model-a", "vendor/model-b")


def _openrouter():
    """The real openrouter row — the Images API protocol."""
    from plugins.image_gen.openrouter import OpenRouterImagesProvider

    return OpenRouterImagesProvider(
        provider_name="openrouter",
        display_name="OpenRouter",
        runtime_name="openrouter",
        config_key="openrouter",
        model_env_var="OPENROUTER_IMAGE_MODEL",
        setup_schema={"name": "OpenRouter (image)", "badge": "paid", "env_vars": []},
    )


def _nous():
    """The real nous row — the legacy chat-completions protocol."""
    from plugins.image_gen.openrouter import _build_providers

    return {p.name: p for p in _build_providers()}["nous"]


# ---------------------------------------------------------------------------
# Provider class
# ---------------------------------------------------------------------------


class TestProviderClass:
    def test_names(self):
        from plugins.image_gen.openrouter import _build_providers

        names = {p.name for p in _build_providers()}
        assert names == {"openrouter", "nous"}

    def test_display_names(self):
        from plugins.image_gen.openrouter import _build_providers

        by_name = {p.name: p for p in _build_providers()}
        assert by_name["openrouter"].display_name == "OpenRouter"
        assert by_name["nous"].display_name == "Nous Portal"

    def test_capabilities_support_image_input(self):
        from plugins.image_gen.openrouter import (
            _MAX_IMAGES_API_REFERENCES,
            _MAX_REFERENCE_IMAGES,
        )

        caps = _openrouter().capabilities()
        assert "image" in caps["modalities"]
        # The Images API advertises input_references 0-14; the legacy
        # chat-completions path is still capped at 3.
        assert caps["max_reference_images"] == _MAX_IMAGES_API_REFERENCES
        assert _nous().capabilities()["max_reference_images"] == _MAX_REFERENCE_IMAGES

    def test_capabilities_accept_custom_models(self):
        """Both pickers offer free-text entry off the back of this flag."""
        assert _openrouter().capabilities()["accepts_custom_model"] is True
        assert _nous().capabilities()["accepts_custom_model"] is True

    def test_is_available_with_key(self):
        with patch(_RUNTIME, return_value=_runtime_ok()):
            assert _openrouter().is_available() is True


    def test_default_model(self):
        from plugins.image_gen.openrouter import DEFAULT_MODEL, _FALLBACK_MODEL

        with patch("plugins.image_gen.openrouter._load_image_gen_config", return_value={}):
            assert _openrouter().default_model() == DEFAULT_MODEL
            # Default must be an image-output model id (provider/model form).
            assert "/" in DEFAULT_MODEL and "image" in DEFAULT_MODEL

        # Pinned: the previous default was an access-gated openai/ image model
        # that most accounts cannot route, which is what broke image generation.
        assert DEFAULT_MODEL == "google/gemini-3-pro-image"
        assert _FALLBACK_MODEL == "google/gemini-3.1-flash-image"
        assert not DEFAULT_MODEL.startswith("openai/")


    def test_model_env_override(self, monkeypatch):
        monkeypatch.setenv("OPENROUTER_IMAGE_MODEL", "black-forest-labs/flux.2-pro")
        assert _openrouter()._resolve_model() == "black-forest-labs/flux.2-pro"
        assert _openrouter()._resolve_model_chain() == ["black-forest-labs/flux.2-pro"]


    def test_nous_honors_top_level_model(self):
        from plugins.image_gen.openrouter import _build_providers

        cfg = {"model": "openai/gpt-image-2"}
        nous = {p.name: p for p in _build_providers()}["nous"]
        with patch("plugins.image_gen.openrouter._load_image_gen_config", return_value=cfg):
            assert nous._resolve_model_chain() == ["openai/gpt-image-2"]

    def test_explicit_model_kwarg_wins_over_config(self):
        cfg = {"model": "openai/gpt-image-2"}
        with patch("plugins.image_gen.openrouter._load_image_gen_config", return_value=cfg):
            assert _openrouter()._resolve_model_chain("google/gemini-3-pro-image") == [
                "google/gemini-3-pro-image"
            ]


# ---------------------------------------------------------------------------
# Model catalog
# ---------------------------------------------------------------------------


_FETCH = "hermes_cli.models.fetch_openrouter_image_models"


class TestCatalog:
    def test_openrouter_lists_the_live_catalog(self):
        live = [
            {"id": "bytedance-seed/seedream-4.5", "display": "Seedream 4.5", "strengths": "1K-4K"},
            {"id": "black-forest-labs/flux.2-pro", "display": "FLUX.2 Pro", "strengths": ""},
        ]
        with patch(_FETCH, return_value=live):
            rows = _openrouter().list_models()

        assert [r["id"] for r in rows] == [
            "bytedance-seed/seedream-4.5",
            "black-forest-labs/flux.2-pro",
        ]

    def test_openrouter_falls_back_to_the_default_chain(self):
        """An empty list would make the CLI picker configure nothing at all,
        so an unreachable catalog must still yield usable rows."""
        from plugins.image_gen.openrouter import DEFAULT_MODEL, _FALLBACK_MODEL

        with patch(_FETCH, return_value=[]):
            rows = _openrouter().list_models()

        assert [r["id"] for r in rows] == [DEFAULT_MODEL, _FALLBACK_MODEL]

    def test_openrouter_falls_back_when_discovery_raises(self):
        from plugins.image_gen.openrouter import DEFAULT_MODEL

        with patch(_FETCH, side_effect=RuntimeError("boom")):
            rows = _openrouter().list_models()

        assert rows[0]["id"] == DEFAULT_MODEL

    def test_nous_does_not_hit_the_openrouter_catalog(self):
        """Nous Portal exposes no catalog endpoint to enumerate."""
        from plugins.image_gen.openrouter import DEFAULT_MODEL, _FALLBACK_MODEL

        with patch(_FETCH, return_value=[{"id": "x/y", "display": "X", "strengths": ""}]) as fetch:
            rows = _nous().list_models()

        fetch.assert_not_called()
        assert [r["id"] for r in rows] == [DEFAULT_MODEL, _FALLBACK_MODEL]

    def test_default_model_ignores_the_catalog(self):
        """The default stays the known-good chain head — a 43-model catalog
        must not silently re-point it at whatever sorts first."""
        from plugins.image_gen.openrouter import DEFAULT_MODEL

        live = [{"id": "some/other-image-model", "display": "Other", "strengths": ""}]
        with patch(_FETCH, return_value=live), \
             patch("plugins.image_gen.openrouter._load_image_gen_config", return_value={}):
            assert _openrouter().default_model() == DEFAULT_MODEL


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class TestHelpers:
    def test_to_image_url_part_passthrough_url(self):
        from plugins.image_gen.openrouter import _to_image_url_part

        assert _to_image_url_part("https://x/y.png") == "https://x/y.png"
        assert _to_image_url_part("data:image/png;base64,AAAA") == "data:image/png;base64,AAAA"


    def test_to_image_url_part_blocks_credential_store(self, tmp_path, monkeypatch):
        from plugins.image_gen.openrouter import _to_image_url_part

        hermes_home = tmp_path / ".hermes"
        hermes_home.mkdir()
        auth_json = hermes_home / "auth.json"
        auth_json.write_text('{"api_key":"sk-secret"}', encoding="utf-8")
        monkeypatch.setenv("HERMES_HOME", str(hermes_home))

        with pytest.raises(ValueError, match="credential store"):
            _to_image_url_part(str(auth_json))


    def test_extract_images(self):
        from plugins.image_gen.openrouter import _extract_images

        payload = {
            "choices": [
                {"message": {"images": [{"image_url": {"url": "data:image/png;base64,AA"}}]}}
            ]
        }
        assert _extract_images(payload) == ["data:image/png;base64,AA"]


    def test_should_try_next_by_status(self):
        from plugins.image_gen.openrouter import _should_try_next

        for status in (402, 403, 404, 408, 429, 500, 503):
            assert _should_try_next(status, "model unavailable") is True, status
        # Same for every model in the chain — retrying is pure latency.
        assert _should_try_next(400, "invalid input_references") is False
        assert _should_try_next(401, "Invalid API key") is False

    def test_should_try_next_by_message(self):
        """OpenRouter returns the access-gate wording under assorted statuses."""
        from plugins.image_gen.openrouter import _should_try_next

        assert _should_try_next(422, "No endpoints found matching your data policy") is True
        assert _should_try_next(422, "something else entirely") is False

    def test_access_error_hint_for_gated_openai_model(self):
        from plugins.image_gen.openrouter import _FALLBACK_MODEL, _access_error_hint

        hint = _access_error_hint(
            "OpenRouter", "openai/gpt-5.4-image-2", "OPENROUTER_IMAGE_MODEL", 404, "No endpoints found"
        )
        assert hint is not None
        assert "openai/gpt-5.4-image-2" in hint
        assert "OPENROUTER_IMAGE_MODEL" in hint
        assert _FALLBACK_MODEL in hint
        # Stays a single line under the humanizer's 200-char truncation.
        assert "\n" not in hint and len(hint) <= 200


# ---------------------------------------------------------------------------
# generate()
# ---------------------------------------------------------------------------


class TestGenerate:
    def test_missing_credentials(self):
        with patch(_RUNTIME, return_value=_runtime_ok(api_key="")):
            result = _openrouter().generate(prompt="a pet")
        assert result["success"] is False
        assert result["error_type"] == "missing_api_key"

    def test_success_b64_json(self):
        with patch(_RUNTIME, return_value=_runtime_ok()), \
             patch("requests.post", return_value=_mock_images_response()), \
             patch(
                 "plugins.image_gen.openrouter.save_b64_image",
                 return_value=Path("/tmp/openrouter_gen.png"),
             ) as mock_save:
            result = _openrouter().generate(prompt="a pet")

        assert result["success"] is True
        assert result["image"] == "/tmp/openrouter_gen.png"
        assert result["provider"] == "openrouter"
        # The raw base64 is saved, not the reconstructed data URI.
        assert mock_save.call_args.args[0] == _B64
        assert mock_save.call_args.kwargs["extension"] == "png"

    def test_media_type_drives_the_saved_extension(self):
        """A vector model's SVG written as .png is silently broken for every
        downstream consumer — the extension must follow media_type."""
        with patch(_RUNTIME, return_value=_runtime_ok()), \
             patch("requests.post", return_value=_mock_images_response([(_B64, "image/svg+xml")])), \
             patch(
                 "plugins.image_gen.openrouter.save_b64_image",
                 return_value=Path("/tmp/x.svg"),
             ) as mock_save:
            result = _openrouter().generate(prompt="a logo")

        assert result["success"] is True
        assert mock_save.call_args.kwargs["extension"] == "svg"

    def test_empty_response(self):
        with patch(_RUNTIME, return_value=_runtime_ok()), \
             patch("requests.post", return_value=_mock_images_response([])):
            result = _openrouter().generate(prompt="a pet")
        assert result["success"] is False
        assert result["error_type"] == "empty_response"

    def test_payload_shape_and_references(self, tmp_path):
        """Images API body: prompt + aspect_ratio, references as objects.

        The reference inlined as a data URI is what makes pet rows stay
        on-model, and `input_references` items are objects — a bare URL string
        is rejected by the endpoint.
        """
        ref = tmp_path / "base.png"
        ref.write_bytes(b"\x89PNG\r\n")

        with patch(_RUNTIME, return_value=_runtime_ok()), \
             patch("requests.post", return_value=_mock_images_response()) as mock_post, \
             patch("plugins.image_gen.openrouter.save_b64_image", return_value=Path("/tmp/x.png")):
            _openrouter().generate(
                prompt="a pet", aspect_ratio="square", reference_images=[str(ref)]
            )

        payload = mock_post.call_args.kwargs["json"]
        assert payload["prompt"] == "a pet"
        assert payload["aspect_ratio"] == "1:1"
        # None of the chat-completions protocol may leak onto this endpoint.
        assert "modalities" not in payload
        assert "messages" not in payload
        assert "image_config" not in payload

        refs = payload["input_references"]
        assert len(refs) == 1
        assert refs[0]["type"] == "image_url"
        assert refs[0]["image_url"]["url"].startswith("data:image/png;base64,")

    def test_input_references_omitted_when_absent(self):
        """Text-to-image must not send an empty list — that is a different
        request shape than omitting the key."""
        with patch(_RUNTIME, return_value=_runtime_ok()), \
             patch("requests.post", return_value=_mock_images_response()) as mock_post, \
             patch("plugins.image_gen.openrouter.save_b64_image", return_value=Path("/tmp/x.png")):
            _openrouter().generate(prompt="a pet")

        assert "input_references" not in mock_post.call_args.kwargs["json"]

    def test_input_references_clamped(self, tmp_path):
        from plugins.image_gen.openrouter import _MAX_IMAGES_API_REFERENCES

        refs = []
        for i in range(_MAX_IMAGES_API_REFERENCES + 5):
            p = tmp_path / f"ref{i}.png"
            p.write_bytes(b"\x89PNG\r\n")
            refs.append(str(p))

        with patch(_RUNTIME, return_value=_runtime_ok()), \
             patch("requests.post", return_value=_mock_images_response()) as mock_post, \
             patch("plugins.image_gen.openrouter.save_b64_image", return_value=Path("/tmp/x.png")):
            _openrouter().generate(prompt="a pet", reference_images=refs)

        sent = mock_post.call_args.kwargs["json"]["input_references"]
        assert len(sent) == _MAX_IMAGES_API_REFERENCES

    def test_auth_header(self):
        with patch(_RUNTIME, return_value=_runtime_ok()), \
             patch("requests.post", return_value=_mock_images_response()) as mock_post, \
             patch("plugins.image_gen.openrouter.save_b64_image", return_value=Path("/tmp/x.png")):
            _openrouter().generate(prompt="a pet")

        headers = mock_post.call_args.kwargs["headers"]
        assert headers["Authorization"] == "Bearer sk-or-test"

    def test_generate_uses_model_kwarg_from_dispatch(self):
        """image_generate passes image_gen.model as a model kwarg — honor it."""
        with patch(_RUNTIME, return_value=_runtime_ok()), \
             patch("requests.post", return_value=_mock_images_response()) as mock_post, \
             patch("plugins.image_gen.openrouter.save_b64_image", return_value=Path("/tmp/x.png")):
            result = _openrouter().generate(prompt="a pet", model="openai/gpt-image-2")

        assert result["success"] is True
        assert result["model"] == "openai/gpt-image-2"
        assert mock_post.call_args.kwargs["json"]["model"] == "openai/gpt-image-2"

    def test_openrouter_posts_to_the_images_endpoint(self):
        with patch(_RUNTIME, return_value=_runtime_ok()), \
             patch("requests.post", return_value=_mock_images_response()) as mock_post, \
             patch("plugins.image_gen.openrouter.save_b64_image", return_value=Path("/tmp/x.png")):
            result = _openrouter().generate(prompt="a pet")

        assert result["success"] is True
        assert mock_post.call_args[0][0] == "https://openrouter.ai/api/v1/images"

    def test_nous_stays_on_chat_completions(self):
        """Nous Portal has no /images endpoint — it must keep the legacy
        protocol, base URL and 3-reference clamp."""
        from plugins.image_gen.openrouter import _MAX_REFERENCE_IMAGES

        nous_runtime = _runtime_ok(
            provider="nous", base_url="https://inference.nousresearch.com/v1", api_key="nous-tok"
        )
        with patch(_RUNTIME, return_value=nous_runtime), \
             patch("requests.post", return_value=_mock_chat_response([_PNG_DATA_URI])) as mock_post, \
             patch("plugins.image_gen.openrouter.save_b64_image", return_value=Path("/tmp/x.png")):
            nous = _nous()
            result = nous.generate(prompt="a pet", aspect_ratio="square")

        assert result["success"] is True
        assert result["provider"] == "nous"
        assert mock_post.call_args[0][0] == "https://inference.nousresearch.com/v1/chat/completions"

        payload = mock_post.call_args.kwargs["json"]
        assert payload["modalities"] == ["image", "text"]
        assert payload["image_config"]["aspect_ratio"] == "1:1"
        assert payload["messages"][0]["content"][0] == {"type": "text", "text": "a pet"}
        assert "input_references" not in payload
        assert nous.max_reference_images == _MAX_REFERENCE_IMAGES

    def test_api_error(self):
        import requests as req_lib

        resp = MagicMock()
        resp.status_code = 401
        resp.text = "Unauthorized"
        resp.json.return_value = {"error": {"message": "Invalid API key"}}
        resp.raise_for_status.side_effect = req_lib.HTTPError(response=resp)

        with patch(_RUNTIME, return_value=_runtime_ok()), \
             patch("requests.post", return_value=resp) as mock_post:
            result = _openrouter().generate(prompt="a pet")
        assert result["success"] is False
        assert result["error_type"] == "api_error"
        assert mock_post.call_count == 1

    def test_timeout(self):
        import requests as req_lib

        with patch(_RUNTIME, return_value=_runtime_ok()), \
             patch("requests.post", side_effect=req_lib.Timeout()):
            result = _openrouter().generate(prompt="a pet")
        assert result["success"] is False
        assert result["error_type"] == "timeout"


# ---------------------------------------------------------------------------
# Model-chain fallback
# ---------------------------------------------------------------------------


class TestModelChain:
    """The chain advances on access-gate / transient failures only.

    Fallback used to be gated on ``_access_error_hint``, which hard-requires an
    ``openai/`` model id — so a chain made of any other vendor's models could
    never advance. These pin the trigger to the status, not the vendor.
    """

    @pytest.fixture(autouse=True)
    def _bare_default_chain(self, monkeypatch):
        monkeypatch.delenv("OPENROUTER_IMAGE_MODEL", raising=False)
        monkeypatch.setattr("plugins.image_gen.openrouter._DEFAULT_MODEL_CHAIN", _CHAIN)

    def test_chain_falls_back_on_404(self):
        # Message deliberately carries none of the retryable substrings, so
        # only the status can drive the retry.
        responses = [
            _http_error(404, "model unavailable"),
            _mock_images_response(),
        ]
        with patch(_RUNTIME, return_value=_runtime_ok()), \
             patch("plugins.image_gen.openrouter._load_image_gen_config", return_value={}), \
             patch("requests.post", side_effect=responses) as mock_post, \
             patch("plugins.image_gen.openrouter.save_b64_image", return_value=Path("/tmp/x.png")):
            result = _openrouter().generate(prompt="a pet")

        assert result["success"] is True
        assert result["model"] == _CHAIN[1]
        assert mock_post.call_count == 2

    def test_chain_falls_back_on_server_error(self):
        responses = [
            _http_error(503, "upstream busy"),
            _mock_images_response(),
        ]
        with patch(_RUNTIME, return_value=_runtime_ok()), \
             patch("plugins.image_gen.openrouter._load_image_gen_config", return_value={}), \
             patch("requests.post", side_effect=responses) as mock_post, \
             patch("plugins.image_gen.openrouter.save_b64_image", return_value=Path("/tmp/x.png")):
            result = _openrouter().generate(prompt="a pet")

        assert result["success"] is True
        assert mock_post.call_count == 2

    def test_chain_does_not_retry_on_400(self):
        """A malformed body fails identically on every model — retrying it only
        doubles the latency before the same error surfaces."""
        with patch(_RUNTIME, return_value=_runtime_ok()), \
             patch("plugins.image_gen.openrouter._load_image_gen_config", return_value={}), \
             patch("requests.post", return_value=_http_error(400, "invalid input_references")) as mock_post:
            result = _openrouter().generate(prompt="a pet")

        assert result["success"] is False
        assert result["error_type"] == "api_error"
        assert mock_post.call_count == 1

    def test_explicit_model_disables_fallback(self):
        """An explicit selection means 'use exactly this' — one attempt only."""
        with patch(_RUNTIME, return_value=_runtime_ok()), \
             patch("plugins.image_gen.openrouter._load_image_gen_config", return_value={}), \
             patch("requests.post", return_value=_http_error(404, "model unavailable")) as mock_post:
            result = _openrouter().generate(prompt="a pet", model=_CHAIN[0])

        assert result["success"] is False
        assert mock_post.call_count == 1


# ---------------------------------------------------------------------------
# Registration + pet integration
# ---------------------------------------------------------------------------


class TestRegistration:
    def test_register_both(self):
        from plugins.image_gen.openrouter import register

        ctx = MagicMock()
        register(ctx)
        registered = [c.args[0].name for c in ctx.register_image_gen_provider.call_args_list]
        assert set(registered) == {"openrouter", "nous"}

    def test_both_are_reference_capable_for_pets(self):
        from agent.pet.generate.imagegen import _REF_CAPABLE

        assert "openrouter" in _REF_CAPABLE
        assert "nous" in _REF_CAPABLE
