"""Real process, credential and TLS boundaries of original-job recovery reads."""

from contextlib import contextmanager
import base64
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import socket
import ssl
import subprocess
import sys
import threading
import time

import pytest
import requests


TRANSPORT = Path(__file__).resolve().parents[1] / "arcanos/backend_client/continuation_transport.py"
JOB_PATH = "/jobs/4a858089-b030-4596-abd2-aa0115df0001/result"
CAPABILITY = "v1." + "R" * 43
HEADERS = {"Content-Type": "application/json", "x-arcanos-job-read-token": CAPABILITY}


def load_transport():
    """Load only transport code, without daemon configuration or provider startup."""
    spec = importlib.util.spec_from_file_location("isolated_continuation_transport", TRANSPORT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@contextmanager
def endpoint(handler, tls=None):
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    server.daemon_threads = True
    if tls is not None:
        server.socket = tls.wrap_socket(server.socket, server_side=True)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        worker.join(3)
        assert not worker.is_alive()


class QuietHandler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass


@pytest.fixture(autouse=True)
def isolated_proxy_environment(monkeypatch):
    """Fixtures contact only their loopback listener and use synthetic TLS trust."""
    for name in ("REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("NO_PROXY", "localhost,127.0.0.1")


def test_actual_child_hides_credentials_and_reaps_process_and_pipes(monkeypatch, tmp_path):
    captured = []
    calls = []
    original = subprocess.Popen
    provider_secret = "synthetic-paid-provider-value-not-for-child"
    backend_secret = "synthetic-backend-credential-not-environment"
    monkeypatch.setenv("OPENAI_API_KEY", provider_secret)
    monkeypatch.setenv("ARCANOS_DAEMON_ACCESS_TOKEN", provider_secret)
    monkeypatch.setenv("BACKEND_TOKEN", backend_secret)
    monkeypatch.setenv("PYTHONPATH", str(tmp_path / "untrusted-startup-hooks"))

    def observed(args, *positional, **options):
        child = original(args, *positional, **options)
        captured.append((args, options, child))
        return child

    monkeypatch.setattr(subprocess, "Popen", observed)
    transport = load_transport()

    class Handler(QuietHandler):
        def do_GET(self):
            calls.append((self.path, self.headers.get("x-arcanos-job-read-token") == CAPABILITY,
                          self.headers.get("Authorization") == "Bearer " + backend_secret))
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"status":"pending"}')

    with endpoint(Handler) as server:
        result = transport.get_response(f"http://127.0.0.1:{server.server_port}" + JOB_PATH,
                                        {**HEADERS, "Authorization": "Bearer " + backend_secret}, 2, lambda: False)
    assert result.status_code == 200 and result.json() == {"status": "pending"}
    assert calls == [(JOB_PATH, True, True)]
    assert len(captured) == 1
    args, options, child = captured[0]
    exposed = json.dumps({"args": args, "env": options["env"]})
    assert all(value not in exposed for value in (CAPABILITY, provider_secret, backend_secret))
    assert "-S" in args
    assert str(tmp_path / "untrusted-startup-hooks") not in options["env"].get("PYTHONPATH", "")
    assert options["close_fds"] is True and options["stderr"] == subprocess.DEVNULL
    assert child.returncode == 0 and child.stdin.closed and child.stdout.closed
    if hasattr(child, "stdout_thread"):
        assert not child.stdout_thread.is_alive()


@pytest.mark.parametrize("defect", ["generation_path", "query", "invalid_job", "missing_capability", "extra_credential", "oversized_input"])
def test_invalid_coordinates_fail_before_process_or_network(monkeypatch, defect):
    transport = load_transport()
    url = "http://127.0.0.1:9" + JOB_PATH
    headers = dict(HEADERS)
    if defect == "generation_path":
        url = "http://127.0.0.1:9/gpt/arcanos-daemon"
    elif defect == "query":
        url += "?unexpected=1"
    elif defect == "invalid_job":
        url = "http://127.0.0.1:9/jobs/not-a-job/result"
    elif defect == "missing_capability":
        headers.pop("x-arcanos-job-read-token")
    elif defect == "extra_credential":
        headers["x-arcanos-daemon-token"] = "synthetic-wrong-purpose"
    else:
        headers["Authorization"] = "Bearer " + "x" * 5000

    def forbidden(*_args, **_options):
        pytest.fail("Invalid continuation input started a process")

    monkeypatch.setattr(subprocess, "Popen", forbidden)
    with pytest.raises(requests.RequestException, match="input is invalid"):
        transport.get_response(url, headers, 2, lambda: False)


def test_helper_failure_has_no_uncontained_network_fallback(monkeypatch):
    original = subprocess.Popen
    children = []
    calls = []

    def failed_helper(_args, *positional, **options):
        child = original([sys.executable, "-c", "import os; os._exit(42)"], *positional, **options)
        children.append(child)
        return child

    monkeypatch.setattr(subprocess, "Popen", failed_helper)
    transport = load_transport()

    class Handler(QuietHandler):
        def do_GET(self):
            calls.append(self.path)
            self.send_response(200)
            self.end_headers()

    with endpoint(Handler) as server:
        with pytest.raises(requests.RequestException, match="transport failed"):
            transport.get_response(f"http://127.0.0.1:{server.server_port}" + JOB_PATH, HEADERS, 2, lambda: False)
    assert len(children) == 1 and children[0].returncode == 42
    assert children[0].stdin.closed and children[0].stdout.closed
    assert calls == []


def test_redirect_is_returned_without_following_credentials():
    calls = []

    class Handler(QuietHandler):
        def do_GET(self):
            calls.append(self.path)
            self.send_response(307)
            self.send_header("Location", "/unexpected-target")
            self.end_headers()

    with endpoint(Handler) as server:
        result = load_transport().get_response(f"http://127.0.0.1:{server.server_port}" + JOB_PATH,
                                              HEADERS, 2, lambda: False)
    assert result.status_code == 307 and calls == [JOB_PATH]


def test_requests_proxy_configuration_preserves_distinct_credentials(monkeypatch):
    """A real loopback proxy intercepts the reserved origin without external DNS or inference."""
    for name in list(os.environ):
        if name.lower() in {"http_proxy", "https_proxy", "all_proxy", "no_proxy"}:
            monkeypatch.delenv(name, raising=False)
    original = subprocess.Popen
    children = []
    calls = []
    writing = "synthetic-writing-bearer-for-proxy"
    proxy_identity = "synthetic-proxy-user:synthetic-proxy-password"
    target = "http://backend.invalid" + JOB_PATH

    def observed(args, *positional, **options):
        child = original(args, *positional, **options)
        children.append((args, options["env"]))
        return child

    class Proxy(QuietHandler):
        def do_GET(self):
            calls.append((self.path, self.headers.get("x-arcanos-job-read-token") == CAPABILITY,
                          self.headers.get("Authorization") == "Bearer " + writing,
                          self.headers.get("Proxy-Authorization") == "Basic " + base64.b64encode(proxy_identity.encode()).decode()))
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"status":"pending"}')

    monkeypatch.setattr(subprocess, "Popen", observed)
    with endpoint(Proxy) as proxy:
        monkeypatch.setenv("HTTP_PROXY", f"http://{proxy_identity}@127.0.0.1:{proxy.server_port}")
        result = load_transport().get_response(target, {**HEADERS, "Authorization": "Bearer " + writing}, 2, lambda: False)
    assert result.status_code == 200 and result.json() == {"status": "pending"}
    assert calls == [(target, True, True, True)]
    assert len(children) == 1
    exposure = json.dumps(children)
    assert CAPABILITY not in exposure and writing not in exposure
    assert all(value not in result.text for value in (CAPABILITY, writing, proxy_identity))


