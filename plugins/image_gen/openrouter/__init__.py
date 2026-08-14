"""OpenRouter-compatible image generation backends (OpenRouter + Nous Portal).

Two backends, two protocols, one set of surrounding machinery.

**OpenRouter** serves image generation from a dedicated ``POST /v1/images``:
send ``model`` + ``prompt`` (plus ``aspect_ratio``, and ``input_references``
for image-to-image) and read the result from ``data[].b64_json`` alongside a
``media_type``. New image models ship there exclusively — chat-completions
image output is legacy compatibility only, which is why the previous default
here (an access-gated ``openai/`` image model reached over
``/chat/completions``) had stopped working for most accounts.

**Nous Portal** proxies OpenRouter but exposes no ``/images`` endpoint, so it
stays on the OpenAI-style ``/chat/completions`` protocol: ``modalities:
["image", "text"]`` with an image-output model, reference images as
``image_url`` content parts, and generated images read back from
``choices[0].message.images[].image_url.url``.

The two share everything that isn't the wire format — credentials, the model
chain, error mapping, saving — through three seams on the base class
(``endpoint_path``, ``_build_payload``, ``_extract_image_refs``). The parsers
normalise both protocols to ``data:`` URIs so one save step serves both.
Credentials resolve through the agent's existing
:func:`~hermes_cli.runtime_provider.resolve_runtime_provider`, which already
understands OpenRouter's key pool and the Nous OAuth device-code token, so this
plugin never reinvents auth.

Reference grounding is the reason pet sprite generation cares about this
backend: each animation row must stay the same character as the chosen base
frame, which only works on models that accept image input. Both defaults do,
so both providers advertise image-to-image support.
"""

from __future__ import annotations

import base64
import logging
import mimetypes
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

from agent.image_gen_provider import (
    DEFAULT_ASPECT_RATIO,
    ImageGenProvider,
    error_response,
    resolve_aspect_ratio,
    save_b64_image,
    save_url_image,
    success_response,
)

logger = logging.getLogger(__name__)

# Quality-first model chain for OpenRouter-compatible endpoints.
#
# Default behavior (no env/config override): highest-fidelity first, falling
# back to the faster tier when the first is access-gated / unavailable / times
# out. Both are reachable without per-account enablement, unlike the ``openai/``
# image models that previously headed this chain.
#
# Explicit override (OPENROUTER_IMAGE_MODEL, image_gen.<provider>.model, or
# image_gen.model from ``hermes tools``): use exactly that model (no auto
# fallback), so power users keep full control.
DEFAULT_MODEL = "google/gemini-3-pro-image"
_FALLBACK_MODEL = "google/gemini-3.1-flash-image"
_DEFAULT_MODEL_CHAIN = (DEFAULT_MODEL, _FALLBACK_MODEL)

# Picker rows for the default chain. Nous Portal has no catalog endpoint to
# enumerate, so this is its whole list; OpenRouter overrides it with the live
# catalog and falls back here when that fetch fails.
_STATIC_MODELS = (
    {
        "id": DEFAULT_MODEL,
        "display": "Gemini 3 Pro Image",
        "strengths": "Highest fidelity; 1K-4K; up to 14 reference images",
    },
    {
        "id": _FALLBACK_MODEL,
        "display": "Gemini 3.1 Flash Image",
        "strengths": "Faster and cheaper; adds 512px and wide/tall ratios",
    },
)

# Semantic aspect ratio (the image_gen contract) → the aspect_ratio strings both
# protocols accept. All three are in every default model's supported set.
_ASPECT_RATIOS = {
    "square": "1:1",
    "landscape": "16:9",
    "portrait": "9:16",
}

# Chat-completions image models accept up to 3 input images per prompt; clamp
# references so we never overflow the model's limit.
_MAX_REFERENCE_IMAGES = 3

# The Images API advertises input_references 0-14 on both default models.
_MAX_IMAGES_API_REFERENCES = 14

