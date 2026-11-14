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
    def test_worker_operation_requests_are_fixed_bounded_and_worker_only(self):
        requests = (
            {"schema": 1, "method": "inventory"},
            {"schema": 1, "method": "inventory", "cursor": "operation-fixed"},
            {"schema": 1, "method": "result-proof", "operationId": "operation-fixed"},
            {"schema": 1, "method": "cleanup-authority"},
            {"schema": 1, "method": "cleanup-inventory"},
            {"schema": 1, "method": "cleanup-inventory", "cursor": "operation-fixed"},
            {
                "schema": 1,
                "method": "result-proof",
                "operationId": "operation-fixed",
                "path": "/etc",
            },
            {"schema": True, "method": "inventory"},
            {"schema": 1, "method": "result-proof", "operationId": "../escape"},
            {"schema": 1, "method": "cleanup-authority", "cursor": "operation-fixed"},
            {"schema": 1, "method": "cleanup-inventory", "operationId": "operation-fixed"},
            {"schema": 1, "method": "cleanup-result-proof", "operationId": "operation-fixed"},
            {"schema": 1, "method": "cleanup-inventory", "cursor": "../escape"},
        )
        for index, parsed in enumerate(requests):
            for worker in (False, True):
                client, server = socket.socketpair()
                peer = (213, 11004, 11004)
                with (
                    patch.object(
                        observer, "observe_worker", return_value=b"{}"
                    ) as called,
                    patch.object(observer, "connection_peer", return_value=peer),
                ):
                    thread = threading.Thread(
                        target=observer.handle_connection, args=(server, False, worker)
                    )
                    thread.start()
                    with client:
                        client.sendall(json.dumps(parsed).encode() + b"\n")
                        try:
                            received = client.recv(32768)
                        except ConnectionResetError:
                            received = b""
                    thread.join()
                    if worker and index < 6:
                        called.assert_called_once_with(peer, parsed)
                        self.assertEqual(received, b"{}\n")
                    else:
                        called.assert_not_called()
                        self.assertEqual(received, b"")

    def test_worker_request_is_only_available_on_the_worker_socket(self):
        for worker in (False, True):
            client, server = socket.socketpair()
            peer = (213, 11004, 11004)
            with (
                patch.object(observer, "observe") as production,
                patch.object(
                    observer,
                    "observe_worker",
                    return_value=b'{"purpose":"production-worker-installed"}',
                ) as observed,
                patch.object(observer, "connection_peer", return_value=peer),
            ):
                thread = threading.Thread(
                    target=observer.handle_connection, args=(server, False, worker)
                )
                thread.start()
                with client:
                    client.sendall(observer.WORKER_REQUEST)
                    received = client.recv(8192)
                thread.join()
                production.assert_not_called()
                if worker:
                    observed.assert_called_once_with(peer)
                    self.assertEqual(
                        received, b'{"purpose":"production-worker-installed"}\n'
                    )
                else:
                    observed.assert_not_called()
                    self.assertEqual(received, b"")

    def test_disposable_observation_binds_kernel_peer_and_rejects_broker_socket(self):
        for broker in (False, True):
            client, server = socket.socketpair()
            peer = (213, 11002, 11002)
            with (
                patch.object(observer, "observe") as production,
                patch.object(
                    observer,
                    "observe_disposable",
                    return_value=b'{"purpose":"disposable-installed"}',
                ) as disposable,
                patch.object(
                    observer, "connection_peer", return_value=peer
                ) as kernel_peer,
            ):
                thread = threading.Thread(
                    target=observer.handle_connection, args=(server, broker)
                )
                thread.start()
                with client:
                    client.sendall(observer.DISPOSABLE_REQUEST)
                    received = client.recv(8192)
                thread.join()
                production.assert_not_called()
                if broker:
                    disposable.assert_not_called()
                    kernel_peer.assert_not_called()
                    self.assertEqual(received, b"")
                else:
                    disposable.assert_called_once_with(peer)
                    kernel_peer.assert_called_once()
                    self.assertEqual(received, b'{"purpose":"disposable-installed"}\n')

    def test_only_fixed_role_sockets_can_be_activated(self):
        self.assertEqual(
            observer.activation_target([]), (observer.SOCKET, "lyrashield-supervisor")
        )
        self.assertEqual(
            observer.activation_target(["--broker-read-only"]),
            (observer.BROKER_SOCKET, "lyrashield-broker"),
        )
        self.assertEqual(
            observer.activation_target(["--worker-read-only"]),
            (observer.WORKER_SOCKET, "lyrashield-worker"),
        )
        for arguments in (
            ["--socket", "/tmp/authority.sock"],
            ["--broker-read-only", "extra"],
            ["--native-executor"],
        ):
            with (
                self.subTest(arguments=arguments),
                patch.object(observer, "observe") as observe,
            ):
                with self.assertRaises(RuntimeError):
                    observer.activation_target(arguments)
                observe.assert_not_called()

    def exchange(self, request, response):
        client, server = socket.socketpair()
        with patch.object(observer, "observe", return_value=response) as observe:
            thread = threading.Thread(target=observer.handle_connection, args=(server,))
            thread.start()
            with client:
                client.sendall(request)
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
        for request in (
            b"execute anything\n",
            b"execution-authority extra\n",
            b"x" * 128,
        ):
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
