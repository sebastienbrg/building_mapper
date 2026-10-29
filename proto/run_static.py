#!/usr/bin/env python3
"""
TeZeLoMa Local Static App Server
================================
Zero-dependency local runner to test the static app and data chunks.
Run:
    python3 proto/run_static.py
"""

import http.server
import socketserver
import webbrowser
from pathlib import Path

PORT = 8080
ROOT_DIR = Path(__file__).resolve().parent.parent


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT_DIR), **kwargs)

    def end_headers(self):
        # Enable CORS and Range headers for local testing
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Range, Content-Type")
        super().end_headers()

    def guess_type(self, path):
        if path.endswith(".parquet"):
            return "application/octet-stream"
        if path.endswith(".json") or path.endswith(".webmanifest"):
            return "application/json"
        return super().guess_type(path)


def main():
    with socketserver.TCPServer(("", PORT), Handler) as httpd:
        url = f"http://localhost:{PORT}/proto/static_app/index.html"
        print(f"\nTeZeLoMa Static App running at: {url}")
        print("Press Ctrl+C to stop.\n")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down server.")


if __name__ == "__main__":
    main()
