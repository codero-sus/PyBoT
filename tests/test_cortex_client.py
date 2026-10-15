import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from cortex_client import CortexClient, CortexClientError


class FakeCortexHandler(BaseHTTPRequestHandler):
    def _send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler API
        if self.path == "/v1/models":
            self.server.model_requests += 1
            self._send_json(200, {"object": "list", "data": self.server.models})
        elif self.path == "/health":
            self._send_json(200, {"status": "ok"})
        elif self.path == "/ready":
            status = 200 if self.server.ready else 503
            self._send_json(status, {"status": "ready" if self.server.ready else "not_ready"})
        else:
            self._send_json(404, {"error": "not found"})

    def do_POST(self):  # noqa: N802 - BaseHTTPRequestHandler API
        self.server.chat_requests += 1
        self.server.authorization = self.headers.get("Authorization")
        self.server.chat_body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self._send_json(200, {
            "choices": [{"message": {"role": "assistant", "content": self.server.reply}}],
        })

    def log_message(self, format_string, *args):
        pass


class CortexClientTests(unittest.TestCase):
    def setUp(self):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), FakeCortexHandler)
        self.server.models = [
            {"id": "embed-local", "capabilities": ["embeddings"]},
            {"id": "chat-local", "capabilities": ["text_generation"]},
        ]
        self.server.ready = True
        self.server.reply = "Cortex says hello."
        self.server.model_requests = 0
        self.server.chat_requests = 0
        self.server.authorization = None
        self.server.chat_body = None
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_port}/v1"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def test_chat_uses_openai_compatible_route_and_local_bearer_key(self):
        client = CortexClient(self.base_url, model="chat-local", api_key="local-secret")
        reply, model = client.chat([{"role": "user", "content": "Hello"}])
        self.assertEqual(reply, "Cortex says hello.")
        self.assertEqual(model, "chat-local")
        self.assertEqual(self.server.authorization, "Bearer local-secret")
        self.assertEqual(self.server.chat_body["model"], "chat-local")
        self.assertFalse(self.server.chat_body["stream"])
        self.assertEqual(self.server.model_requests, 0)

    def test_auto_selection_uses_a_text_generation_model_and_caches_it(self):
        client = CortexClient(self.base_url)
        client.chat([{"role": "user", "content": "First prompt"}])
        client.chat([{"role": "user", "content": "Second prompt"}])
        self.assertEqual(self.server.chat_requests, 2)
        self.assertEqual(self.server.model_requests, 1)
        self.assertEqual(self.server.chat_body["model"], "chat-local")

    def test_model_list_without_text_generation_is_reported(self):
        self.server.models = [{"id": "embed-local", "capabilities": ["embeddings"]}]
        client = CortexClient(self.base_url)
        with self.assertRaises(CortexClientError) as raised:
            client.chat([{"role": "user", "content": "Hello"}])
        self.assertEqual(raised.exception.kind, "no_model")

    def test_model_picker_lists_text_models_and_rejects_other_capabilities(self):
        client = CortexClient(self.base_url)
        self.assertEqual(client.list_models(), [{"id": "chat-local", "capabilities": ["text_generation"]}])
        reply, selected = client.chat([{"role": "user", "content": "Hello"}], model="chat-local")
        self.assertEqual((reply, selected), ("Cortex says hello.", "chat-local"))
        with self.assertRaises(CortexClientError) as raised:
            client.chat([{"role": "user", "content": "Hello"}], model="embed-local")
        self.assertEqual(raised.exception.kind, "not_found")
        self.assertEqual(self.server.chat_requests, 1)

    def test_status_checks_hoster_liveness_and_model_readiness(self):
        client = CortexClient(self.base_url, model="chat-local")
        status = client.status()
        self.assertTrue(status["enabled"])
        self.assertTrue(status["reachable"])
        self.assertTrue(status["ready"])
        self.server.ready = False
        client._status_cache = None
        status = client.status()
        self.assertTrue(status["reachable"])
        self.assertFalse(status["ready"])

    def test_invalid_base_url_is_rejected(self):
        with self.assertRaises(ValueError):
            CortexClient("file:///tmp/model")
        with self.assertRaises(ValueError):
            CortexClient("http://user:secret@127.0.0.1:8624/v1")


if __name__ == "__main__":
    unittest.main()