# Per single image call. The quality-first default is genuinely slow — a single
# cold row can run well past 3 minutes — so give each call real headroom before
# we treat it as hung and fall back / retry.
_REQUEST_TIMEOUT = 300.0

# media_type → file extension for saved images. Kept explicit and small: we
# never want to inherit an extension from a degenerate content type, and a
# vector model's SVG written as ".png" is silently broken for every consumer.
_MEDIA_EXTENSIONS = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/svg+xml": "svg",
}


def _load_image_gen_config() -> Dict[str, Any]:
    """Read the ``image_gen`` section from config.yaml (``{}`` on failure)."""
    try:
        from hermes_cli.config import load_config

        cfg = load_config()
        section = cfg.get("image_gen") if isinstance(cfg, dict) else None
        return section if isinstance(section, dict) else {}
    except Exception as exc:  # noqa: BLE001 - config is best-effort
        logger.debug("could not load image_gen config: %s", exc)
        return {}


def _to_image_url_part(ref: str) -> Optional[str]:
    """Turn a reference (local path or http URL) into an ``image_url`` value.

    Remote URLs pass through unchanged; local files are inlined as base64 data
    URIs so the request is self-contained (the provider endpoint can't reach a
    path on our disk). Returns ``None`` when the reference can't be read.
    """
    ref = str(ref or "").strip()
    if not ref:
        return None
    if ref.startswith(("http://", "https://", "data:")):
        return ref
    path = Path(ref)
    # Enforce the shared credential-read guard before inlining local bytes.
    from agent.file_safety import raise_if_read_blocked

    raise_if_read_blocked(ref)
    try:
        raw = path.read_bytes()
    except OSError as exc:
        logger.debug("could not read reference image %s: %s", ref, exc)
        return None
    mime = mimetypes.guess_type(path.name)[0] or "image/png"
    encoded = base64.b64encode(raw).decode("ascii")
    return f"data:{mime};base64,{encoded}"


def _extract_images(payload: Dict[str, Any]) -> List[str]:
    """Pull generated image URLs from a chat-completions response.

    OpenRouter returns generated images under
    ``choices[0].message.images[].image_url.url`` (typically a base64 data URI).
    """
    out: List[str] = []
    choices = payload.get("choices") if isinstance(payload, dict) else None
    if not isinstance(choices, list):
        return out
    for choice in choices:
        message = choice.get("message") if isinstance(choice, dict) else None
        images = message.get("images") if isinstance(message, dict) else None
        if not isinstance(images, list):
            continue
        for image in images:
            if not isinstance(image, dict):
                continue
            image_url = image.get("image_url")
            url = image_url.get("url") if isinstance(image_url, dict) else None
            if isinstance(url, str) and url.strip():
                out.append(url.strip())
    return out


def _extract_images_api_images(payload: Dict[str, Any]) -> List[str]:
    """Pull generated images from an Images API response, as ``data:`` URIs.

    The endpoint returns base64 bytes in ``data[].b64_json`` with the format in
    a sibling ``media_type`` — never a hosted URL. Re-joining them into a data
    URI lets the shared save step handle both protocols identically.
    """
    out: List[str] = []
    items = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(items, list):
        return out
    for item in items:
        if not isinstance(item, dict):
            continue
        b64 = item.get("b64_json")
        if not isinstance(b64, str) or not b64.strip():
            continue
        media = str(item.get("media_type") or "image/png").strip() or "image/png"
        out.append(f"data:{media};base64,{b64.strip()}")
    return out


def _data_uri_parts(uri: str) -> tuple[str, str]:
    """Split a ``data:`` URI into ``(base64_payload, file_extension)``.

    Falls back to ``png`` for unknown or absent media types — the historical
    behavior, and right for every raster format we'd otherwise mislabel.
    """
    header, _, payload = uri.partition(",")
    media = header[len("data:") :].split(";", 1)[0].strip().lower()
    return payload, _MEDIA_EXTENSIONS.get(media, "png")