def test_requests_custom_ca_and_hostname_verification_are_preserved(tmp_path, monkeypatch):
    """A local self-signed fixture fails by default and succeeds only with explicit CA trust."""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")])
    issuer = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Synthetic continuation test CA")])
    now = datetime.now(timezone.utc)
    authority = (x509.CertificateBuilder().subject_name(issuer).issuer_name(issuer).public_key(key.public_key())
                 .serial_number(x509.random_serial_number()).not_valid_before(now - timedelta(minutes=5))
                 .not_valid_after(now + timedelta(days=1))
                 .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
                 .sign(key, hashes.SHA256()))

    def certificate(address):
        return (x509.CertificateBuilder().subject_name(name).issuer_name(issuer).public_key(key.public_key())
                .serial_number(x509.random_serial_number()).not_valid_before(now - timedelta(minutes=5))
                .not_valid_after(now + timedelta(days=1))
                .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address(address))]), critical=False)
                .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
                .sign(key, hashes.SHA256()).public_bytes(serialization.Encoding.PEM))

    good_certificate, wrong_certificate = certificate("127.0.0.1"), certificate("127.0.0.2")
    certificate_path, wrong_path = tmp_path / "synthetic-server.pem", tmp_path / "synthetic-wrong-server.pem"
    authority_path, key_path = tmp_path / "synthetic-ca.pem", tmp_path / "synthetic-key.pem"
    certificate_path.write_bytes(good_certificate)
    wrong_path.write_bytes(wrong_certificate)
    authority_path.write_bytes(authority.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                          serialization.NoEncryption()))
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(certificate_path, key_path)
    wrong_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    wrong_context.load_cert_chain(wrong_path, key_path)
    calls = []

    class Handler(QuietHandler):
        def do_GET(self):
            calls.append(self.path)
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"{}")

    transport = load_transport()
    with endpoint(Handler, context) as server, endpoint(Handler, wrong_context) as wrong_server:
        url = f"https://127.0.0.1:{server.server_port}" + JOB_PATH
        with pytest.raises(requests.RequestException):
            transport.get_response(url, HEADERS, 2, lambda: False)
        monkeypatch.setenv("REQUESTS_CA_BUNDLE", str(authority_path))
        assert transport.get_response(url, HEADERS, 2, lambda: False).status_code == 200
        with pytest.raises(requests.RequestException):
            transport.get_response(f"https://127.0.0.1:{wrong_server.server_port}" + JOB_PATH, HEADERS, 2, lambda: False)
    assert calls == [JOB_PATH]


