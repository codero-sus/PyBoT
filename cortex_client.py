"""Small OpenAI-compatible client for a local Cortex LLMHoster instance.

PyBoT talks to Cortex over its public HTTP API; Cortex source and runtime are
installed and managed separately.
"""

from __future__ import annotations

import json
import os
import socket
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, urlunsplit
from urllib.request import Request, urlopen


DEFAULT_BASE_URL = "http://127.0.0.1:8624/v1"
DEFAULT_TIMEOUT_SECONDS = 180.0
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MODEL_CACHE_SECONDS = 30.0


class CortexClientError(RuntimeError):
    """A bounded, safe-to-display description of a Cortex API failure."""

    def __init__(self, message: str, *, kind: str = "unavailable", status: int | None = None):
        super().__init__(message)
        self.kind = kind
        self.status = status


class CortexClient:
    """Call Cortex's OpenAI-compatible ``/chat/completions`` endpoint."""

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        model: str = "",
        api_key: str = "",
        enabled: bool = True,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        self.base_url = self._validate_base_url(base_url)
        self.model = model.strip()[:160]
        self.api_key = api_key.strip()
        self.enabled = enabled
        self.timeout = max(1.0, min(float(timeout), 600.0))
        self._models_cache: tuple[float, list[dict[str, object]]] | None = None
        self._model_lock = threading.Lock()
        self._status_cache: tuple[float, dict[str, object]] | None = None
        self._status_lock = threading.Lock()

    @classmethod
    def from_environment(cls) -> "CortexClient":
        enabled_value = os.environ.get("PYBOT_CORTEX_ENABLED", "true").strip().lower()
        enabled = enabled_value not in {"0", "false", "no", "off", "disabled"}
        raw_timeout = os.environ.get("PYBOT_CORTEX_TIMEOUT_SECONDS", str(DEFAULT_TIMEOUT_SECONDS))
        try:
            timeout = float(raw_timeout)
        except (TypeError, ValueError):
            timeout = DEFAULT_TIMEOUT_SECONDS
        return cls(
            base_url=os.environ.get("PYBOT_CORTEX_BASE_URL", DEFAULT_BASE_URL),
            model=os.environ.get("PYBOT_CORTEX_MODEL", ""),
            api_key=os.environ.get("CORTEX_API_KEY", ""),
            enabled=enabled,
            timeout=timeout,
        )

    @staticmethod
    def _validate_base_url(value: str) -> str:
        try:
            parsed = urlsplit(value.strip())
            _ = parsed.port  # Force validation of malformed ports.
        except (AttributeError, ValueError) as exc:
            raise ValueError("PYBOT_CORTEX_BASE_URL must be a valid HTTP(S) URL.") from exc
        if (
            parsed.scheme.lower() not in {"http", "https"}
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
            or "\\" in parsed.path
            or any(part in {".", ".."} for part in parsed.path.split("/"))
        ):
            raise ValueError("PYBOT_CORTEX_BASE_URL must be a safe HTTP(S) API base URL without credentials or query parameters.")
        return urlunsplit((parsed.scheme.lower(), parsed.netloc, parsed.path.rstrip("/"), "", ""))

    @property
    def _headers(self) -> dict[str, str]:
        headers = {
            "Accept": "application/json",
            "User-Agent": "PyBoT/1.0 Cortex client",
        }
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    def _request_json(
        self,
        url: str,
        body: dict[str, object] | None = None,
        *,
        timeout: float | None = None,
    ) -> dict[str, object]:
        data = None
        headers = self._headers
        if body is not None:
            data = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = Request(url, data=data, headers=headers, method="POST" if data is not None else "GET")
        try:
            with urlopen(request, timeout=self.timeout if timeout is None else timeout) as response:
                raw = response.read(MAX_RESPONSE_BYTES + 1)
        except HTTPError as exc:
            status = exc.code
            exc.close()
            if status == 401:
                raise CortexClientError("Cortex rejected the local API key.", kind="authentication", status=status) from None
            if status == 404:
                raise CortexClientError("Cortex could not find the configured model or API route.", kind="not_found", status=status) from None
            if status == 503:
                raise CortexClientError("The Cortex model is not ready yet.", kind="not_ready", status=status) from None
            raise CortexClientError("Cortex returned an unsuccessful response.", kind="http_error", status=status) from None
        except (TimeoutError, socket.timeout):
            raise CortexClientError("Cortex did not respond before the request timeout.", kind="timeout") from None
        except URLError as exc:
            reason = exc.reason
            if isinstance(reason, (TimeoutError, socket.timeout)):
                raise CortexClientError("Cortex did not respond before the request timeout.", kind="timeout") from None
            raise CortexClientError("Cortex LLMHoster is unreachable.", kind="unavailable") from None
        except OSError:
            raise CortexClientError("Cortex LLMHoster is unreachable.", kind="unavailable") from None

        if len(raw) > MAX_RESPONSE_BYTES:
            raise CortexClientError("Cortex returned an oversized response.", kind="invalid_response")
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise CortexClientError("Cortex returned invalid JSON.", kind="invalid_response") from None
        if not isinstance(payload, dict):
            raise CortexClientError("Cortex returned an invalid response.", kind="invalid_response")
        return payload

    def list_models(self) -> list[dict[str, object]]:
        """Return cached Cortex text-generation models for the model picker."""
        now = time.monotonic()
        with self._model_lock:
            if self._models_cache and now - self._models_cache[0] < MODEL_CACHE_SECONDS:
                return [dict(model) for model in self._models_cache[1]]
            payload = self._request_json(f"{self.base_url}/models", timeout=min(self.timeout, 10.0))
            raw_models = payload.get("data")
            if not isinstance(raw_models, list):
                raise CortexClientError("Cortex returned an invalid model list.", kind="invalid_response")
            available: list[dict[str, object]] = []
            seen: set[str] = set()
            for item in raw_models:
                if not isinstance(item, dict):
                    continue
                model_id = item.get("id")
                capabilities = item.get("capabilities")
                if not isinstance(model_id, str) or not model_id.strip():
                    continue
                model_id = model_id.strip()[:160]
                if model_id in seen:
                    continue
                if isinstance(capabilities, list) and "text_generation" not in capabilities:
                    continue
                safe_capabilities = [value[:64] for value in capabilities if isinstance(value, str)][:16] if isinstance(capabilities, list) else []
                available.append({"id": model_id, "capabilities": safe_capabilities})
                seen.add(model_id)
            if not available:
                raise CortexClientError("Cortex has no text-generation model configured.", kind="no_model")
            self._models_cache = (time.monotonic(), available)
            return [dict(model) for model in available]

    def _resolve_model(self, requested: str | None = None) -> str:
        if requested is not None:
            requested = requested.strip()[:160]
            if not requested:
                raise CortexClientError("The selected model ID is empty.", kind="not_found")
            available = self.list_models()
            if not any(model["id"] == requested for model in available):
                raise CortexClientError("Cortex does not have that text model available.", kind="not_found")
            return requested
        if self.model:
            return self.model
        available = self.list_models()
        return str(available[0]["id"])

    def chat(self, messages: list[dict[str, str]], model: str | None = None) -> tuple[str, str]:
        """Return the assistant text and selected Cortex model ID."""
        if not self.enabled:
            raise CortexClientError("Cortex integration is disabled.", kind="disabled")
        model = self._resolve_model(model)
        payload = self._request_json(
            f"{self.base_url}/chat/completions",
            {"model": model, "messages": messages, "stream": False},
        )
        choices = payload.get("choices")
        if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
            raise CortexClientError("Cortex returned no assistant message.", kind="invalid_response")
        message = choices[0].get("message")
        if not isinstance(message, dict):
            raise CortexClientError("Cortex returned no assistant message.", kind="invalid_response")
        content = message.get("content")
        if isinstance(content, str):
            reply = content.strip()
        elif isinstance(content, list):
            reply = "\n".join(
                part["text"].strip()
                for part in content
                if isinstance(part, dict) and isinstance(part.get("text"), str) and part["text"].strip()
            )
        else:
            reply = ""
        if not reply:
            raise CortexClientError("Cortex returned an empty assistant message.", kind="invalid_response")
        return reply[:4000], model

    def status(self) -> dict[str, object]:
        """Return a short, cached readiness snapshot without exposing secrets."""
        if not self.enabled:
            return {"enabled": False, "reachable": False, "ready": False, "model": self.model}
        now = time.monotonic()
        with self._status_lock:
            if self._status_cache and now - self._status_cache[0] < 5.0:
                return dict(self._status_cache[1])
            parsed = urlsplit(self.base_url)
            origin = f"{parsed.scheme}://{parsed.netloc}"
            reachable = False
            ready = False
            try:
                health = self._request_json(f"{origin}/health", timeout=min(self.timeout, 0.8))
                reachable = health.get("status") == "ok"
            except CortexClientError:
                pass
            if reachable:
                try:
                    readiness = self._request_json(f"{origin}/ready", timeout=min(self.timeout, 0.8))
                    ready = readiness.get("status") == "ready"
                except CortexClientError:
                    ready = False
            status: dict[str, object] = {
                "enabled": True,
                "reachable": reachable,
                "ready": ready,
                "model": self.model or "",
            }
            self._status_cache = (time.monotonic(), status)
            return dict(status)
