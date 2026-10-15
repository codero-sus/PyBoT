"""Dependency-free HTTP server for the PyBoT web app."""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

from assistant import respond
from cortex_client import CortexClient, CortexClientError


ROOT = Path(__file__).resolve().parent
CORTEX = CortexClient.from_environment()
MAX_HISTORY_MESSAGES = 12
MAX_HISTORY_MESSAGE_CHARS = 2000
STATIC_DIR = ROOT / "static"
MAX_REQUEST_BYTES = 256 * 1024


def _cortex_messages(message: str, language: str, history: object = None, context: object = None) -> list[dict[str, str]]:
    """Build a small, role-filtered OpenAI-style conversation for Cortex."""
    language_code = language.strip()[:20] if isinstance(language, str) and language.strip() else "en"
    system = (
        "You are PyBoT, a helpful personal assistant. Reply in the user's selected "
        f"language (BCP-47 language code: {language_code}). Be clear and concise, "
        "and be honest when a request needs information or tools you do not have."
    )
    if isinstance(context, dict):
        local_values = []
        for key, label in (("date", "User's local date"), ("time", "User's local time")):
            value = context.get(key)
            if isinstance(value, str):
                value = " ".join(value.split())[:80]
                if value:
                    local_values.append(f"{label}: {value}")
        if local_values:
            system += "\n" + "\n".join(local_values)

    messages = [{"role": "system", "content": system}]
    if isinstance(history, list):
        for item in history[-MAX_HISTORY_MESSAGES:]:
            if not isinstance(item, dict):
                continue
            role = item.get("role")
            content = item.get("content")
            if not isinstance(role, str) or role not in {"user", "assistant"} or not isinstance(content, str):
                continue
            content = content.strip()[:MAX_HISTORY_MESSAGE_CHARS]
            if content:
                messages.append({"role": role, "content": content})
    messages.append({"role": "user", "content": message[:2000]})
    return messages