def _access_error_hint(
    display: str, model_id: str, env_var: str, status: int, err_msg: str
) -> Optional[str]:
    """A targeted hint when an access-gated OpenAI image model can't be reached.

    Some OpenAI image models on OpenRouter need account enablement / BYOK, so the
    failure isn't a missing key (the key is valid) — the *model* is unreachable.
    The generic "check your key" message is misleading there, so we detect that
    case and point the user at the real fix. Returns one actionable line, or
    ``None`` when this isn't the access-gated case.
    """
    if not model_id.startswith("openai/"):
        return None
    low = (err_msg or "").lower()
    gated = status in (402, 403, 404) or any(
        s in low for s in ("no endpoints", "no allowed", "not a valid model", "data policy")
    )
    if not gated:
        return None
    return (
        f"{display} can't reach image model '{model_id}' ({status}) — enable OpenAI "
        f"image access in your {display} account, or set {env_var}={_FALLBACK_MODEL}."
    )


# HTTP statuses worth re-attempting on the next model in the chain. 402/403/404
# are the access-gate shapes (model not enabled, not routable, unknown here),
# 408/429 and 5xx are transient on this endpoint but not on the request itself.
_RETRYABLE_STATUSES = frozenset({402, 403, 404, 408, 429})

# Messages OpenRouter returns for "this model isn't available to you", across
# assorted statuses.
_RETRYABLE_MESSAGES = ("no endpoints", "not a valid model", "data policy")


def _should_try_next(status: int, err_msg: str) -> bool:
    """Whether an HTTP failure should advance to the next candidate model.

    Deliberately separate from :func:`_access_error_hint`, which only shapes
    the *message*: that helper is scoped to ``openai/`` models, so gating the
    retry on it would silently disable fallback for every other vendor's chain.

    ``400`` (malformed body) and ``401`` (bad credential) are identical for
    every model in the chain, so retrying them just burns a call and doubles
    the latency before the same error surfaces.
    """
    if status in (400, 401):
        return False
    if status in _RETRYABLE_STATUSES or status >= 500:
        return True
    low = (err_msg or "").lower()
    return any(s in low for s in _RETRYABLE_MESSAGES)


