#!/usr/bin/env python3
"""Local, one-team browser feed. Uses only Python's standard library."""
import http.server
import json
import os
from pathlib import Path
import re
import signal
import sys
import time

TEAM_ID = sys.argv[1] if len(sys.argv) > 1 else ""
if not re.fullmatch(r"[a-zA-Z0-9_.-]+", TEAM_ID) or TEAM_ID in (".", ".."):
    sys.exit("invalid team-id")

root = Path(os.environ.get("COLLAB_RUNTIME_ROOT", "/tmp/ensemble")).resolve()
team = root / TEAM_ID
if not team.is_dir() or team.is_symlink() or team.resolve().parent != root:
    sys.exit("team directory missing or unsafe")
page = Path(__file__).with_name("orca-webfeed.html").read_bytes()
grace = float(os.environ.get("COLLAB_WEBFEED_GRACE_SECONDS", "20"))
limit = float(os.environ.get("COLLAB_WEBFEED_MAX_SECONDS", "86400"))


def team_file(name):
    candidate = team / name
    if candidate.is_symlink() or candidate.resolve().parent != team:
        return None
    return candidate if candidate.is_file() else None


class Feed(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/":
            body, content_type = page, "text/html; charset=utf-8"
        elif self.path == "/messages.jsonl":
            source = team_file("messages.jsonl")
            body = source.read_bytes() if source else b""
            if team_file(".finished"):
                summary = team_file("summary.txt")
                end = {"type": "webfeed-finished", "summary": summary.read_text() if summary else ""}
                body = body.rstrip(b"\n") + b"\n" + json.dumps(end).encode() + b"\n"
            content_type = "application/x-ndjson; charset=utf-8"
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format, *_args):
        pass


server = http.server.HTTPServer(("127.0.0.1", 0), Feed)
server.timeout = 0.5
pid_file = team / "webfeed.pid"
port_file = team / "webfeed.port"
pid_file.write_text(str(os.getpid()) + "\n")
port_file.write_text(str(server.server_port) + "\n")
start = time.monotonic()
finished_at = None


def stop(_signal, _frame):
    global limit
    limit = 0


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
try:
    while time.monotonic() - start < limit:
        server.handle_request()
        if team_file(".finished"):
            if finished_at is None:
                finished_at = time.monotonic()
            if time.monotonic() - finished_at >= grace:
                break
finally:
    server.server_close()
    for file in (pid_file, port_file):
        try:
            file.unlink()
        except FileNotFoundError:
            pass
