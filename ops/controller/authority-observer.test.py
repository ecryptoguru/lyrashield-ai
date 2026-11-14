import importlib.util
import json
import socket
import threading
import unittest
from pathlib import Path
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "authority_observer", Path(__file__).with_name("authority-observer.py")
)
observer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(observer)


class AuthorityObserverTest(unittest.TestCase):
    def exchange(self, request, response):
        client, server = socket.socketpair()
        with patch.object(observer, "observe", return_value=response) as observe:
            thread = threading.Thread(target=observer.handle_connection, args=(server,))
            thread.start()
            with client:
                client.sendall(request)
                client.shutdown(socket.SHUT_WR)
                try:
                    received = client.recv(9000)
                except ConnectionResetError:
                    received = b""
            thread.join(timeout=5)
            self.assertFalse(thread.is_alive())
            return received, observe.call_count

    def test_only_fixed_observation_request_returns_the_observed_identity(self):
        raw = json.dumps({"purpose": "production-installed"}).encode()
        received, calls = self.exchange(b"execution-authority\n", raw)
        self.assertEqual(received, raw + b"\n")
        self.assertEqual(calls, 1)

    def test_other_requests_cannot_invoke_the_host_observer(self):
        for request in (b"execute anything\n", b"execution-authority extra\n", b"x" * 128):
            with self.subTest(request=request):
                received, calls = self.exchange(request, b"{}")
                self.assertEqual(received, b"")
                self.assertEqual(calls, 0)

    def test_oversized_or_multiline_observations_are_not_forwarded(self):
        for response in (b"x" * 8192, b"{}\n{}"):
            with self.subTest(response=response[:10]):
                received, calls = self.exchange(b"execution-authority\n", response)
                self.assertEqual(received, b"")
                self.assertEqual(calls, 1)


if __name__ == "__main__":
    unittest.main()