def _dedupe_models(models: list[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for model in models:
        m = (model or "").strip()
        if not m or m in seen:
            continue
        seen.add(m)
        out.append(m)
    return out


class OpenRouterCompatImageProvider(ImageGenProvider):
    """Image generation over an OpenRouter-compatible chat-completions endpoint.

    Instantiated once per backend (OpenRouter, Nous Portal). The two differ only
    in which runtime provider supplies ``(base_url, api_key)`` and in the config
    namespace used for the model override.

    Subclasses that speak a different image protocol override the three seams
    below — the endpoint suffix, the request body, and the response parser.
    Everything else (credentials, the model chain, error mapping, saving) is
    protocol-agnostic and inherited.
    """

    #: Appended to the resolved ``base_url`` to form the request URL.
    endpoint_path = "/chat/completions"
    #: Hard cap on reference images sent in one request.
    max_reference_images = _MAX_REFERENCE_IMAGES

    def __init__(
        self,
        *,
        provider_name: str,
        display_name: str,
        runtime_name: str,
        config_key: str,
        model_env_var: str,
        setup_schema: Dict[str, Any],
    ) -> None:
        self._name = provider_name
        self._display = display_name
        self._runtime_name = runtime_name
        self._config_key = config_key
        self._model_env_var = model_env_var
        self._setup_schema = setup_schema

    @property
    def name(self) -> str:
        return self._name

    @property
    def display_name(self) -> str:
        return self._display

    def _resolve_runtime(self) -> Dict[str, Any]:
        """Resolve ``(base_url, api_key)`` via the shared runtime resolver."""
        from hermes_cli.runtime_provider import resolve_runtime_provider

        return resolve_runtime_provider(requested=self._runtime_name)

    def is_available(self) -> bool:
        try:
            runtime = self._resolve_runtime()
        except Exception as exc:  # noqa: BLE001 - treat resolution failure as unavailable
            logger.debug("%s runtime resolution failed: %s", self._name, exc)
            return False
        return bool(str(runtime.get("api_key") or "").strip())

    def capabilities(self) -> Dict[str, Any]:
        # Both text-to-image and image-to-image (reference grounding) — the
        # latter is what makes this backend usable for pet sprite rows.
        return {
            "modalities": ["text", "image"],
            "max_reference_images": self.max_reference_images,
            # These endpoints route any model id the account can reach, and the
            # catalog moves faster than we ship — so the pickers let the user
            # type an id we've never heard of instead of rejecting it.
            "accepts_custom_model": True,
        }

    # -- protocol seams ----------------------------------------------------

    def _build_payload(
        self,
        *,
        model_id: str,
        prompt: str,
        aspect: str,
        refs: List[str],
    ) -> Dict[str, Any]:
        """Request body for one generation attempt.

        Chat-completions image output: the prompt and any reference images ride
        in a single user message's content parts, and ``modalities`` is what
        asks the model for an image back instead of text.
        """
        content: List[Dict[str, Any]] = [{"type": "text", "text": prompt}]
        for ref in refs[: self.max_reference_images]:
            part = _to_image_url_part(ref)
            if part:
                content.append({"type": "image_url", "image_url": {"url": part}})
        return {
            "model": model_id,
            "modalities": ["image", "text"],
            "messages": [{"role": "user", "content": content}],
            "image_config": {"aspect_ratio": aspect},
        }

    def _extract_image_refs(self, payload: Dict[str, Any]) -> List[str]:
        """Generated images from one response, as URLs or ``data:`` URIs."""
        return _extract_images(payload)

    def list_models(self) -> List[Dict[str, Any]]:
        return [dict(row) for row in _STATIC_MODELS]

    def default_model(self) -> Optional[str]:
        return self._resolve_model()

    def get_setup_schema(self) -> Dict[str, Any]:
        return dict(self._setup_schema)

    def _resolve_model(self, explicit: Optional[str] = None) -> str:
        """Pick the image model (first of :meth:`_resolve_model_chain`)."""
        return self._resolve_model_chain(explicit)[0]

    def _resolve_model_chain(self, explicit: Optional[str] = None) -> list[str]:
        """Ordered model attempts for this request.

        Precedence: explicit caller override (the ``model`` kwarg) → the
        provider's ``*_IMAGE_MODEL`` env override → scoped
        ``image_gen.<provider>.model`` → top-level ``image_gen.model`` (written
        by ``hermes tools``) → the quality-first default chain.

        Any explicit user/model selection means "use this exact model", so no
        fallback. Only the bare default chain carries a Gemini fallback.
        """
        if isinstance(explicit, str) and explicit.strip():
            return [explicit.strip()]
        env_override = os.environ.get(self._model_env_var, "").strip()
        if env_override:
            return [env_override]
        cfg = _load_image_gen_config()
        scoped = cfg.get(self._config_key) if isinstance(cfg.get(self._config_key), dict) else {}
        if isinstance(scoped, dict):
            value = scoped.get("model")
            if isinstance(value, str) and value.strip():
                return [value.strip()]
        top = cfg.get("model")
        if isinstance(top, str) and top.strip():
            return [top.strip()]
        return _dedupe_models(list(_DEFAULT_MODEL_CHAIN))

    def generate(
        self,
        prompt: str,
        aspect_ratio: str = DEFAULT_ASPECT_RATIO,
        *,
        image_url: Optional[str] = None,
        reference_image_urls: Optional[List[str]] = None,
        **kwargs: Any,
    ) -> Dict[str, Any]:
        import requests

        try:
            runtime = self._resolve_runtime()
        except Exception as exc:  # noqa: BLE001
            return error_response(
                error=f"Could not resolve {self._display} credentials: {exc}",
                error_type="missing_api_key",
                provider=self._name,
                aspect_ratio=aspect_ratio,
            )
        api_key = str(runtime.get("api_key") or "").strip()
        base_url = str(runtime.get("base_url") or "").strip().rstrip("/")
        if not api_key or not base_url:
            return error_response(
                error=(
                    f"No {self._display} credentials found. "
                    f"Configure {self._display} in `hermes tools` → Image Generation."
                ),
                error_type="missing_api_key",
                provider=self._name,
                aspect_ratio=aspect_ratio,
            )

        model_chain = self._resolve_model_chain(kwargs.get("model"))
        aspect = resolve_aspect_ratio(aspect_ratio)
        or_aspect = _ASPECT_RATIOS.get(aspect, "1:1")

        # Collect every reference: the pet generator passes local paths via the
        # ``reference_images`` kwarg; the generic tool surface uses ``image_url``
        # / ``reference_image_urls``. Accept all three.
        references: List[str] = []
        for ref in kwargs.get("reference_images") or []:
            references.append(str(ref))
        if image_url:
            references.append(str(image_url))
        for ref in reference_image_urls or []:
            references.append(str(ref))

        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            # OpenRouter attribution headers (harmless against Nous Portal).
            "HTTP-Referer": "https://github.com/NousResearch/hermes-agent",
            "X-Title": "Hermes Agent",
        }
        last_error: Optional[Dict[str, Any]] = None
        for i, model_id in enumerate(model_chain):
            payload = self._build_payload(
                model_id=model_id,
                prompt=prompt,
                aspect=or_aspect,
                refs=references,
            )
            is_last = i == len(model_chain) - 1
            try:
                response = requests.post(
                    f"{base_url}{self.endpoint_path}",
                    headers=headers,
                    json=payload,
                    timeout=_REQUEST_TIMEOUT,
                )
                response.raise_for_status()
            except requests.HTTPError as exc:
                resp = exc.response
                status = resp.status_code if resp is not None else 0
                try:
                    err_msg = resp.json().get("error", {}).get("message", resp.text[:300])
                except Exception:  # noqa: BLE001
                    err_msg = resp.text[:300] if resp is not None else str(exc)
                logger.error("%s image gen failed (%d) on %s: %s", self._name, status, model_id, err_msg)
                if _should_try_next(status, err_msg) and not is_last:
                    logger.info(
                        "%s model %s unavailable; retrying with fallback %s",
                        self._name,
                        model_id,
                        model_chain[i + 1],
                    )
                    continue
                hint = _access_error_hint(self._display, model_id, self._model_env_var, status, err_msg)
                last_error = error_response(
                    error=hint or f"{self._display} image generation failed ({status}): {err_msg}",
                    error_type="model_access" if hint else "api_error",
                    provider=self._name,
                    model=model_id,
                    prompt=prompt,
                    aspect_ratio=aspect,
                )
                return last_error
            except requests.Timeout:
                if not is_last:
                    logger.info(
                        "%s model %s timed out; retrying with fallback %s",
                        self._name,
                        model_id,
                        model_chain[i + 1],
                    )
                    continue
                return error_response(
                    error=f"{self._display} image generation timed out "
                    f"({int(_REQUEST_TIMEOUT)}s)",
                    error_type="timeout",
                    provider=self._name,
                    model=model_id,
                    prompt=prompt,
                    aspect_ratio=aspect,
                )
            except requests.ConnectionError as exc:
                return error_response(
                    error=f"{self._display} connection error: {exc}",
                    error_type="connection_error",
                    provider=self._name,
                    model=model_id,
                    prompt=prompt,
                    aspect_ratio=aspect,
                )

            try:
                result = response.json()
            except Exception as exc:  # noqa: BLE001
                return error_response(
                    error=f"{self._display} returned invalid JSON: {exc}",
                    error_type="invalid_response",
                    provider=self._name,
                    model=model_id,
                    prompt=prompt,
                    aspect_ratio=aspect,
                )

            images = self._extract_image_refs(result)
            if not images:
                if not is_last:
                    logger.info(
                        "%s model %s returned no image; retrying with fallback %s",
                        self._name,
                        model_id,
                        model_chain[i + 1],
                    )
                    continue
                # A response with text but no image usually means the model didn't
                # honor image output (wrong model or modalities); surface that.
                return error_response(
                    error=(
                        f"{self._display} returned no image. Ensure the model "
                        f"'{model_id}' supports image output."
                    ),
                    error_type="empty_response",
                    provider=self._name,
                    model=model_id,
                    prompt=prompt,
                    aspect_ratio=aspect,
                )

            first = images[0]
            try:
                if first.startswith("data:"):
                    b64, extension = _data_uri_parts(first)
                    saved_path = save_b64_image(
                        b64, prefix=f"{self._name}_gen", extension=extension
                    )
                else:
                    saved_path = save_url_image(first, prefix=f"{self._name}_gen")
            except Exception as exc:  # noqa: BLE001
                return error_response(
                    error=f"Could not save generated image: {exc}",
                    error_type="io_error",
                    provider=self._name,
                    model=model_id,
                    prompt=prompt,
                    aspect_ratio=aspect,
                )

            return success_response(
                image=str(saved_path),
                model=model_id,
                prompt=prompt,
                aspect_ratio=aspect,
                provider=self._name,
            )

        return last_error or error_response(
            error=f"{self._display} image generation failed after trying all candidate models.",
            error_type="api_error",
            provider=self._name,
            model=model_chain[-1] if model_chain else "",
            prompt=prompt,
            aspect_ratio=aspect,
        )


class OpenRouterImagesProvider(OpenRouterCompatImageProvider):
    """OpenRouter's dedicated Image API (``POST /v1/images``).

    Same credentials, model chain and error handling as the chat-completions
    base class — only the wire format differs.
    """

    endpoint_path = "/images"
    max_reference_images = _MAX_IMAGES_API_REFERENCES

    def _build_payload(
        self,
        *,
        model_id: str,
        prompt: str,
        aspect: str,
        refs: List[str],
    ) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "model": model_id,
            "prompt": prompt,
            "aspect_ratio": aspect,
        }
        # Reference items take the same shape as chat-completions image parts,
        # so _to_image_url_part (which inlines local files as data URIs) is
        # reused verbatim.
        parts = [
            {"type": "image_url", "image_url": {"url": url}}
            for url in (
                _to_image_url_part(ref) for ref in refs[: self.max_reference_images]
            )
            if url
        ]
        if parts:
            # Omitted entirely rather than sent empty — an empty list is a
            # different request than a text-to-image one on some providers.
            payload["input_references"] = parts
        return payload

    def _extract_image_refs(self, payload: Dict[str, Any]) -> List[str]:
        return _extract_images_api_images(payload)


