#!/usr/bin/env python3
"""Stand-in for the skydeck local server. Binds 127.0.0.1 only. Never starts claude.

GET  /          the key-test page
GET  /ping      {t, boot_id, uptime_s, pid}  (the page polls this once a second)
POST /log       appends one JSON line to keylog.jsonl next to this file
Run:  python3 serve.py [port]      (default 8765)
"""
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
LOG = os.path.join(HERE, "keylog.jsonl")
STATIC = {"/": ("keytest.html", "text/html; charset=utf-8"),
          "/keytest.js": ("keytest.js", "text/javascript; charset=utf-8")}


def read_first(path, default=""):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return default


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path in STATIC:
            name, ctype = STATIC[path]
            with open(os.path.join(HERE, name), "rb") as f:
                return self._send(200, f.read(), ctype)
        if path == "/ping":
            up = float(read_first("/proc/uptime", "0 0").split()[0])
            body = json.dumps({"t": time.time(),
                               "boot_id": read_first("/proc/sys/kernel/random/boot_id"),
                               "uptime_s": up, "pid": os.getpid()}).encode()
            return self._send(200, body, "application/json")
        return self._send(404, b"not found", "text/plain")

    def do_POST(self):
        if self.path != "/log":
            return self._send(404, b"not found", "text/plain")
        n = min(int(self.headers.get("Content-Length", "0") or 0), 65536)
        raw = self.rfile.read(n)
        try:
            entry = json.loads(raw)
        except ValueError:
            return self._send(400, b"bad json", "text/plain")
        entry["server_t"] = time.time()
        entry["peer"] = self.client_address[0]
        with open(LOG, "a") as f:
            f.write(json.dumps(entry) + "\n")
        return self._send(204, b"", "text/plain")

    def log_message(self, fmt, *args):  # keep the terminal quiet except for /log
        if self.path == "/log":
            sys.stdout.write("log %s\n" % (self.log_date_time_string(),))
            sys.stdout.flush()


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print("listening on http://127.0.0.1:%d/  (pid %d), log: %s" % (PORT, os.getpid(), LOG))
    srv.serve_forever()
