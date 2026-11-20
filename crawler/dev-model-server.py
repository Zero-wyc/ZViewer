import http.server,json
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self,*a): pass
    def do_GET(self):
        if self.path.endswith('/models'):
            body=json.dumps({"data":[{"id":"model-b","owned_by":"x"},{"id":"model-a"}]}).encode()
            self.send_response(200); self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(body))); self.end_headers(); self.wfile.write(body)
        else:
            self.send_response(404); self.end_headers()
http.server.HTTPServer(('127.0.0.1',3899),H).serve_forever()
