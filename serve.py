#!/usr/bin/env python3
"""Un serveur statique pour Lapse, si file:// coince.

   python3 serve.py          puis http://localhost:8000
   python3 serve.py 3000     pour choisir le port
"""
import http.server
import os
import socket
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000


class Server(socketserver.TCPServer):
    # Double pile : localhost resout parfois en ::1 avant 127.0.0.1.
    address_family = socket.AF_INET6 if socket.has_ipv6 else socket.AF_INET
    allow_reuse_address = True

    def server_bind(self):
        if self.address_family == socket.AF_INET6:
            self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        socketserver.TCPServer.server_bind(self)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=os.path.dirname(os.path.abspath(__file__)), **kw)

    def end_headers(self):
        # Pas de cache : on veut voir ses modifications tout de suite.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    with Server(("", PORT), Handler) as httpd:
        print("Lapse sur http://localhost:%d  (Ctrl+C pour arrêter)" % PORT)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("")
