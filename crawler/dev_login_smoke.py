import threading, http.server, socketserver, tempfile, os, json
from engine.browser import BrowserController
from engine.accounts import AccountStore

class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body=b"<html><body><h1>ok</h1></body></html>"
        self.send_response(200)
        self.send_header("Content-Type","text/html")
        self.send_header("Set-Cookie","sid=abc; Path=/")
        self.end_headers(); self.wfile.write(body)
    def log_message(self,*a): pass

srv=socketserver.TCPServer(("127.0.0.1",0),H)
port=srv.server_address[1]
threading.Thread(target=srv.serve_forever,daemon=True).start()
tmp=tempfile.mkdtemp(prefix="br-")
accounts=AccountStore(os.path.join(tmp,"accounts.json"))
bc=BrowserController({"debug_port":9341,"profile_dir":os.path.join(tmp,"profile")}, tmp)
try:
    page=bc.open("http://127.0.0.1:%d/"%port)
    print("page", page.get("title"), page.get("ready"))
    out=bc.save_login("127.0.0.1", "local", accounts)
    print("saved", out["cookieCount"], out["account"].get("name"), "cookies" in out["account"] and out["account"].get("cookies"))
    print("running_after", bc.status()["running"])
finally:
    bc.close(); srv.shutdown()