class PyBotHandler(BaseHTTPRequestHandler):
    server_version = "PyBoT/1.0"
    protocol_version = "HTTP/1.1"

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        request_path = unquote(urlsplit(self.path).path)
        if request_path == "/api/health":
            cortex_status = CORTEX.status()
            self._send_json(200, {
                "name": "PyBoT",
                "status": "ok",
                "mode": "cortex" if cortex_status["ready"] else "local-fallback",
                "cortex": cortex_status,
            })
            return
        if request_path == "/api/models":
            if not CORTEX.enabled:
                self._send_json(200, {"enabled": False, "models": [], "selected": ""})
                return
            try:
                models = CORTEX.list_models()
            except CortexClientError:
                self._send_json(503, {"error": "Cortex model list is unavailable."})
                return
            model_ids = [str(model["id"]) for model in models]
            selected = CORTEX.model if CORTEX.model in model_ids else model_ids[0]
            self._send_json(200, {"enabled": True, "models": models, "selected": selected})
            return
        if request_path.startswith("/api/"):
            self._send_json(404, {"error": "Unknown API endpoint."})
            return
        if request_path == "/":
            request_path = "/index.html"
        self._serve_static(request_path)

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        request_path = urlsplit(self.path).path
        if request_path != "/api/chat":
            self._send_json(404, {"error": "Unknown API endpoint."})
            return

        try:
            raw_length = self.headers.get("Content-Length", "0")
            length = int(raw_length)
        except (ValueError, TypeError):
            self._send_json(400, {"error": "Invalid request length."})
            return
        if length <= 0:
            self._send_json(400, {"error": "A JSON request body is required."})
            return
        if length > MAX_REQUEST_BYTES:
            self._send_json(413, {"error": "Request is too large."})
            return

        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._send_json(400, {"error": "Request body must be valid JSON."})
            return
        if not isinstance(payload, dict):
            self._send_json(400, {"error": "Request body must be a JSON object."})
            return

        message = payload.get("message")
        if not isinstance(message, str) or not message.strip():
            self._send_json(400, {"error": "Enter a message before sending."})
            return
        if len(message) > 2000:
            self._send_json(413, {"error": "Messages are limited to 2,000 characters."})
            return

        language = payload.get("language", "en")
        if not isinstance(language, str) or not re.fullmatch(r"[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?", language):
            language = "en"

        # Custom locale values are display strings, never executable code. Pass
        # through only the small set of response templates used by the engine.
        raw_translations = payload.get("translations")
        translations = {}
        if isinstance(raw_translations, dict):
            translations = {
                key: value
                for key, value in raw_translations.items()
                if isinstance(key, str)
                and key.startswith("response.")
                and isinstance(value, str)
                and len(value) <= 2000
            }

        result = respond(
            message=message.strip(),
            language=language,
            context=payload.get("context"),
            translations=translations,
            commands=payload.get("commands"),
        )
        if result.get("intent") == "unknown" and CORTEX.enabled:
            try:
                messages = _cortex_messages(
                    message=message.strip(),
                    language=language,
                    history=payload.get("history"),
                    context=payload.get("context"),
                )
                raw_model = payload.get("model")
                selected_model = raw_model.strip()[:160] if isinstance(raw_model, str) and raw_model.strip() else None
                reply, model = CORTEX.chat(messages, selected_model)
                result = {"reply": reply, "intent": "cortex", "provider": "cortex", "model": model}
            except CortexClientError:
                # Preserve the deterministic offline assistant if Cortex is
                # stopped, still loading a model, or not fully configured.
                result["provider"] = "local-fallback"
                result["provider_warning"] = "toast.cortexUnavailable"
        result["timestamp"] = datetime.now(timezone.utc).isoformat()
        self._send_json(200, result)

    def do_HEAD(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        request_path = unquote(urlsplit(self.path).path)
        if request_path == "/":
            request_path = "/index.html"
        try:
            target = self._static_target(request_path)
            content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
            self.send_response(200)
            self.send_header("Content-Type", f"{content_type}; charset=utf-8")
            self.send_header("Content-Length", str(target.stat().st_size))
            self._security_headers()
            self.end_headers()
        except (FileNotFoundError, ValueError):
            self.send_error(404)

    def _serve_static(self, request_path: str) -> None:
        try:
            target = self._static_target(request_path)
            body = target.read_bytes()
        except (FileNotFoundError, IsADirectoryError, ValueError):
            self._send_json(404, {"error": "Page not found."})
            return

        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if content_type.startswith("text/") or content_type in {"application/javascript", "application/json"}:
            content_type += "; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self._security_headers()
        self.end_headers()
        self.wfile.write(body)

    @staticmethod
    def _static_target(request_path: str) -> Path:
        if not request_path.startswith("/") or "\\" in request_path:
            raise ValueError("Invalid path")
        relative = request_path.lstrip("/")
        parts = Path(relative).parts
        if not parts or any(part in {".", ".."} or part.startswith(".") for part in parts):
            raise ValueError("Invalid path")
        target = (STATIC_DIR / relative).resolve()
        if os.path.commonpath((str(STATIC_DIR.resolve()), str(target))) != str(STATIC_DIR.resolve()):
            raise ValueError("Invalid path")
        if not target.is_file():
            raise FileNotFoundError(relative)
        return target

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._security_headers()
        self.end_headers()
        self.wfile.write(body)

    def _security_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("Permissions-Policy", "microphone=(self)")

    def log_message(self, format_string: str, *args: object) -> None:
        # Keep a compact access log while avoiding printing request bodies.
        super().log_message(format_string, *args)


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the local PyBoT assistant web app.")
    parser.add_argument("--host", default=os.environ.get("HOST", "0.0.0.0"), help="Host interface to bind (default: 0.0.0.0).")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8000")), help="Port to listen on (default: 8000).")
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), PyBotHandler)
    server.daemon_threads = True
    mode = "Cortex LLMHoster enabled" if CORTEX.enabled else "local assistant only"
    print(f"PyBoT is ready at http://{args.host}:{args.port} ({mode})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping PyBoT…", flush=True)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
