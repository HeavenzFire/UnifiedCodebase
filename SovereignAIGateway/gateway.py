#!/usr/bin/env python3
"""Sovereign AI Gateway: local-only HTTP routing MVP using the Python standard library."""
import json
import logging
import os
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

HOST = os.environ.get("SAG_HOST", "127.0.0.1")
PORT = int(os.environ.get("SAG_PORT", "8765"))
OLLAMA_URL = os.environ.get("SAG_OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
OLLAMA_MODEL = os.environ.get("SAG_OLLAMA_MODEL", "llama3.2:1b")
MAX_BODY = int(os.environ.get("SAG_MAX_BODY_BYTES", "1048576"))
TIMEOUT = float(os.environ.get("SAG_TIMEOUT_SECONDS", "90"))

logging.basicConfig(level=os.environ.get("SAG_LOG_LEVEL", "INFO"),
                    format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("sovereign-gateway")


def is_loopback_http(url):
    parsed = urlparse(url)
    return parsed.scheme == "http" and (parsed.hostname or "").lower() in {
        "127.0.0.1", "localhost", "::1"
    }


def encode_json(value):
    return json.dumps(value, ensure_ascii=False).encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    server_version = "SovereignGateway/0.1"

    def log_message(self, fmt, *args):
        log.info("client=%s " + fmt, self.client_address[0], *args)

    def send_json(self, status, value):
        data = encode_json(value)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            self.send_json(200, {
                "ok": True, "service": "sovereign-ai-gateway", "version": "0.1.0",
                "routing": "local-only", "upstream_url_valid": is_loopback_http(OLLAMA_URL),
                "model": OLLAMA_MODEL
            })
        elif self.path == "/v1/providers":
            self.send_json(200, {
                "providers": [{"id": "ollama-local", "kind": "local",
                               "enabled": is_loopback_http(OLLAMA_URL), "model": OLLAMA_MODEL}],
                "cloud_fallback": False,
                "policy": "No implicit cloud routing or fallback."
            })
        else:
            self.send_json(404, {"error": {"type": "not_found", "message": "not found"}})

    def do_POST(self):
        if self.path != "/v1/chat/completions":
            self.send_json(404, {"error": {"type": "not_found", "message": "not found"}})
            return
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            self.send_json(411, {"error": {"type": "invalid_request",
                                           "message": "valid Content-Length required"}})
            return
        if length < 1 or length > MAX_BODY:
            self.send_json(413, {"error": {"type": "request_too_large",
                                           "message": "request body size rejected"}})
            return
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self.send_json(400, {"error": {"type": "invalid_request", "message": "invalid JSON"}})
            return

        messages = body.get("messages") if isinstance(body, dict) else None
        if not isinstance(messages, list) or not messages:
            self.send_json(400, {"error": {"type": "invalid_request",
                                           "message": "messages must be a non-empty array"}})
            return
        normalized = []
        for item in messages:
            if (not isinstance(item, dict)
                    or item.get("role") not in {"system", "user", "assistant"}
                    or not isinstance(item.get("content"), str)):
                self.send_json(400, {"error": {"type": "invalid_request",
                                               "message": "each message needs role and string content"}})
                return
            normalized.append({"role": item["role"], "content": item["content"]})

        if not is_loopback_http(OLLAMA_URL):
            self.send_json(503, {"error": {"type": "policy_block",
                                           "message": "upstream must be loopback HTTP"}})
            return

        request_id = str(uuid.uuid4())
        payload = encode_json({"model": OLLAMA_MODEL, "messages": normalized, "stream": False})
        req = Request(OLLAMA_URL + "/api/chat", data=payload,
                      headers={"Content-Type": "application/json"}, method="POST")
        started = time.monotonic()
        try:
            with urlopen(req, timeout=TIMEOUT) as response:
                upstream = json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:
            self.send_json(502, {"error": {"type": "upstream_error",
                                           "message": "local provider returned an error",
                                           "status": exc.code}, "request_id": request_id})
            return
        except (URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
            log.warning("request_id=%s upstream_failure=%s", request_id, type(exc).__name__)
            self.send_json(503, {"error": {"type": "provider_unavailable",
                                           "message": "local model provider unavailable"},
                                 "request_id": request_id})
            return

        answer = upstream.get("message", {}).get("content") if isinstance(upstream, dict) else None
        if not isinstance(answer, str):
            self.send_json(502, {"error": {"type": "upstream_error",
                                           "message": "unexpected local provider response"},
                                 "request_id": request_id})
            return
        elapsed = int((time.monotonic() - started) * 1000)
        log.info("request_id=%s outcome=success elapsed_ms=%d message_count=%d",
                 request_id, elapsed, len(normalized))
        self.send_json(200, {
            "id": "chatcmpl-" + request_id, "object": "chat.completion",
            "created": int(time.time()), "model": OLLAMA_MODEL,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": answer},
                         "finish_reason": "stop"}],
            "usage": {"prompt_tokens": None, "completion_tokens": None, "total_tokens": None},
            "sovereign_gateway": {"request_id": request_id, "elapsed_ms": elapsed,
                                  "provider": "ollama-local"}
        })


def main():
    if not is_loopback_http(OLLAMA_URL):
        log.error("SAG_OLLAMA_URL must be loopback HTTP; refusing startup")
        raise SystemExit(2)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    log.info("listening=http://%s:%d provider=ollama-local model=%s", HOST, PORT, OLLAMA_MODEL)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("shutdown requested")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
