import json
import os
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, urlopen
from urllib.error import HTTPError

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
import gateway


class FakeProvider(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length))
        data = json.dumps({"message": {"content": "fake response: " +
                                       body["messages"][-1]["content"]}}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


class GatewayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fake = ThreadingHTTPServer(("127.0.0.1", 0), FakeProvider)
        threading.Thread(target=cls.fake.serve_forever, daemon=True).start()
        cls.old_url = gateway.OLLAMA_URL
        gateway.OLLAMA_URL = "http://127.0.0.1:%d" % cls.fake.server_address[1]
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), gateway.Handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = "http://127.0.0.1:%d" % cls.server.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.fake.shutdown()
        cls.server.server_close()
        cls.fake.server_close()
        gateway.OLLAMA_URL = cls.old_url

    def get_json(self, path):
        with urlopen(self.base + path) as response:
            return response.status, json.loads(response.read())

    def test_health(self):
        status, body = self.get_json("/health")
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(body["routing"], "local-only")

    def test_no_cloud_fallback(self):
        _, body = self.get_json("/v1/providers")
        self.assertFalse(body["cloud_fallback"])
        self.assertEqual(body["providers"][0]["kind"], "local")

    def test_chat_routes_to_local_provider(self):
        data = json.dumps({"messages": [{"role": "user", "content": "hello"}]}).encode()
        request = Request(self.base + "/v1/chat/completions", data=data,
                          headers={"Content-Type": "application/json"})
        with urlopen(request) as response:
            status, body = response.status, json.loads(response.read())
        self.assertEqual(status, 200)
        self.assertEqual(body["choices"][0]["message"]["content"], "fake response: hello")
        self.assertEqual(body["sovereign_gateway"]["provider"], "ollama-local")

    def test_empty_messages_rejected(self):
        data = json.dumps({"messages": []}).encode()
        request = Request(self.base + "/v1/chat/completions", data=data,
                          headers={"Content-Type": "application/json"})
        with self.assertRaises(HTTPError) as ctx:
            urlopen(request)
        self.assertEqual(ctx.exception.code, 400)

    def test_unknown_route_rejected(self):
        with self.assertRaises(HTTPError) as ctx:
            urlopen(self.base + "/missing")
        self.assertEqual(ctx.exception.code, 404)


if __name__ == "__main__":
    unittest.main()
