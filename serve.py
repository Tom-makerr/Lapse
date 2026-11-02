#!/usr/bin/env python3
"""Petit serveur local pour essayer Lapse sans rien installer.

    python3 serve.py          # http://localhost:8000
    python3 serve.py 3000     # autre port

Un simple double-clic sur index.html suffit la plupart du temps, mais certains
navigateurs refusent IndexedDB sur file:// — d'où ce serveur.
"""
import http.server
import os
import socket
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
os.chdir(os.path.dirname(os.path.abspath(__file__)))


class Server(socketserver.TCPServer):
    allow_reuse_address = True
    address_family = socket.AF_INET6

    def server_bind(self):
        # Répondre aussi bien sur ::1 que sur 127.0.0.1.
        try:
            self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        except OSError:
            pass
        socketserver.TCPServer.server_bind(self)


with Server(("::", PORT), http.server.SimpleHTTPRequestHandler) as httpd:
    print("Lapse sur http://localhost:%d  (Ctrl+C pour arrêter)" % PORT)
    httpd.serve_forever()