def _build_providers() -> List[OpenRouterCompatImageProvider]:
    return [
        OpenRouterImagesProvider(
            provider_name="openrouter",
            display_name="OpenRouter",
            runtime_name="openrouter",
            config_key="openrouter",
            model_env_var="OPENROUTER_IMAGE_MODEL",
            setup_schema={
                "name": "OpenRouter (image)",
                "badge": "paid",
                "tag": "OpenRouter's full image catalog (Gemini, FLUX, Seedream, …); uses OPENROUTER_API_KEY",
                "env_vars": [
                    {
                        "key": "OPENROUTER_API_KEY",
                        "prompt": "OpenRouter API key",
                        "url": "https://openrouter.ai/keys",
                    }
                ],
            },
        ),
        OpenRouterCompatImageProvider(
            provider_name="nous",
            display_name="Nous Portal",
            runtime_name="nous",
            config_key="nous",
            model_env_var="NOUS_IMAGE_MODEL",
            setup_schema={
                "name": "Nous Portal (image)",
                "badge": "subscription",
                "tag": "Reference-grounded image generation via Nous Portal (OpenRouter-backed)",
                "env_vars": [],
                "requires_nous_auth": True,
            },
        ),
    ]


def register(ctx: Any) -> None:
    """Register the OpenRouter + Nous Portal image gen providers."""
    for provider in _build_providers():
        ctx.register_image_gen_provider(provider)
