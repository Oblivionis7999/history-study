"""Isolated CI fixture. No network access to a real model provider."""
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if not body.get('max_tokens'):
            self.send_error(400); return
        data = json.dumps({'choices': [{'message': {'content': 'Isolated CI explanation'}, 'finish_reason': 'stop'}]}).encode()
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers(); self.wfile.write(data)
    def log_message(self, *args): pass

HTTPServer(('0.0.0.0', 9090), Handler).serve_forever()