@pytest.mark.skipif(os.name != "nt", reason="Native Windows parent-death/process-handle acceptance")
def test_parent_exit_during_real_get_cannot_leave_network_helper_alive(tmp_path):
    """Abrupt parent death cannot orphan a slow header read past the helper's hard lifetime."""
    import ctypes
    from ctypes import wintypes

    gate = tmp_path / "request-started"
    closed = threading.Event()
    calls = []

    class Handler(QuietHandler):
        def do_GET(self):
            calls.append(self.path)
            gate.write_text("started", encoding="ascii")
            self.connection.settimeout(4)
            try:
                if self.connection.recv(1) == b"":
                    closed.set()
            except (ConnectionResetError, ConnectionAbortedError):
                closed.set()
            except socket.timeout:
                pass

    with endpoint(Handler) as server:
        config = {"module": str(TRANSPORT), "gate": str(gate),
                  "url": f"http://127.0.0.1:{server.server_port}" + JOB_PATH, "headers": HEADERS}
        env = {key: value for key, value in os.environ.items() if key.lower() in load_transport()._ENVIRONMENT}
        parent = subprocess.Popen([sys.executable, "-B", str(Path(__file__).resolve()), "--orphan-parent"],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                  env=env, creationflags=subprocess.CREATE_NO_WINDOW, close_fds=True)
        output, errors = parent.communicate(json.dumps(config).encode(), timeout=6)
        assert parent.returncode == 73 and errors == b""
        child_pid = json.loads(output)["child_pid"]
        assert closed.wait(3), "The orphaned network helper did not close its real HTTP connection"
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel.WaitForSingleObject.restype = wintypes.DWORD
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.CloseHandle.restype = wintypes.BOOL
        handle = kernel.OpenProcess(0x00100000, False, child_pid)
        if handle:
            try:
                assert kernel.WaitForSingleObject(handle, 1000) == 0
            finally:
                kernel.CloseHandle(handle)
        else:
            assert ctypes.get_last_error() == 87, "The helper must be absent, not merely inaccessible"
    assert calls == [JOB_PATH]


if __name__ == "__main__" and sys.argv[1:] == ["--orphan-parent"]:
    # Credentials arrive only over an anonymous pipe, even in this abrupt-parent
    # fixture. No daemon configuration, provider or paid transport is imported.
    config = json.load(sys.stdin)
    spec = importlib.util.spec_from_file_location("parent_death_transport", config["module"])
    transport = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(transport)
    original = transport.subprocess.Popen

    def observed_child(*args, **kwargs):
        child = original(*args, **kwargs)
        print(json.dumps({"child_pid": child.pid}), flush=True)
        return child

    transport.subprocess.Popen = observed_child
    worker = threading.Thread(target=lambda: transport.get_response(config["url"], config["headers"], 2, lambda: False), daemon=True)
    worker.start()
    limit = time.monotonic() + 4
    while not Path(config["gate"]).exists() and time.monotonic() < limit:
        time.sleep(0.01)
    os._exit(73 if Path(config["gate"]).exists() else 74)
